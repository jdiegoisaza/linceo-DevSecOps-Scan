# ADR-000 — Arquitectura y alcance v0.1 de la extensión linceo para Azure DevOps

**Estado:** Propuesto
**Fecha:** 2026-09-24
**Decide:** mantenedor único
**Depende de:** ADR-000 de linceo (`docs/adr/ADR-000-arquitectura-base-y-alcance-v0.1.md`), en
particular R2 (offline-first), R3 (determinismo), R4 (el contenedor es la unidad de
compatibilidad) y §8 (el CLI es el producto).

---

## §0 Contexto y problema

linceo se usa hoy en Azure DevOps como un paso `script:` que invoca `docker run` y reenvía a
mano una allowlist de variables de entorno de la plataforma. El usuario escribe infraestructura
de invocación —montajes, `-e`, tag de imagen, traducción del código de salida— que no es una
decisión suya: es una consecuencia mecánica de la plataforma en la que corre. Esa fricción es
el único problema que esta extensión existe para resolver.

De ahí el principio rector del que se derivan casi todas las decisiones siguientes:

> **La tarea es un adaptador de invocación. No es un segundo lugar donde vive la política.**

Todo lo que la tarea hace debe ser o bien un reenvío 1:1 de un flag documentado del CLI, o bien
una decisión que sólo la plataforma puede tomar (montar el workspace, propagar el allowlist,
publicar artefactos, traducir un código de salida a un resultado de build). Cualquier input que
introduzca semántica nueva es, por construcción, un defecto de diseño. §9 explica por qué esta
regla es una condición de supervivencia y no una preferencia estética.

### §0.1 Supuestos declarados

| # | Supuesto | Si resulta falso |
|---|---|---|
| S1 | La extensión vive en un repositorio nuevo creado desde `ExtensionsTemplate_DevOps`, no como fork ni submódulo de linceo. | Cambia el layout, no las decisiones. |
| S2 | `pip install linceo` instala el orquestador pero **no** Gitleaks, Trivy ni Checkov; la imagen sí los trae con versiones fijadas. | §4 se simplifica: los dos modos serían equivalentes y el default sería discutible. |
| S3 | Gitleaks, Trivy y Checkov **no** vienen preinstalados en los agentes hospedados de Microsoft. | Igual que S2. |
| S4 | linceo v0.1 acepta **una categoría por invocación** (`scan secrets sca` está diferido en su ADR). | §2 pasaría a considerar un input multi-selección real. |
| S5 | La versión publicada de referencia es la que etiqueta la imagen (`0.2.0`), aunque el README aún anuncie `0.1.0.dev0`. | Cambia el número del pin de §7, no el mecanismo. |
| S6 | **Resuelto (Enmienda 2026-09-24, §12):** `--format json` y `--format sarif` escriben el reporte completo a stdout; no existe `--output-dir` ni ningún flag que escriba a fichero. | La ruta y el nombre de cada artefacto los decide la tarea por completo (§1). |

---

## §1 Alcance de la v0.1

### Decisión

La v0.1 entrega **una extensión con una tarea de pipeline que ejecuta una categoría de escaneo
de linceo en agentes Linux, aplica el gate y publica la evidencia**. Nada más.

Concretamente, entra:

1. Una tarea (`linceoScan`) con la categoría como input (§2).
2. Dos modos de ejecución declarados por el usuario: contenedor y paquete de PyPI (§4).
3. Propagación automática del allowlist de variables de contexto de Azure DevOps que linceo
   declara. Este punto es el producto: es lo que el usuario deja de escribir.
4. Publicación de los reportes JSON y SARIF como artefacto de pipeline.
5. Traducción de los códigos de salida a resultado de tarea, con un input que decide si el
   gate bloquea o avisa (§5).
6. Preflight de compatibilidad de versión contra el rango soportado (§7).
7. Publicación privada al Marketplace, compartida con organizaciones concretas, usando los
   pipelines de la plantilla.

### Captura y nombrado de reportes

El CLI no escribe reportes a fichero: `--format json` y `--format sarif` escriben el reporte
completo a **stdout**, y no existe ningún `--output-dir` ni flag equivalente (confirmado
ejecutando el binario; Enmienda 2026-09-24, §12). La consecuencia es estructural, no de
detalle: **la ruta de cada artefacto la decide la tarea por completo**, porque no hay ningún
fichero en disco que "recoger" — sólo un stream que capturar y volcar ella misma.

**Decisión — ruta local, por categoría:**

```
$(Agent.TempDirectory)/linceo/<category>/report.json
$(Agent.TempDirectory)/linceo/<category>/report.sarif
```

`<category>` es uno de `secrets | sca | iac` (§2, enum cerrado). Como cada paso de la tarea
ejecuta exactamente una categoría, y cada categoría escribe en su propio subdirectorio, dos
pasos de la misma tarea **no pueden colisionar** aunque compartan job y `Agent.TempDirectory`.
El "esquema de nombrado" que el resto del documento da por sentado es este: no hace falta que
sea configurable porque la partición ya la da el enum de §2.

**Decisión — nombre del artefacto publicado:** `linceo-<category>` (p. ej. `linceo-secrets`),
uno por paso. Igual que la ruta local, es la categoría la que garantiza unicidad, aquí dentro de
la corrida completa del pipeline (Azure DevOps exige nombres de artefacto únicos por ejecución,
no sólo por job).

**Límite aceptado, no resuelto en v0.1:** si el mismo pipeline ejecuta la **misma** categoría
más de una vez (p. ej. `sca` sobre dos rutas de un monorepo en dos pasos distintos), el segundo
`linceo-sca` colisiona con el primero. No se resuelve en v0.1 —el caso mayoritario es una
categoría por pipeline— y queda documentado como limitación conocida en el README en vez de
resolverse con un input que la mayoría no necesitaría.

