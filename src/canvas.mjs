import fs from "node:fs";

// Cliente de lectura para Canvas. El endurecimiento viene de canvas-cookie-mcp
// y no se relaja: origen en allowlist, solo rutas /api/v1/, redirecciones
// manuales y la cookie nunca sale del dominio de Canvas.

export class CanvasError extends Error {
  constructor(message, status = null) {
    super(message);
    this.name = "CanvasError";
    this.status = status;
  }
}

export class CanvasClient {
  constructor(config, fetchImpl = globalThis.fetch) {
    this.config = config;
    this.fetch = fetchImpl;
    this.cached = null;
  }

  cookieHeader() {
    if (this.cached) return this.cached;
    let value = this.config.cookieHeaderEnv;
    if (!value && fs.existsSync(this.config.cookieFile)) {
      const stat = fs.statSync(this.config.cookieFile);
      if (stat.size > this.config.maxCookieBytes) {
        throw new CanvasError("El archivo de cookies es demasiado grande.");
      }
      value = fs.readFileSync(this.config.cookieFile, "utf8").trim();
    }
    if (!value) {
      throw new CanvasError(`Falta la cookie de Canvas. Guarda canvas_session en ${this.config.cookieFile}.`);
    }
    value = value
      .replace(/^CANVAS_COOKIE_HEADER\s*=\s*/i, "")
      .replace(/^Cookie:\s*/i, "")
      .trim();
    if (/^[\w+.-]+$/.test(value)) value = `canvas_session=${value}`;
    if (/[\r\n]/.test(value) || !/(^|;\s*)canvas_session=/.test(value)) {
      throw new CanvasError("La cookie debe contener canvas_session.");
    }
    this.cached = value;
    return value;
  }

  apiUrl(relativeOrAbsolute) {
    const url = new URL(relativeOrAbsolute, this.config.baseUrl);
    if (url.origin !== this.config.origin || !url.pathname.startsWith("/api/v1/")) {
      throw new CanvasError("Canvas devolvió una URL fuera de la API configurada.");
    }
    return url;
  }

  async getJson(url) {
    const target = this.apiUrl(url);
    const response = await this.fetch(target, {
      headers: { Accept: "application/json", Cookie: this.cookieHeader() },
      redirect: "manual",
      signal: AbortSignal.timeout(this.config.timeoutMs),
    });
    if (response.status === 401 || response.status === 403) {
      throw new CanvasError(
        `Canvas rechazó la sesión (${response.status}). Actualiza canvas_session en ${this.config.cookieFile}.`,
        response.status,
      );
    }
    if (!response.ok) {
      throw new CanvasError(`Canvas respondió ${response.status} en ${target.pathname}.`, response.status);
    }
    const type = response.headers.get("content-type") || "";
    if (!type.includes("application/json")) {
      throw new CanvasError("Canvas no devolvió JSON; la sesión puede haber caducado.");
    }
    return { data: await response.json(), next: nextLink(response.headers.get("link")) };
  }

  async list(url) {
    const results = [];
    let next = url;
    for (let page = 0; next && page < this.config.maxPages; page++) {
      const reply = await this.getJson(next);
      if (!Array.isArray(reply.data)) throw new CanvasError("Canvas devolvió una respuesta inesperada.");
      results.push(...reply.data);
      next = reply.next;
    }
    if (next) throw new CanvasError("Canvas superó el límite de páginas; la lista puede estar incompleta.");
    return results;
  }

  // Descarga siguiendo redirecciones a mano. La cookie solo viaja al origen de
  // Canvas; los enlaces firmados a CDN externo no la reciben.
  async download(rawUrl, maxBytes) {
    let url = new URL(rawUrl);
    if (url.origin !== this.config.origin) {
      throw new CanvasError("URL inicial de descarga fuera de Canvas.");
    }
    let response;
    for (let step = 0; step < 6; step++) {
      response = await this.fetch(url, {
        headers: url.origin === this.config.origin ? { Cookie: this.cookieHeader() } : {},
        redirect: "manual",
        signal: AbortSignal.timeout(this.config.downloadTimeoutMs),
      });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers.get("location");
      if (!location) throw new CanvasError("Redirección de descarga sin destino.");
      url = new URL(location, url);
      if (url.protocol !== "https:") throw new CanvasError("Redirección de descarga insegura.");
    }
    if (!response.ok || response.status >= 300) {
      throw new CanvasError(`Descarga HTTP ${response.status}.`, response.status);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > maxBytes) throw new CanvasError("El archivo descargado supera el límite permitido.");
    return { bytes, contentType: response.headers.get("content-type") || "" };
  }

  get page() {
    return `per_page=${this.config.pageSize}`;
  }

  async courses() {
    const includes = "include%5B%5D=term&include%5B%5D=syllabus_body";
    const items = await this.list(`/api/v1/courses?enrollment_state=active&${includes}&${this.page}`);
    return items.filter(course => course.id && course.workflow_state !== "deleted");
  }

  async course(courseId) {
    const id = numericId(courseId);
    return (await this.getJson(`/api/v1/courses/${id}?include%5B%5D=syllabus_body&include%5B%5D=term`)).data;
  }

  assignments(courseId) {
    const id = numericId(courseId);
    return this.list(`/api/v1/courses/${id}/assignments?${this.page}&include%5B%5D=submission`);
  }

  assignment(courseId, assignmentId) {
    const id = numericId(courseId);
    const aid = numericId(assignmentId);
    return this.getJson(`/api/v1/courses/${id}/assignments/${aid}?include%5B%5D=submission`).then(r => r.data);
  }

  modules(courseId) {
    const id = numericId(courseId);
    return this.list(`/api/v1/courses/${id}/modules?${this.page}&include%5B%5D=items`);
  }

  pages(courseId) {
    const id = numericId(courseId);
    return this.list(`/api/v1/courses/${id}/pages?${this.page}`);
  }

  pageDetail(courseId, pageUrl) {
    const id = numericId(courseId);
    return this.getJson(`/api/v1/courses/${id}/pages/${encodeURIComponent(pageUrl)}`).then(r => r.data);
  }

  files(courseId) {
    const id = numericId(courseId);
    return this.list(`/api/v1/courses/${id}/files?${this.page}`);
  }

  file(courseId, fileId) {
    const id = numericId(courseId);
    const fid = numericId(fileId);
    return this.getJson(`/api/v1/courses/${id}/files/${fid}`).then(r => r.data);
  }

  announcements(courseId) {
    const id = numericId(courseId);
    return this.list(`/api/v1/announcements?context_codes%5B%5D=course_${id}&${this.page}`);
  }

  discussions(courseId) {
    const id = numericId(courseId);
    return this.list(`/api/v1/courses/${id}/discussion_topics?${this.page}`);
  }

  profile() {
    return this.getJson("/api/v1/users/self/profile").then(r => r.data);
  }
}

export function nextLink(header) {
  for (const part of (header || "").split(",")) {
    const match = part.match(/<([^>]+)>;\s*rel="next"/);
    if (match) return match[1];
  }
  return null;
}

export function numericId(value) {
  if (!/^\d+$/.test(String(value)) || Number(value) < 1) {
    throw new CanvasError("Se requiere un ID numérico positivo.");
  }
  return Number(value);
}

export function courseSummary(course, baseUrl) {
  return {
    id: course.id,
    name: course.name,
    code: course.course_code,
    url: `${baseUrl}/courses/${course.id}`,
  };
}
