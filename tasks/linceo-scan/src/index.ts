import path = require('path');
import fs = require('fs');
import tl = require('azure-pipelines-task-lib/task');

// Repositorio de la imagen; el tag es un input (imageTag) — quien usa la
// extensión puede fijar su propia versión sin esperar a un release de la
// extensión. El valor por defecto en task.json es la versión que esta
// versión de la extensión soporta y probó.
const LINCEO_IMAGE_REPOSITORY = 'ghcr.io/jdiegoisaza/linceo';

// Punto donde se monta Build.SourcesDirectory dentro del contenedor (ver
// el -v más abajo). El contenedor siempre es Linux, sin importar el SO del
// agente, así que esta ruta y el separador '/' con el que se construyen
// las rutas hijas son literales, no path.sep.
const CONTAINER_WORKSPACE = '/workspace';

// Variables que el ContextProvider `azure_devops` de linceo necesita para
// resolver el ExecutionContext, más TF_BUILD como centinela de detección
// de plataforma (`--platform auto`, el default de linceo). Lista tomada
// tal cual de la implementación de referencia de linceo
// (azure-pipelines/templates/linceo-scan.yml y
// src/linceo/providers/azure_devops.py::ENV_VARS).
const CONTEXT_ENV_VARS = [
    'TF_BUILD',
    'BUILD_REPOSITORY_NAME',
    'BUILD_SOURCEVERSION',
    'BUILD_SOURCEBRANCH',
    'SYSTEM_PULLREQUEST_SOURCEBRANCH',
    'SYSTEM_PULLREQUEST_PULLREQUESTID',
    'SYSTEM_PULLREQUEST_PULLREQUESTNUMBER',
    'BUILD_BUILDID',
    'BUILD_REPOSITORY_URI',
];

// Variables del PolicySource (src/linceo/providers/azure_devops.py::
// AzureDevOpsPolicySource / REMOTE_POLICY_ENV_VARS), distintas de las del
// ContextProvider de arriba. SYSTEM_COLLECTIONURI y SYSTEM_TEAMPROJECT no
// son secretos y Azure Pipelines ya los mapea al entorno de cualquier
// tarea; se reenvían siempre — un repositorio sin [remote_policy] declarado
// simplemente no los lee, igual de inofensivo que reenviar
// BUILD_REPOSITORY_URI a un escaneo de sólo secrets. SYSTEM_ACCESSTOKEN es
// la única variable sensible de este grupo y queda gobernada por el input
// useSystemAccessToken (ver run()), nunca reenviada por defecto.
const REMOTE_POLICY_CONTEXT_ENV_VARS = ['SYSTEM_COLLECTIONURI', 'SYSTEM_TEAMPROJECT'];

interface ResolvedWorkspacePath {
    /** Ruta real en el disco del agente — se usa para validar existencia. */
    hostPath: string;
    /** Ruta equivalente dentro del contenedor, bajo CONTAINER_WORKSPACE. */
    containerPath: string;
}

/**
 * Resuelve un input de ruta (path o configPath) contra el punto de montaje
 * del contenedor.
 *
 * Devuelve `undefined` cuando el valor equivale a "nada": cadena vacía, o
 * una ruta absoluta que resulta ser exactamente sourcesDirectory. Ese
 * segundo caso no es hipotético: un input `filePath` de Azure Pipelines
 * puede resolver al Build.SourcesDirectory completo aunque el usuario no
 * haya escrito nada — es la causa exacta del bug visto en producción
 * (--path y --config recibiendo la ruta absoluta del agente, concatenada
 * sin traducir). Tratar ese valor como "vacío" aquí, en el único lugar
 * donde ambos inputs se resuelven, es lo que hace que cada llamador
 * aplique el default correcto sin tener que conocer este detalle — y es
 * también el motivo de que el input ya no sea `filePath` en task.json,
 * sino `string` (defensa en profundidad, no solo el cambio de tipo).
 *
 * Cualquier otra ruta absoluta — que no sea exactamente sourcesDirectory
 * ni caiga dentro de él — no tiene correspondencia posible dentro del
 * contenedor (sólo sourcesDirectory está montado) y se rechaza con un
 * error explícito en vez de producir una ruta rota como
 * "/workspace//home/...".
 */
