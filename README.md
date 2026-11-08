# mcp-canvas

Servidor MCP para Canvas LMS que, en la misma llamada con la que lee, deja las notas
correspondientes en un vault de Obsidian ya etiquetadas. No hay un segundo paso ni una herramienta
aparte que haya que acordarse de invocar: leer Canvas es sincronizar el vault.

También permite entregar tareas, con dry-run por defecto y confirmación explícita.

Sin dependencias. Node.js 18 o superior. Funciona con cualquier instancia de Canvas.

## Qué hace distinto

El etiquetado y el frontmatter los decide el **código**, no el modelo. Toda nota sincronizada sale
con la misma forma:

```yaml
---
tags:
  - segundo-semestre     # campaña, del dígito del semestre
  - canvas               # raíz, en toda nota sincronizada
  - 2026-2               # semestre detectado en el nombre o el código del curso
  - canvas/archivo       # arquetipo: curso|archivo|tarea|pagina|modulo|anuncio|discusion
tipo: archivo
course_id: 4101
file_id: 1218706
filename: guia.pdf
content_type: application/pdf
size: 473737
updated_at: "2026-08-11T19:00:42Z"
download_url: "https://canvas.example.edu/files/1218706/download?download_frd=1"
semestre: segundo semestre
---
```

Markdown y YAML planos: nada de Dataview ni Templater, así que las notas se leen igual en
cualquier instalación de Obsidian.

## Instalación

```bash
npx -y github:k0ngan/mcp_canvas
```

O desde el repo clonado:

```bash
node bin/mcp-canvas.mjs
```

### Registro en Claude Code

Un `.mcp.json` en la raíz del proyecto, sin secretos dentro:

```json
{
  "mcpServers": {
    "canvas": {
      "command": "npx",
      "args": ["-y", "github:k0ngan/mcp_canvas"],
      "env": {
        "CANVAS_BASE_URL": "https://canvas.tu-institucion.edu",
        "CANVAS_VAULT_DIR": "C:\\ruta\\a\\tu\\vault"
      }
    }
  }
}
```

`npx` guarda en caché la versión que descargó. Para forzar una nueva, apunta al commit:
`github:k0ngan/mcp_canvas#<sha>`.

### Registro en Codex

```toml
[mcp_servers.canvas]
command = "node"
args = ["bin/mcp-canvas.mjs"]
cwd = "C:\\ruta\\al\\repo\\mcp_canvas"
startup_timeout_sec = 20
tool_timeout_sec = 300
```

## La cookie

El servidor usa la cookie de sesión del navegador, no un token de API. Inicia sesión en Canvas,
copia la cookie del dominio de tu institución y guárdala **fuera del repositorio**, en
`%LOCALAPPDATA%\mcp-canvas\canvas_session`:

```text
canvas_session=VALOR
```

Acepta el valor pelado, `canvas_session=VALOR` o un header `Cookie:` completo. Para **entregar
tareas** hace falta la cookie completa, porque de ahí sale el `_csrf_token` que Canvas exige en las
operaciones de escritura; para solo leer basta con `canvas_session`.

Nunca la pegues en la configuración del MCP ni la subas a ningún repo. Cuando Canvas responda 401 o
403, vuelve a iniciar sesión y reemplaza el contenido de ese archivo.

Para otra ruta, `CANVAS_COOKIE_FILE`. Para un proceso efímero, `CANVAS_COOKIE_HEADER`.

## Variables de entorno