**Decisión — una invocación del CLI por formato solicitado:** dado que `--format` selecciona un
único formato de salida por ejecución, ninguna invocación produce JSON y SARIF a la vez. Con
`reportFormats` no vacío (§8) la tarea invoca el CLI hasta tres veces por categoría: una en
formato consola —la que decide el veredicto y puebla el log humano, §5— y una por cada formato
de reporte a publicar. Esto es aceptable porque linceo garantiza determinismo byte-a-byte entre
corridas con la misma entrada (R3 de su propio ADR): las invocaciones adicionales no vuelven a
decidir nada, sólo repiten el mismo veredicto en otro formato. Por disciplina, la tarea compara
el código de salida de cada invocación adicional contra el de la invocación primaria y falla con
una causa distinta (`LINCEO_NONDETERMINISTIC_OUTPUT`) si difieren —no porque se espere que
ocurra, sino porque si ocurriera sería exactamente el escenario que un gate de seguridad no
puede permitirse silenciar: un artefacto que no concuerda con el veredicto que el pipeline
mostró.

**Coste aceptado:** triplicar la invocación implica triplicar el tiempo de la categoría más
lenta (Trivy/Checkov). Se acepta por el mismo motivo que el peso de la imagen en §4.4: es un
problema de rendimiento con mitigación disponible al usuario (reducir `reportFormats` a uno
solo, o vacío), no un problema de corrección.

**Propuesta para linceo (no bloquea la v0.1):** un flag `--output-dir` que escriba los formatos
solicitados a disco en una sola invocación eliminaría las tres invocaciones y el chequeo de
consistencia por completo. Es la misma clase de mejora que la propuesta de `cli_contract` en
§7.6: pequeña en linceo, elimina una clase entera de complejidad en la extensión.

### Criterio de aceptación

El YAML mínimo para un escaneo completo es tres pasos de la misma tarea, con un input cada uno,
y **cero variables de entorno declaradas a mano**. Si al terminar la v0.1 el usuario sigue
necesitando un bloque `env:`, la v0.1 no cumplió su objetivo aunque todo lo demás funcione.

### No-objetivos explícitos

| No-objetivo | Motivo |
|---|---|
| Agentes Windows y macOS | El modo contenedor es Linux-only y en Windows habría que resolver los tres binarios de herramientas. Se declara fuera de alcance en lugar de soportarse a medias. |
| Comentarios en pull request | Requiere token con permisos de escritura, idempotencia entre corridas y una política de ruido. Es una funcionalidad con su propio ciclo de vida, no un detalle de la tarea. |
| Pestaña de resultados o resumen markdown en el build | Superficie de UI que hay que versionar y mantener; el log y el artefacto cubren el caso en v0.1. |
| Service connection propia | §6. |
| Auto-instalar Gitleaks, Trivy o Checkov | Heredado de linceo (R2/R4): la imagen es la unidad de compatibilidad. Instalar binarios en tiempo de ejecución produciría escaneos cuyo resultado depende del agente. |
| Gestionar baselines (`baseline init` / `migrate`) desde la tarea | Un input que genera supresiones desde CI es un botón para dejar el gate en verde sin mirar. El baseline se crea localmente, con revisión, y se commitea. |
| Exponer exclusiones, overrides de severidad o herramientas omitidas como inputs | Son elementos de política; viven en `.devsecops/config.toml`. Ver §0 y §9/R3. |
| Multi-categoría en una sola invocación | El CLI no lo soporta (S4). Cuando lo soporte, es un input nuevo, no una tarea nueva. |
| Cachear o replicar la imagen, autenticar contra registries privados | La tarea acepta un `image` alternativo; el `docker login` lo hace el usuario con la tarea nativa. |
| Telemetría de uso | Heredado de linceo: no hay capacidad, no hay decisión que tomar. |
| Pipeline decorators, políticas de rama automáticas, tareas de release | Cada uno es una contribución con su propio id inmutable. §2 explica por qué eso importa. |

---

## §2 Una tarea con la categoría como input, o una tarea por categoría

### Decisión: **una sola tarea, con `category` como input de lista (`secrets` | `sca` | `iac`), una categoría por instancia de la tarea.**

### Argumento

El argumento decisivo no es de ergonomía, es de **reversibilidad**. En Azure DevOps el `id` de
una tarea es un GUID inmutable y público: una vez que alguien tiene un pipeline apuntando a él,
no se puede retirar sin romperlo, y el nombre queda reservado en el publisher para siempre.
Las dos direcciones no cuestan lo mismo:

- Empezar con **una** y dividir después: se publican tareas nuevas, la existente sigue siendo
  válida. Coste bajo, sin rupturas.
- Empezar con **tres** y unificar después: hay que deprecar dos ids que seguirán existiendo y
  recibiendo soporte indefinidamente. Coste permanente.

Cuando una decisión es simétrica en beneficio y asimétrica en coste de deshacerla, se elige la
reversible. Y aquí es que además ni siquiera es simétrica en beneficio:

- **No hay ganancia funcional.** El CLI acepta una categoría por invocación (S4), así que tres
  tareas harían exactamente lo mismo que un desplegable con tres valores.
- **No hay ganancia de UX.** El asistente de tareas del editor de pipelines muestra un
  `pickList` con tres opciones; tres entradas separadas en el catálogo no son más descubribles.
- **Sí hay coste de mantenimiento, y es multiplicativo.** Tres `task.json`, tres versiones
  major que versionar por separado, tres changelogs, tres matrices de compatibilidad con
  linceo (§7), tres superficies de test. Para un mantenedor único con tiempo limitado, el coste
  no está en escribir tres ficheros: está en que cada cambio del contrato del CLI se aplica
  tres veces y hay tres oportunidades de que una se quede atrás.
- **El evento de major bump se triplica.** Subir el major de una tarea obliga a los usuarios a
  re-seleccionar la versión en sus pipelines. Multiplicar por tres los momentos en que le pides
  eso a tus usuarios es una forma barata de agotar su paciencia.

