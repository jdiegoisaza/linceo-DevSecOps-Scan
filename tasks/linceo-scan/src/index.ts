import path = require('path');
import fs = require('fs');
import tl = require('azure-pipelines-task-lib/task');

// Copiado literalmente de pyproject.toml de linceo (ver linceo-pins.json)
// — el mínimo de Python que el modo pypi necesita para instalarlo no es
// un dato que esta tarea decida, es un hecho sobre linceo. Igual que
// tasks/linceo-install/tool-pins.json, se vendoriza y se vigila con la
// misma comprobación de deriva programada (azure-pipelines-linceo-pins-
// check.yml) — nunca se recalcula ni se adivina aquí.
interface LinceoPins {
    python: { requires: string };
}
const LINCEO_PINS: LinceoPins = JSON.parse(fs.readFileSync(path.join(__dirname, 'linceo-pins.json'), 'utf8'));

// Repositorio de la imagen; el tag es un input (imageTag) — quien usa la
// extensión puede fijar su propia versión sin esperar a un release de la
// extensión. El valor por defecto en task.json es la versión que esta
// versión de la extensión soporta y probó. Sólo aplica en executionMode
// "container" (ADR-000 §4, §12.5).
const LINCEO_IMAGE_REPOSITORY = 'ghcr.io/jdiegoisaza/linceo';

// Punto donde se monta Build.SourcesDirectory dentro del contenedor (ver
// el -v más abajo). El contenedor siempre es Linux, sin importar el SO del
// agente, así que esta ruta y el separador '/' con el que se construyen
// las rutas hijas son literales, no path.sep. Sólo aplica en modo
// container; en modo pypi no hay remapeo, el proceso ve el disco del
// agente directamente.
const CONTAINER_WORKSPACE = '/workspace';

// Variables que el ContextProvider `azure_devops` de linceo necesita para
// resolver el ExecutionContext, más TF_BUILD como centinela de detección
// de plataforma (`--platform auto`, el default de linceo). Lista tomada
// tal cual de la implementación de referencia de linceo
// (azure-pipelines/templates/linceo-scan.yml y
// src/linceo/providers/azure_devops.py::ENV_VARS). Sólo se usa para
// construir la lista de `-e` del modo container: en modo pypi el proceso
// hereda el entorno completo sin que la tarea tenga que enumerar nada
// (ADR-000 §4.6) — es, literalmente, la asimetría que la extensión existe
// para resolver.
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
// useSystemAccessToken (ver resolveSystemAccessToken), nunca reenviada por
// defecto.
const REMOTE_POLICY_CONTEXT_ENV_VARS = ['SYSTEM_COLLECTIONURI', 'SYSTEM_TEAMPROJECT'];

