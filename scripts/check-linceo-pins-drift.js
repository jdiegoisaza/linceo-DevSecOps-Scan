// Comprueba que los valores que esta extensión copió de linceo —
// versiones/checksums de herramientas en tasks/linceo-install/tool-pins.json,
// y el mínimo de Python en tasks/linceo-scan/linceo-pins.json— siguen
// coincidiendo con el release más reciente de linceo (ADR-000 §12.7/§12.8).
// No sustituye la verificación de checksum contra una descarga real (eso
// detecta un error de transcripción); esto detecta que linceo cambió algo
// y el pin de esta extensión se quedó atrás — lo que aquella verificación,
// por diseño, no puede ver.
//
// Pensado para correr en un pipeline propio y programado
// (azure-pipelines-linceo-pins-check.yml), nunca en el de build/publish: si
// encuentra deriva, FALLA (no avisa) — es la única razón por la que ese
// pipeline puede ponerse en rojo, y un aviso en una corrida programada que
// nadie abre equivale, en la práctica, a no tener esta comprobación (ver
// el ADR para el argumento completo de por qué esto es distinto del
// preflight de versión de §7.3, que sí avisa).
//
// linceo no publica "Releases" de GitHub (confirmado: GET /releases
// devuelve []), sólo tags — por eso se resuelve el tag más reciente a mano
// vía la API de tags, en vez de /releases/latest.

const https = require('https');
const fs = require('fs');
const path = require('path');

const REPO = 'jdiegoisaza/linceo';
const USER_AGENT = 'linceo-azure-extension-linceo-pins-check';
const TOOL_PINS_PATH = path.join(__dirname, '..', 'tasks', 'linceo-install', 'tool-pins.json');
const LINCEO_PINS_PATH = path.join(__dirname, '..', 'tasks', 'linceo-scan', 'linceo-pins.json');

function httpsGetJson(url) {
    return new Promise((resolve, reject) => {
        https
            .get(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/vnd.github+json' } }, res => {
                if (res.statusCode !== 200) {
                    reject(new Error(`GET ${url} -> HTTP ${res.statusCode}`));
                    res.resume();
                    return;
                }
                let body = '';
                res.on('data', chunk => (body += chunk));
                res.on('end', () => {
                    try {
                        resolve(JSON.parse(body));
                    } catch (err) {
                        reject(new Error(`GET ${url}: respuesta no es JSON válido (${err.message})`));
                    }
                });
            })
            .on('error', reject);
    });
}

function httpsGetText(url) {
    return new Promise((resolve, reject) => {
        https
            .get(url, { headers: { 'User-Agent': USER_AGENT } }, res => {
                if (res.statusCode !== 200) {
                    reject(new Error(`GET ${url} -> HTTP ${res.statusCode}`));
                    res.resume();
                    return;
                }
                let body = '';
                res.on('data', chunk => (body += chunk));
                res.on('end', () => resolve(body));
            })
            .on('error', reject);
    });
}

/**
 * Compara dos tags "vX.Y.Z" numéricamente, sin traer una librería de
 * semver sólo para esto — mismo criterio que linceo aplica en su propio
 * version_range.py para no traer `packaging` por una necesidad igual de
 * acotada.
 */
function compareTags(a, b) {
    const parse = tag => tag.replace(/^v/, '').split('.').map(Number);
    const [aMajor, aMinor, aPatch] = parse(a);
    const [bMajor, bMinor, bPatch] = parse(b);
    return aMajor - bMajor || aMinor - bMinor || aPatch - bPatch;
}

async function resolveLatestTag() {
    const tags = await httpsGetJson(`https://api.github.com/repos/${REPO}/tags?per_page=100`);
    const versionTags = tags.map(t => t.name).filter(name => /^v\d+\.\d+\.\d+$/.test(name));
    if (versionTags.length === 0) {
        throw new Error(`No se encontró ningún tag con forma vX.Y.Z en ${REPO}.`);
    }
    versionTags.sort(compareTags);
    return versionTags[versionTags.length - 1];
}

function extractArg(dockerfile, argName) {
    const match = dockerfile.match(new RegExp(`^ARG ${argName}=(\\S+)`, 'm'));
    return match ? match[1] : undefined;
}