function resolveWorkspacePath(sourcesDirectory: string, rawValue: string): ResolvedWorkspacePath | undefined {
    const value = rawValue.trim();
    if (!value) {
        return undefined;
    }

    let relative: string;
    if (path.isAbsolute(value)) {
        relative = path.relative(sourcesDirectory, value);
        if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
            throw new Error(
                `"${value}" está fuera del workspace del build (${sourcesDirectory}). Sólo el workspace se ` +
                'monta dentro del contenedor; una ruta fuera de él no tiene equivalente ahí.'
            );
        }
    } else {
        relative = value;
    }

    if (relative === '' || relative === '.') {
        return undefined;
    }

    const hostPath = path.join(sourcesDirectory, relative);
    const containerRelative = relative.split(path.sep).join('/');
    return { hostPath, containerPath: `${CONTAINER_WORKSPACE}/${containerRelative}` };
}

/**
 * Falla con causa propia si `hostPath` no existe, o no es del tipo
 * esperado — antes de que linceo llegue a intentar leerlo dentro del
 * contenedor. Sin esto, una ruta mal escrita se manifiesta como un error
 * de la herramienta ("trivy binary not found" fue el síntoma real) que
 * apunta a cualquier sitio menos al input que la causó.
 */
function requireWorkspacePath(label: string, hostPath: string, expectedKind: 'directory' | 'file'): void {
    let stats: fs.Stats;
    try {
        stats = fs.statSync(hostPath);
    } catch {
        throw new Error(
            `${label} no existe dentro del workspace: "${hostPath}" no se encontró en el agente. Revisa el ` +
            'input antes de que la tarea invoque linceo.'
        );
    }

    const isExpectedKind = expectedKind === 'directory' ? stats.isDirectory() : stats.isFile();
    if (!isExpectedKind) {
        const actualKind = stats.isDirectory() ? 'un directorio' : 'un archivo';
        const expectedLabel = expectedKind === 'directory' ? 'un directorio' : 'un archivo';
        throw new Error(`${label} existe, pero es ${actualKind}, no ${expectedLabel}: "${hostPath}".`);
    }
}