interface ResolvedWorkspacePath {
    /** Ruta real en el disco del agente — se usa para validar existencia, y es la que se pasa a linceo en modo pypi. */
    hostPath: string;
    /** Ruta equivalente dentro del contenedor, bajo CONTAINER_WORKSPACE — sólo se usa en modo container. */
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
 * "/workspace//home/...". La misma validación aplica en modo pypi, aunque
 * ahí no haya montaje: una ruta fuera del workspace del build sigue sin
 * ser un target legítimo para esta tarea en ningún modo.
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
                `"${value}" está fuera del workspace del build (${sourcesDirectory}). Sólo el workspace es un ` +
                'target válido para esta tarea; una ruta fuera de él no tiene equivalente ahí.'
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
 * Flags que esta tarea ya gobierna con un input propio y validado —
 * comparar §0 del ADR ("la tarea expone flags de invocación; nunca deja
 * ambigüedad"). extraArgs no puede repetirlos: no porque "ganar después"
 * sea inseguro en general (es justo el comportamiento buscado para todo
 * lo demás, ver el orden de construcción en run()), sino porque estos
 * tres en concreto ya pasan por su propia validación — existencia en el
 * workspace para path/configPath, pickList cerrado para failOn — que un
 * valor colado por extraArgs se saltaría en silencio. --format no está
 * en esta lista porque hoy ningún input de esta tarea lo gobierna
 * todavía; si alguna vez se añade uno, se agrega aquí también.
 */
const GOVERNED_FLAGS = ['--path', '--config', '--fail-on'] as const;

/**
 * Tokeniza una línea de argumentos exactamente como
 * azure-pipelines-task-lib/toolrunner.ts::ToolRunner.line() lo hace por
 * dentro (su _argStringToArray, privado, no exportado por el paquete) —
 * reimplementado aquí porque hace falta inspeccionar los tokens ANTES de
 * ejecutar (política de flags gobernados, abajo) y loguearlos tal cual
 * quedan, en una sola pasada: usar .line() habría tokenizado una segunda
 * vez, sin garantía de coincidir con lo ya validado.
 *
 * Verificado, no asumido: comparado contra la función real en un banco de
 * doce casos —comillas, escapes, y el ejemplo peligroso de abajo— y
 * coinciden token a token.
 *
 * Puramente léxico: separa por espacios fuera de comillas dobles; no
 * interpreta `;`, `|`, `&`, `&&`, backticks, `$()` ni ninguna sintaxis de
 * shell — quedan como texto literal dentro de un token. Alcanza porque
 * nunca se invoca un shell para expandirlos: docker.exec() no pasa
 * `shell: true`, así que child_process.spawn ejecuta `docker` directo con
 * el argv resultante (y lo mismo para el binario de linceo en modo pypi).
 * `--max-rows 200; rm -rf /` produce
 * `['--max-rows', '200;', 'rm', '-rf', '/']` — cinco argumentos literales
 * que linceo recibe (y probablemente rechace como uso inválido, exit 2),
 * nunca un comando que se ejecuta.
 */
function tokenizeArgLine(argString: string): string[] {
    const tokens: string[] = [];
    let inQuotes = false;
    let escaped = false;
    let lastCharWasSpace = true;
    let current = '';

    const append = (c: string): void => {
        if (escaped && c !== '"') {
            current += '\\';
        }
        current += c;
        escaped = false;
    };

    for (let i = 0; i < argString.length; i++) {
        const c = argString.charAt(i);

        if (c === ' ' && !inQuotes) {
            if (!lastCharWasSpace) {
                tokens.push(current);
                current = '';
            }
            lastCharWasSpace = true;
            continue;
        }
        lastCharWasSpace = false;

        if (c === '"') {
            if (!escaped) {
                inQuotes = !inQuotes;
            } else {
                append(c);
            }
            continue;
        }

        if (c === '\\' && escaped) {
            append(c);
            continue;
        }

        if (c === '\\' && inQuotes) {
            escaped = true;
            continue;
        }

        append(c);
    }

    if (!lastCharWasSpace) {
        tokens.push(current.trim());
    }

    return tokens;
}

/**
 * Nombre del input dedicado que corresponde a cada flag gobernado, para
 * el mensaje de error — que apunte a la solución, no sólo al problema.
 */
function dedicatedInputFor(flag: (typeof GOVERNED_FLAGS)[number]): string {
    switch (flag) {
        case '--path':
            return 'path';
        case '--config':
            return 'configPath';
        case '--fail-on':
            return 'failOn';
    }
}

/**
 * Falla con causa propia si `hostPath` no existe, o no es del tipo
 * esperado — antes de que linceo llegue a intentar leerlo. Sin esto, una
 * ruta mal escrita se manifiesta como un error de la herramienta
 * ("trivy binary not found" fue el síntoma real) que apunta a cualquier
 * sitio menos al input que la causó. Aplica igual en los dos modos: en
 * container la validación ocurre antes del montaje, en pypi antes de la
 * invocación directa.
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

/**
 * Resuelve System.AccessToken desde el endpoint SYSTEMVSSCONNECTION del
 * agente y lo expone al proceso de esta tarea como SYSTEM_ACCESSTOKEN
 * (ADR-000 §6) — nunca como argumento literal de un comando, para que no
 * aparezca en el log. Común a los dos modos: en container, el llamador
 * decide además si añadirlo a la lista de `-e`; en pypi, basta con
 * haberlo puesto en process.env, porque el subproceso hereda el entorno
 * completo (§4.6).
 *
 * Devuelve si se resolvió, para que el modo container sepa si debe
 * reenviarlo explícitamente al contenedor.
 */
function resolveSystemAccessToken(useSystemAccessToken: boolean): boolean {
    if (!useSystemAccessToken) {
        return false;
    }

    let accessToken: string | undefined;
    try {
        accessToken = tl.getEndpointAuthorizationParameter('SYSTEMVSSCONNECTION', 'AccessToken', true);
    } catch {
        accessToken = undefined;
    }

    if (accessToken) {
        tl.setSecret(accessToken);
        process.env.SYSTEM_ACCESSTOKEN = accessToken;
        return true;
    }

    tl.warning(
        'useSystemAccessToken está activo, pero no se pudo obtener System.AccessToken del endpoint ' +
        'SYSTEMVSSCONNECTION de este agente. La política remota que dependa de él no se resolverá; linceo la ' +
        'reportará como fuente no disponible, no como éxito silencioso.'
    );
    return false;
}

/**
 * Modo pypi (ADR-000 §4.5/§12.5/§12.9): si ya hay un `linceo` resoluble en
 * el PATH del agente, se usa ese y no se instala nada — es lo que hace
 * que este modo sea utilizable sin red en agentes curados (p. ej. con
 * linceo-install ya corrido, o con linceo preinstalado por otra vía). Si
 * no, se crea un venv efímero bajo Agent.TempDirectory con `uv` (nunca
 * `python -m venv`) y se instala linceo en él con `uv pip install`, con
 * versión exacta y siempre el extra [remote-config] (§4.5) — nunca
 * persistido entre jobs: a diferencia de gitleaks/trivy/checkov/uv en
 * linceo-install, el propio orquestador es ligero y puro-Python, así que
 * no hay a quién ahorrarle una reinstalación de peso comparable.
 *
 * Por qué `uv` y no `python -m venv` (ADR §12.9 — reemplaza el preflight
 * de versión de Python y la detección de "ensurepip" que existían antes
 * de este hallazgo, ahora código muerto y eliminado, no dejado al lado):
 * Debian/Ubuntu empaquetan "ensurepip" aparte del intérprete del sistema
 * (paquete "python3.X-venv"); sin él, `python -m venv` falla recién al
 * intentar arrancar pip DENTRO del entorno ya creado, con un "exit code 1"
 * que no nombra la causa real. `uv venv` no necesita ensurepip en
 * absoluto —no instala pip en el entorno, instala paquetes él mismo con
 * `uv pip install`— y además puede descargar su propio Python
 * autocontenido cuando el que haya en el PATH no alcanza el mínimo que
 * linceo declara. Verificado contra un intérprete real sin "ensurepip":
 * `uv venv --python <esa misma ruta>` crea el entorno sin tropezar, y
 * `uv venv --python ">=3.11"` con el PATH vaciado de cualquier Python de
 * sistema descarga uno autocontenido y funciona igual — motivo por el que
 * ya no hace falta validar ni buscar un intérprete por versión o
 * capacidad: `uv` resuelve las dos cosas internamente, y acepta el mismo
 * rango de linceo-pins.json tal cual, sin que esta tarea lo interprete.
 *
 * `uv` no lo instala esta tarea (evitaría duplicar el mecanismo de
 * checksum/caché que linceo-install ya tiene para gitleaks/trivy/checkov
 * — ADR §12.9): se asume ya resuelto en el PATH, igual que docker en modo
 * container. Sin fallback a `python -m venv` si falta (ADR §12.9,
 * mismo argumento que executionMode sin `auto`): degradar en silencio a
 * un mecanismo con un bug ya conocido no es una opción.
 */
async function ensureLinceoBinary(linceoVersion: string, pythonRequires: string): Promise<string> {
    const existing = tl.which('linceo', false);
    if (existing) {
        console.log(`linceo ya está en el PATH del agente (${existing}) — se usa ese, no se instala nada.`);
        return existing;
    }

    const uvPath = tl.which('uv', false);
    if (!uvPath) {
        throw new Error(
            '"uv" no está en el PATH del agente. El modo pypi lo usa para crear el entorno de linceo (nunca ' +
            '"python -m venv" — ADR §12.9) — añade la tarea linceo-install a este mismo job, antes de este paso, ' +
            'o instala uv manualmente y déjalo en el PATH. No hay una vía alternativa automática.'
        );
    }

    const agentTemp = tl.getVariable('Agent.TempDirectory') ?? '';
    const venvDir = path.join(agentTemp, `linceo-scan-venv-${Date.now()}`);

    console.log(
        `linceo no está en el PATH. Usando uv (${uvPath}) para crear un venv con Python ${pythonRequires} e ` +
        `instalar linceo[remote-config]==${linceoVersion} en ${venvDir}.`
    );

    const venvResult = tl.tool(uvPath).arg(['venv', '--python', pythonRequires, venvDir]).execSync();
    if (venvResult.code !== 0) {
        throw new Error(
            `"uv venv --python ${pythonRequires}" no pudo crear el entorno (código ${venvResult.code}): ` +
            (venvResult.stderr.trim() || venvResult.stdout.trim())
        );
    }

    const installResult = tl
        .tool(uvPath)
        .arg(['pip', 'install', '--python', path.join(venvDir, 'bin', 'python'), `linceo[remote-config]==${linceoVersion}`])
        .execSync();
    if (installResult.code !== 0) {
        throw new Error(
            `"uv pip install" no pudo instalar linceo (código ${installResult.code}): ` +
            (installResult.stderr.trim() || installResult.stdout.trim())
        );
    }

    return path.join(venvDir, 'bin', 'linceo');
}

/**
 * Preflight de modo pypi (ADR-000 §4.3): corre `linceo doctor` y falla
 * con su propia salida —nombrando qué herramienta falta o está fuera de
 * rango— si algo no está disponible. Nunca reintenta ni degrada a
 * container (§4.2/§4.3): eso sería exactamente el `auto` que el ADR
 * descarta.
 */
function runDoctorPreflight(linceoPath: string, cwd: string): void {
    const result = tl.tool(linceoPath).arg(['doctor']).execSync({ cwd });
    if (result.code !== 0) {
        throw new Error(
            `LINCEO_MODE_UNAVAILABLE: "linceo doctor" reportó herramientas no disponibles o fuera de rango ` +
            `(código de salida ${result.code}). linceo-scan no instala gitleaks/trivy/checkov por diseño ` +
            '(ADR-000 §1/§12.6) — corre la tarea linceo-install en este mismo job, o prepara el agente a ' +
            `mano. Salida de "linceo doctor":\n${result.stdout}`
        );
    }
}

async function run(): Promise<void> {
    try {
        const category: string = tl.getInput('category', true) ?? '';
        const executionMode: string = tl.getInput('executionMode', true) ?? 'container';
        const scanPathInput: string = tl.getInput('path', false) ?? '';
        const configPathInput: string = tl.getInput('configPath', false) ?? '';
        const imageTag: string = tl.getInput('imageTag', false) ?? '';
        const linceoVersion: string = tl.getInput('linceoVersion', false) ?? '';
        const onGateFailure: string = tl.getInput('onGateFailure', true) ?? 'fail';
        const failOn: string = tl.getInput('failOn', false) ?? '';
        const useSystemAccessToken: boolean = tl.getBoolInput('useSystemAccessToken', false);
        const extraArgsInput: string = tl.getInput('extraArgs', false) ?? '';

        const sourcesDirectory: string = tl.getVariable('Build.SourcesDirectory') ?? '';
        if (!sourcesDirectory) {
            tl.setResult(tl.TaskResult.Failed, 'Build.SourcesDirectory no está definido; ¿falta un paso de checkout?');
            return;
        }

        // Resolución y validación de rutas ANTES de tocar Docker o linceo
        // — si algo está mal, la tarea debe fallar por esa causa, no por
        // lo que la herramienta reporte al no encontrar lo que se le
        // pidió leer.
        const resolvedScanPath = resolveWorkspacePath(sourcesDirectory, scanPathInput);
        if (resolvedScanPath) {
            requireWorkspacePath('La ruta a escanear (path)', resolvedScanPath.hostPath, 'directory');
        }

        const resolvedConfigPath = resolveWorkspacePath(sourcesDirectory, configPathInput);
        if (resolvedConfigPath) {
            requireWorkspacePath('La ruta al documento de política (configPath)', resolvedConfigPath.hostPath, 'file');
        }

        // Target efectivo según el modo: en container, la ruta remapeada
        // bajo el punto de montaje; en pypi, la ruta real del agente —
        // nunca una traducción entre los dos (ADR-000 §12.5).
        const scanTargetPath = resolvedScanPath
            ? executionMode === 'container'
                ? resolvedScanPath.containerPath
                : resolvedScanPath.hostPath
            : executionMode === 'container'
            ? CONTAINER_WORKSPACE
            : sourcesDirectory;
        const configTargetPath = resolvedConfigPath
            ? executionMode === 'container'
                ? resolvedConfigPath.containerPath
                : resolvedConfigPath.hostPath
            : undefined;

        // Tokenizado y validado ANTES de tocar Docker o linceo, como el
        // resto de esta sección — mismo criterio que arriba: si algo está
        // mal, la tarea falla por esa causa, no por lo que la herramienta
        // reporte al recibir un argv que no esperaba. Común a los dos
        // modos: extraArgs se reenvía igual sea cual sea el transporte.
        const extraArgsTokens = tokenizeArgLine(extraArgsInput);
        const collidingFlag = GOVERNED_FLAGS.find(flag =>
            extraArgsTokens.some(t => t === flag || t.startsWith(`${flag}=`))
        );
        if (collidingFlag) {
            throw new Error(
                `extraArgs incluye "${collidingFlag}", que ya gobierna el input "${dedicatedInputFor(collidingFlag)}" ` +
                'de esta tarea. Usa ese input en vez de repetirlo aquí: evita que dos valores compitan por el ' +
                `mismo flag, y evita que el que venga por extraArgs se salte la validación propia de "${dedicatedInputFor(collidingFlag)}".`
            );
        }
        if (extraArgsTokens.length > 0) {
            // Requisito de depuración: el valor efectivo, ya tokenizado,
            // visible en el log — no sólo en el eco automático del
            // comando completo, que puede ser largo y mezclar esto entre
            // las variables -e (modo container) o pasar inadvertido.
            console.log(`extraArgs interpretado como ${extraArgsTokens.length} argumento(s): ${JSON.stringify(extraArgsTokens)}`);
        }

        // --fail-on reemplaza [thresholds] por completo en linceo, no se
        // combina con él (ADR §5) — avisar siempre que este input esté
        // activo, incluido "none" (que fuerza apagar el gate). Común a
        // los dos modos.
        if (failOn) {
            tl.warning(
                `failOn está en "${failOn}": esto reemplaza por completo el bloque [thresholds] de ` +
                '.devsecops/config.toml del repositorio escaneado, no se combina con él. Quita este ' +
                'input para que decida la política del repositorio.'
            );
        }

        let exitCode: number;

        if (executionMode === 'container') {
            const accessTokenResolved = resolveSystemAccessToken(useSystemAccessToken);
            const dockerEnvVarNames = [...CONTEXT_ENV_VARS, ...REMOTE_POLICY_CONTEXT_ENV_VARS];
            if (accessTokenResolved) {
                dockerEnvVarNames.push('SYSTEM_ACCESSTOKEN');
            }

            if (!imageTag) {
                throw new Error('imageTag es obligatorio en executionMode "container".');
            }

            const dockerPath: string = tl.which('docker', true);
            const docker = tl.tool(dockerPath);

            docker.arg(['run', '--rm']);
            for (const name of dockerEnvVarNames) {
                docker.arg(['-e', name]);
            }
            docker.arg(['-v', `${sourcesDirectory}:${CONTAINER_WORKSPACE}`]);
            docker.arg(`${LINCEO_IMAGE_REPOSITORY}:${imageTag}`);

            docker.arg(['scan', category, '--path', scanTargetPath]);
            if (configTargetPath) {
                docker.arg(['--config', configTargetPath]);
            }
            if (failOn) {
                docker.arg(['--fail-on', failOn]);
            }
            // Al final, después de todo lo que construye la tarea — así,
            // para cualquier flag que admita un solo valor (Typer/Click:
            // gana la última aparición; confirmado contra
            // src/linceo/cli/scan.py, que declara --path/--config/
            // --fail-on como Option escalares, no "multiple"), extraArgs
            // puede sobrescribir un default de la tarea si hace falta.
            // docker.arg(array) no vuelve a tokenizar: son exactamente
            // los tokens ya validados y logueados arriba.
            if (extraArgsTokens.length > 0) {
                docker.arg(extraArgsTokens);
            }

            exitCode = await docker.exec({ ignoreReturnCode: true });
        } else if (executionMode === 'pypi') {
            if (process.platform !== 'linux') {
                throw new Error(
                    'LINCEO_MODE_UNAVAILABLE: executionMode "pypi" sólo está soportado en agentes Linux ' +
                    '(ADR-000 §1/§12.5) — usa executionMode "container", o mueve este paso a un agente Linux.'
                );
            }

            resolveSystemAccessToken(useSystemAccessToken);

            if (!linceoVersion) {
                throw new Error('linceoVersion es obligatorio en executionMode "pypi".');
            }

            let linceoPath: string;
            try {
                linceoPath = await ensureLinceoBinary(linceoVersion, LINCEO_PINS.python.requires);
            } catch (err) {
                const message = err instanceof Error ? err.message : 'Error desconocido';
                throw new Error(`LINCEO_MODE_UNAVAILABLE: no se pudo preparar linceo en modo pypi: ${message}`);
            }

            runDoctorPreflight(linceoPath, sourcesDirectory);

            const linceo = tl.tool(linceoPath);
            linceo.arg(['scan', category, '--path', scanTargetPath]);
            if (configTargetPath) {
                linceo.arg(['--config', configTargetPath]);
            }
            if (failOn) {
                linceo.arg(['--fail-on', failOn]);
            }
            if (extraArgsTokens.length > 0) {
                linceo.arg(extraArgsTokens);
            }

            // El proceso hereda process.env completo (incluido
            // SYSTEM_ACCESSTOKEN si se resolvió arriba) — es la propiedad
            // de §4.6 que hace innecesaria la lista de -e de modo
            // container.
            exitCode = await linceo.exec({ ignoreReturnCode: true, cwd: sourcesDirectory });
        } else {
            throw new Error(`executionMode desconocido: "${executionMode}". Valores válidos: container, pypi.`);
        }

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