function extractRequiresPython(pyproject) {
    const match = pyproject.match(/^requires-python\s*=\s*"([^"]+)"/m);
    return match ? match[1] : undefined;
}

async function main() {
    const toolPins = JSON.parse(fs.readFileSync(TOOL_PINS_PATH, 'utf8'));
    const linceoPins = JSON.parse(fs.readFileSync(LINCEO_PINS_PATH, 'utf8'));

    const latestTag = await resolveLatestTag();
    console.log(
        `Tag más reciente de ${REPO}: ${latestTag} (pins actuales: ${toolPins.source.dockerfileRef} / ` +
        `${linceoPins.source.pyprojectRef})`
    );

    const [dockerfile, pyproject] = await Promise.all([
        httpsGetText(`https://raw.githubusercontent.com/${REPO}/${latestTag}/Dockerfile`),
        httpsGetText(`https://raw.githubusercontent.com/${REPO}/${latestTag}/pyproject.toml`),
    ]);

    const upstream = {
        gitleaksVersion: extractArg(dockerfile, 'GITLEAKS_VERSION'),
        gitleaksSha256Amd64: extractArg(dockerfile, 'GITLEAKS_SHA256_AMD64'),
        gitleaksSha256Arm64: extractArg(dockerfile, 'GITLEAKS_SHA256_ARM64'),
        trivyVersion: extractArg(dockerfile, 'TRIVY_VERSION'),
        trivySha256Amd64: extractArg(dockerfile, 'TRIVY_SHA256_AMD64'),
        trivySha256Arm64: extractArg(dockerfile, 'TRIVY_SHA256_ARM64'),
        checkovVersion: extractArg(dockerfile, 'CHECKOV_VERSION'),
        pythonRequires: extractRequiresPython(pyproject),
    };

    for (const [field, value] of Object.entries(upstream)) {
        if (!value) {
            const sourceFile = field === 'pythonRequires' ? 'pyproject.toml' : 'Dockerfile';
            throw new Error(
                `No se pudo extraer "${field}" del ${sourceFile} de ${REPO}@${latestTag} — su formato pudo haber ` +
                'cambiado. Esto es un fallo de la propia comprobación, no necesariamente deriva de pin.'
            );
        }
    }

    const local = {
        gitleaksVersion: toolPins.gitleaks.version,
        gitleaksSha256Amd64: toolPins.gitleaks.sha256.amd64,
        gitleaksSha256Arm64: toolPins.gitleaks.sha256.arm64,
        trivyVersion: toolPins.trivy.version,
        trivySha256Amd64: toolPins.trivy.sha256.amd64,
        trivySha256Arm64: toolPins.trivy.sha256.arm64,
        checkovVersion: toolPins.checkov.version,
        pythonRequires: linceoPins.python.requires,
    };

    const localFileFor = {
        pythonRequires: 'tasks/linceo-scan/linceo-pins.json',
    };

    const diffs = Object.keys(upstream).filter(field => upstream[field] !== local[field]);

    if (diffs.length === 0) {
        console.log(`Sin deriva: tool-pins.json y linceo-pins.json coinciden con ${REPO}@${latestTag}.`);
        return;
    }

    console.log(`##vso[task.logissue type=error]Pins desactualizados frente a ${REPO}@${latestTag}:`);
    for (const field of diffs) {
        const file = localFileFor[field] ?? 'tasks/linceo-install/tool-pins.json';
        console.log(`##vso[task.logissue type=error]  ${field} (${file}): vendorizado="${local[field]}" upstream="${upstream[field]}"`);
    }
    console.log(
        '##vso[task.logissue type=error]Actualiza el fichero de pins correspondiente con estos valores ' +
        '(copiados de linceo, nunca calculados) y súbele la versión a esta extensión — ADR-000 §12.2/§12.7/§12.8.'
    );
    process.exitCode = 1;
}

main().catch(err => {
    console.log(`##vso[task.logissue type=error]La comprobación de deriva de pins no pudo completarse: ${err.message}`);
    console.log(
        '##vso[task.logissue type=error]Esto no significa "sin deriva" — significa que no se pudo verificar. ' +
        'Tratado como fallo a propósito (ADR-000 §12.7): un chequeo que no corrió y queda en verde es el mismo ' +
        'patrón de falso positivo que el resto de este proyecto evita.'
    );
    process.exitCode = 1;
});
