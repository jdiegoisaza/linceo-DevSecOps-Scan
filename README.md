# linceo-azure-extension

Extensión de Azure DevOps que ejecuta [linceo](https://github.com/jdiegoisaza/linceo) como
tarea nativa de pipeline, con dos tareas:

- **`linceo-scan`** — ejecuta un escaneo. Dos modos (`executionMode`): `container` (`docker run`
  contra `ghcr.io/jdiegoisaza/linceo`, monta el workspace y propaga las variables de entorno que
  linceo necesita) o `pypi` (invoca el `linceo` instalado en el PATH del agente directamente, sin
  Docker). El código de salida de linceo determina el resultado de la tarea en los dos modos.
- **`linceo-install`** — prepara un agente Linux para el modo `pypi`: instala gitleaks/trivy/
  checkov (según las categorías elegidas) y `uv` (siempre) sin Docker, verificados contra un
  checksum publicado, cacheados entre jobs del mismo agente. `linceo-scan` en modo `pypi` depende
  de que esta tarea haya corrido en el mismo job. Ver
  `docs/adr/ADR-000-arquitectura-y-alcance-v0.1.md` §12 para el diseño completo.

No existe `executionMode: auto` — es una decisión deliberada, no una omisión (ADR §4.2/§12.5).

Fuera de alcance, deliberadamente: service connection propia, y el preflight de rango de versión
del CLI de linceo contra la matriz de compatibilidad de esta extensión (`supported-linceo.json`,
§7 del ADR) — ambos diseñados pero no implementados todavía.

## Estructura

```
tasks/linceo-scan/                tarea Node/TypeScript — ejecuta el escaneo (container o pypi)
tasks/linceo-scan/linceo-pins.json   mínimo de Python que linceo declara, copiado de su pyproject.toml
tasks/linceo-install/             tarea Node/TypeScript — prepara gitleaks/trivy/checkov/uv sin Docker
tasks/linceo-install/tool-pins.json  versiones y checksums de gitleaks/trivy/checkov/uv, copiados del Dockerfile de linceo y de los releases de uv
scripts/                          build.js / install.js / package.js, heredados de la plantilla
scripts/check-linceo-pins-drift.js   compara los dos ficheros de pins de arriba contra el release público de linceo
pipelines/check-linceo-pins.yml   steps template de esa comprobación
azure-pipelines-linceo-pins-check.yml  pipeline programado independiente — ver más abajo
static/logo.png                   ícono de la extensión (placeholder — reemplazar antes de publicar)
vss-extension.json                 manifiesto de la extensión
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
- **`static/logo.png`**, **`tasks/linceo-scan/icon.png`** y **`tasks/linceo-install/icon.png`**
  son los íconos genéricos de la plantilla — reemplazarlos antes de publicar.

## Inputs de `linceo-scan`

| Input | Tipo | Default | Se traduce a |
|---|---|---|---|
| `category` | pickList (`secrets`\|`sca`\|`iac`) | `secrets` | `scan <category>` |
| `executionMode` | pickList (`container`\|`pypi`) | `container` | cómo se invoca linceo — ver abajo |
| `path` | string | vacío (workspace completo) | `--path` |
| `configPath` | string | vacío (rutas convenidas) | `--config` |
| `imageTag` | string (sólo `container`) | `0.9.1` | tag de `ghcr.io/jdiegoisaza/linceo` |
| `linceoVersion` | string (sólo `pypi`) | `0.9.1` | versión exacta instalada vía pip si no hay `linceo` ya en el PATH |
| `onGateFailure` | pickList (`fail`\|`warn`) | `fail` | resultado de la tarea cuando linceo sale con código 1 |
| `failOn` | pickList (vacío\|`critical`\|`high`\|`medium`\|`low`\|`none`) | vacío | `--fail-on` |
| `useSystemAccessToken` | boolean | `false` | reenvía `System.AccessToken` como `SYSTEM_ACCESSTOKEN` |
| `extraArgs` | string | vacío | argumentos crudos reenviados al final de la invocación |

Notas importantes, no obvias desde los nombres:

- **No existe `executionMode: auto`.** Los dos modos pueden dar veredictos distintos sobre el
  mismo repositorio (versiones de herramienta distintas); degradar de uno a otro en silencio
  cambiaría el resultado del escaneo sin que cambiara la configuración del pipeline. Si el modo
  elegido no está disponible (Docker ausente en `container`, o `linceo doctor` reporta algo roto
  o fuera de rango en `pypi`), la tarea falla con un mensaje accionable — nunca prueba el otro
  modo por su cuenta.
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

## Modo `pypi`: `linceo-install` + `linceo-scan`

`linceo-scan` en modo `pypi` **no instala gitleaks, trivy, checkov ni uv** — asume que ya están en
el PATH del agente. `linceo-install` es quien los prepara, sin Docker:

| Input de `linceo-install` | Tipo | Default | Qué hace |
|---|---|---|---|
| `categories` | multiSelect (`secrets`\|`sca`\|`iac`) | las tres | instala gitleaks/trivy/checkov según la categoría |
| `gitleaksVersion` / `gitleaksSha256Amd64` / `gitleaksSha256Arm64` | string | vacío (usa el pin) | override de versión — exige los dos checksums |
| `trivyVersion` / `trivySha256Amd64` / `trivySha256Arm64` | string | vacío (usa el pin) | override de versión — exige los dos checksums |
| `checkovVersion` | string | vacío (usa el pin) | override de versión (sin checksum: pip ya verifica contra PyPI) |
| `uvVersion` / `uvSha256Amd64` / `uvSha256Arm64` | string | vacío (usa el pin) | override de versión — exige los dos checksums |

Puntos no obvios:

- **`uv` se instala siempre, sin importar `categories`.** A diferencia de gitleaks/trivy/checkov
  (atados a una categoría de escaneo), `linceo-scan` en modo `pypi` necesita `uv` para instalar
  linceo mismo sin importar qué categoría se escanee después — es la primera herramienta de esta
  tarea que no depende de `categories`.
- **Único modo de instalación, sin input para elegir otro — incluido `uv`.** `linceo-install`
  nunca sobrescribe ni desinstala lo que ya haya en el PATH del agente — instala su propia copia
  versionada y la antepone al PATH, de forma que gana por resolución sin pisar nada ajeno. Si un
  agente ya está curado con las herramientas que necesitas y no quieres que esta tarea descargue
  nada, la respuesta es no añadirla al pipeline — eso ya es una señal explícita.
  `linceo doctor` (corrido por `linceo-scan` en modo `pypi`) es quien valida versiones de
  gitleaks/trivy/checkov contra el rango soportado, no esta tarea.
- **Las versiones y checksums se copian literalmente del Dockerfile de linceo** (y, para `uv`, de
  los `.sha256` que su propio release publica) —nunca se calculan sobre lo descargado. Ver
  `tasks/linceo-install/tool-pins.json` y ADR §12.2/§12.9.2.
- **`linceo-install` y `linceo-scan` deben vivir en el mismo job.** El PATH que antepone
  `linceo-install`, la variable `TRIVY_CACHE_DIR` para la base de datos de vulnerabilidades de
  trivy, y `UV_PYTHON_INSTALL_DIR`/`UV_CACHE_DIR` para lo que `uv` pueda necesitar descargar
  después, sólo se propagan a pasos posteriores del mismo job.
- **`sca` también pre-descarga la base de datos de vulnerabilidades de trivy** la primera vez
  (`trivy fs --download-db-only`) — sin ella, `linceo scan sca` fallaría en modo `pypi` aunque el
  binario de trivy esté presente. Se cachea igual que los binarios.
- **Caché entre jobs:** `linceo-install` usa `Agent.ToolsDirectory`. En agentes self-hosted
  persistentes sobrevive entre jobs y corridas; en agentes Microsoft-hosted (VM efímera por job)
  no hay caché posible por ningún medio basado en disco, y la tarea simplemente reinstala cada
  vez — mismo costo que no tener la tarea, no una regresión.

### Por qué `uv` y no Python directamente

**El modo `pypi` exige `uv` en el PATH del agente (vía `linceo-install`) — es un requisito, no un
pendiente. Python en sí ya no hace falta que esté preinstalado.** `linceo-scan` usa `uv venv`
(nunca `python -m venv`) para crear el entorno de linceo: `uv` no necesita `ensurepip` para
instalar paquetes, y si no encuentra en el PATH un Python que cumpla el mínimo que linceo declara
(`tasks/linceo-scan/linceo-pins.json`, copiado de su `pyproject.toml`), descarga uno autocontenido
él mismo. Esto reemplaza un diseño anterior de esta misma tarea que sí exigía Python 3.11+
preinstalado y buscaba un intérprete compatible a mano — abandonado porque seguía tropezando con
que Debian/Ubuntu empaquetan `ensurepip` aparte del intérprete (paquete `python3.X-venv`); `uv` no
tiene ese problema en absoluto. Ver ADR §12.9 para el detalle y la verificación.

Si `uv` no está en el PATH, la tarea falla con un mensaje accionable — no cae de vuelta al
mecanismo basado en `python -m venv` que tenía este problema.

```yaml
steps:
  - task: linceo-install@0
    inputs:
      categories: 'secrets,sca'

  - task: linceo-scan@0
    inputs:
      category: secrets
      executionMode: pypi

  - task: linceo-scan@0
    inputs:
      category: sca
      executionMode: pypi
```

## Comprobación de deriva de los pins de linceo

`tasks/linceo-install/tool-pins.json` (versiones/checksums de gitleaks, trivy, checkov y la
versión de uv) y `tasks/linceo-scan/linceo-pins.json` (mínimo de Python) son copias manuales de
valores de linceo — pueden quedar desactualizados sin que nada lo note.
`azure-pipelines-linceo-pins-check.yml` es un pipeline **separado** del de build/publish,
programado a diario, que resuelve el tag más reciente de `github.com/jdiegoisaza/linceo`,
descarga su `Dockerfile` y su `pyproject.toml`, y compara ambos contra los dos ficheros de pins —
**falla** (no avisa) si algo difiere (ADR §12.7/§12.8/§12.9.2). El checksum de `uv` no vive en el
Dockerfile de linceo (se instala ahí vía pip, no por binario verificado), así que esta
comprobación programada sólo vigila su versión — su checksum lo sigue verificando, con la misma
fuerza que el resto, cada corrida real de `linceo-install`.

Para activarlo: en Azure DevOps, *Pipelines → New pipeline → Existing Azure Pipelines YAML file*,
apuntando a `azure-pipelines-linceo-pins-check.yml` de este repositorio. No corre solo por existir
el fichero — como cualquier otro pipeline de este proyecto, hay que registrarlo una vez.

## Variables de entorno propagadas al contenedor

Esta sección describe el modo `container`. En modo `pypi` no hace falta nada de esto: el proceso
de linceo hereda el entorno completo de la tarea directamente (ADR §4.6) — es, literalmente, la
asimetría que esta extensión existe para resolver.

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
