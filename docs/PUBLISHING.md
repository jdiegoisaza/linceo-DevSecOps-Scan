# Publicación automática

Un solo pipeline (`azure-pipelines.yml`), dos etapas:

1. **`build`** — corre en *cada* push a `main` y en *cada* push de un tag `vX.Y.Z`.
   Compila, empaqueta, deriva la versión (si el trigger fue un tag) y valida que el
   `.vsix` resultante esté completo. Nunca publica nada.
2. **`publish`** — corre sólo cuando `build` pasó **y** el trigger fue un tag
   (`condition: startsWith(variables['Build.SourceBranch'], 'refs/tags/')`). Descarga
   el `.vsix` que `build` ya validó — nunca reconstruye — y lo sube al Marketplace.

Mismo patrón que `.github/workflows/ci.yml` + `release.yml` en linceo (build/test en
cada push, publicar sólo en un tag), expresado como un único pipeline de Azure con una
etapa condicionada en vez de dos workflows separados.

## Cómo se corta un release

```bash
git tag v0.3.0
git push origin v0.3.0
```

La etapa `build` deriva `0.3.0` de ese tag y lo escribe en `vss-extension.json` antes
de empaquetar — es la **única** fuente de la versión publicada; no hay
`--rev-version` en ningún paso. Un push a `main` sin tag no toca `vss-extension.json`
en absoluto: el `.vsix` que produce ese build es sólo para validar que el empaquetado
sigue funcionando, y la etapa `publish` ni siquiera corre para ese trigger.

**Publicación manual** (`npm run create`, la forma de hoy) sigue funcionando igual,
pero desde ahora usa la versión que esté comiteada en `vss-extension.json` en ese
momento — si quieres publicar una versión distinta a mano, edita ese campo antes de
correrlo. Es deliberado: la misma regla ("una fuente de verdad, nunca autoincrementar")
aplica corra el pipeline o corras el comando tú mismo.

## Qué valida antes de publicar, y qué no

Dos chequeos independientes sobre el `.vsix` ya generado, antes de publicarlo como
artefacto de build (con lo que un `.vsix` roto nunca llega siquiera a la etapa
`publish`):

1. **Tamaño mínimo** (200 KB) — el bug real que motivó esto producía un `.vsix` de
   ~7 KB en vez de ~860 KB.
2. **Contenido exacto** — que el `.vsix` contenga
   `tasks/linceo-scan/dist/node_modules/azure-pipelines-task-lib/package.json`, entre
   otros. Probado a mano que el chequeo de tamaño solo no basta: un `.vsix` de 260 KB
   con `dist/` sin `node_modules` pero relleno de basura para superar el mínimo pasa
   el (1) y falla el (2).

Lo que esto **no** valida: que la extensión funcione de verdad en un agente real, ni
que `task.json` sea semánticamente correcto (más allá de que exista). Es una
verificación de integridad de empaquetado, no una prueba end-to-end.

## Prerrequisitos (los configuras tú)

### 1. Conectar el pipeline al repositorio de GitHub

Uno de los dos, según cómo crees el pipeline en Azure DevOps:

- **Recomendado**: Pipelines → New pipeline → GitHub → autorizar la GitHub App
  "Azure Pipelines" sobre `jdiegoisaza/linceo-DevSecOps-Scan`. No requiere crear nada
  a mano; Azure DevOps registra la conexión al autorizar.
- Alternativa: una service connection tipo **GitHub** clásica (OAuth o PAT), creada
  en Project Settings → Service connections, si prefieres no usar la GitHub App.

Sin esto, Azure DevOps no puede ver el repositorio en absoluto — es lo primero que
hace falta, antes que cualquier otra cosa de este documento.

### 2. Instalar "Azure DevOps Extension Tasks" en la organización

Las tareas `TfxInstaller@3` y `PublishAzureDevOpsExtension@5` que usa
`pipelines/publish.yaml` no son nativas de Azure DevOps — vienen de la extensión de
Marketplace **"Azure DevOps Extension Tasks"** (publisher `ms-devlabs`). Se instala
una sola vez, a nivel de organización:

