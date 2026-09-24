# linceo-azure-extension

Extensión de Azure DevOps que ejecuta [linceo](https://github.com/jdiegoisaza/linceo) como
tarea nativa de pipeline. Alcance actual (v0.1 mínimo): una sola tarea, `linceo-scan`, con la
categoría de escaneo (`secrets` | `sca` | `iac`) como único input. La tarea ejecuta
`docker run` contra `ghcr.io/jdiegoisaza/linceo:0.9.1`, monta el workspace del build y
propaga las variables de entorno que el proveedor de contexto `azure_devops` de linceo necesita
para resolver el `ExecutionContext`. El código de salida de linceo determina el resultado de la
tarea (0 → `Succeeded`; 1/2/3/cualquier otro → `Failed`).

Fuera de este alcance, deliberadamente: service connection, publicación de artefactos, modo
PyPI y verificación de rango de versión. Están diseñados en
`docs/adr/ADR-000-arquitectura-y-alcance-v0.1.md`, pero no implementados todavía.

## Estructura

```
tasks/linceo-scan/     tarea Node/TypeScript (única tarea de esta extensión)
scripts/                build.js / install.js / package.js, heredados de la plantilla
static/logo.png         ícono de la extensión (placeholder — reemplazar antes de publicar)
vss-extension.json       manifiesto de la extensión
```

## Compilar y empaquetar

Requiere Node.js y, para el último paso, [tfx-cli](https://github.com/microsoft/tfs-cli)
instalado globalmente (`npm install -g tfx-cli`).

```bash
npm install          # instala dependencias raíz + de cada tarea (postinstall)
npm run build         # compila TypeScript de cada tarea a dist/
npm run package        # copia task.json/package.json/icon.png a dist/ e instala deps de producción ahí
npm run create         # tfx extension create --output-path dist --rev-version → genera el .vsix
```

## Antes de publicar

- **`publisher`** en `vss-extension.json` está en `"your-publisher"` — hay que reemplazarlo por
  el ID de publisher real de Marketplace antes de `tfx extension create`.
- **`static/logo.png`** y **`tasks/linceo-scan/icon.png`** son los íconos genéricos de la
  plantilla — reemplazarlos antes de publicar.
- La imagen (`ghcr.io/jdiegoisaza/linceo:0.9.1`) está fija en el código de la tarea
  (`tasks/linceo-scan/src/index.ts`), no es un input. Cambiar de versión hoy significa editar
  esa constante y recompilar.

## Variables de contexto propagadas

Exactamente las que `src/linceo/providers/azure_devops.py::ENV_VARS` del propio linceo declara,
más `TF_BUILD` como centinela de `--platform auto` — la misma lista que usa la plantilla de
referencia `azure-pipelines/templates/linceo-scan.yml` del repositorio de linceo:

`TF_BUILD`, `BUILD_REPOSITORY_NAME`, `BUILD_SOURCEVERSION`, `BUILD_SOURCEBRANCH`,
`SYSTEM_PULLREQUEST_SOURCEBRANCH`, `SYSTEM_PULLREQUEST_PULLREQUESTID`,
`SYSTEM_PULLREQUEST_PULLREQUESTNUMBER`, `BUILD_BUILDID`, `BUILD_REPOSITORY_URI`.

No incluye las variables del *policy source* (`SYSTEM_COLLECTIONURI`, `SYSTEM_TEAMPROJECT`,
`SYSTEM_ACCESSTOKEN`) — esas son para política remota, que depende de una service connection y
queda fuera de este alcance mínimo.

## Uso en un pipeline

```yaml
steps:
  - task: linceo-scan@0
    inputs:
      category: secrets
  - task: linceo-scan@0
    inputs:
      category: sca
  - task: linceo-scan@0
    inputs:
      category: iac
```

Sin ninguna variable de entorno declarada a mano.
