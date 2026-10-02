import path = require('path');
import fs = require('fs');
import os = require('os');
import crypto = require('crypto');
import tl = require('azure-pipelines-task-lib/task');
import toolLib = require('azure-pipelines-tool-lib/tool');

// Copiados literalmente de los ARG del Dockerfile de linceo — nunca
// recalculados aquí (ADR-000 §12.2 de esta extensión). Ver tool-pins.json
// para la fuente exacta y la fecha de verificación.
interface Sha256Pair {
    amd64: string;
    arm64: string;
}

interface GithubBinaryPin {
    version: string;
    sha256: Sha256Pair;
}

interface CheckovPin {
    version: string;
}

interface ToolPins {
    gitleaks: GithubBinaryPin;
    trivy: GithubBinaryPin;
    checkov: CheckovPin;
    uv: GithubBinaryPin;
}

const TOOL_PINS: ToolPins = JSON.parse(fs.readFileSync(path.join(__dirname, 'tool-pins.json'), 'utf8'));

type ReleaseArch = 'amd64' | 'arm64';

// Mapeo fijo, confirmado contra el código de linceo (Category.SECRETS/
// SCA/IAC en gitleaks.py/trivy.py/checkov.py) — no una decisión de esta
// tarea (ADR-000 §12.1).
const CATEGORY_TO_TOOL: Record<string, 'gitleaks' | 'trivy' | 'checkov'> = {
    secrets: 'gitleaks',
    sca: 'trivy',
    iac: 'checkov',
};

function verifyLinux(): void {
    if (process.platform !== 'linux') {
        throw new Error(
            `linceo-install sólo soporta agentes Linux (detectado "${process.platform}") — mismo límite ` +
            'que el modo pypi de linceo-scan: en Windows/macOS habría que resolver gitleaks/trivy/checkov ' +
            'por otra vía, y no está resuelto todavía.'
        );
    }
}

/**
 * Traduce la arquitectura de Node (os.arch()) al vocabulario que usan los
 * assets de release de gitleaks/trivy y las claves de tool-pins.json —
 * calcado del `case "${TARGETARCH}"` del Dockerfile de linceo.
 */
function resolveReleaseArch(): ReleaseArch {
    switch (process.arch) {
        case 'x64':
            return 'amd64';
        case 'arm64':
            return 'arm64';
        default:
            throw new Error(
                `Arquitectura de agente no soportada: "${process.arch}". linceo-install sólo pinea ` +
                'binarios para amd64 y arm64, igual que la imagen de referencia de linceo.'
            );
    }
}

async function sha256File(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        const stream = fs.createReadStream(filePath);
        stream.on('error', reject);
        stream.on('data', chunk => hash.update(chunk));
        stream.on('end', () => resolve(hash.digest('hex')));
    });
}

interface GithubReleaseSpec {
    toolName: 'gitleaks' | 'trivy' | 'uv';
    binaryName: string;
    version: string;
    expectedSha256: string;
    assetName: string;
    downloadUrl: string;
    /**
     * Subdirectorio dentro del tar donde vive el binario, cuando el
     * release no lo deja en la raíz del archivo (caso de uv: el tarball
     * contiene "uv-<triple>/uv", no "uv" a secas, confirmado extrayendo
     * el tarball real). Ausente para gitleaks/trivy, que sí lo dejan en
     * la raíz.
     */
    archiveDir?: string;
}

function buildGitleaksSpec(releaseArch: ReleaseArch): GithubReleaseSpec {
    const version = TOOL_PINS.gitleaks.version;
    const expectedSha256 = TOOL_PINS.gitleaks.sha256[releaseArch];
    const platformSuffix = releaseArch === 'amd64' ? 'linux_x64' : 'linux_arm64';
    const assetName = `gitleaks_${version}_${platformSuffix}.tar.gz`;
    return {
        toolName: 'gitleaks',
        binaryName: 'gitleaks',
        version,
        expectedSha256,
        assetName,
        downloadUrl: `https://github.com/gitleaks/gitleaks/releases/download/v${version}/${assetName}`,
    };
}

