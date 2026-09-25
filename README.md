# linceo-azure-extension

Extensión de Azure DevOps que ejecuta [linceo](https://github.com/jdiegoisaza/linceo) como
tarea nativa de pipeline: una sola tarea, `linceo-scan`. La tarea ejecuta `docker run` contra
`ghcr.io/jdiegoisaza/linceo`, monta el workspace del build y propaga las variables de entorno
que linceo necesita para resolver el contexto (y, opcionalmente, la política remota). El código
de salida de linceo determina el resultado de la tarea.

Fuera de alcance, deliberadamente: service connection, publicación de artefactos, modo PyPI y
verificación de rango de versión. Están diseñados en
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
(vía `npx`, o instalado globalmente con `npm install -g tfx-cli`).

```bash
npm install          # instala dependencias raíz + de cada tarea (postinstall)
npm run package        # empaqueta a dist/ — encadena su propio build vía el hook prepackage
npm run create         # tfx extension create --output-path dist → genera el .vsix
```

`npm run create` ya no usa `--rev-version`: publica la versión que esté comiteada en
`vss-extension.json` en ese momento. Edítala a mano antes de correrlo si quieres publicar una
versión distinta. Ver `docs/PUBLISHING.md` para el pipeline que hace esto automáticamente en
cada tag.

## Antes de publicar

- **`publisher`** en `vss-extension.json` debe ser el ID de publisher real de Marketplace.
- **`static/logo.png`** y **`tasks/linceo-scan/icon.png`** son los íconos genéricos de la
  plantilla — reemplazarlos antes de publicar.

## Inputs de la tarea

| Input | Tipo | Default | Se traduce a |
|---|---|---|---|
| `category` | pickList (`secrets`\|`sca`\|`iac`) | `secrets` | `scan <category>` |
| `path` | filePath | vacío (workspace completo) | `--path /workspace[/<path>]` |
| `configPath` | filePath | vacío (rutas convenidas) | `--config /workspace/<configPath>` |
| `imageTag` | string | `0.9.1` | tag de `ghcr.io/jdiegoisaza/linceo` |
| `onGateFailure` | pickList (`fail`\|`warn`) | `fail` | resultado de la tarea cuando linceo sale con código 1 |
| `failOn` | pickList (vacío\|`critical`\|`high`\|`medium`\|`low`\|`none`) | vacío | `--fail-on` |
| `useSystemAccessToken` | boolean | `false` | reenvía `System.AccessToken` como `SYSTEM_ACCESSTOKEN` |

Notas importantes, no obvias desde los nombres:

- **`onGateFailure` sólo gobierna el código de salida 1** (el gate falló). Los códigos 2 (error
  de configuración) y 3 (herramienta rota o evidencia incompleta) siempre fallan la tarea, sin
  excepción — un pipeline verde que no escaneó nada es peor que uno rojo.
- **`failOn` reemplaza el bloque `[thresholds]` de `.devsecops/config.toml` por completo**, no
  se combina con él — así lo define linceo. La tarea emite un warning en el log cada vez que
  este input está activo, incluido el valor `none` (que fuerza apagar el gate aunque el
  repositorio tenga umbrales configurados).
- **`useSystemAccessToken` no requiere nada en el YAML del pipeline.** El token se obtiene
  automáticamente del endpoint `SYSTEMVSSCONNECTION` del agente, no de una variable
  `System.AccessToken` que el usuario tenga que mapear. Sólo sirve si el repositorio escaneado
  declara `[remote_policy]`; por defecto está apagado, por mínimo privilegio (no por fricción de
  configuración, que ya no existe).

## Variables de entorno propagadas al contenedor

**Contexto** (siempre) — exactamente las que `src/linceo/providers/azure_devops.py::ENV_VARS`
del propio linceo declara, más `TF_BUILD` como centinela de `--platform auto`:

`TF_BUILD`, `BUILD_REPOSITORY_NAME`, `BUILD_SOURCEVERSION`, `BUILD_SOURCEBRANCH`,
`SYSTEM_PULLREQUEST_SOURCEBRANCH`, `SYSTEM_PULLREQUEST_PULLREQUESTID`,
`SYSTEM_PULLREQUEST_PULLREQUESTNUMBER`, `BUILD_BUILDID`, `BUILD_REPOSITORY_URI`.

**Política remota** (`PolicySource`, distinto del proveedor de contexto):

- `SYSTEM_COLLECTIONURI`, `SYSTEM_TEAMPROJECT` — siempre. No son secretos; un repositorio sin
  `[remote_policy]` simplemente no los lee.
- `SYSTEM_ACCESSTOKEN` — sólo si `useSystemAccessToken: true`. Es la identidad OAuth del propio
  build, con alcance de sólo este job.

## Uso en un pipeline

```yaml
steps:
  - task: linceo-scan@0
    inputs:
      category: secrets

  - task: linceo-scan@0
    inputs:
      category: sca
      path: backend
      failOn: high

  - task: linceo-scan@0
    inputs:
      category: iac
      onGateFailure: warn
      useSystemAccessToken: true
```

Sin ninguna variable de entorno declarada a mano.
