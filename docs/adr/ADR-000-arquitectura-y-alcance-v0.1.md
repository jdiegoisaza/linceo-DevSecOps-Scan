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
| Auto-instalar Gitleaks, Trivy o Checkov **como efecto secundario de `linceo-scan`** | Heredado de linceo (R2/R4): la imagen es la unidad de compatibilidad. Instalar binarios como parte de un escaneo produciría escaneos cuyo resultado depende del agente. Esto no descarta una tarea *separada y explícita* que los instale como paso propio del pipeline — ver la Enmienda 2026-10-01 (§12), que es la que efectivamente se construyó. |
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

---

### Enmienda 2026-10-01 — Tarea `linceo-install` y modo `pypi` de `linceo-scan`

**Motivo:** el modo `container` es hoy la única vía práctica, y su imagen pesa ~2.37 GB (§4.4)
aunque el pipeline sólo quiera escanear `secrets`. Esta enmienda construye lo que §4 ya diseñaba
pero dejaba sin implementar: una segunda tarea, `linceo-install`, que prepara un agente Linux con
las herramientas que linceo orquesta, y el modo `pypi` de `linceo-scan`, que asume que esas
herramientas ya están en el PATH. Las dos tareas son independientes: nada en `linceo-scan` exige
que `linceo-install` haya corrido antes; sin ella, el preflight de §4.3 simplemente falla con la
salida de `doctor`, igual que si el operador hubiera preparado el agente a mano.

#### §12.1 Qué instala `linceo-install`

**Decisión: input `categories` (multiSelect, `secrets`\|`sca`\|`iac`, default: las tres), con una
tabla fija categoría→herramienta, no un input de nombres de herramienta.**

```
secrets → gitleaks
sca     → trivy (+ su base de datos de vulnerabilidades, §12.5)
iac     → checkov
```

Mapeo confirmado contra el código de linceo, no supuesto: `Category.SECRETS`/`SCA`/`IAC` en
`gitleaks.py`/`trivy.py`/`checkov.py`, y `doctor.py::gather_report` prueba exactamente esas tres
integraciones. Usar `categories` reutiliza el vocabulario que el usuario ya tiene que conocer para
`linceo-scan` (mismo pickList) en vez de introducir una segunda taxonomía —nombres de binarios—
que es un detalle de implementación de linceo. El mapeo se añade a los elementos de contrato de
§7.4: si linceo alguna vez cambia qué herramienta respalda una categoría, es un cambio de
contrato declarado, no una sorpresa silenciosa.

**Alternativas descartadas:** un input `tools` directo (vocabulario paralelo que nadie consume
por sí mismo); derivar `categories` leyendo los inputs de otros pasos `linceo-scan` del mismo
YAML (Azure DevOps no da esa visibilidad entre tareas en tiempo de ejecución).

#### §12.2 Verificación

**Decisión: versión y checksum sha256 (por arquitectura) se copian literalmente de los `ARG` del
`Dockerfile` de linceo a `tasks/linceo-install/tool-pins.json`. Checkov es la excepción
deliberada: no lleva checksum manual.**

Valores vigentes, verificados contra el tag `v0.9.1` del Dockerfile de linceo (confirmado que es
idéntico al HEAD actual de ese repositorio para este fichero):

| Herramienta | Versión | Verificación |
|---|---|---|
| gitleaks | 8.30.1 | sha256 por arquitectura (amd64/arm64), copiado del Dockerfile |
| trivy | 0.74.0 | sha256 por arquitectura (amd64/arm64), copiado del Dockerfile |
| checkov | 3.3.19 | ninguna manual — ver argumento abajo |

**Por qué checkov es asimétrico, no un descuido:** gitleaks y trivy se bajan como tarball de un
release de GitHub sin autenticar — exactamente lo que ADR R4 de linceo exige verificar contra un
checksum publicado, nunca calculado sobre lo descargado. Checkov se instala con
`pip install checkov==<pin>`, y pip ya lo verifica contra el índice de PyPI (TLS + hash del
índice) — una cadena de confianza distinta, ya autenticada, la misma razón que el propio
Dockerfile de linceo documenta para no pinnear un sha256 de checkov en su etapa `checkov-build`.
Exigir un checksum manual ahí sería una verificación redundante que ni linceo se exige a sí mismo.

**Mantenimiento del pin, para que no sea una copia que se olvida:** `tool-pins.json` lleva un
campo `source` con el tag del que se copió y la fecha de verificación. Actualizarlo es un evento
de versión de esta extensión (mismo criterio que §7.6: cambiar un pin por defecto es un minor).
La detección de que el pin quedó desactualizado no depende de que alguien se acuerde — ver §12.6.

**Override explícito, misma disciplina que `imageTag`:** inputs opcionales
`gitleaksVersion`/`gitleaksSha256Amd64`/`gitleaksSha256Arm64` y el trío equivalente para trivy.
Fijar la versión sin los dos checksums falla la tarea —calcular el checksum sobre lo descargado
es precisamente lo que esta sección prohíbe—, nunca lo calcula por su cuenta. `checkovVersion` no
necesita checksums acompañantes, por la asimetría de arriba.

#### §12.3 Caché entre jobs del mismo agente