function buildTrivySpec(releaseArch: ReleaseArch): GithubReleaseSpec {
    const version = TOOL_PINS.trivy.version;
    const expectedSha256 = TOOL_PINS.trivy.sha256[releaseArch];
    const platformSuffix = releaseArch === 'amd64' ? 'Linux-64bit' : 'Linux-ARM64';
    const assetName = `trivy_${version}_${platformSuffix}.tar.gz`;
    return {
        toolName: 'trivy',
        binaryName: 'trivy',
        version,
        expectedSha256,
        assetName,
        downloadUrl: `https://github.com/aquasecurity/trivy/releases/download/v${version}/${assetName}`,
    };
}

/**
 * uv no es una herramienta que linceo orqueste (ADR-000 §12.9) — se
 * instala porque linceo-scan en modo pypi la usa para crear el venv de
 * linceo mismo, sin depender de "ensurepip" (ADR-000 §12.9, que reemplaza
 * el preflight de versión de Python que existía antes de este hallazgo).
 * Se ancla a la misma versión que el Dockerfile de linceo ya usa para
 * construirse a sí mismo (ARG UV_VERSION) — una sola autoridad externa,
 * igual que gitleaks/trivy/checkov.
 *
 * Tag del release sin prefijo "v" (a diferencia de gitleaks/trivy) y
 * nombre de asset con el triple de la plataforma — confirmado contra el
 * release real 0.12.15 en github.com/astral-sh/uv, no asumido.
 */
function buildUvSpec(releaseArch: ReleaseArch): GithubReleaseSpec {
    const version = TOOL_PINS.uv.version;
    const expectedSha256 = TOOL_PINS.uv.sha256[releaseArch];
    const targetTriple = releaseArch === 'amd64' ? 'x86_64-unknown-linux-gnu' : 'aarch64-unknown-linux-gnu';
    const archiveDir = `uv-${targetTriple}`;
    const assetName = `${archiveDir}.tar.gz`;
    return {
        toolName: 'uv',
        binaryName: 'uv',
        version,
        expectedSha256,
        assetName,
        downloadUrl: `https://github.com/astral-sh/uv/releases/download/${version}/${assetName}`,
        archiveDir,
    };
}

/**
 * Asegura un binario pinneado de GitHub release en el PATH del job.
 *
 * Único modo, sin input (ADR-000 §12.4): nunca toca ni desinstala lo que
 * ya esté en el PATH del agente por otra vía; instala su propia copia
 * versionada en la caché de herramientas del agente y la antepone al
 * PATH, de modo que gana por resolución de PATH sin pisar nada ajeno. Un
 * hit de caché nunca puede ser una descarga a medias: azure-pipelines-
 * tool-lib sólo da una entrada por válida si su marcador `.complete`
 * existe, y ese marcador sólo lo escribe esta misma función tras verificar
 * el checksum (ver `cacheDir`/`findLocalTool` en azure-pipelines-tool-lib).
 */
async function ensureGithubReleaseBinary(spec: GithubReleaseSpec, cacheArch: string): Promise<void> {
    const cached = toolLib.findLocalTool(spec.toolName, spec.version, cacheArch);
    if (cached) {
        console.log(`${spec.toolName} ${spec.version}: ya en la caché del agente (${cached}) — no se descarga.`);
        toolLib.prependPath(cached);
        return;
    }

    console.log(`${spec.toolName} ${spec.version}: no está en caché. Descargando ${spec.downloadUrl}`);
    const downloadedFile = await toolLib.downloadTool(spec.downloadUrl);

    const actualSha256 = await sha256File(downloadedFile);
    if (actualSha256.toLowerCase() !== spec.expectedSha256.toLowerCase()) {
        throw new Error(
            `Verificación de checksum fallida para ${spec.assetName}.\n` +
            `  esperado (checksum publicado): ${spec.expectedSha256}\n` +
            `  obtenido de la descarga:       ${actualSha256}\n` +
            'No se instala un binario que no coincide con su checksum publicado — puede ser una descarga ' +
            'corrupta, una manipulación en tránsito, o un pin incorrecto en tool-pins.json.'
        );
    }
    console.log(`${spec.toolName} ${spec.version}: checksum verificado (${actualSha256}).`);

    const extractedDir = await toolLib.extractTar(downloadedFile);
    const binaryDir = spec.archiveDir ? path.join(extractedDir, spec.archiveDir) : extractedDir;
    fs.chmodSync(path.join(binaryDir, spec.binaryName), 0o755);

    const cachedDir = await toolLib.cacheDir(binaryDir, spec.toolName, spec.version, cacheArch);
    toolLib.prependPath(cachedDir);
    console.log(`${spec.toolName} ${spec.version}: instalado y cacheado en ${cachedDir}.`);
}

