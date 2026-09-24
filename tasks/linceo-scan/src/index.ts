import tl = require('azure-pipelines-task-lib/task');

// Imagen pinneada explícitamente: sin input, sin `latest` (alcance mínimo;
// la verificación de versión y el override por input quedan para más
// adelante, ver docs/adr/ADR-000-arquitectura-y-alcance-v0.1.md §7).
const LINCEO_IMAGE = 'ghcr.io/jdiegoisaza/linceo:0.9.1';

// Variables que el ContextProvider `azure_devops` de linceo necesita para
// resolver el ExecutionContext, más TF_BUILD como centinela de detección
// de plataforma (`--platform auto`, el default de linceo). Lista tomada
// tal cual de la implementación de referencia de linceo
// (azure-pipelines/templates/linceo-scan.yml y
// src/linceo/providers/azure_devops.py::ENV_VARS) — no del script que esta
// tarea reemplaza. Deliberadamente NO incluye las variables de política
// remota (SYSTEM_COLLECTIONURI, SYSTEM_TEAMPROJECT, SYSTEM_ACCESSTOKEN):
// esas pertenecen al PolicySource, no al ContextProvider, y quedan fuera
// del alcance mínimo de esta tarea (sin service connection, sin política
// remota).
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

async function run(): Promise<void> {
    try {
        const category: string = tl.getInput('category', true) ?? '';

        const sourcesDirectory: string = tl.getVariable('Build.SourcesDirectory') ?? '';
        if (!sourcesDirectory) {
            tl.setResult(tl.TaskResult.Failed, 'Build.SourcesDirectory no está definido; ¿falta un paso de checkout?');
            return;
        }

        const dockerPath: string = tl.which('docker', true);
        const docker = tl.tool(dockerPath);

        docker.arg(['run', '--rm']);
        for (const name of CONTEXT_ENV_VARS) {
            docker.arg(['-e', name]);
        }
        docker.arg(['-v', `${sourcesDirectory}:/workspace`]);
        docker.arg(LINCEO_IMAGE);
        docker.arg(['scan', category, '--path', '/workspace']);

        const exitCode: number = await docker.exec({ ignoreReturnCode: true });

        switch (exitCode) {
            case 0:
                tl.setResult(tl.TaskResult.Succeeded, `linceo (${category}): gate superado (o sin umbral configurado).`);
                break;
            case 1:
                tl.setResult(tl.TaskResult.Failed, `linceo (${category}): el gate falló — hay hallazgos que superan el umbral configurado.`);
                break;
            case 2:
                tl.setResult(tl.TaskResult.Failed, `linceo (${category}): error de configuración (exit 2).`);
                break;
            case 3:
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