| Variable | Por defecto | Para qué |
|---|---|---|
| `CANVAS_BASE_URL` | — | **obligatoria**: la instancia de Canvas. También es la allowlist de origen |
| `CANVAS_COOKIE_FILE` | `%LOCALAPPDATA%\mcp-canvas\canvas_session` | archivo con la cookie de sesión |
| `CANVAS_COOKIE_HEADER` | — | cookie por entorno, tiene prioridad sobre el archivo |
| `CANVAS_VAULT_DIR` | — | raíz del vault. **Sin esto no se escribe nada**, solo se lee |
| `CANVAS_SUBDIR` | `Canvas` | carpeta de Canvas dentro del vault |
| `CANVAS_TERM_FOLDER` | `1` | agrupa los cursos en `Segundo semestre 2026` según el semestre |
| `CANVAS_OUTPUT_DIR` | `<vault>/../output/pdf` | destino de `canvas_download_pdf` y de las exportaciones |
| `CANVAS_TAGS_FILE` | `<vault>/<subdir>/vault-tags.json` | mapa `course_code` → tag temático |
| `CANVAS_VAULT_WRITE` | `1` | interruptor general de la escritura al vault |
| `CANVAS_VAULT_DRY_RUN` | `0` | simula siempre, sin tocar el disco |
| `CANVAS_EOL` | el del sistema | fin de línea de las notas **nuevas** |
| `CANVAS_UPLOAD_EXTENSIONS` | `.pdf,.sql,.pbix` | extensiones que se permiten entregar |
| `CANVAS_UPLOAD_DIR` | — | si se define, solo se pueden entregar archivos de ahí para abajo |
| `CANVAS_UPLOAD_MAX_BYTES` | `50000000` | tamaño máximo por archivo entregado |
| `CANVAS_TIMEOUT_SEC` | `30` | timeout de las llamadas a la API |
| `CANVAS_PAGE_SIZE` | `100` | tamaño de página de la API |

El token de API no se soporta a propósito: el modo cookie es el que cubre los dos usos y evita
tener otro secreto guardado en disco. `CANVAS_TOKEN` se ignora.

### Tags temáticos

`vault-tags.json` mapea el código de la asignatura a un tag. Sin mapeo no se inventa ninguno:

```json
{
  "DEMO1001": "materia-de-ejemplo",
  "DEMO2002": "otra-materia"
}
```

Ojo: activarlo añade un tag a las notas de esos cursos, así que en un vault con historia la primera
pasada reescribirá sus notas. Corre antes con `dry_run: true` para ver cuántas.

## Herramientas

Lectura, todas con write-through al vault:

| Herramienta | Qué deja en el vault |
|---|---|
| `canvas_test_connection` | nada; es la única de lectura que no escribe |
| `canvas_list_courses` | una nota de curso por curso activo y el índice del semestre |
| `canvas_list_active_tasks` | las notas de las tareas pendientes |
| `canvas_list_course_assignments` | todas las notas de tareas del curso |
| `canvas_course_inventory` | la nota de curso con los conteos por recurso |
| `canvas_course_updates` | anuncios, archivos y módulos |
| `canvas_download_pdf` | el PDF en la carpeta de salida y su nota de archivo |

Sincronización y exportación:

| Herramienta | Entrada |
|---|---|
| `canvas_sync_course` | `course_id`; opcional `download_files`, `include_announcements`, `include_discussions` |
| `canvas_sync_all_courses` | `term` (por defecto el más reciente), `all_terms`, `download_files` |
| `canvas_download_course_files` | `course_id`, `force` |
| `canvas_export_course_sources` | `course_id`: instrucciones, páginas, módulos, enlaces y adjuntos como JSON |
| `canvas_vault_status` | sin argumentos: dónde escribe y qué cursos detecta |

Todas aceptan `dry_run: true`, que devuelve el plan completo sin escribir. Cada respuesta trae un
bloque `vault` con el recuento de notas creadas, actualizadas, con cuerpo preservado y sin cambios.

## Entregar una tarea

`canvas_submit_assignment` es la única herramienta que escribe en Canvas, y lo que hace **no se
deshace**. Por eso son dos pasos obligatorios.

Primero, la validación. Sin `confirm` no se manda ni un byte:

```json
{ "course_id": 4102, "assignment_id": 68145, "file_path": "C:\\entregas\\laboratorio1.pdf" }
```