/**
 * Asegura checkov en el PATH del job, en un venv propio y aislado —
 * nunca en el mismo entorno que linceo (mismo criterio que la etapa
 * checkov-build del Dockerfile de linceo: su árbol de dependencias
 * (~220MB) no debe mezclarse con el de linceo). Verificado por el índice
 * de PyPI al instalar (ADR-000 §12.2) — no lleva checksum manual.
 */
async function ensureCheckov(cacheArch: string): Promise<void> {
    const version = TOOL_PINS.checkov.version;

    const cached = toolLib.findLocalTool('checkov', version, cacheArch);
    if (cached) {
        console.log(`checkov ${version}: ya en la caché del agente (${cached}) — no se reinstala.`);
        toolLib.prependPath(path.join(cached, 'bin'));
        return;
    }

    // uv ya quedó en el PATH de este proceso (ensureGithubReleaseBinary lo
    // antepone antes de llegar aquí). Se usa `uv venv` + `uv pip install`
    // en vez de `python -m venv` + pip por la misma razón que linceo-scan
    // (ADR-000 §12.9): Debian/Ubuntu empaquetan "ensurepip" aparte
    // (python3.X-venv) y sin él `python -m venv` falla al arrancar pip
    // dentro del entorno, sin nombrar la causa. uv no necesita ensurepip
    // ni un python3 preinstalado: descarga uno autocontenido si hace falta.
    const uvPath = tl.which('uv', true);
    const agentTemp = tl.getVariable('Agent.TempDirectory') ?? '';
    const tempVenvDir = path.join(agentTemp, `linceo-install-checkov-venv-${Date.now()}`);

    console.log(`checkov ${version}: no está en caché. Creando venv aislado con uv e instalando desde PyPI.`);
    await tl.tool(uvPath).arg(['venv', tempVenvDir]).exec();
    await tl
        .tool(uvPath)
        .arg(['pip', 'install', '--python', path.join(tempVenvDir, 'bin', 'python'), `checkov==${version}`])
        .exec();

    const cachedDir = await toolLib.cacheDir(tempVenvDir, 'checkov', version, cacheArch);
    toolLib.prependPath(path.join(cachedDir, 'bin'));
    console.log(`checkov ${version}: instalado (uv pip, verificado por el índice de PyPI) y cacheado en ${cachedDir}.`);
}

/**
 * Pre-descarga la base de datos de vulnerabilidades de trivy (ADR-000
 * §12.5 — hallazgo no pedido por el encargo original). linceo siempre
 * invoca trivy con --skip-db-update (ADR R2/§5 de linceo); sin una base
 * ya presente, `linceo scan sca` fallaría con
 * "--skip-db-update cannot be specified on the first run". Ejecuta
 * exactamente el comando que src/linceo/adapters/trivy.py::
 * TRIVY_DB_NOT_READY_HINT ya recomienda correr a mano, y expone
 * TRIVY_CACHE_DIR para que ese mismo trivy, invocado después por linceo,
 * la encuentre (requiere que linceo-install y linceo-scan vivan en el
 * mismo job — la variable sólo se propaga dentro de él).
 *
 * `dbCacheArch` fijo en "all": la base de datos no depende de la
 * arquitectura del agente — una sola copia la sirve a todas, a diferencia
 * del binario de trivy.
 */
async function ensureTrivyVulnerabilityDatabase(trivyVersion: string): Promise<void> {
    const dbCacheArch = 'all';
    const cached = toolLib.findLocalTool('trivy-db', trivyVersion, dbCacheArch);
    if (cached) {
        console.log(`Base de datos de trivy (clave de versión ${trivyVersion}): ya en caché (${cached}).`);
        tl.setVariable('TRIVY_CACHE_DIR', cached);
        return;
    }

    console.log(
        'Base de datos de vulnerabilidades de trivy no encontrada en caché. Ejecutando ' +
        '"trivy fs --download-db-only" — el único comando que linceo documenta como permitido para esto.'
    );
    const agentTemp = tl.getVariable('Agent.TempDirectory') ?? '';
    const tempDbDir = path.join(agentTemp, `linceo-install-trivy-db-${Date.now()}`);
    tl.mkdirP(tempDbDir);

    const trivyPath = tl.which('trivy', true);
    await tl
        .tool(trivyPath)
        .arg(['fs', '--cache-dir', tempDbDir, '--download-db-only', '.'])
        .exec({ cwd: agentTemp });

    const cachedDir = await toolLib.cacheDir(tempDbDir, 'trivy-db', trivyVersion, dbCacheArch);
    tl.setVariable('TRIVY_CACHE_DIR', cachedDir);
    console.log(`Base de datos de trivy cacheada en ${cachedDir} y expuesta como TRIVY_CACHE_DIR.`);
}