### Alternativas descartadas

| Alternativa | Motivo del descarte |
|---|---|
| Una tarea por categoría (`linceoSecrets`, `linceoSca`, `linceoIac`) | Triplica superficie de versionado y compromete tres ids inmutables sin ganar nada funcional ni de descubribilidad. Es la dirección irreversible de una decisión que tiene una dirección reversible. |
| Una tarea con multi-selección de categorías que itera invocaciones internamente | Obliga a la tarea a agregar varios veredictos en uno, y linceo define explícitamente "un veredicto, un código de salida". La tarea tendría que inventar la regla de agregación —qué pasa si secrets sale 1 e iac sale 3— y eso es exactamente convertirse en un segundo motor de política (§0). Se difiere hasta que el CLI agregue veredictos él mismo. |
| Una tarea genérica tipo "linceo run" con los argumentos crudos como único input | Es el `script:` actual con otro nombre. No elimina ninguna fricción. |

### Consecuencia operativa que hay que documentar

El pipeline típico son tres pasos de la misma tarea. Si están **en el mismo job**, comparten el
pull de la imagen (§4 la tasa en ~2.37 GB). Si el usuario los reparte en jobs distintos, paga
el pull tres veces. Esto se documenta en el README con un ejemplo del layout recomendado; la
extensión no lo fuerza.

---

## §3 Node o Python para la tarea

### Decisión: **Node (TypeScript) con `azure-pipelines-task-lib`.**

### Argumento

Escribir la tarea en Python crearía una paradoja: **la tarea dependería de exactamente aquello
que existe para encapsular.** En modo contenedor, el único requisito que la extensión debe
imponer al agente es Docker —el agente no necesita Python en absoluto—. Una tarea con handler
Python exigiría un intérprete presente y resuelto sólo para poder *arrancar* el proceso que
lanza el contenedor. El requisito de Python pertenece al **modo** `pypi`, no a la tarea; un
lanzador en Node mantiene esa frontera limpia.

Además:

- El agente de Azure Pipelines **trae su propio Node** y garantiza el handler (`Node16`/`Node20`).
  Python en un agente self-hosted es lo que el cliente haya instalado, con la versión que sea, y
  linceo exige 3.11+.
- `azure-pipelines-task-lib` es la librería de primera clase para lo que esta tarea hace:
  `tl.getInput`, `tl.setResult`, `tl.setSecret`, el runner de procesos, los comandos `##vso`.
  Su equivalente en Python no tiene paridad ni mantenimiento comparable.
- La plantilla ya compila TypeScript con `scripts/build.js`.

### Alternativas descartadas

| Alternativa | Motivo del descarte |
|---|---|
| Handler Python | Añade al agente un requisito (intérprete 3.11+) que el modo contenedor no necesita, y su task-lib carece de paridad. Convierte una propiedad del modo en una propiedad de la tarea. |
| Script / PowerShell handler | Es el `script:` con `docker run` que la extensión viene a eliminar, sin tipado ni tests. |

### Consecuencia y su mitigación

El mantenedor es un desarrollador Python y acaba manteniendo TypeScript. La mitigación es de
diseño, no de disciplina: **la tarea se mantiene deliberadamente tonta**. Construye un `argv`,
ejecuta un proceso, mapea un código de salida y publica ficheros. Cero lógica de dominio. Si
alguna vez hace falta entender el modelo de hallazgos de linceo dentro del TypeScript, es señal
de que se cruzó la línea de §0. Esa misma frontera es la mitigación del riesgo R3 de §9.

---

## §4 Modos de ejecución: contenedor y paquete de PyPI

### §4.1 Los dos modos no son intercambiables

Hay que decirlo antes de decidir nada, porque condiciona todo lo demás: **PyPI no es un
fallback del contenedor.** El contenedor trae Gitleaks, Trivy y Checkov con versiones fijadas y
la base de datos de Trivy preinstalada. `pip install linceo` trae el orquestador y nada más
(S2), y linceo declara no-objetivo auto-instalar binarios de herramientas. Por tanto:

- El modo `container` funciona en cualquier agente Linux con Docker.
- El modo `pypi` funciona **sólo** en agentes donde alguien ya instaló las tres herramientas.
  En un agente hospedado sin preparar, su modo de fallo natural es el código 3.
- Los dos modos pueden producir **resultados distintos sobre el mismo repositorio**, porque las
  versiones de las herramientas difieren.

### §4.2 Decisión: el modo lo declara el usuario. **No existe `auto`.**

Input `executionMode`: `container` (por defecto) | `pypi`.

**Motivo:** un `auto` con degradación silenciosa de contenedor a PyPI produciría escaneos que
parecen equivalentes y no lo son. El mismo pipeline, sin cambiar una línea, daría veredictos
distintos según qué agente lo recogiera. Eso contradice R3 de linceo (determinismo: misma
entrada, misma salida) y, peor, lo hace de forma invisible: nadie mira los logs de un paso en
verde. El modo es una propiedad de la infraestructura del usuario, y el usuario es el único que
la conoce.

### §4.3 Decisión: cuando el modo elegido no está disponible, la tarea **falla con un mensaje accionable. Nunca degrada al otro modo.**