**Decisión: `Agent.ToolsDirectory`, vía `azure-pipelines-tool-lib` (`findLocalTool`/`cacheDir`/
`prependPath`) — el mecanismo que usan las tareas nativas de Microsoft (`UsePythonVersion`,
`NodeTool`, `UseDotNet`) para este caso exacto.**

Verificado contra el código fuente del paquete (`tool.js` de `azure-pipelines-tool-lib@2.281.0`),
no de memoria: `cacheDir()` escribe en `tl.getVariable('Agent.ToolsDirectory')`, marca la carpeta
con un fichero `.complete` tras copiar, y `findLocalTool()` sólo la da por válida si ese marcador
existe — un hit de caché no puede ser una descarga a medias, porque nada deja esa carpeta en un
estado intermedio marcado como completo.

| Tipo de agente | Qué pasa con la caché |
|---|---|
| Self-hosted/privado, máquina persistente | Sobrevive entre jobs y entre corridas, porque es un directorio bajo `_work` del agente y la máquina no se reinicia entre jobs. Es el caso que motiva esta tarea. |
| Microsoft-hosted | Cada job es una VM efímera nueva; ningún mecanismo basado en disco sobrevive eso. La tarea vuelve a descargar y verificar cada vez — mismo costo que sin esta tarea, no una regresión. |
| Self-hosted efímero (scale-set) | Se comporta como hosted a efectos de caché si la máquina se recicla por job. |

**No-objetivo, mismo precedente que el peso de la imagen (§4.4):** un caché remoto
(`Cache@2`, key/restoreKeys contra un blob) daría persistencia en agentes hosted, pero es una
decisión de la infraestructura del pipeline, no de esta tarea — igual que §1 ya descarta que la
extensión gestione réplicas o caché de la imagen de contenedor. Se documenta el patrón (un paso
`Cache@2` antes de `linceo-install`, restaurando sobre la misma ruta de `Agent.ToolsDirectory`);
no se implementa dentro de la tarea.

#### §12.4 Herramienta ya presente con otra versión

**Decisión: un único modo, sin input. La tarea nunca sobrescribe lo que ya esté en el PATH del
agente, nunca falla sólo por encontrar una versión distinta, y nunca intenta aceptar una versión
preexistente "si cumple el rango".**

Mecanismo: la tarea instala (o reutiliza desde caché) su propia copia pinneada en un directorio
versionado y propio (`<tool-cache>/<tool>/<versión>/<arch>/`) y la antepone al PATH
(`toolLib.prependPath`, que emite `##vso[task.prependpath]`) — por resolución de PATH, su versión
gana sobre cualquier otra instalación preexistente, sin tocar ni desinstalar nada que no sea
suyo. La validación de si la versión resultante cumple el rango soportado queda, siempre, en
`linceo doctor` (ejecutado después por `linceo-scan` en modo `pypi`, §12.5) — nunca en esta
tarea, que no reimplementa `SUPPORTED_VERSION_RANGE`.

**Por qué no hay un modo "aceptar si está en el PATH" (`reuseIfPresent`, descartado tras revisión
del diseño inicial):** el propio rango que `doctor` valida no es una versión, es un intervalo —
`>=0.50,<1` para trivy son más de cincuenta versiones con comportamientos distintos entre sí.
"Aceptar lo que haya" significaría escanear con una versión que nadie fijó, elegida por quien
preparó el agente para un propósito que no era éste, y que sólo se sabe si es aceptable después
de correr `doctor` — momento en el que ya es demasiado tarde para decidir no descargar nada. Eso
contradice el resto del diseño (checksums, pines exactos, versión declarada) por la puerta de
atrás. Quien tiene un agente curado y no quiere la descarga de esta tarea tiene una respuesta ya
explícita y sin necesidad de un input: no añadir el paso `linceo-install` al pipeline.

#### §12.5 Modo `pypi` de `linceo-scan`

Implementa exactamente lo que §4.2–§4.5 ya diseñaban (`executionMode`: `container`\|`pypi`,
default `container`; preflight asimétrico de §4.3; venv efímero con versión exacta de §4.5) —
confirmado que no estaba construido: `tasks/linceo-scan/src/index.ts` sólo tenía la rama Docker,
y el propio README decía "modo PyPI... diseñado... pero no implementado todavía".