[marketplace.visualstudio.com/items?itemName=ms-devlabs.vsts-developer-tools-build-tasks](https://marketplace.visualstudio.com/items?itemName=ms-devlabs.vsts-developer-tools-build-tasks)
→ "Get it free" → elegir la organización → instalar.

Sin esto, el pipeline falla en la etapa `publish` con "no se reconoce la tarea
TfxInstaller/PublishAzureDevOpsExtension", no con un error de permisos — si ves ese
mensaje, es este paso el que falta.

### 3. Crear la service connection del Marketplace

Tipo **Visual Studio Marketplace** (nativo de Azure DevOps, no requiere instalar nada
adicional — distinto del punto 2, que sí lo requiere).

**Credencial — Personal Access Token de Marketplace:**

1. [marketplace.visualstudio.com/manage/publishers/juandiego-13](https://marketplace.visualstudio.com/manage/publishers/juandiego-13)
   → confirmar que estás en el publisher correcto.
2. En [dev.azure.com](https://dev.azure.com), User settings → Personal access tokens →
   New Token.
3. Organización: **All accessible organizations** (el PAT de Marketplace no se limita
   a una organización — el scope que importa es el siguiente punto, no éste).
4. Scopes → Marketplace → **Publish** únicamente. No `Manage` (permite despublicar y
   cambiar el listado, más de lo que este pipeline necesita) ni `Acquire`.
5. Expiración: la que prefieras, pero anótala en algún sitio que revises — cuando
   caduque, la etapa `publish` empieza a fallar con 401/403 y el pipeline no puede
   avisarte de otra forma que fallando ese día.

**Crear la connection:**

1. Azure DevOps → Project Settings → Service connections → New service connection.
2. Buscar "**Visual Studio Marketplace**".
3. Pegar el PAT del paso anterior.
4. Nombre: `marketplace-service-connection` (exacto — es el valor de
   `Extension.ServiceConnection` en `pipelines/vars.yml`; si usas otro nombre, cambia
   sólo ese valor, no hace falta tocar ningún `.yml` de pipeline).
5. Marcar "Grant access permission to all pipelines" (o autorizar el pipeline
   específico después, desde la connection).

## Cosas que se dejaron fuera, a propósito

- **`IsAzureDevOpsExtensionValid@5`** (confirmación post-publicación contra el
  Marketplace): no se incluyó. El schema exacto de sus inputs no se pudo verificar
  contra una organización real en este momento, y añadir un paso después de una
  publicación exitosa que pudiera fallar por un input mal escrito es peor que no
  tenerlo. Es un candidato razonable para agregar después, una vez confirmado el
  schema contra la versión instalada de la extensión.
- **Aprobación manual antes de publicar**: el pipeline de la plantilla original tenía
  un `ManualValidation@0`. No se pidió y no se añadió — si se quiere, es un
  *Environment* con un check de aprobación en Azure DevOps (Pipelines → Environments),
  no una etapa de pipeline.
- **Split dev/pdn con nombres de extensión side-by-side** (`#{extension.tag}#`,
  `deploy.yml`, `validation.yaml` de la plantilla original): no aplica — un solo
  target de publicación (Marketplace, público bajo `juandiego-13`), no dos entornos
  instalados en paralelo.

## Advertencia cosmética conocida

`tfx extension create` imprime un warning:

```
warning: linceo-scan: execution.Node20_1.target references file that does not exist: index.js
```

Es un falso positivo — compara contra `tasks/linceo-scan/` (la carpeta fuente, donde
en efecto no hay `index.js`, sólo `src/index.ts`) en vez de
`tasks/linceo-scan/dist/` (la carpeta empaquetada, donde sí está). El `.vsix` se
genera correctamente pese al warning; verificado con `unzip -l` contra un `.vsix` real
de este proyecto. No bloquea el pipeline.