Es el espejo exacto de la regla que linceo ya aplica consigo mismo ("si falta un binario,
error accionable; nunca auto-instala"). La tarea hace un preflight por modo:

| Modo | Preflight | Si falla |
|---|---|---|
| `container` | `docker version` responde | `Failed`. Mensaje: este agente no tiene Docker disponible; usa `executionMode: pypi` en una imagen que ya tenga Gitleaks, Trivy y Checkov instalados, o mueve el job a un agente con Docker. |
| `pypi` | Python ≥3.11 resoluble; `linceo` instalado o instalable; después `linceo doctor` | `Failed`. Mensaje con la salida de `doctor`, nombrando **qué herramienta falta exactamente** y recordando que la tarea no las instala por diseño. |

El fallo se marca con una causa propia (`LINCEO_MODE_UNAVAILABLE`) para distinguirlo en el log
de un fallo de gate.

### §4.4 Decisión: el default es `container`

**Motivo**, en orden de peso:

1. Es la unidad de compatibilidad que linceo declara (R4). Lo que se certifica y se prueba es
   la imagen.
2. En agentes Linux hospedados, Docker está siempre disponible y las tres herramientas nunca lo
   están (S3). El default correcto es el que funciona en el agente por defecto.
3. El resultado es reproducible entre agentes, que es la propiedad que un gate de seguridad
   necesita para que sus veredictos sean discutibles.

**Coste aceptado:** la imagen pesa ~2.37 GB. En un agente hospedado eso es un pull por job.
Mitigaciones que se documentan pero **no** se implementan en v0.1: agrupar las tres categorías
en un job (§2), fijar el tag exacto para aprovechar la caché de capas en self-hosted, y
replicar la imagen en un ACR propio vía el input `image`. Gestionar la caché es no-objetivo
(§1): es responsabilidad de la infraestructura del usuario, y una extensión que intente
resolverlo acaba manteniendo un gestor de imágenes.

### §4.5 Decisión: en modo `pypi`, la tarea **sí instala linceo**, en un venv efímero y con versión exacta

`python -m venv $(Agent.TempDirectory)/linceo-venv` y `pip install 'linceo[remote-config]==<pin>'`.

No contradice el no-objetivo heredado: lo que linceo prohíbe auto-instalar son los **binarios de
las herramientas**, cuya versión determina el resultado del escaneo. El orquestador es el
artefacto cuya versión la extensión ya fija explícitamente (§7). Exigirlo preinstalado
reintroduciría un paso manual previo, que es la fricción que esta extensión elimina.

Se instala **siempre con el extra `[remote-config]`**, aunque no se use política remota. Motivo:
la diferencia es un cliente HTTP, y el modo de fallo que evita —"configuré política remota y no
funciona porque falta un extra"— es caro de diagnosticar y barato de prevenir.

Si ya hay un `linceo` en el `PATH` con una versión dentro del rango soportado, se usa ese y no
se instala nada. Esto hace que el modo `pypi` sea utilizable sin red, que es su caso de uso real
en agentes curados.

### §4.6 Lo que la tarea hace en modo `container` y el usuario ya no escribe

- `--rm`, montaje de `Build.SourcesDirectory` como workspace, `-w` en él.
- `-u $(id -u):$(id -g)` para que los reportes no queden con propietario root. Es un problema
  recurrente y silencioso en agentes self-hosted persistentes.
- Un volumen separado bajo `Agent.TempDirectory` para los reportes, de modo que el escaneo no
  ensucie el árbol de fuentes.
- **Un `-e` por cada variable del allowlist de contexto de Azure DevOps que linceo declara**
  (`TF_BUILD`, `BUILD_*`, `SYSTEM_PULLREQUEST_*`), leídas del propio entorno de la tarea.
  Esta lista es parte del contrato consumido y se versiona con él (§7): si linceo añade una
  variable a su allowlist, la extensión debe propagarla o el contexto quedará incompleto.

En modo `pypi` nada de esto hace falta: el proceso hereda el entorno. Esa asimetría es,
literalmente, el problema que la extensión resuelve.

La captura de stdout por formato solicitado (§1) no está en esta lista porque no es una
propiedad del modo: aplica igual en `container` y en `pypi`, porque es una propiedad del CLI,
no de cómo se invoca el proceso.

### Alternativas descartadas en §4

| Alternativa | Motivo del descarte |
|---|---|
| `executionMode: auto` con degradación silenciosa | Cambia el resultado del escaneo sin que cambie la configuración, y de forma invisible. Rompe el determinismo de linceo. |
| `auto` que sólo elige y **avisa** | El aviso vive en un log que nadie lee cuando el paso está en verde. Un aviso no es un mecanismo de control. |
| Que la tarea instale Gitleaks/Trivy/Checkov en modo `pypi` | Contradice R2/R4 de linceo y hace que el veredicto dependa de qué versión descargó el agente ese día. |
| Default `pypi` (más ligero) | Falla en el agente por defecto de la plataforma. Un default que no funciona sin preparación previa no es un default. |
| Sólo modo contenedor en v0.1 | Deja fuera a quien ya tiene imágenes curadas y a quien no puede usar Docker en su agente, que es justo el perfil de cliente con políticas restrictivas. El coste de soportarlo es bajo porque el modo es una rama en la construcción del `argv`. |
| `--network none` por defecto (endurecimiento) | linceo es offline-first pero la política remota y la actualización de la base de datos necesitan red. Se anota como posible endurecimiento opcional futuro, no como default. |

---

## §5 Traducción de códigos de salida a resultado de tarea

### Decisión

Input `onGateFailure`: `fail` (por defecto) | `warn`. **Gobierna exclusivamente el código 1.**

| Código | Significado en linceo | `onGateFailure: fail` | `onGateFailure: warn` |
|---|---|---|---|
| 0 | Pasó, o gate no activo | `Succeeded` | `Succeeded` |
| 1 | El gate falló | `Failed` | `SucceededWithIssues` |
| 2 | Error de configuración | `Failed` | **`Failed`** |
| 3 | Herramienta rota o evidencia incompleta | `Failed` | **`Failed`** |
| Otro | Desconocido o fallo de infraestructura | `Failed` | `Failed` |

### Argumento

**Los códigos 2 y 3 no se degradan nunca a advertencia.** Es la decisión más importante de esta
sección. Un 3 significa que no hay evidencia: la herramienta no corrió o corrió a medias. Si un
3 pudiera salir en amarillo, el estado final de un proyecto sería un pipeline verde que no
escanea nada, y nadie lo notaría, porque el escenario que produce un 3 —una herramienta que
desapareció del agente— es persistente y silencioso. Es el peor modo de fallo posible en una
herramienta de seguridad: no es que falle, es que **miente**. linceo ya toma esta postura
internamente (con evidencia parcial nunca imprime `PASSED` y marca el gate como `NOT
EVALUATED`); la tarea no puede ser más laxa que el CLI que envuelve.

El 2 sigue la misma lógica por un motivo distinto: es una configuración inválida, siempre es un
error del usuario y siempre tiene arreglo inmediato. Degradarlo a advertencia sólo consigue que
se quede así durante meses.

**El default es `fail`.** El default permisivo ya existe, y vive en el sitio correcto: linceo
no activa gate si no hay `--fail-on` ni `[thresholds]`, así que sin configuración de gate el
código 1 no ocurre. Poner además un default permisivo en la tarea sería permisividad doble: un
gate configurado explícitamente que no bloquea, y un usuario que no entiende por qué.

**Los códigos desconocidos van a `Failed`.** En un gate, lo desconocido se trata como fallo. El
código crudo se registra en el log. Esto cubre además los códigos de Docker, que no colisionan
con los 0-3 de linceo pero significan otra cosa:

| Código | Origen | Mensaje |
|---|---|---|
| 125 | Fallo del propio `docker run` | Problema de invocación del contenedor, no de linceo. |
| 126 / 127 | Entrypoint no ejecutable o no encontrado | Imagen inesperada; suele indicar un `image` mal apuntado. |
| 137 | Proceso terminado por OOM | Realista con Trivy en agentes hospedados; el mensaje debe sugerir un agente con más memoria en vez de dejar al usuario buscando un bug inexistente. |

### Interacción con el resto del pipeline

- La publicación de artefactos ocurre **antes** de traducir el código de salida, incluidos el 1
  y el 3 parcial. La evidencia es más útil justo cuando el paso falla.
- En `warn` se emite `##vso[task.logissue type=warning]` con el resumen del veredicto; en `fail`,
  `type=error`. El usuario ve la causa sin abrir los logs completos.
- **Se documenta explícitamente que no hay que usar el `continueOnError` nativo de Azure
  Pipelines con esta tarea**: degrada a advertencia *todos* los fallos, incluido el 3, y destruye
  exactamente la distinción que esta sección construye.

### Input `failOn` y dónde está la línea

La tarea expone `failOn` (vacío por defecto) como reenvío 1:1 de `--fail-on`, porque ya es un
flag de invocación en linceo y linceo define su propia precedencia (reemplaza `[thresholds]` por
completo y lo anuncia en su salida). La tarea no interpreta nada.

Lo que la tarea **no** expone, en ninguna circunstancia: exclusiones, overrides de severidad,
herramientas omitidas, baseline. Esos son política y viven en `.devsecops/config.toml`. La regla
enunciable es: **la tarea expone flags de invocación; nunca elementos de política.**

### Alternativas descartadas en §5

| Alternativa | Motivo del descarte |
|---|---|
| Un único booleano que degrada cualquier fallo | Mete el 3 en el mismo saco que el 1 y produce el pipeline verde que no escanea. |
| Apoyarse en el `continueOnError` nativo | Mismo defecto, y además fuera del control de la extensión. |
| `warn` por defecto | Permisividad doble; el default permisivo ya está en el CLI, en el lugar correcto. |
| Mapear el 3 a `SucceededWithIssues` "porque no es culpa del usuario" | De quién sea la culpa es irrelevante; lo que importa es si hay evidencia. No la hay. |
| Códigos desconocidos a `Succeeded` | Inaceptable en un gate. |

---

## §6 Service connection: aplazada, con el hueco diseñado

### Decisión: **fuera de la v0.1.** La política remota en la misma organización se resuelve con `System.AccessToken`.

Mecanismo, usando lo que linceo ya define (`token_env` en `[remote_policy]`):

- Input `useSystemAccessToken`, **por defecto `false`**.
- Si se activa, la tarea obtiene el token de la `SYSTEMVSSCONNECTION` del agente, lo registra
  como secreto (`tl.setSecret`, para que quede enmascarado en los logs) y lo expone al proceso
  como `LINCEO_POLICY_TOKEN`. El usuario pone `token_env = "LINCEO_POLICY_TOKEN"` en su
  configuración.
- Obtenerlo del endpoint del sistema —en vez de exigir `env: SYSTEM_ACCESSTOKEN: $(System.AccessToken)`
  en el YAML— elimina una fricción más, que es precisamente el objetivo de §1.

**El default es `false`** por mínimo privilegio: inyectar el token del build service en un
subproceso que no lo necesita es superficie regalada. Se activa quien usa política remota, que
sabe que la usa.

### Motivo del aplazamiento

Una service connection publicada es un contrato permanente: tiene su propio id de contribución
inmutable, un esquema de endpoint y una superficie de UI que hay que mantener indefinidamente.
Hoy no resuelve ningún problema que el usuario tenga —la distribución de la v0.1 es privada,
dentro de organizaciones conocidas—, y `System.AccessToken` cubre el caso completo. Crear un
contrato permanente para un problema hipotético es la forma más común de acumular deuda sin
haber entregado nada.

### Lo que sí se hace ahora para que aplazar sea barato

La resolución del token se concentra en **un único punto de entrada** (`resolvePolicyToken()`),
con un orden de precedencia ya escrito aunque hoy sólo tenga dos ramas:

1. `policyServiceConnection` (futuro, v0.2+)
2. `useSystemAccessToken`
3. Ninguno: el usuario gestiona su propio `token_env` con una variable secreta del pipeline

Añadir la service connection en v0.2 es entonces una rama nueva en esa función y una
contribución nueva en el manifiesto, no un rediseño de la tarea.

### Disparador explícito de reconsideración

El primer consumidor que necesite política remota alojada **fuera** de la organización que
ejecuta el pipeline —otra organización de Azure DevOps, o GitHub—. Ese día, y no antes.

### Alternativas descartadas en §6

| Alternativa | Motivo del descarte |
|---|---|
| Service connection en v0.1 | Contrato permanente para un problema que hoy no existe. |
| No soportar política remota en absoluto en v0.1 | Es una funcionalidad existente de linceo; dejarla inaccesible desde la tarea obligaría a volver al `script:` para usarla, justo lo que hay que eliminar. |
| Un input `policyToken` de tipo string | Invita a pegar un PAT en el YAML. linceo ya rechaza `--token VALOR` por esto mismo; la extensión no puede reabrir esa puerta. |
| `useSystemAccessToken` por defecto `true` | Reparte un token con permisos del build service a todo el mundo, incluida la mayoría que no usa política remota. |

---

## §7 Acoplamiento de versiones entre la extensión y linceo

### El problema

Dos repositorios, un contrato implícito. La extensión depende de nombres de subcomandos,
categorías, flags, semántica de códigos de salida y del allowlist de variables de contexto.
Nada de eso está declarado hoy como interfaz pública, y linceo es pre-1.0: puede romper. Un
mantenedor único agrava el riesgo en lugar de mitigarlo, porque el contrato vive en su cabeza y
cambiar un flag "en mi propio proyecto" se siente gratis.

### §7.1 Decisión: pin exacto por defecto, nunca `latest`

La extensión lleva compilado un pin exacto —el tag de imagen y la versión de PyPI que esa
release certifica— y lo expone como input `linceoVersion` para override.

**Motivo:** con `latest`, una release de linceo rompe pipelines ajenos sin que nadie haya
cambiado nada, y el usuario no tiene forma de relacionar causa y efecto. El pin convierte la
actualización en un acto deliberado: subir la versión de la extensión, o cambiar un input.

### §7.2 Decisión: cada versión de la extensión declara un rango `>=MIN,<MAX`

Declarado en un único sitio del repositorio (`supported-linceo.json`), publicado como tabla en
el README y verificado en CI. Pre-1.0 el rango es **estrecho**: típicamente el minor actual.
Cuando linceo llegue a 1.0 y el CLI pase a ser contrato público con SemVer, el rango se podrá
ensanchar a `>=1.x,<2.0` y esta sección se revisa.

### §7.3 Decisión: preflight de versión en cada ejecución, con comportamiento asimétrico

Antes de escanear, la tarea ejecuta `linceo version` **en el modo elegido** (única fuente de
verdad: el tag de una imagen no prueba qué hay dentro) y compara con el rango:

| Situación | Comportamiento | Motivo |
|---|---|---|
| Dentro del rango | Continúa | — |
| **Por debajo del mínimo** | `Failed` con causa de configuración | Faltan flags, categorías o códigos que la tarea usa. El fallo alternativo sería un error críptico de parseo de argumentos, imposible de diagnosticar desde un log de pipeline. |
| **Por encima del máximo** | **Advertencia y continúa** | Una versión más nueva y aún no certificada probablemente funciona: en la práctica los cambios de CLI son aditivos. Bloquear aquí convertiría cada release de linceo en un incidente para todo el que haya fijado su versión a mano, y haría del mantenedor el cuello de botella de los pipelines ajenos. |
| Cualquiera de los dos con `allowUnsupportedVersion: true` | Advertencia y continúa, registrando en el log qué se está asumiendo | Un mantenedor único no puede ser quien bloquea a un usuario con prisa. Siempre debe existir la palanca de "asumo el riesgo", y debe dejar rastro. |

La asimetría es deliberada y responde a la pregunta "¿qué fallo es recuperable?": por debajo del
mínimo el fallo es seguro y el mensaje es la única ayuda posible; por encima del máximo el fallo
es hipotético y el coste de bloquear es real.

### §7.4 Decisión: el contrato se escribe

Un fichero `docs/cli-contract.md` en el repositorio de la extensión enumera **exactamente** lo
que la extensión consume:

- `linceo scan <secrets|sca|iac>`, más `version` y `doctor`.
- Flags: `--fail-on`, `--format {console|json|sarif}`, `--max-rows`, `--platform`, `--config`,
  `--path`, `--continue-on-tool-error`.
- Códigos de salida 0, 1, 2, 3 con la semántica de §5.
- El allowlist de variables de contexto de Azure DevOps (§4.6).
- El canal de emisión de reportes: siempre stdout, nunca fichero; no existe `--output-dir`
  (S6, confirmado; §1, Enmienda 2026-09-24).

Cambiar cualquiera de esos elementos es un **breaking change de linceo**, aunque linceo siga
siendo pre-1.0 y aunque el cambio sea trivial en su propio repositorio. El valor de este
documento es convertir un acoplamiento implícito en uno declarado: lo que está escrito se puede
romper a propósito, lo que no está escrito se rompe por accidente.

### §7.5 Decisión: test de contrato en el CI de la extensión

Un job que ejecuta la imagen pinneada contra repositorios de fixture y verifica los cuatro
códigos:

| Caso | Esperado |
|---|---|
| Repositorio limpio, sin gate | 0 |
| Repositorio con un secreto conocido y `--fail-on high` | 1 |
| Configuración inválida (categoría inexistente bajo `[thresholds]`) | 2 |
| Modo `pypi` con un binario de herramienta ausente | 3 |
| Parseo de `linceo version` y de `linceo doctor` | Formato esperado |

Es la única verificación que detecta la deriva del contrato **antes** que el usuario. Siguiendo
el estilo del ADR de linceo, la decisión de §7.4 sin este job es aspiracional; con él es
ejecutable.

### §7.6 Versionado de la extensión y propuesta cruzada

- La extensión usa SemVer propio, independiente del de linceo.
- Cambiar el pin por defecto es un **minor** de la extensión; cambiar el mínimo del rango
  soportado es un **major**.
- El README publica la matriz `versión de extensión ↔ rango de linceo`.
- **Un solo evento de release:** una release de linceo que toque el contrato de §7.4 se
  acompaña de una release de la extensión. No hay automatización que lo garantice, y no se
  intenta construir una; lo que se hace es dejarlo escrito en ambos repositorios.
- **Propuesta para linceo (no bloquea la v0.1):** que `linceo version` reporte además un entero
  monotónico `cli_contract`, que se incremente sólo cuando cambia algo de §7.4. Entonces el
  preflight compararía contra ese entero en vez de contra números de versión de paquete, y la
  extensión dejaría de tener que adivinar si un `0.3.0` rompió algo. Es un cambio pequeño en
  linceo que elimina la clase entera de problema.

### Alternativas descartadas en §7

| Alternativa | Motivo del descarte |
|---|---|
| Apuntar a `latest` | Convierte cada release de linceo en un fallo de pipelines ajenos sin cambio de configuración. |
| Rango amplio (`>=0.2,<1.0`) | linceo es pre-1.0 y puede romper en cualquier minor; el rango amplio promete una compatibilidad que nadie verifica. |
| Vendorizar linceo dentro de la extensión | Rompe el modo contenedor, duplica el artefacto y hace que arreglar un bug de linceo requiera republicar en el Marketplace. |
| Fiarse del tag de la imagen como declaración de versión | El tag es una etiqueta mutable; sólo `linceo version` dice qué hay dentro realmente. |
| Fallar también por encima del máximo | Hace del mantenedor el cuello de botella de todo el mundo cada vez que publica una versión de linceo. |
| No hacer preflight (dejar que falle el escaneo) | El fallo se manifiesta como un error de parseo de argumentos, que es indistinguible de un bug de la extensión desde el log. |

---

## §8 Inputs propuestos de la tarea

Todos tienen default salvo `category`. El uso mínimo es un solo input.

| Input | Tipo | Default | Mapea a |
|---|---|---|---|
| `category` | pickList | `secrets` | `scan <category>` |
| `executionMode` | pickList | `container` | §4 |
| `linceoVersion` | string | pin de la release | tag de imagen / `==versión` |
| `image` | string | `ghcr.io/jdiegoisaza/linceo:<pin>` | espejo o ACR propio |
| `workingDirectory` | filePath | `$(Build.SourcesDirectory)` | `--path` y el montaje |
| `configPath` | filePath | vacío (convención del workspace) | `--config` |
| `failOn` | pickList | vacío | `--fail-on` |
| `onGateFailure` | pickList | `fail` | §5 (no toca el CLI) |
| `continueOnToolError` | pickList tri-estado | sin definir | `--continue-on-tool-error` |
| `maxRows` | string | vacío | `--max-rows` |
| `reportFormats` | multiSelect (`json`, `sarif`) | ambos | artefacto de pipeline, uno por formato (§1) |
| `useSystemAccessToken` | boolean | `false` | §6 |
| `allowUnsupportedVersion` | boolean | `false` | §7.3 |
| `extraArgs` | string | vacío | reenvío crudo al CLI |

`continueOnToolError` se mantiene **tri-estado** (sin definir / true / false) porque linceo lo
define así: sin definir, decide el fichero de configuración. Aplanarlo a booleano haría que la
tarea pisara silenciosamente la política del usuario.

`reportFormats` reemplaza al `publishReports` booleano original (Enmienda 2026-09-24, §12):
dado que cada formato exige su propia invocación del CLI (§1), publicar es una decisión por
formato, no un interruptor único. Selección vacía equivale al antiguo `publishReports: false`:
la tarea sigue ejecutando la invocación primaria en consola para el gate, pero no publica
ningún artefacto ni paga el coste de invocaciones adicionales.

`extraArgs` merece justificación explícita, porque parece lo contrario de la disciplina de §0.
Es su defensa: es reenvío puro, con cero semántica añadida, y existe para absorber la presión de
"expón este flag" sin que cada petición se convierta en un input nuevo con su propia validación
y su propia documentación. Se documenta como sin garantías de compatibilidad. Es la válvula que
protege el invariante contra el riesgo R3.

---

## §9 Los tres mayores riesgos de que el proyecto muera

### R1 — Deriva del contrato entre los dos repositorios

Que el mantenedor sea el mismo persona no mitiga el riesgo: lo agrava. Cambiar un nombre de flag
en tu propio proyecto no se siente como romper una API pública, y no hay revisor que lo señale.
El día que un `scan secrets` cambia de forma o un código de salida cambia de significado, la
extensión publicada rompe pipelines de terceros, y el usuario afectado no tiene forma de
relacionar el fallo con una release de otro repositorio.

- **Señal temprana:** el primer cambio en el CLI que no viene acompañado de una actualización de
  `docs/cli-contract.md` o del test de §7.5.
- **Mitigación:** contrato escrito (§7.4), test de contrato en CI (§7.5) y pin exacto (§7.1). El
  pin es lo que compra tiempo: la deriva no rompe a los usuarios existentes de inmediato, sólo a
  quien actualiza.
- **Coste de la mitigación:** un job de CI y un fichero markdown.

### R2 — El coste de publicar y sostener en el Marketplace

La parte que mata no es el código, es la administración: cuenta de publisher, PAT que caduca,
validación, capturas, licencia, notas de release, responder a un usuario que reportó algo. Un
mantenedor único con tiempo limitado abandona en la segunda rotación de credenciales, no en la
primera decisión técnica difícil.

- **Señal temprana:** la primera release que se retrasa por un problema de credenciales en vez
  de por el contenido.
- **Mitigación:** la decisión ya tomada de publicar **privado primero** reduce la superficie de
  soporte a organizaciones conocidas; los pipelines de publicación de la plantilla ya están
  resueltos y no hay que reinventarlos; el PAT vive en un variable group con la fecha de
  caducidad anotada; y la release al Marketplace se dispara **manualmente**, nunca en cada
  merge. Intentar CD continuo al Marketplace es la forma más rápida de que la publicación se
  convierta en una fuente permanente de ruido.

### R3 — Que la extensión se convierta en un segundo motor de política

El patrón es conocido y avanza por peticiones razonables una a una: "expón este flag", "añade un
input para las exclusiones", "que la tarea decida el umbral según la rama". A los seis meses hay
veinticinco inputs, la lógica de política existe en TypeScript y en Python, y las dos
divergen. A partir de ahí cada cambio cuesta el doble, ninguna de las dos es autoritativa, y el
mantenedor deja de tocar el proyecto porque cada modificación es un riesgo.

- **Señal temprana:** el primer input que **no** sea un reenvío 1:1 de un flag documentado del
  CLI ni una decisión de plataforma.
- **Mitigación:** el invariante de §0 escrito como regla verificable —todo input mapea a un flag
  documentado o a una decisión de plataforma; ninguno introduce semántica nueva— más un test que
  enumere los inputs de `task.json` contra la lista permitida de §7.4. Es el mismo estilo de
  verificación ejecutable que linceo aplica a sus cinco restricciones. Y `extraArgs` (§8) es la
  válvula que absorbe la presión sin romper la regla.

### Riesgos considerados y descartados como no letales

| Riesgo | Por qué no mata el proyecto |
|---|---|
| La imagen de ~2.37 GB | Es un problema de rendimiento con mitigaciones conocidas y a disposición del usuario. Molesta; no mata. |
| Competencia de `MicrosoftSecurityDevOps` y similares | La extensión existe porque linceo existe; el diferencial es el modelo de política, normalización y baseline, no el escáner. Si linceo no tiene razón de ser, la extensión tampoco, pero esa es una pregunta sobre linceo. |
| No soportar agentes Windows | Declarado no-objetivo (§1) y añadible después sin romper nada. |
| Cambios en la API de extensiones de Azure DevOps | Superficie muy estable y la plantilla ya la abstrae. |

---

## §10 Checkpoints de la v0.1

| Paso | Entregable | Criterio de salida |
|---|---|---|
| 1 | Esqueleto desde la plantilla, `task.json` con los inputs de §8 | La tarea aparece en el editor de pipelines y no hace nada |
| 2 | Modo `container` completo, con propagación del allowlist | Un escaneo real pasa sin ningún `env:` en el YAML |
| 3 | Traducción de códigos de salida (§5) | Los cuatro casos del test de contrato producen el resultado esperado |
| **Checkpoint** | **Revisión del contrato CLI (§7.4) contra el CLI real, incluida S6** | El contrato escrito coincide con el comportamiento observado |
| 4 | Modo `pypi` y preflight con `doctor` | Falla con mensaje accionable en un agente sin herramientas |
| 5 | Preflight de versión (§7.3) y publicación de artefactos | Matriz de compatibilidad publicada en el README |
| 6 | Publicación privada compartida con una organización | Un pipeline ajeno ejecuta la tarea desde el Marketplace |

---

## §11 Resumen de decisiones

| § | Decisión | Descartado principalmente |
|---|---|---|
| 1 | Ejecutar, gatear y publicar evidencia. Nada más | UI, comentarios en PR, gestión de baseline |
| 2 | Una tarea, la categoría como input | Tres tareas: ids inmutables e irreversibles |
| 3 | Node/TypeScript | Python: añadiría al agente el requisito que el contenedor elimina |
| 4 | Dos modos declarados por el usuario, `container` por defecto, sin degradación | `auto`: cambiaría el resultado sin cambiar la configuración |
| 5 | `onGateFailure` gobierna sólo el código 1; el 2 y el 3 nunca avisan | `continueOnError` nativo: el pipeline verde que no escanea |
| 6 | Aplazada; `System.AccessToken` vía `token_env`, con el hueco diseñado | Service connection: contrato permanente sin problema que resolver |
| 7 | Pin exacto, rango declarado, preflight asimétrico, contrato escrito y testeado | `latest` y rangos amplios sin verificación |
| 9 | Deriva del contrato, coste de publicación, segundo motor de política | — |

---

## §12 Enmiendas

### Enmienda 2026-09-24 — S6 resuelto: `--format` es stdout-only, sin `--output-dir`

**Hallazgo:** confirmado ejecutando el binario. La forma real del flag es
`--format {console|json|sarif}`, no `--json`/`--sarif` como flags independientes, y con
`--format json` o `--format sarif` el reporte se escribe **únicamente a stdout**. No existe
`--output-dir` ni ningún flag que escriba a fichero.

**Cambios en el documento:**
- §0.1 — S6 pasa de supuesto pendiente a confirmado.
- §1 — nueva subsección "Captura y nombrado de reportes": ruta local por categoría
  (`$(Agent.TempDirectory)/linceo/<category>/`), nombre de artefacto por categoría
  (`linceo-<category>`), y la consecuencia de que publicar JSON y SARIF exige una invocación
  del CLI por formato, con verificación de consistencia entre invocaciones apoyada en el
  determinismo (R3) que linceo garantiza sobre sí mismo.
- §4.6 — aclara que la captura de stdout es propiedad del CLI, no del modo de ejecución.
- §7.4 — corrección de los nombres de flag en el contrato escrito.
- §8 — `publishReports` (booleano) se reemplaza por `reportFormats` (multiselección), porque
  con una invocación por formato la publicación deja de ser un interruptor único.

**Por qué esto no cambia ninguna decisión previa, sólo la refina:** §1 ya comprometía publicar
JSON y SARIF como artefacto; lo que este hallazgo añade es el *cómo*, no el *qué*. La única
decisión nueva —una invocación por formato en vez de una combinada— es consecuencia mecánica del
propio contrato del CLI, no una elección de diseño con alternativas reales que discutir.