/**
 * uv guarda sus propias descargas (Python autocontenido cuando no hay uno
 * que sirva en el PATH, y su caché de paquetes) en rutas que, por
 * defecto, no sobreviven entre jobs si no se les dice dónde vivir — el
 * mismo problema que esta tarea ya resuelve para sus binarios, ahora
 * aplicado a lo que uv pueda necesitar descargar él mismo más adelante
 * (en linceo-scan, no aquí). Se exponen como variables de pipeline para
 * que cualquier `uv` invocado después, en el mismo job, las herede sin
 * configuración adicional — uv las lee de su propio entorno de proceso.
 */
function configureUvCaching(): void {
    const toolsDirectory = tl.getVariable('Agent.ToolsDirectory') ?? '';
    const pythonInstallDir = path.join(toolsDirectory, 'uv-python');
    const cacheDir = path.join(toolsDirectory, 'uv-cache');
    tl.mkdirP(pythonInstallDir);
    tl.mkdirP(cacheDir);
    tl.setVariable('UV_PYTHON_INSTALL_DIR', pythonInstallDir);
    tl.setVariable('UV_CACHE_DIR', cacheDir);
    console.log(`uv: UV_PYTHON_INSTALL_DIR=${pythonInstallDir}, UV_CACHE_DIR=${cacheDir} (persisten entre jobs del mismo agente, igual que el resto de la caché de esta tarea).`);
}

async function run(): Promise<void> {
    try {
        verifyLinux();
        const releaseArch = resolveReleaseArch();
        // Mismo valor que azure-pipelines-tool-lib usaría por defecto
        // (os.arch(): 'x64'|'arm64') — se pasa explícito para que la
        // clave de caché quede a la vista, no implícita en un default.
        const cacheArch = os.arch();

        // Las categorías se validan ANTES de descargar nada.
        const categories = Object.keys(CATEGORY_TO_TOOL).filter(category => tl.getBoolInput(category, false));
        if (categories.length === 0) {
            throw new Error(
                'Ninguna categoría seleccionada: activa al menos una de secrets, sca o iac. Esta tarea siempre ' +
                'instala uv, pero una ejecución sin ninguna categoría no prepara nada que linceo-scan pueda usar.'
            );
        }
        const tools = new Set(categories.map(category => CATEGORY_TO_TOOL[category]));

        // uv no está condicionado por las categorías: a diferencia de
        // gitleaks/trivy/checkov (atados a una categoría de escaneo),
        // uv lo necesita linceo-scan en modo pypi para instalar linceo
        // mismo, sin importar qué categoría se vaya a escanear después
        // (ADR-000 §12.9).
        await ensureGithubReleaseBinary(buildUvSpec(releaseArch), cacheArch);
        configureUvCaching();

        if (tools.has('gitleaks')) {
            await ensureGithubReleaseBinary(buildGitleaksSpec(releaseArch), cacheArch);
        }

        let trivyVersionUsed: string | undefined;
        if (tools.has('trivy')) {
            const spec = buildTrivySpec(releaseArch);
            await ensureGithubReleaseBinary(spec, cacheArch);
            trivyVersionUsed = spec.version;
        }

        if (tools.has('checkov')) {
            await ensureCheckov(cacheArch);
        }

        // Después de asegurar el binario de trivy: el preflight de la
        // base de datos necesita invocar "trivy" ya resuelto en PATH, y
        // prependPath ya mutó process.env.PATH de este mismo proceso más
        // arriba, no sólo el de pasos futuros.
        if (trivyVersionUsed) {
            await ensureTrivyVulnerabilityDatabase(trivyVersionUsed);
        }

        tl.setResult(
            tl.TaskResult.Succeeded,
            `linceo-install: uv listo y preparadas las categorías ${categories.join(', ')} para ejecutar linceo en modo pypi.`
        );
    } catch (err) {
        const message = err instanceof Error ? err.message : 'Error desconocido';
        tl.setResult(tl.TaskResult.Failed, message);
    }
}

run();
