import tl = require('azure-pipelines-task-lib/task');

// Repositorio de la imagen; el tag es un input (imageTag, ver abajo) desde
// esta tanda — quien usa la extensión puede fijar su propia versión sin
// esperar a un release de la extensión. El valor por defecto en task.json
// es la versión que esta versión de la extensión soporta y probó.
const LINCEO_IMAGE_REPOSITORY = 'ghcr.io/jdiegoisaza/linceo';

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

async function run(): Promise<void> {
    try {
        const category: string = tl.getInput('category', true) ?? '';
        const scanPath: string = tl.getInput('path', false) ?? '';
        const configPath: string = tl.getInput('configPath', false) ?? '';
        const imageTag: string = tl.getInput('imageTag', true) ?? '';
        const onGateFailure: string = tl.getInput('onGateFailure', true) ?? 'fail';
        const failOn: string = tl.getInput('failOn', false) ?? '';
        const useSystemAccessToken: boolean = tl.getBoolInput('useSystemAccessToken', false);

        const sourcesDirectory: string = tl.getVariable('Build.SourcesDirectory') ?? '';
        if (!sourcesDirectory) {
            tl.setResult(tl.TaskResult.Failed, 'Build.SourcesDirectory no está definido; ¿falta un paso de checkout?');
            return;
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
        docker.arg(['-v', `${sourcesDirectory}:/workspace`]);
        docker.arg(`${LINCEO_IMAGE_REPOSITORY}:${imageTag}`);

        const targetPath = scanPath ? `/workspace/${scanPath}` : '/workspace';
        docker.arg(['scan', category, '--path', targetPath]);
        if (configPath) {
            docker.arg(['--config', `/workspace/${configPath}`]);
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
