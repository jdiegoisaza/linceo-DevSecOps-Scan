// Comprueba que tasks/linceo-install/tool-pins.json sigue coincidiendo con
// el Dockerfile del release más reciente de linceo (ADR-000 §12.7 de esta
// extensión). No sustituye la verificación de checksum de tool-pins.json
// contra una descarga real (eso detecta un error de transcripción); esto
// detecta que linceo subió una versión de herramienta y el pin de esta
// extensión se quedó atrás — lo que aquella verificación, por diseño, no
// puede ver.
//
// Pensado para correr en un pipeline propio y programado
// (azure-pipelines-tool-pins-check.yml), nunca en el de build/publish: si
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
const USER_AGENT = 'linceo-azure-extension-tool-pins-check';
const TOOL_PINS_PATH = path.join(__dirname, '..', 'tasks', 'linceo-install', 'tool-pins.json');

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

async function main() {
    const toolPins = JSON.parse(fs.readFileSync(TOOL_PINS_PATH, 'utf8'));

    const latestTag = await resolveLatestTag();
    console.log(`Tag más reciente de ${REPO}: ${latestTag} (pin actual: ${toolPins.source.dockerfileRef})`);

    const dockerfile = await httpsGetText(`https://raw.githubusercontent.com/${REPO}/${latestTag}/Dockerfile`);

    const upstream = {
        gitleaksVersion: extractArg(dockerfile, 'GITLEAKS_VERSION'),
        gitleaksSha256Amd64: extractArg(dockerfile, 'GITLEAKS_SHA256_AMD64'),
        gitleaksSha256Arm64: extractArg(dockerfile, 'GITLEAKS_SHA256_ARM64'),
        trivyVersion: extractArg(dockerfile, 'TRIVY_VERSION'),
        trivySha256Amd64: extractArg(dockerfile, 'TRIVY_SHA256_AMD64'),
        trivySha256Arm64: extractArg(dockerfile, 'TRIVY_SHA256_ARM64'),
        checkovVersion: extractArg(dockerfile, 'CHECKOV_VERSION'),
    };

    for (const [field, value] of Object.entries(upstream)) {
        if (!value) {
            throw new Error(
                `No se pudo extraer "${field}" del Dockerfile de ${REPO}@${latestTag} — el formato del ` +
                'Dockerfile pudo haber cambiado. Esto es un fallo de la propia comprobación, no necesariamente deriva de pin.'
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
    };

    const diffs = Object.keys(upstream).filter(field => upstream[field] !== local[field]);

    if (diffs.length === 0) {
        console.log(`Sin deriva: tool-pins.json coincide con el Dockerfile de ${REPO}@${latestTag}.`);
        return;
    }

    console.log(`##vso[task.logissue type=error]tool-pins.json quedó desactualizado frente a ${REPO}@${latestTag}:`);
    for (const field of diffs) {
        console.log(`##vso[task.logissue type=error]  ${field}: vendorizado="${local[field]}" upstream="${upstream[field]}"`);
    }
    console.log(
        '##vso[task.logissue type=error]Actualiza tasks/linceo-install/tool-pins.json con estos valores ' +
        '(copiados del Dockerfile, nunca calculados) y súbele la versión a esta extensión — ADR-000 §12.2/§12.7.'
    );
    process.exitCode = 1;
}

main().catch(err => {
    console.log(`##vso[task.logissue type=error]La comprobación de deriva de tool-pins no pudo completarse: ${err.message}`);
    console.log(
        '##vso[task.logissue type=error]Esto no significa "sin deriva" — significa que no se pudo verificar. ' +
        'Tratado como fallo a propósito (ADR-000 §12.7): un chequeo que no corrió y queda en verde es el mismo ' +
        'patrón de falso positivo que el resto de este proyecto evita.'
    );
    process.exitCode = 1;
});