**¿Sigue valiendo el argumento contra `executionMode: auto` ahora que existe una tarea
instaladora explícita?** Sí, y se refuerza. El argumento original (§4.2) es que `auto` cambiaría
el veredicto sin cambiar la configuración, de forma invisible. Con `linceo-install` como paso
explícito y opcional, un `auto` en `linceo-scan` tendría que adivinar la intención del operador
detectando "¿hay Docker? ¿están las tres herramientas en PATH?" — y ambas condiciones pueden ser
ciertas a la vez en un agente self-hosted por motivos ajenos a este pipeline (alguien instaló
gitleaks para otro job). La presencia o ausencia del paso `linceo-install` en el YAML es
precisamente la señal explícita que el §0 exige ("la tarea es un adaptador de invocación, no un
segundo lugar donde vive la política") — el argumento no sólo sigue vigente, ahora tiene un
segundo apoyo concreto.

**Hallazgo no pedido por el encargo original, y que habría salido recién en la primera prueba
real: trivy necesita su base de datos de vulnerabilidades pre-descargada para funcionar sin
contenedor.** `linceo` siempre invoca trivy con `--skip-db-update` (ADR R2/§5 de linceo: offline
por defecto) — sin una base de datos ya presente, trivy falla con
`--skip-db-update cannot be specified on the first run`, y linceo traduce eso a
`TrivyDatabaseNotReadyError` con un hint que **ya nombra la solución** (confirmado leyendo
`src/linceo/adapters/trivy.py`, `TRIVY_DB_NOT_READY_HINT`):

> "Fetch it once, explicitly, with one of: `trivy fs --download-db-only` run by hand on this
> machine — the one command in this whole workflow allowed to touch the network, and only
> because you ran it yourself..."

`linceo-install`, al preparar `trivy` para la categoría `sca`, ejecuta exactamente ese comando
contra su propio directorio de caché (`trivy fs --download-db-only --cache-dir <tool-cache>/
trivy-db`) y expone `TRIVY_CACHE_DIR` como variable de pipeline (`tl.setVariable`) para que el
`trivy` que invoque `linceo scan sca` después la encuentre. La base de datos se cachea bajo la
misma lógica que los binarios, con la versión de trivy como clave de caché (bump de
`TRIVY_VERSION` invalida la base, que es el comportamiento correcto: no hay garantía de formato
estable entre majors de trivy).

**Consecuencia operativa a documentar (mismo estilo que §2, sobre compartir el pull de imagen):**
`linceo-install` y los pasos `linceo-scan` en modo `pypi` deben vivir **en el mismo job** — el
PATH y `TRIVY_CACHE_DIR` que `linceo-install` propaga vía variable de pipeline sólo llegan a
pasos posteriores del mismo job, nunca a otro job.

#### §12.6 Límite con el ADR de linceo (R2/R4)

**Decisión: `linceo-install` descarga binarios de terceros como decisión explícita de esta
extensión. No contradice R2/R4 de linceo porque esas restricciones gobiernan el comportamiento de
linceo, nunca el de quien prepara el agente antes de que linceo corra.**

Cita literal, no parafraseada, de R2 y R4 (`docs/adr/ADR-000-arquitectura-base-y-alcance-v0.1.md`
del repositorio de linceo):

> R2: "Los binarios de herramienta (Gitleaks, Trivy) nunca se descargan **en runtime** bajo
> ninguna circunstancia: si faltan, es un error accionable (ver R4), no un intento de resolución
> automática."
>
> R4: "si un binario requerido no está en PATH, el CLI falla con un error accionable que nombra
> qué falta, qué versión se espera, **y cómo instalarla** — y nunca intenta instalarla por su
> cuenta."

El sujeto de las dos frases es siempre el CLI/la herramienta —linceo—, nunca "el operador". R4
deja un hueco con nombre, "cómo instalarla", que algo tiene que llenar fuera de linceo.
`linceo-install` es una respuesta concreta y verificada a esa frase, ejecutada como su propio
paso de pipeline, por un proceso que el operador eligió explícitamente añadir al YAML — nunca
como efecto secundario de una invocación de `linceo scan`. El caso de la base de datos de trivy
(§12.5) es la prueba más directa: `linceo-install` ejecuta literalmente el comando que el propio
código de linceo le recomienda al operador correr a mano.

#### §12.7 Detección de deriva del pin contra el Dockerfile público de linceo

**Problema con la mitigación original de §12.2:** un test que descarga cada asset pinneado y
compara su checksum contra el valor vendorizado detecta un error de transcripción, pero no
detecta que linceo subió `TRIVY_VERSION` de `0.74.0` a una versión posterior — `tool-pins.json`
seguiría siendo internamente consistente (versión y checksum vendorizados coinciden entre sí) y
sólo estaría desactualizado frente a la realidad, sin que nada lo señale.

**Decisión: una comprobación programada y separada, que resuelve el tag más reciente de
`github.com/jdiegoisaza/linceo` vía su API pública (`/tags`; el repositorio no usa "Releases" de
GitHub, confirmado: `/releases` devuelve `[]`), descarga el `Dockerfile` de ese tag vía
`raw.githubusercontent.com`, extrae sus `ARG` de versión y checksum, y los compara contra
`tasks/linceo-install/tool-pins.json`. Si difieren, la comprobación falla — no avisa.**

*(Extendida en §12.8 a un segundo fichero, `tasks/linceo-scan/linceo-pins.json`, y un segundo
fichero fuente, `pyproject.toml` — mismo script, mismo pipeline, mismo argumento de abajo.)*

**Por qué falla y no avisa, a diferencia de §7.3 (CLI por encima del rango máximo → avisa y
continúa):** son dos situaciones con la misma forma superficial —"algo está más nuevo de lo que
pinneamos"— pero distinto costo de fallar. §7.3 avisa porque ese preflight corre en **cada
ejecución de un pipeline ajeno**: fallarlo convertiría cada release de linceo en un incidente
para todo tercero que use la tarea, con el mantenedor como cuello de botella de pipelines que no
son los suyos. Esta comprobación, en cambio, corre únicamente en el CI de esta extensión, en un
pipeline propio y programado — no bloquea ningún pipeline de ningún usuario, sólo informa al
mantenedor de la extensión que su propio pin quedó atrás. Fallar aquí no tiene el costo que
`§7.3` evita; y avisar tendría el defecto que el propio documento ya señaló dos veces (§4.2, §4.4
discutidas): "un aviso vive en un log que nadie lee cuando el paso está en verde". Con un
mantenedor único, un aviso en una corrida programada que nadie abre es, en la práctica, no tener
comprobación.

**Por qué es un pipeline separado y no un job del pipeline de build/publish:** si viviera en
`azure-pipelines.yml`, cada push a `main` se pondría en rojo el día que linceo suba una versión,
sin relación alguna con el contenido de ese push — el mismo problema que `latest` en §7.1, pero
en el repositorio equivocado. Un pipeline propio (`azure-pipelines-linceo-pins-check.yml`,
programado diariamente) falla sólo esa corrida, con su propio motivo etiquetado, sin tocar el
semáforo de build/publish.

**Qué pasa si la comprobación en sí no puede completarse** (GitHub no responde, cambia el
formato del Dockerfile): también falla, con un mensaje que lo distingue explícitamente de
"hay deriva" — una comprobación que no pudo correr y queda en verde por defecto es el mismo
patrón de "pipeline verde que no verificó nada" que el §5 de este documento ya rechaza para el
propio gate de linceo.

---

### Enmienda 2026-10-01 (continuación) — §12.8 Preflight de versión de Python en modo `pypi`

**Problema real, encontrado por un usuario, no en diseño:** en un agente con `python3` apuntando
a Python 3.8 (el default de sistema en varias imágenes Ubuntu LTS ampliamente usadas en agentes
self-hosted), el modo `pypi` de `linceo-scan` fallaba con:

```
ERROR: Could not find a version that satisfies the requirement linceo[remote-config]==0.9.1 (from versions: none)
```

`from versions: none` es pip descartando silenciosamente todas las distribuciones porque el
intérprete no cumple el `requires-python` que linceo declara (`>=3.11`) — un mensaje que no nombra
esa causa, y que nadie va a deducir sin leer el código de linceo. Contradice el criterio que el
resto de esta tarea ya sigue (resolveWorkspacePath, extraArgs, el propio `runDoctorPreflight`):
si algo está mal, la tarea falla por esa causa explícita, antes de que la herramienta de turno
reporte un síntoma que apunta a cualquier sitio menos al problema real.

#### Dónde vive el mínimo de Python, y cómo se vigila su deriva

El mínimo (`>=3.11`) está declarado en el `pyproject.toml` de linceo, no en esta extensión.
Copiarlo a mano en el mensaje de error o en el código de `linceo-scan` crearía una tercera copia
de un dato ajeno —junto a los checksums de `tasks/linceo-install/tool-pins.json` (§12.2) y al
rango de compatibilidad del CLI de §7— sin ningún mecanismo que detecte cuándo linceo lo cambia.

**Decisión: el mismo mecanismo que ya existe para los pines de herramientas, extendido.**
`tasks/linceo-scan/linceo-pins.json` vendoriza `{"python": {"requires": ">=3.11"}}`, copiado
literalmente del `pyproject.toml` de linceo (verificado contra el tag `v0.9.1`, igual que
`tool-pins.json`). `scripts/check-linceo-pins-drift.js` (renombrado desde
`check-tool-pins-drift.js`, mismo pipeline programado de §12.7) ahora descarga **dos** ficheros
del tag más reciente de linceo —`Dockerfile` y `pyproject.toml`— y compara **ambos** ficheros de
pins locales contra lo que encuentra, con el mismo criterio de fallo (nunca aviso) y el mismo
argumento de §12.7: la comprobación corre en el CI de esta extensión, nunca en el pipeline de un
usuario, así que fallar aquí no tiene el costo que hace que §7.3 prefiera avisar.

No se creó un tercer pipeline ni un segundo script: es la misma pregunta —"¿lo que vendorizamos de
linceo sigue vigente?"— aplicada a un segundo dato, no un problema nuevo.

#### Preflight: falla antes del `pip install`, con causa propia

`ensureLinceoBinary` (sólo en la rama donde no hay ya un `linceo` en el PATH — si lo hay, no se
toca Python en absoluto, §4.5) corre `resolvePythonInterpreter` antes de crear el venv. El
intérprete candidato se interroga directamente (`python -c "import sys; ..."`), no se parsea el
texto de `--version`. Si nada cumple el mínimo, la tarea falla nombrando la versión encontrada,
la mínima requerida (con su fuente: "tomado de su propio pyproject.toml"), y qué hacer —instalar
una versión que cumpla, o usar `executionMode: container`, que no depende de Python en el agente.

#### Buscar un intérprete alternativo antes de rendirse

**Problema:** un agente con varios intérpretes instalados uno junto a otro —`python3` apuntando
al 3.8 de sistema, `python3.12` instalado aparte para otro propósito— es una situación común, no
un error de configuración. Rendirse con el primero que se encuentra sería innecesariamente
estricto: existe una alternativa que ya serviría, a un `tl.which` de distancia.

**Decisión: sí, se busca.** Orden: `python3` primero (si ya sirve, cero sorpresas, cero
búsqueda), luego `python3.<minor>` ascendente desde el mínimo requerido, hasta diez minors por
delante (margen generoso sobre casi una década de releases de Python a su cadencia histórica de
~1/año, sin búsqueda no acotada). El intérprete elegido se nombra en el log, incluida la
advertencia de que `python3` no alcanzaba cuando aplica — nunca una elección silenciosa.

**Por qué esto no es el `auto` que §4.2 descarta, aunque se parezca:** `executionMode: auto`
cambiaría qué corre (contenedor vs. paquete, con sus propias versiones de gitleaks/trivy/checkov)
de forma invisible para el mismo pipeline. Qué intérprete de Python arranca el venv no cambia
nada de eso: es plomería de arranque, no una decisión que afecte qué se escanea, con qué versión
de linceo, ni qué veredicto produce `doctor` después. La búsqueda tampoco amplía qué se acepta
como válido —cada candidato se mide contra el mismo mínimo exacto que `pythonVersionSatisfies`
ya exige—, sólo amplía dónde se busca un candidato que ya cumple esa única barra.

**Alternativas descartadas:**

| Alternativa | Motivo del descarte |
|---|---|
| Fallar con el primer `python3` insuficiente, sin buscar más | Innecesariamente estricto en el caso real que motivó este hallazgo — un `python3.12` ya instalado al lado se queda sin usar por no tener un nombre que la tarea reconociera. |
| Input nuevo para que el usuario indique la ruta del intérprete | Añade un input para un problema que `tl.which` ya resuelve solo en el caso común; se deja como escape hatch futuro si alguna vez hace falta un intérprete en una ruta no convencional. |
| Buscar cualquier nombre de binario que empiece por "python" | Encontraría intérpretes Python 2, o binarios no relacionados; la convención `python3.<minor>` es la que `pyenv`, las distros y las PPAs de Python ya usan, y es la única que relaciona el nombre con una versión sin tener que ejecutar el binario primero. |

#### Consecuencia operativa

El fichero `tasks/linceo-scan/linceo-pins.json` se documenta en el README junto al resto de
inputs de modo `pypi`, con la misma frase que ya usa el resto del documento para una limitación
de plataforma aceptada, no un pendiente: **Python 3.11+ en el agente es un requisito del modo
`pypi`, con `executionMode: container` como alternativa donde no esté disponible.**

> **Superseded por §12.9.** Esta subsección completa (búsqueda de intérprete por versión y por
> capacidad de `ensurepip`) quedó obsoleta un día después: `uv` resuelve las dos cosas por su
> cuenta, sin que esta tarea tenga que reimplementar ninguna. El código que describe ya no existe
> en `tasks/linceo-scan/src/index.ts` — se deja el texto como registro de por qué existió y por
> qué se borró, no como comportamiento vigente.

---

### Enmienda 2026-10-01 (continuación) — `uv` reemplaza `python -m venv`

**Motivo:** el preflight de la enmienda anterior convertía el fallo en un mensaje accionable,
pero seguía exigiendo que alguien instalara `python3.X-venv` a mano en cada agente nuevo — el
preflight diagnostica bien el problema de Debian/Ubuntu, pero no lo elimina. `uv` (astral-sh/uv)
crea entornos sin pasar por `ensurepip`, es un binario estático que se descarga y verifica igual
que gitleaks y trivy, y linceo ya lo usa y pinea en su propio Dockerfile (`ARG UV_VERSION`) para
construirse a sí mismo.

**Verificado empíricamente antes de diseñar nada, no asumido de la documentación de `uv`** (los
tres experimentos corrieron contra binarios reales, no simulados):

1. `uv venv --python /usr/bin/python3` (ese mismo intérprete 3.12 sin `ensurepip`, el que
   reproduce el bug reportado) crea el entorno sin tropezar — `uv` no instala pip dentro del venv,
   instala paquetes él mismo con `uv pip install`, así que `ensurepip` nunca entra en juego.
2. Con el PATH vaciado de cualquier intérprete de sistema, `uv venv --python ">=3.11"` descarga un
   Python 3.14 autocontenido (`python-build-standalone`) y crea el entorno igual.
3. `uv pip install --python <venv>/bin/python "linceo[remote-config]==0.9.1"` instala linceo real
   desde PyPI en ese venv, sin que exista un `pip` dentro de él.

Las tres pruebas se repitieron de punta a punta contra el `dist/index.js` compilado real de
`linceo-scan`, no contra una reimplementación de prueba, incluyendo una corrida con el `python3`
3.12 real (sin `ensurepip`) todavía primero en el PATH — `uv` lo descartó por su cuenta a favor de
un `python3.13` también presente, sin que esta tarea tuviera que buscar ni decidir nada.

#### §12.9.1 Quién descarga `uv`

**Decisión: `linceo-install`, con el mismo mecanismo de checksum y caché que ya usa para
gitleaks/trivy/checkov (§12.1–§12.4), extendido — no un segundo mecanismo en `linceo-scan`.**

Un segundo mecanismo de descarga sería peor por el motivo exacto que el ADR ya viene repitiendo
desde §2: dos sitios donde la misma pregunta ("¿cómo se descarga y verifica un binario externo?")
tiene una respuesta cada uno es, por construcción, dos respuestas que pueden divergir. `linceo-
install` ya resuelve exactamente ese problema; `uv` es, para efectos de este mecanismo, un cuarto
binario con la misma forma que los otros tres (tarball de GitHub release, checksum publicado,
versión fijada) — la única diferencia real es de detalle de extracción (el tarball de `uv` deja el
binario en un subdirectorio con el nombre del triple de plataforma, no en la raíz como gitleaks/
trivy), absorbida en el mismo `ensureGithubReleaseBinary` con un campo `archiveDir` opcional.

**Consecuencia que había que aceptar y se acepta explícitamente:** el modo `pypi` pasa a depender
de que `linceo-install` esté en el pipeline **siempre**, no sólo cuando se van a instalar
gitleaks/trivy/checkov. A diferencia de esos tres (atados a una categoría de escaneo), `uv` lo
necesita `linceo-scan` para instalar linceo mismo, sin importar qué categoría se escanee después
— es la primera herramienta de `linceo-install` que no está condicionada por el input
`categories`.

#### §12.9.2 Versión y checksum

**Decisión: anclado igual que el resto — versión exacta en `tasks/linceo-install/tool-pins.json`,
checksums por arquitectura copiados del release oficial, verificados antes de usar, nunca
calculados sobre lo descargado.**

La versión (`0.12.15`) se toma de la misma autoridad externa que gitleaks/trivy/checkov: el
`ARG UV_VERSION` del Dockerfile de linceo — una sola fuente de la que copiar, vigilada por la
misma comprobación de deriva de §12.7, extendida para comparar también este `ARG`. Los checksums
se copiaron de los ficheros `.sha256` que el propio release de `uv` publica por asset
(`uv-x86_64-unknown-linux-gnu.tar.gz.sha256`, `uv-aarch64-unknown-linux-gnu.tar.gz.sha256`) —
verificados descargando ambos binarios y comprobando el checksum contra el valor vendorizado antes
de escribir nada en `tool-pins.json`.

**Límite honesto, no cerrado por completo:** a diferencia de gitleaks/trivy, el Dockerfile de
linceo no embebe un checksum de `uv` (lo instala vía `pip install uv==…`, confiando en PyPI, no en
un binario verificado — ver el propio comentario de esa etapa del Dockerfile). La comprobación de
deriva programada, por tanto, sólo puede vigilar la **versión** de `uv` contra ese `ARG`, no su
checksum contra una fuente externa de la misma forma que hace con gitleaks/trivy. La verificación
del checksum de `uv` sigue existiendo igual de fuerte que la de los demás — ocurre en cada corrida
real de `linceo-install`, que nunca instala un binario sin verificarlo —, simplemente no hay una
segunda fuente externa contra la que contrastarlo de forma proactiva y programada.

#### §12.9.3 Si ya está en el PATH

**Decisión: el mismo criterio que el resto — `preferPinned`, sin input, sin reutilizar lo
preexistente. `uv` no es distinto.**

La tentación de tratarlo distinto viene de que `uv`, a diferencia de gitleaks/trivy/checkov, no
afecta el veredicto de un escaneo — es plomería, igual que "qué Python arranca el venv" lo era en
la enmienda anterior. Pero hay una diferencia real con ese caso: el intérprete de Python nunca lo
instala esta tarea (sólo busca uno que ya esté), mientras que `uv` sí es algo que `linceo-install`
instala activamente — está, por definición, dentro del conjunto de cosas que esta tarea gestiona,
no en el conjunto de hechos del entorno que sólo puede descubrir. Introducir una segunda regla de
reutilización aquí reabriría exactamente la puerta que §12.4 cerró para los otros tres: un modo
adicional que mantener, documentar y que alguien tiene que recordar que existe. Una sola regla,
sin excepciones, es más simple que una regla con una excepción justificada caso por caso — y el
costo de no reutilizar es mínimo: un binario de ~15 MB que, igual que los demás, se cachea después
de la primera vez.

#### §12.9.4 Qué desaparece: el preflight de versión de Python

**Sí, desaparece por completo — confirmado empíricamente, no sólo argumentado.** `uv venv
--python "<requires-python>"` acepta el mismo formato de rango que linceo ya declara en su
`pyproject.toml` (`>=3.11`) tal cual, sin que esta tarea lo interprete, y resuelve internamente
las dos preguntas que el preflight anterior resolvía a mano:

1. ¿Hay un intérprete que cumpla la versión? `uv` lo busca él mismo entre los disponibles.
2. ¿Puede ese intérprete crear un venv utilizable? Siempre sí, porque `uv` no depende de
   `ensurepip` para instalar paquetes — el problema de Debian/Ubuntu deja de existir, no se
   detecta y se reporta mejor.

**Código eliminado de `tasks/linceo-scan/src/index.ts`, no dejado al lado:** `PythonVersion`,
`detectPythonVersion`, `pythonVersionSatisfies`, `debianVenvPackageName`,
`detectEnsurepipAvailable`, `RejectedCandidate`, `resolvePythonInterpreter`, y la red de seguridad
de `ensureLinceoBinary` que inspeccionaba la salida de `python -m venv` buscando el mensaje de
`ensurepip`. Dejarlo "por si acaso" sería mantener una segunda implementación de algo que `uv` ya
hace, con su propio riesgo de desviarse — el mismo argumento de §12.9.1 contra un segundo
mecanismo de descarga, aplicado aquí a un segundo mecanismo de resolución de intérprete.

**Lo que no desaparece:** `tasks/linceo-scan/linceo-pins.json` sigue siendo necesario — sigue
siendo la única fuente de verdad de qué versión de Python requiere linceo, vigilada por la misma
comprobación de deriva de §12.7/§12.8. Lo único que cambia es su destino: antes alimentaba un
comparador propio, ahora se pasa literal a `uv venv --python`.

**Caché del Python que `uv` pueda descargar:** `linceo-install`, al asegurar `uv`, fija
`UV_PYTHON_INSTALL_DIR` y `UV_CACHE_DIR` bajo `Agent.ToolsDirectory` (mismo argumento que
`TRIVY_CACHE_DIR`, §12.5) — sin esto, un agente que necesite que `uv` descargue un Python
autocontenido lo repetiría en cada corrida, el mismo desperdicio que la caché de herramientas
existe para evitar.

#### §12.9.5 Si `uv` no está disponible: falla, no cae a `python -m venv`

**Decisión: `linceo-scan` falla con un mensaje accionable si `uv` no está en el PATH. No hay
fallback al mecanismo de `python -m venv` que existía antes de esta enmienda.**

Mismo argumento que dos decisiones ya tomadas en este documento:

- **§4.2 (`executionMode` sin `auto`):** degradar en silencio a un mecanismo distinto cambia el
  comportamiento sin que cambie la configuración del pipeline.
- **§12.4 (`preferPinned` sin `reuseIfPresent`):** una vía alternativa "por si acaso" es una
  segunda superficie que mantener y que alguien tiene que acordarse de que existe.

Aquí el argumento es más fuerte todavía: la vía alternativa no es sólo una superficie adicional,
es **el mecanismo que esta misma enmienda demostró que tiene un bug de plataforma conocido**
(Debian/Ubuntu + `ensurepip`). Mantenerlo vivo como fallback silencioso significaría que el bug
que motivó todo este trabajo puede seguir ocurriendo, ahora de forma más difícil de diagnosticar
porque ya no es el camino principal. La ausencia de `uv` en el PATH es, en la práctica, una señal
de que falta el paso `linceo-install` en el job — un error de configuración del pipeline, no una
situación que el modo `pypi` deba absorber en silencio degradando a algo peor.

#### §12.9.6 Resumen de lo que cambia

| Antes (enmienda anterior) | Ahora |
|---|---|
| `python -m venv` | `uv venv --python "<requires-python>"` |
| `pip install` dentro del venv | `uv pip install --python <venv>/bin/python` |
| Preflight propio de versión + búsqueda por capacidad de `ensurepip` | Delegado por completo a `uv` |
| Requisito del agente: Python 3.11+ en el PATH | Requisito del agente: `uv` en el PATH (vía `linceo-install`) — Python puede faltar del todo |
| `linceo-install` necesario sólo si se usan sus categorías | `linceo-install` necesario siempre que `executionMode: pypi`, para cualquier categoría |

---

### Enmienda 2026-10-02 — §12.10 `linceo-install@1`: sin overrides sueltos, categorías booleanas

Dos cambios de contrato en los inputs de `linceo-install`, publicados como cambio mayor de la
tarea (`0.2.x` → `1.0.0`). Ambos rompen pipelines ya escritos.

#### §12.10.1 Desaparecen los nueve overrides (sustitución por `toolPinsFile` revocada en §12.10.3)

**Decisión: desaparecen `gitleaksVersion`, `gitleaksSha256Amd64`/`Arm64`, `trivyVersion`,
`trivySha256Amd64`/`Arm64`, `checkovVersion`, `uvVersion` y `uvSha256Amd64`/`Arm64` (§12.2,
§12.9.2). Se propuso sustituirlos por un input opcional `toolPinsFile` (ruta, dentro del
workspace, a un fichero con el formato de `tool-pins.json`); esa sustitución se revocó antes de
publicar — ver §12.10.3. Quedan pins fijos y sin input.**

**Por qué:** no había un caso real. Nueve de once inputs eran overrides que nadie iba a rellenar
desde el formulario —sobre todo los checksums, que hay que copiar a mano del fichero de checksums
de cada release, dos arquitecturas por herramienta—, y ensanchaban la superficie del formulario de
una tarea cuyo uso normal no toca ninguno. Quien de verdad necesite anclar versiones distintas
tiene dos vías: el fichero de pins (versionado en su repositorio, revisable en un PR, un solo
sitio donde mirar), o el modo `container` (`imageTag`), donde las versiones de las herramientas
vienen ya fijadas dentro de la imagen.

**Lo que no cambia:** la regla de §12.2 —versión y checksum van juntos, copiados de una fuente
independiente, nunca calculados sobre lo descargado— sigue siendo la del `tool-pins.json` de la
extensión; lo que desaparece es la vía para sustituirlo desde el pipeline.

#### §12.10.2 `categories` (multiSelect) se sustituye por tres booleanos

**Decisión: `secrets`, `sca` e `iac`, tipo `boolean`, los tres `true` por defecto (conserva el
comportamiento de `categories` por defecto). Reemplaza a §12.1 en cuanto al tipo del input; el
mapeo categoría→herramienta (§12.1) no cambia.**

**Por qué:** el tipo `multiSelect` se renderiza bien en el formulario clásico, pero el validador
del esquema de YAML del editor de Azure DevOps lo rechaza (con los tres valores marca "Value is
not accepted. Valid values: secrets, sca, iac"), aunque en ejecución funcione. Un error permanente
en el editor es peor que un campo de más: acaba ignorándose, y entonces tampoco se ven los
errores reales. Un `boolean` solo admite `true`/`false`, que el esquema valida sin falsos
positivos, y el editor no puede ofrecer nada que la tarea no soporte. Si ninguna categoría queda
activa, la tarea falla con un mensaje claro (era `required: true` con `categories`; el equivalente
ahora es "al menos una").

**Migración:** `linceo-install@0` debería dejar de resolver tras publicar esta versión (la extensión
sólo empaqueta una versión mayor de cada tarea; comportamiento de Azure DevOps a confirmar al
publicar, junto con la verificación pendiente de `properties.name`): hay que cambiar a `linceo-install@1` y reescribir
`categories: 'secrets,sca'` como `iac: false`; los overrides no tienen sustituto (§12.10.3). Se
prefirió un fallo ruidoso a mantener `@0`, donde un input eliminado se habría ignorado en
silencio —incluido un pin de versión, que habría dejado de aplicarse sin aviso.

#### §12.10.3 Se revoca `toolPinsFile`: pins fijos, sin input

**Decisión: `linceo-install` no tiene ningún input para cambiar versiones ni checksums de las
herramientas. Los pins son los de `tool-pins.json`, fijos por versión de la extensión. La
propuesta de §12.10.1 (`toolPinsFile`) se implementó, se revisó y se retiró antes de publicarse.**

**Por qué:** el fichero vivía en el repositorio escaneado, así que quien pudiera modificarlo
decidía qué binario se descarga y ejecuta en el agente y lo acompañaba del checksum que él mismo
escribía; la verificación sólo confirmaba que el binario coincidía con lo que el autor declaró. Si
el pipeline valida PRs, el autor de un PR obtiene ejecución arbitraria en el agente. Es la misma
frontera que linceo ya resolvió para su política —exclusiones del repositorio escaneado, umbrales
del central—, sólo que aquí lo que cruza la frontera no es un umbral sino código ejecutable.
Matiz de alcance: si el YAML del pipeline no está gobernado (en Azure Repos, un build de PR usa el
YAML de la rama del PR), el riesgo ya existe por otra vía y el fichero no añade nada; si sí lo
está (plantillas `extends`, definición en otro repositorio), el fichero abre exactamente la
brecha que esa gobernanza cierra. Se diseña contra el segundo escenario.

**Criterio:** el de §12.4 (`reuseIfPresent`) —no abrir por la puerta de atrás lo que el resto del
diseño cierra, y no añadir un input cuando ya hay una respuesta explícita— más una regla de
seguridad: **una garantía que depende de que el usuario configure bien el pipeline no cuenta**;
tiene que ser mecánica. Además, no había un caso real que justificara asumir un modelo de
seguridad para el input (la misma razón por la que desaparecieron los nueve overrides).

**Alternativas descartadas:**

- **Fuente fuera del repositorio escaneado** (Secure File, artefacto, ruta fuera del workspace,
  variable): lo único mecánico sería rechazar rutas bajo `Build.SourcesDirectory`, y la tarea no
  puede saber de dónde salió el fichero, sólo dónde está; con varios repositorios todos caen bajo
  `s/`. Una variable con el contenido en línea es peor: las definidas en el YAML las controla
  quien edita el YAML. Seguridad por convención.
- **Sólo versión, checksums resueltos contra la fuente oficial en ejecución:** cierra la ejecución
  arbitraria (el PR sólo elige entre versiones que el upstream publicó, con la versión validada por
  regex antes de construir la URL), pero el checksum bajado del mismo release que el binario
  protege contra corrupción, no contra un release comprometido —hoy el checksum viene de una
  fuente independiente y revisada (R4)—; exige código nuevo para tres formatos de checksum
  distintos; y deja al autor del PR bajar la versión de la herramienta de escaneo dentro del rango
  soportado (`linceo doctor` sólo rechaza lo que cae fuera del rango, que es amplio).

**Coste que se acepta, y no es menor:** con los pins fijos, **un fix de seguridad en gitleaks,
trivy o checkov (o uv) obliga a esperar un release de la extensión para el modo `pypi`.** Mitigación
existente: el modo `container` con `imageTag`, donde la imagen la publica el mantenedor de linceo
y no depende del ciclo de esta extensión. La comprobación de deriva (§12.7) avisa cuando el pin
quedó atrás, pero no acelera el release.

**Disparador para reconsiderar (variante B'):** que aparezca un caso real —alguien que necesita
fijar una versión distinta, a la que no puede llegar con `imageTag` ni esperando al release—. La
vía sería un input de **sólo versión**, entre las que la extensión trae **vendorizadas con sus
checksums revisados** (`tool-pins.json` pasaría a una lista de versiones por herramienta, y la
comprobación de deriva se ampliaría a todas): el PR no podría nombrar ningún binario que no haya
pasado por revisión. Hasta que ese caso exista, no se construye.
