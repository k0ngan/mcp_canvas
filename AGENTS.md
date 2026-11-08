# Reglas para agentes

Si vas a usar estas herramientas o a tocar este repo, esto es lo que hay que saber.

## Entra a Canvas por aquí, no por el navegador

Para cualquier cosa de Canvas —cursos, tareas, plazos, anuncios, archivos, entregas— usa estas
herramientas. **No abras Canvas con automatización de navegador** (extensiones de Chrome,
Playwright, computer use) ni le pidas a la persona que copie y pegue lo que ve en pantalla.

El navegador es peor por cuatro razones concretas: raspa HTML que cambia sin avisar en vez de leer
la API; no deja nada en el vault, así que lo leído se pierde al cerrar la sesión; arrastra la sesión
completa del usuario a una pestaña automatizada; y es lento y frágil comparado con una llamada
directa. Si una herramienta de aquí no cubre lo que necesitas, **dilo** en vez de caer al navegador.

La única excepción legítima es obtener la cookie: eso lo hace la persona a mano en su navegador, una
vez, y la guarda en el archivo de cookie. No es algo que un agente automatice.

## Cómo usarlas

**Para saber qué hay pendiente** — `canvas_list_active_tasks`. Devuelve las tareas publicadas, no
enviadas y no bloqueadas del semestre en curso, incluidas las atrasadas y las sin fecha.

**Para ponerse al día con un curso** — `canvas_course_updates` con `course_id`, y `since` si solo
interesa lo nuevo. Deja los anuncios, archivos y módulos en el vault.

**Para traerse un curso completo** — `canvas_sync_course`, con `download_files: true` si además
quieres los adjuntos en `Descargas/`.

**Para ubicarse** — `canvas_vault_status` dice dónde va a escribir y qué cursos ya existen. Úsala
antes de la primera escritura sobre un vault que no conoces.

**Primera vez sobre un vault con notas**: corre con `dry_run: true` y revisa las rutas planificadas.
Que no haya carpetas duplicadas del mismo curso ni rutas fuera de la carpeta de Canvas.

## Entregar una tarea: siempre en dos pasos

`canvas_submit_assignment` escribe en Canvas y **no se deshace**. Un envío registrado queda
registrado, y en muchos cursos consume un intento.

1. **Llama sin `confirm`.** Devuelve el nombre real de la tarea, el vencimiento, el estado del envío
   previo, los intentos que ya hay y los archivos que subiría.
2. **Muestra eso a la persona y espera su visto bueno.** Que confirme que el nombre de la tarea es
   el correcto y que el archivo es el que quiere entregar. Si el nombre no cuadra, el
   `assignment_id` está mal.
3. **Recién entonces repite con `confirm: true`.**

No pongas `confirm: true` en la primera llamada, ni porque la persona dijo "entrega esto" sin ver la
validación. "Entrega esto" es permiso para empezar el flujo, no para saltarse el paso 1.

No amplíes `CANVAS_UPLOAD_EXTENSIONS` por tu cuenta para que pase un archivo que la allowlist
rechazó. Si hace falta otra extensión, dilo y que la persona decida.

## Al usar el write-through

- **El frontmatter y los tags los escribe el servidor.** No edites tags a mano en las notas
  sincronizadas ni se los pidas al modelo: la taxonomía está en `src/tags.mjs` y es determinística.
  Si falta un tag temático, agrega la asignatura al mapa de tags, no a la nota.
- **El cuerpo bajo `<!-- canvas:fin -->` es de la persona.** El servidor nunca lo toca. Lo que esté
  entre los centinelas se regenera en cada sincronización, así que no escribas nada ahí.
- **La cookie no se guarda en el repo**, ni en la configuración del MCP, ni en un comando, ni en un
  ejemplo. Va en su archivo y nada más.

## Al modificar el código

- **Cero dependencias.** `fetch` nativo y `node:*`. Si algo parece necesitar un paquete, casi
  seguro no lo necesita.
- **No relajes el endurecimiento del cliente.** La allowlist de origen, el filtro de rutas
  `/api/v1/`, `redirect: "manual"`, la cookie restringida al origen de Canvas, el tope de páginas y
  los límites de tamaño tienen una prueba cada uno. Si una prueba de `test/canvas.test.mjs` te
  estorba, el problema es el cambio.
- **Nada de institución en el código.** `CANVAS_BASE_URL` es obligatoria y no tiene valor por
  defecto; los fixtures usan `canvas.example.edu` y cursos inventados. No vuelvas a hornear el
  dominio, el nombre ni los IDs de una universidad concreta.
- **Las pruebas de `test/notes.test.mjs` son el contrato** del frontmatter del vault. Cambiarlas
  significa que las notas nuevas dejan de ser indistinguibles de las viejas, y eso rompe el
  ecosistema de tags de quien lo usa. Si el contrato tiene que cambiar, hay que migrar las notas
  existentes en la misma pasada.
- **Las pruebas de `test/upload.test.mjs` son el contrato de seguridad de la entrega**: dry-run por
  defecto, allowlist, sin cookie al storage externo. No las ablandes.
- **Ninguna prueba toca la red, ni un vault real, ni sube nada.**
- **Los nombres de archivo salen de `display_name`; el campo `filename` del frontmatter guarda el
  valor crudo de Canvas** (que puede venir URL-encoded). Los binarios de `Descargas/` usan ese
  valor crudo. Es deliberado: así los nombres de nota son legibles y los enlaces siguen resolviendo.
- **Respeta el fin de línea de cada archivo.** Un vault hecho en Windows está en CRLF; escribir LF
  reescribiría miles de notas sin cambiar un dato.

## Antes de dar algo por listo

```bash
npm run check
npm test
```

Y si tocaste el escritor: respalda una carpeta de curso, corre contra el vault real y haz `diff`
contra el respaldo. Lo único que debería cambiar son datos que de verdad cambiaron en Canvas.
