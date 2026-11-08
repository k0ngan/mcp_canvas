import fs from "node:fs";
import path from "node:path";

import { CanvasError, numericId } from "./canvas.mjs";

// Entrega de tareas. Es la única operación de escritura hacia Canvas y no se
// deshace, así que va con dry-run por defecto: sin `confirm: true` valida todo
// y no sube nada.

export function csrfToken(cookie) {
  const match = String(cookie).match(/(?:^|;\s*)_csrf_token=([^;]+)/);
  if (!match) {
    throw new CanvasError(
      "No se encontró _csrf_token en la cookie. Vuelve a capturarla completa desde el navegador con la sesión abierta.",
    );
  }
  return decodeURIComponent(match[1]);
}

export function checkFile(config, filePath) {
  const absolute = path.resolve(filePath);
  if (config.uploadDir) {
    const root = path.resolve(config.uploadDir);
    if (absolute !== root && !absolute.startsWith(root + path.sep)) {
      throw new CanvasError(`El archivo está fuera de CANVAS_UPLOAD_DIR (${root}).`);
    }
  }
  if (!fs.existsSync(absolute)) throw new CanvasError(`No existe el archivo: ${absolute}`);
  const stat = fs.statSync(absolute);
  if (!stat.isFile()) throw new CanvasError(`La ruta no es un archivo: ${absolute}`);
  if (stat.size === 0) throw new CanvasError("El archivo está vacío.");
  if (stat.size > config.uploadMaxBytes) {
    throw new CanvasError(`El archivo supera el límite de ${config.uploadMaxBytes} bytes.`);
  }
  const extension = path.extname(absolute).toLowerCase();
  if (!config.uploadExtensions.has(extension)) {
    const permitidas = [...config.uploadExtensions].sort().join(", ");
    throw new CanvasError(
      `La extensión ${extension || "(ninguna)"} no está permitida. Permitidas: ${permitidas}. Para ampliarla, define CANVAS_UPLOAD_EXTENSIONS.`,
    );
  }
  return { absolute, size: stat.size, filename: path.basename(absolute), extension };
}