async function run(): Promise<void> {
    try {
        const category: string = tl.getInput('category', true) ?? '';
        const scanPathInput: string = tl.getInput('path', false) ?? '';
        const configPathInput: string = tl.getInput('configPath', false) ?? '';
        const imageTag: string = tl.getInput('imageTag', true) ?? '';
        const onGateFailure: string = tl.getInput('onGateFailure', true) ?? 'fail';
        const failOn: string = tl.getInput('failOn', false) ?? '';
        const useSystemAccessToken: boolean = tl.getBoolInput('useSystemAccessToken', false);

        const sourcesDirectory: string = tl.getVariable('Build.SourcesDirectory') ?? '';
        if (!sourcesDirectory) {
            tl.setResult(tl.TaskResult.Failed, 'Build.SourcesDirectory no está definido; ¿falta un paso de checkout?');
            return;
        }

        // Resolución y validación de rutas ANTES de tocar Docker — si algo
        // está mal, la tarea debe fallar por esa causa, no por lo que
        // linceo reporte al no encontrar lo que se le pidió leer.
        const resolvedScanPath = resolveWorkspacePath(sourcesDirectory, scanPathInput);
        const scanContainerPath = resolvedScanPath ? resolvedScanPath.containerPath : CONTAINER_WORKSPACE;
        if (resolvedScanPath) {
            requireWorkspacePath('La ruta a escanear (path)', resolvedScanPath.hostPath, 'directory');
        }

        const resolvedConfigPath = resolveWorkspacePath(sourcesDirectory, configPathInput);
        if (resolvedConfigPath) {
            requireWorkspacePath('La ruta al documento de política (configPath)', resolvedConfigPath.hostPath, 'file');
        }

        // --fail-on reemplaza [thresholds] por completo en linceo, no se
        // combina con él (ADR §5) — avisar siempre que este input esté
        // activo, incluido "none" (que fuerza apagar el gate).
        if (failOn) {
            tl.warning(
                `failOn está en "${failOn}": esto reemplaza por completo el bloque [thresholds] de ` +
                '.devsecops/config.toml del repositorio escaneado, no se combina con él. Quita este ' +
                'input para que decida la política del repositorio.'
            );
        }

        const dockerEnvVarNames = [...CONTEXT_ENV_VARS, ...REMOTE_POLICY_CONTEXT_ENV_VARS];

        if (useSystemAccessToken) {
            let accessToken: string | undefined;
            try {
                // SYSTEMVSSCONNECTION está siempre disponible en el job; a
                // diferencia de System.AccessToken como variable de
                // pipeline, esto no requiere ningún `env:` en el YAML del
                // consumidor de la tarea.
                accessToken = tl.getEndpointAuthorizationParameter('SYSTEMVSSCONNECTION', 'AccessToken', true);
            } catch {
                accessToken = undefined;
            }

            if (accessToken) {
                tl.setSecret(accessToken);
                // Se asigna al entorno del propio proceso (nunca como
                // argumento literal de docker run) para que el `-e
                // SYSTEM_ACCESSTOKEN` de abajo lo reenvíe por nombre, igual
                // que el resto de variables — el token nunca aparece en el
                // comando que se hace eco en el log.
                process.env.SYSTEM_ACCESSTOKEN = accessToken;
                dockerEnvVarNames.push('SYSTEM_ACCESSTOKEN');
            } else {
                tl.warning(
                    'useSystemAccessToken está activo, pero no se pudo obtener System.AccessToken del ' +
                    'endpoint SYSTEMVSSCONNECTION de este agente. La política remota que dependa de él no ' +
                    'se resolverá; linceo la reportará como fuente no disponible, no como éxito silencioso.'
                );
            }
        }

        const dockerPath: string = tl.which('docker', true);
        const docker = tl.tool(dockerPath);

        docker.arg(['run', '--rm']);
        for (const name of dockerEnvVarNames) {
            docker.arg(['-e', name]);
        }
        docker.arg(['-v', `${sourcesDirectory}:${CONTAINER_WORKSPACE}`]);
        docker.arg(`${LINCEO_IMAGE_REPOSITORY}:${imageTag}`);

        docker.arg(['scan', category, '--path', scanContainerPath]);
        if (resolvedConfigPath) {
            docker.arg(['--config', resolvedConfigPath.containerPath]);
        }
        if (failOn) {
            docker.arg(['--fail-on', failOn]);
        }

        const exitCode: number = await docker.exec({ ignoreReturnCode: true });

        switch (exitCode) {
            case 0:
                tl.setResult(tl.TaskResult.Succeeded, `linceo (${category}): gate superado (o sin umbral configurado).`);
                break;
            case 1:
                if (onGateFailure === 'warn') {
                    tl.setResult(
                        tl.TaskResult.SucceededWithIssues,
                        `linceo (${category}): el gate falló, reportado como advertencia (onGateFailure=warn).`
                    );
                } else {
                    tl.setResult(
                        tl.TaskResult.Failed,
                        `linceo (${category}): el gate falló — hay hallazgos que superan el umbral configurado.`
                    );
                }
                break;
            case 2:
                // onGateFailure no aplica: un error de configuración
                // siempre falla la tarea, sin excepción (ADR §5).
                tl.setResult(tl.TaskResult.Failed, `linceo (${category}): error de configuración (exit 2).`);
                break;
            case 3:
                // onGateFailure no aplica: sin evidencia completa, la tarea
                // siempre falla, sin excepción (ADR §5) — un pipeline verde
                // que no escaneó nada es peor que uno rojo.
                tl.setResult(tl.TaskResult.Failed, `linceo (${category}): herramienta rota o evidencia incompleta (exit 3).`);
                break;
            default:
                tl.setResult(tl.TaskResult.Failed, `linceo (${category}): código de salida inesperado (${exitCode}).`);
        }
    } catch (err) {
        const message = err instanceof Error ? err.message : 'Error desconocido';
        tl.setResult(tl.TaskResult.Failed, message);
    }
}

run();