Devuelve el nombre real de la tarea, la fecha de vencimiento, el estado del envío previo, los
intentos que ya existen y los archivos que subiría. **Esa respuesta es para que la lea una persona**:
si el nombre de la tarea no es el que esperabas, el `assignment_id` está mal.

Recién después, la entrega:

```json
{ "course_id": 4102, "assignment_id": 68145, "file_path": "C:\\entregas\\laboratorio1.pdf",
  "confirm": true, "comment": "Entrega del laboratorio 1" }
```

Acepta `file_paths` con hasta 10 rutas si la tarea admite varios archivos. Antes de subir comprueba
que la tarea acepte `online_upload`, que no esté bloqueada y que el plazo no se haya cerrado; si
algo de eso falla, corta sin tocar la red de escritura.

El flujo son los 3 pasos de Canvas: pedir los parámetros de subida, subir los bytes al destino que
Canvas indique y confirmar para obtener el `file_id`. Ese destino suele ser un storage externo, y
**nunca recibe la cookie ni el token CSRF**. Al terminar, la nota de la tarea en el vault se
actualiza con el estado del envío.

## Cómo convive con las notas que ya existen

1. **Reutiliza la carpeta del curso.** Antes de crear `<course_id>-<slug>` busca una carpeta que
   ya empiece con ese `course_id` y la usa tal cual. Si hay más de una, gana la que está dentro de
   la carpeta del semestre y el resultado lo reporta como aviso.
2. **El frontmatter es del servidor; el cuerpo es tuyo.** Las notas nuevas llevan el cuerpo
   generado entre `<!-- canvas:inicio -->` y `<!-- canvas:fin -->`, con una sección `## Notas`
   debajo para lo que escribas. Al volver a sincronizar solo se regenera ese bloque. Una nota sin
   centinelas —las que venían de otro exportador— **conserva su cuerpo intacto** y solo recibe el
   frontmatter actualizado.
3. **Los tags se unen, no se reemplazan.** Se reescriben únicamente los que el servidor gestiona
   (`canvas`, `canvas/*`, `AAAA-N`, `primer|segundo-semestre` y los del mapa temático). Los que
   pusiste a mano quedan.
4. **Respeta el fin de línea de cada archivo.** Una nota en CRLF se reescribe en CRLF. Sin esto,
   una sola pasada reescribiría el vault completo sin cambiar un dato.
5. **Si nada cambió, no escribe.** La segunda pasada sobre el mismo curso reporta `sin_cambios` y
   no toca el disco.

## Seguridad

- Las peticiones solo salen hacia `CANVAS_BASE_URL` y únicamente a rutas `/api/v1/`; los enlaces de
  paginación que apunten a otro lado se rechazan.
- `redirect: "manual"` en todo. La cookie se manda solo al origen de Canvas: una descarga que
  redirige a un CDN externo, o una subida a un storage externo, viajan sin cookie.
- Toda ruta de escritura se resuelve y se verifica contra la raíz del vault o la carpeta de salida.
- Escritura atómica (archivo temporal más `rename`), tope de páginas, timeouts y límites de tamaño
  en cada transferencia.
- Los PDF descargados se validan por `content-type`, firma `%PDF-` y SHA-256 contra el archivo que
  ya exista.
- Las entregas van tras `confirm: true`, con allowlist de extensiones y límite de tamaño, y pueden
  quedar encerradas en una carpeta con `CANVAS_UPLOAD_DIR`.

## Desarrollo

```bash
npm run check   # node --check
npm test        # node --test
```

Las pruebas mockean `fetch` y escriben en carpetas temporales: no tocan Canvas, ni ningún vault, ni
suben nada. El grupo de `test/notes.test.mjs` fija el contrato de frontmatter; si falla, el servidor
dejó de hablar el idioma del vault.

## Licencia

MIT.