const CONTENT_TYPES = {
  ".pdf": "application/pdf",
  ".sql": "application/sql",
  ".zip": "application/zip",
  ".ipynb": "application/json",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".py": "text/x-python",
  ".tex": "application/x-tex",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

export function contentTypeFor(extension) {
  return CONTENT_TYPES[extension] || "application/octet-stream";
}

export class Uploader {
  constructor(config, client) {
    this.config = config;
    this.client = client;
  }

  get fetch() {
    return this.client.fetch;
  }

  // Paso 1: pedir a Canvas los parámetros de subida.
  async requestSlot(courseId, assignmentId, file, cookie, csrf) {
    const url = this.client.apiUrl(`/api/v1/courses/${courseId}/assignments/${assignmentId}/submissions/self/files`);
    const response = await this.fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Cookie: cookie,
        "X-CSRF-Token": csrf,
      },
      body: JSON.stringify({
        name: file.filename,
        size: file.size,
        content_type: contentTypeFor(file.extension),
      }),
      redirect: "manual",
      signal: AbortSignal.timeout(this.config.timeoutMs),
    });
    if (!response.ok) {
      throw new CanvasError(`Canvas rechazó la solicitud de subida (HTTP ${response.status}).`, response.status);
    }
    const slot = await response.json();
    if (!slot?.upload_url) throw new CanvasError("Canvas no devolvió upload_url.");
    return slot;
  }

  // Paso 2: subir los bytes al destino que Canvas indique. Ese destino puede
  // ser un storage externo, así que nunca recibe la cookie.
  async putBytes(slot, file, bytes) {
    const target = new URL(slot.upload_url);
    if (target.protocol !== "https:") throw new CanvasError("Canvas devolvió un upload_url que no es https.");

    const form = new FormData();
    for (const [key, value] of Object.entries(slot.upload_params || {})) form.append(key, value);
    form.append("file", new Blob([bytes]), file.filename);

    const response = await this.fetch(target, {
      method: "POST",
      body: form,
      redirect: "manual",
      signal: AbortSignal.timeout(this.config.downloadTimeoutMs),
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new CanvasError("La subida redirigió sin destino de confirmación.");
      return this.confirm(new URL(location, target));
    }
    if (!response.ok) throw new CanvasError(`La subida de bytes falló (HTTP ${response.status}).`, response.status);
    const fileObject = await response.json();
    if (!fileObject?.id) throw new CanvasError("Canvas no devolvió un file_id tras la subida.");
    return fileObject;
  }

  // Paso 3: confirmar la subida para obtener el file_id definitivo.
  async confirm(url) {
    if (url.protocol !== "https:") throw new CanvasError("Confirmación de subida por un canal insegura.");
    const response = await this.fetch(url, {
      headers: {
        Accept: "application/json",
        // La cookie solo viaja si la confirmación es contra el propio Canvas.
        ...(url.origin === this.config.origin ? { Cookie: this.client.cookieHeader() } : {}),
      },
      redirect: "manual",
      signal: AbortSignal.timeout(this.config.timeoutMs),
    });
    if (!response.ok) {
      throw new CanvasError(`La confirmación de la subida falló (HTTP ${response.status}).`, response.status);
    }
    const fileObject = await response.json();
    if (!fileObject?.id) throw new CanvasError("Canvas no devolvió un file_id al confirmar la subida.");
    return fileObject;
  }

  // Registra la entrega con el archivo ya subido.
  async submit(courseId, assignmentId, fileIds, cookie, csrf, comment) {
    const url = this.client.apiUrl(`/api/v1/courses/${courseId}/assignments/${assignmentId}/submissions`);
    const body = new URLSearchParams();
    body.append("submission[submission_type]", "online_upload");
    for (const id of fileIds) body.append("submission[file_ids][]", String(id));
    if (comment) body.append("comment[text_comment]", String(comment).slice(0, 2000));

    const response = await this.fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
        Cookie: cookie,
        "X-CSRF-Token": csrf,
      },
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(this.config.timeoutMs),
    });
    if (!response.ok) {
      throw new CanvasError(`El envío de la entrega falló (HTTP ${response.status}).`, response.status);
    }
    return response.json();
  }

  // Comprueba que la tarea acepte la entrega antes de tocar nada.
  verifyAssignment(assignment) {
    const problemas = [];
    if (assignment.locked_for_user) problemas.push("la tarea está bloqueada para este usuario");
    const tipos = assignment.submission_types || [];
    if (!tipos.includes("online_upload")) {
      problemas.push(`la tarea no acepta online_upload (acepta: ${tipos.join(", ") || "ninguno"})`);
    }
    if (assignment.lock_at && Date.parse(assignment.lock_at) < Date.now()) {
      problemas.push(`el plazo se cerró el ${assignment.lock_at}`);
    }
    return problemas;
  }

  async run({ courseId, assignmentId, filePaths, confirm, comment }) {
    const curso = numericId(courseId);
    const tarea = numericId(assignmentId);
    const rutas = (Array.isArray(filePaths) ? filePaths : [filePaths]).filter(Boolean);
    if (!rutas.length) throw new CanvasError("Se requiere al menos un archivo.");
    if (rutas.length > 10) throw new CanvasError("Máximo 10 archivos por entrega.");

    const archivos = rutas.map(ruta => checkFile(this.config, ruta));
    const assignment = await this.client.assignment(curso, tarea);
    const problemas = this.verifyAssignment(assignment);

    const plan = {
      course_id: curso,
      assignment_id: tarea,
      tarea: assignment.name,
      vence: assignment.due_at || null,
      bloquea: assignment.lock_at || null,
      estado_actual: assignment.submission?.workflow_state || "sin envío previo",
      intentos_previos: assignment.submission?.attempt ?? 0,
      archivos: archivos.map(file => ({ ruta: file.absolute, nombre: file.filename, bytes: file.size })),
      bloqueos: problemas,
    };

    if (problemas.length) {
      throw new CanvasError(`Canvas no aceptaría esta entrega: ${problemas.join("; ")}.`);
    }

    if (confirm !== true) {
      return {
        ...plan,
        enviado: false,
        dry_run: true,
        nota: "Nada se subió. Repite la llamada con confirm: true para entregar de verdad. Revisa antes el nombre de la tarea, la fecha y los archivos.",
      };
    }

    const cookie = this.client.cookieHeader();
    const csrf = csrfToken(cookie);
    const subidos = [];
    for (const file of archivos) {
      const bytes = fs.readFileSync(file.absolute);
      const slot = await this.requestSlot(curso, tarea, file, cookie, csrf);
      const fileObject = await this.putBytes(slot, file, bytes);
      subidos.push({ file_id: fileObject.id, nombre: file.filename, bytes: file.size });
    }
    const submission = await this.submit(curso, tarea, subidos.map(f => f.file_id), cookie, csrf, comment);

    return {
      ...plan,
      enviado: true,
      dry_run: false,
      subidos,
      submission: {
        id: submission.id,
        workflow_state: submission.workflow_state,
        submitted_at: submission.submitted_at,
        attempt: submission.attempt,
        late: Boolean(submission.late),
      },
    };
  }
}
