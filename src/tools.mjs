import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

import { CanvasClient, CanvasError, courseSummary, numericId } from "./canvas.mjs";
import { describeConfig } from "./config.mjs";
import { detectTerm, latestTerm, termParts } from "./tags.mjs";
import { VaultWriter, commonTagContext, sanitizeName } from "./vault.mjs";
import { Uploader } from "./upload.mjs";
import { get as frontmatterGet, parse as parseFrontmatter } from "./frontmatter.mjs";
import * as notes from "./notes.mjs";
import * as study from "./study.mjs";

const TERM_ARG = /^20\d{2}-[12]$/;

function contextFor(course, config) {
  return {
    ...commonTagContext(course, config),
    courseId: Number(course.id),
    baseUrl: config.baseUrl,
  };
}

function assignmentSummary(item, course, baseUrl) {
  const submission = item.submission || null;
  return {
    id: item.id,
    course_id: course.id,
    course: course.name,
    name: item.name,
    due_at: item.due_at || null,
    lock_at: item.lock_at || null,
    points_possible: item.points_possible ?? null,
    submission_types: item.submission_types || [],
    locked_for_user: Boolean(item.locked_for_user),
    submission_state: submission?.workflow_state || null,
    submitted_at: submission?.submitted_at || null,
    url: item.html_url || `${baseUrl}/courses/${course.id}/assignments/${item.id}`,
  };
}

function isPending(item, now) {
  if (item.published === false) return false;
  if (item.locked_for_user) return false;
  if (item.submission_types?.length === 1 && item.submission_types[0] === "none") return false;
  const state = item.submission?.workflow_state;
  if (state === "submitted" || state === "graded") return false;
  if (item.lock_at && Date.parse(item.lock_at) < now) return false;
  return true;
}

// Escritura fuera del vault (output/pdf, exportaciones JSON). Siempre bajo la
// raíz declarada: cualquier ruta que escape se rechaza.
function writeUnder(root, relative, data) {
  const absolute = path.resolve(root, relative);
  const base = path.resolve(root);
  if (absolute !== base && !absolute.startsWith(base + path.sep)) {
    throw new CanvasError(`Ruta fuera de la carpeta de salida: ${relative}`);
  }
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  const temporary = `${absolute}.${randomUUID()}.part`;
  try {
    fs.writeFileSync(temporary, data, { flag: "wx" });
    fs.renameSync(temporary, absolute);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
  return absolute;
}

export class Toolbox {
  constructor(config, fetchImpl) {
    this.config = config;
    this.client = new CanvasClient(config, fetchImpl);
  }

  writer(args = {}) {
    return new VaultWriter(this.config, { dryRun: Boolean(args.dry_run) });
  }

  async courseById(courseId) {
    const id = numericId(courseId);
    const found = (await this.client.courses()).find(course => Number(course.id) === id);
    if (found) return found;
    return this.client.course(id);
  }

  // --- conexión ----------------------------------------------------------

  async testConnection() {
    const profile = await this.client.profile();
    return { connected: true, user_id: profile.id, name: profile.name, base_url: this.config.baseUrl };
  }

  // --- cursos ------------------------------------------------------------

  async listCourses(args) {
    const courses = await this.client.courses();
    const writer = this.writer(args);
    if (writer.enabled) {
      for (const course of courses) {
        const folder = writer.courseFolder(course);
        const note = notes.courseNote(course, folder, contextFor(course, this.config), null);
        writer.upsert(note.relativePath, note);
      }
      this.writeTermIndex(writer, courses);
    }
    return {
      cursos: courses.map(course => courseSummary(course, this.config.baseUrl)),
      vault: writer.report(),
    };
  }

  writeTermIndex(writer, courses) {
    if (!writer.enabled || !this.config.termFolder) return;
    const groups = new Map();
    for (const course of courses) {
      const term = detectTerm(course);
      if (!term) continue;
      if (!groups.has(term)) groups.set(term, []);
      groups.get(term).push(course);
    }
    const stamp = new Date().toISOString().replace("T", " ").slice(0, 16) + " UTC";
    for (const [term, group] of groups) {
      const parts = termParts(term);
      if (!parts) continue;
      const sorted = group.slice().sort((a, b) => String(a.name).localeCompare(String(b.name)));
      const folders = sorted.map(course => writer.courseFolder(course));
      const note = notes.termIndexNote(this.config, parts, sorted, folders, stamp);
      writer.upsert(note.relativePath, note);
    }
  }

  // --- tareas ------------------------------------------------------------

  async listActiveTasks(args) {
    if (args.term && !TERM_ARG.test(args.term)) {
      throw new CanvasError("term debe tener formato AAAA-1 o AAAA-2.");
    }
    const all = await this.client.courses();
    const term = args.term || latestTerm(all);
    const selected = args.course_id == null
      ? all.filter(course => args.all_terms || !term || detectTerm(course) === term)
      : [all.find(course => Number(course.id) === Number(args.course_id))
          || { id: Number(args.course_id), name: `Curso ${args.course_id}` }];

    const writer = this.writer(args);
    const now = Date.now();
    const tasks = [];
    const errors = [];
    for (const course of selected) {
      try {
        const items = await this.client.assignments(course.id);
        const pending = items.filter(item => isPending(item, now));
        tasks.push(...pending.map(item => assignmentSummary(item, course, this.config.baseUrl)));
        this.writeAssignments(writer, course, pending);
      } catch (error) {
        errors.push({ course_id: course.id, error: error.message });
      }
    }
    tasks.sort((a, b) => (a.due_at || "9999").localeCompare(b.due_at || "9999"));
    return {
      checked_at: new Date(now).toISOString(),
      term: args.all_terms ? "all" : term,
      courses_checked: selected.length,
      tasks,
      errors,
      vault: writer.report(),
    };
  }

  async listCourseAssignments(args) {
    const course = await this.courseById(args.course_id);
    const items = await this.client.assignments(course.id);
    const writer = this.writer(args);
    this.writeAssignments(writer, course, items);
    return {
      tareas: items.map(item => assignmentSummary(item, course, this.config.baseUrl)),
      vault: writer.report(),
    };
  }

  writeAssignments(writer, course, items) {
    if (!writer.enabled || !items.length) return;
    const folder = writer.courseFolder(course);
    const ctx = contextFor(course, this.config);
    for (const item of items) {
      const note = notes.assignmentNote(item, folder, ctx);
      writer.upsert(note.relativePath, note);
    }
  }

  // --- inventario --------------------------------------------------------

  async courseInventory(args) {
    const all = await this.client.courses();
    const term = args.term || latestTerm(all);
    if (args.term && !TERM_ARG.test(args.term)) {
      throw new CanvasError("term debe tener formato AAAA-1 o AAAA-2.");
    }
    const selected = args.course_id != null
      ? all.filter(course => Number(course.id) === Number(args.course_id))
      : all.filter(course => detectTerm(course) === term);

    const writer = this.writer(args);
    const results = [];
    for (const course of selected) {
      const inventory = {};
      const errors = {};
      const resources = {
        modules: () => this.client.modules(course.id),
        pages: () => this.client.pages(course.id),
        assignments: () => this.client.assignments(course.id),
        files: () => this.client.files(course.id),
        announcements: () => this.client.announcements(course.id),
        discussions: () => this.client.discussions(course.id),
      };
      for (const [name, load] of Object.entries(resources)) {
        try {
          inventory[name] = await load();
        } catch (error) {
          errors[name] = error.message;
          inventory[name] = [];
        }
      }
      if (writer.enabled) {
        const folder = writer.courseFolder(course);
        const note = notes.courseNote(course, folder, contextFor(course, this.config), inventory);
        writer.upsert(note.relativePath, note);
      }
      results.push({
        ...courseSummary(course, this.config.baseUrl),
        counts: Object.fromEntries(Object.entries(inventory).map(([k, v]) => [k, v.length])),
        errors,
      });
    }
    return { term, cursos: results, vault: writer.report() };
  }

  // --- novedades ---------------------------------------------------------

  async courseUpdates(args) {
    const course = await this.courseById(args.course_id);
    const since = args.since == null ? null : Date.parse(args.since);
    if (args.since != null && !Number.isFinite(since)) {
      throw new CanvasError("since debe ser una fecha válida.");
    }
    const errores = {};
    const load = async (name, loader) => {
      try {
        return await loader();
      } catch (error) {
        errores[name] = error.message;
        return [];
      }
    };
    const [announcements, files, modules] = await Promise.all([
      load("announcements", () => this.client.announcements(course.id)),
      load("files", () => this.client.files(course.id)),
      load("modules", () => this.client.modules(course.id)),
    ]);
    const recent = date => !since || (date && Date.parse(date) >= since);

    const writer = this.writer(args);
    const folder = writer.enabled ? writer.courseFolder(course) : null;
    const ctx = contextFor(course, this.config);
    if (writer.enabled) {
      const resolver = notes.moduleItemResolver({ files });
      for (const announcement of announcements) {
        const note = notes.announcementNote(announcement, folder, ctx);
        writer.upsert(note.relativePath, note);
      }
      for (const file of files) {
        const note = notes.fileNote(file, folder, ctx, { downloaded: this.hasDownload(folder, file) });
        writer.upsert(note.relativePath, note);
      }
      for (const module of modules) {
        const note = notes.moduleNote(module, folder, ctx, resolver);
        writer.upsert(note.relativePath, note);
      }
    }

    return {
      course_id: Number(course.id),
      checked_at: new Date().toISOString(),
      announcements: announcements.filter(a => recent(a.posted_at || a.created_at)).map(a => ({
        id: a.id,
        title: a.title,
        posted_at: a.posted_at,
        url: a.html_url,
        text: notes.htmlToText(a.message),
      })).sort((a, b) => String(b.posted_at).localeCompare(String(a.posted_at))),
      files: files.filter(f => recent(f.updated_at || f.created_at)).map(f => ({
        id: f.id,
        name: f.display_name || f.filename,
        created_at: f.created_at,
        updated_at: f.updated_at,
        content_type: f["content-type"],
        size: f.size,
      })).sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at))),
      errores,
      modules: modules.map(m => ({
        id: m.id,
        name: m.name,
        items: (m.items || []).map(i => ({ id: i.id, title: i.title, type: i.type, content_id: i.content_id })),
      })),
      vault: writer.report(),
    };
  }

  hasDownload(folder, file) {
    if (!folder || !this.config.vaultDir) return false;
    const target = path.join(folder.absolute, "Descargas", notes.downloadName(file));
    return fs.existsSync(target);
  }

  // --- sincronización completa ------------------------------------------

  async syncCourse(args) {
    const base = await this.courseById(args.course_id);
    const course = await this.client.course(base.id);
    const writer = this.writer(args);
    const detail = await this.loadCourse(course.id, {
      includeAnnouncements: args.include_announcements !== false,
      includeDiscussions: args.include_discussions !== false,
      pageBodies: true,
    });
    const result = await this.writeCourse(writer, course, detail, {
      downloadFiles: Boolean(args.download_files),
    });
    this.writeTermIndex(writer, [course]);
    return {
      curso: courseSummary(course, this.config.baseUrl),
      ...result,
      errores: detail.errores,
      vault: writer.report(),
    };
  }

  async syncAllCourses(args) {
    const all = await this.client.courses();
    if (args.term && !TERM_ARG.test(args.term)) {
      throw new CanvasError("term debe tener formato AAAA-1 o AAAA-2.");
    }
    const term = args.term || latestTerm(all);
    const selected = args.all_terms ? all : all.filter(course => detectTerm(course) === term);
    const writer = this.writer(args);
    const resumen = [];
    const errores = [];
    for (const summary of selected) {
      try {
        const course = await this.client.course(summary.id);
        const detail = await this.loadCourse(course.id, {
          includeAnnouncements: args.include_announcements !== false,
          includeDiscussions: args.include_discussions !== false,
          pageBodies: args.page_bodies !== false,
        });
        const written = await this.writeCourse(writer, course, detail, {
          downloadFiles: Boolean(args.download_files),
        });
        resumen.push({ course_id: course.id, name: course.name, ...written });
      } catch (error) {
        errores.push({ course_id: summary.id, error: error.message });
      }
    }
    this.writeTermIndex(writer, selected);
    return { term: args.all_terms ? "all" : term, cursos: resumen, errores, vault: writer.report() };
  }

  // Un recurso deshabilitado en el curso responde 404 y no debe tumbar la
  // sincronización completa: se anota el error y se sigue con el resto.
  async loadCourse(courseId, { includeAnnouncements, includeDiscussions, pageBodies }) {
    const errores = {};
    const load = async (name, loader) => {
      try {
        return await loader();
      } catch (error) {
        errores[name] = error.message;
        return [];
      }
    };

    const [modules, pages, assignments, files] = await Promise.all([
      load("modules", () => this.client.modules(courseId)),
      load("pages", () => this.client.pages(courseId)),
      load("assignments", () => this.client.assignments(courseId)),
      load("files", () => this.client.files(courseId)),
    ]);
    const announcements = includeAnnouncements
      ? await load("announcements", () => this.client.announcements(courseId))
      : [];
    const discussions = includeDiscussions
      ? await load("discussions", () => this.client.discussions(courseId))
      : [];

    let detailedPages = pages;
    if (pageBodies && pages.length) {
      detailedPages = [];
      for (const page of pages) {
        try {
          detailedPages.push(await this.client.pageDetail(courseId, page.url));
        } catch {
          detailedPages.push(page);
        }
      }
    }
    return { modules, pages: detailedPages, assignments, files, announcements, discussions, errores };
  }

  async writeCourse(writer, course, detail, { downloadFiles }) {
    if (!writer.enabled) return { descargas: 0 };
    const folder = writer.courseFolder(course);
    const ctx = contextFor(course, this.config);
    const resolver = notes.moduleItemResolver(detail);

    let descargas = 0;
    for (const file of detail.files) {
      let downloaded = this.hasDownload(folder, file);
      if (downloadFiles && !downloaded && !writer.dryRun) {
        try {
          if (!file.url) throw new CanvasError("El archivo no trae URL de descarga.");
          if ((file.size ?? 0) > this.config.maxFileBytes) throw new CanvasError("El archivo supera el límite permitido.");
          const { bytes } = await this.client.download(file.url, this.config.maxFileBytes);
          writer.writeBinary(path.join(folder.relative, "Descargas", notes.downloadName(file)), bytes);
          downloaded = true;
          descargas++;
        } catch (error) {
          writer.avisos.push({ file_id: file.id, error: error.message });
        }
      }
      const note = notes.fileNote(file, folder, ctx, { downloaded });
      writer.upsert(note.relativePath, note);
    }
    for (const assignment of detail.assignments) {
      const note = notes.assignmentNote(assignment, folder, ctx);
      writer.upsert(note.relativePath, note);
    }
    for (const page of detail.pages) {
      const note = notes.pageNote(page, folder, ctx);
      writer.upsert(note.relativePath, note);
    }
    for (const module of detail.modules) {
      const note = notes.moduleNote(module, folder, ctx, resolver);
      writer.upsert(note.relativePath, note);
    }
    for (const announcement of detail.announcements) {
      const note = notes.announcementNote(announcement, folder, ctx);
      writer.upsert(note.relativePath, note);
    }
    for (const discussion of detail.discussions) {
      const note = notes.discussionNote(discussion, folder, ctx);
      writer.upsert(note.relativePath, note);
    }
    const courseNote = notes.courseNote(course, folder, ctx, detail);
    writer.upsert(courseNote.relativePath, courseNote);
    return { descargas, carpeta: folder.wiki, carpeta_reutilizada: folder.reutilizada };
  }

  // --- descargas ---------------------------------------------------------

  async downloadCourseFiles(args) {
    const course = await this.courseById(args.course_id);
    const files = await this.client.files(course.id);
    const writer = this.writer(args);
    if (!writer.enabled) throw new CanvasError("Se requiere CANVAS_VAULT_DIR para guardar las descargas.");
    const folder = writer.courseFolder(course);
    const ctx = contextFor(course, this.config);
    const errores = [];
    let descargados = 0;
    for (const file of files) {
      let downloaded = this.hasDownload(folder, file);
      if ((!downloaded || args.force) && !writer.dryRun) {
        try {
          if (!file.url) throw new CanvasError("El archivo no trae URL de descarga.");
          if ((file.size ?? 0) > this.config.maxFileBytes) throw new CanvasError("El archivo supera el límite permitido.");
          const { bytes } = await this.client.download(file.url, this.config.maxFileBytes);
          writer.writeBinary(path.join(folder.relative, "Descargas", notes.downloadName(file)), bytes);
          downloaded = true;
          descargados++;
        } catch (error) {
          errores.push({ file_id: file.id, error: error.message });
        }
      }
      const note = notes.fileNote(file, folder, ctx, { downloaded });
      writer.upsert(note.relativePath, note);
    }
    return { course_id: Number(course.id), archivos: files.length, descargados, errores, vault: writer.report() };
  }

  async downloadPdf(args) {
    const courseId = numericId(args.course_id);
    const fileId = numericId(args.file_id);
    const listed = await this.client.files(courseId);
    if (!listed.some(file => Number(file.id) === fileId)) {
      throw new CanvasError("El archivo no pertenece a este curso.");
    }
    const metadata = await this.client.file(courseId, fileId);
    if (metadata["content-type"] !== "application/pdf" || !metadata.url) {
      throw new CanvasError("El archivo no es un PDF descargable.");
    }
    if (metadata.size > this.config.maxPdfBytes) {
      throw new CanvasError("El PDF supera el límite permitido.");
    }
    const { bytes } = await this.client.download(metadata.url, this.config.maxPdfBytes);
    if (bytes.subarray(0, 5).toString() !== "%PDF-") {
      throw new CanvasError("El contenido descargado no es un PDF.");
    }
    const safeName = sanitizeName(metadata.display_name || metadata.filename || "archivo.pdf", "archivo.pdf");
    const basename = `canvas_${courseId}_${fileId}_${safeName.replace(/\.pdf$/i, "")}.pdf`;
    const destination = path.join(this.config.outputDir, basename);
    const sha256 = createHash("sha256").update(bytes).digest("hex");

    let alreadyPresent = false;
    if (fs.existsSync(destination)) {
      const existing = createHash("sha256").update(fs.readFileSync(destination)).digest("hex");
      if (existing !== sha256) throw new CanvasError("Ya existe un archivo con ese nombre y contenido distinto.");
      alreadyPresent = true;
    } else {
      writeUnder(this.config.outputDir, basename, bytes);
    }

    const writer = this.writer(args);
    if (writer.enabled) {
      const course = await this.courseById(courseId);
      const folder = writer.courseFolder(course);
      const ctx = contextFor(course, this.config);
      const note = notes.fileNote(metadata, folder, ctx, { downloaded: this.hasDownload(folder, metadata) });
      note.entries.push(["downloaded_to", destination]);
      writer.upsert(note.relativePath, note);
    }

    return {
      course_id: courseId,
      file_id: fileId,
      path: destination,
      bytes: bytes.length,
      sha256,
      already_present: alreadyPresent,
      vault: writer.report(),
    };
  }

  // --- exportación de fuentes -------------------------------------------

  async exportCourseSources(args) {
    const courseId = numericId(args.course_id);
    const root = path.join(this.config.outputDir, "..", "fuentes_canvas", String(courseId));
    const [assignments, pages, modules] = await Promise.all([
      this.client.assignments(courseId),
      this.client.pages(courseId),
      this.client.modules(courseId),
    ]);
    const links = [];
    const collect = (html, source) => {
      for (const match of String(html || "").matchAll(/\b(?:href|src|data-api-endpoint)\s*=\s*["']([^"']+)["']/gi)) {
        let url = match[1].replace(/&amp;/g, "&");
        if (url.startsWith("/")) url = new URL(url, this.config.baseUrl).href;
        if (/^https?:\/\//.test(url)) links.push({ source, url });
      }
    };

    for (const assignment of assignments) {
      const full = await this.client.assignment(courseId, assignment.id);
      writeUnder(root, path.join("tareas", `${assignment.id}.json`), JSON.stringify(full, null, 2));
      collect(full.description, `tarea:${assignment.id}`);
    }
    for (const page of pages) {
      const full = await this.client.pageDetail(courseId, page.url);
      writeUnder(root, path.join("paginas", `${page.page_id}.json`), JSON.stringify(full, null, 2));
      collect(full.body, `pagina:${page.page_id}`);
    }
    writeUnder(root, "modulos.json", JSON.stringify(modules, null, 2));
    writeUnder(root, "enlaces.json", JSON.stringify(links, null, 2));

    const pattern = new RegExp(`/api/v1/courses/${courseId}/files/(\\d+)`);
    const fileIds = [...new Set(links.map(link => link.url.match(pattern)?.[1]).filter(Boolean))];
    const errores = [];
    let descargados = 0;
    for (const id of fileIds) {
      try {
        const metadata = await this.client.file(courseId, id);
        writeUnder(root, path.join("archivos_metadata", `${id}.json`), JSON.stringify(metadata, null, 2));
        if (!metadata.url) throw new CanvasError("Archivo sin URL.");
        if ((metadata.size ?? 0) > this.config.maxFileBytes) throw new CanvasError("Archivo sobre el límite permitido.");
        const name = `${id}-${sanitizeName(metadata.filename || metadata.display_name || `archivo-${id}`)}`;
        const target = path.resolve(root, "archivos", name);
        if (fs.existsSync(target) && fs.statSync(target).size === metadata.size) {
          descargados++;
          continue;
        }
        const { bytes } = await this.client.download(metadata.url, this.config.maxFileBytes);
        writeUnder(root, path.join("archivos", name), bytes);
        descargados++;
      } catch (error) {
        errores.push({ id, error: error.message });
      }
    }

    return {
      course_id: courseId,
      tareas: assignments.length,
      paginas: pages.length,
      modulos: modules.length,
      enlaces: links.length,
      archivos_referenciados: fileIds.length,
      archivos_descargados: descargados,
      errores,
      destino: path.resolve(root),
    };
  }

  // --- entrega de tareas -------------------------------------------------

  // La única operación que escribe en Canvas. Sin `confirm: true` solo valida.
  async submitAssignment(args) {
    const uploader = new Uploader(this.config, this.client);
    const result = await uploader.run({
      courseId: args.course_id,
      assignmentId: args.assignment_id,
      filePaths: args.file_path ?? args.file_paths,
      confirm: args.confirm,
      comment: args.comment,
    });

    const writer = this.writer(args);
    if (result.enviado && writer.enabled) {
      try {
        const course = await this.courseById(args.course_id);
        const assignment = await this.client.assignment(course.id, args.assignment_id);
        const folder = writer.courseFolder(course);
        const note = notes.assignmentNote(assignment, folder, contextFor(course, this.config));
        writer.upsert(note.relativePath, note);
      } catch (error) {
        writer.avisos.push({ aviso: "la entrega se registró pero no se pudo actualizar la nota", error: error.message });
      }
    }
    return { ...result, vault: writer.report() };
  }

  // --- material de estudio -----------------------------------------------

  // Junta el material ya sincronizado, con su procedencia. No redacta nada:
  // la prosa la escribe el agente, citando solo estas fuentes.
  async studySources(args) {
    const course = await this.courseLocal(args.course_id);
    const writer = this.writer({ dry_run: true });
    if (!writer.enabled) {
      throw new CanvasError("Se requiere CANVAS_VAULT_DIR: las guías se arman con el material del vault.");
    }
    const folder = writer.courseFolder(course);
    const paquete = study.collectSources(folder, {
      tema: args.tema || "",
      fileIds: args.file_ids || null,
      tipos: args.tipos || null,
      maxChars: Math.min(Number(args.max_chars) || 60_000, 400_000),
    });
    return { curso: { id: Number(course.id), name: course.name }, ...paquete };
  }

  async writeStudyGuide(args) {
    const course = await this.courseLocal(args.course_id);
    const writer = this.writer(args);
    if (!writer.enabled) {
      throw new CanvasError("Se requiere CANVAS_VAULT_DIR para escribir la guía.");
    }
    const folder = writer.courseFolder(course);
    const catalogo = study.inventory(folder).map(fuente => ({
      cita: fuente.cita,
      nota: fuente.nota,
      titulo: fuente.titulo,
    }));
    if (!catalogo.length) {
      throw new CanvasError(
        `No hay material sincronizado en ${folder.wiki}. Corre canvas_sync_course antes de escribir la guía.`,
      );
    }

    const note = study.buildGuideNote(folder, contextFor(course, this.config), {
      titulo: args.titulo,
      secciones: args.secciones,
      catalogo,
      tagsExtra: args.tags || [],
      fechaPrueba: args.fecha_prueba || null,
      hora: args.hora || null,
      sala: args.sala || null,
      tema: args.tema || null,
    });
    const resultado = writer.upsert(note.relativePath, note);
    return {
      curso: { id: Number(course.id), name: course.name },
      guia: note.relativePath.split(path.sep).join("/"),
      estado: resultado.estado,
      citas: note.citas,
      secciones: args.secciones.length,
      vault: writer.report(),
    };
  }

  // Resuelve el curso sin pegarle a Canvas si el vault ya lo tiene: las guías
  // se arman con material local y no deberían fallar por una cookie vencida.
  async courseLocal(courseId) {
    const id = numericId(courseId);
    if (this.config.vaultDir) {
      const writer = new VaultWriter(this.config, { dryRun: true });
      const existente = writer.findExisting(id, null);
      if (existente) {
        const curso = path.join(this.config.vaultDir, existente, "Curso.md");
        if (fs.existsSync(curso)) {
          const parsed = parseFrontmatter(fs.readFileSync(curso, "utf8"));
          const nombre = String(parsed.body).match(/^#\s+(.+)$/m)?.[1]?.trim();
          return {
            id,
            name: nombre || `Curso ${id}`,
            course_code: frontmatterGet(parsed.entries, "course_code") || null,
          };
        }
      }
    }
    return this.courseById(id);
  }

  // --- estado ------------------------------------------------------------

  async vaultStatus() {
    const writer = this.writer({ dry_run: true });
    const estado = describeConfig(this.config);
    const carpetas = [];
    if (this.config.vaultDir && fs.existsSync(writer.root)) {
      for (const entry of fs.readdirSync(writer.root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (/^\d+-/.test(entry.name)) {
          carpetas.push(`${this.config.subdir}/${entry.name}`);
          continue;
        }
        for (const child of fs.readdirSync(path.join(writer.root, entry.name), { withFileTypes: true })) {
          if (child.isDirectory() && /^\d+-/.test(child.name)) {
            carpetas.push(`${this.config.subdir}/${entry.name}/${child.name}`);
          }
        }
      }
    }
    return {
      configuracion: estado,
      arquetipos: ["curso", "archivo", "tarea", "pagina", "modulo", "anuncio", "discusion"],
      carpetas_de_curso: carpetas.sort(),
      nota: "El frontmatter y los tags los escribe el servidor. El cuerpo bajo el centinela canvas:fin es de la persona y no se toca.",
    };
  }
}

export const TOOLS = [
  {
    name: "canvas_test_connection",
    description: "Comprueba la sesión de Canvas con la cookie local. No escribe en el vault.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "canvas_list_courses",
    description: "Lista los cursos activos y deja una nota de curso por cada uno en el vault, más el índice del semestre.",
    inputSchema: {
      type: "object",
      properties: { dry_run: { type: "boolean" } },
      additionalProperties: false,
    },
  },
  {
    name: "canvas_list_active_tasks",
    description: "Lista tareas publicadas aún no enviadas y no bloqueadas del semestre más reciente, y escribe sus notas en el vault.",
    inputSchema: {
      type: "object",
      properties: {
        course_id: { type: "integer", minimum: 1 },
        term: { type: "string", description: "Semestre AAAA-1 o AAAA-2" },
        all_terms: { type: "boolean" },
        dry_run: { type: "boolean" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "canvas_list_course_assignments",
    description: "Lista todas las tareas de un curso con estado de envío y escribe sus notas en el vault.",
    inputSchema: {
      type: "object",
      properties: { course_id: { type: "integer", minimum: 1 }, dry_run: { type: "boolean" } },
      required: ["course_id"],
      additionalProperties: false,
    },
  },
  {
    name: "canvas_course_inventory",
    description: "Cuenta módulos, páginas, tareas, archivos, anuncios y discusiones, y actualiza la nota de curso con esos conteos.",
    inputSchema: {
      type: "object",
      properties: {
        course_id: { type: "integer", minimum: 1 },
        term: { type: "string" },
        dry_run: { type: "boolean" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "canvas_course_updates",
    description: "Lista anuncios, archivos y módulos de un curso y escribe sus notas en el vault.",
    inputSchema: {
      type: "object",
      properties: {
        course_id: { type: "integer", minimum: 1 },
        since: { type: "string", description: "Fecha ISO" },
        dry_run: { type: "boolean" },
      },
      required: ["course_id"],
      additionalProperties: false,
    },
  },
  {
    name: "canvas_sync_course",
    description: "Sincroniza un curso completo al vault: curso, archivos, tareas, páginas, módulos, anuncios y discusiones.",
    inputSchema: {
      type: "object",
      properties: {
        course_id: { type: "integer", minimum: 1 },
        download_files: { type: "boolean" },
        include_announcements: { type: "boolean" },
        include_discussions: { type: "boolean" },
        dry_run: { type: "boolean" },
      },
      required: ["course_id"],
      additionalProperties: false,
    },
  },
  {
    name: "canvas_sync_all_courses",
    description: "Sincroniza al vault todos los cursos de un semestre y actualiza el índice.",
    inputSchema: {
      type: "object",
      properties: {
        term: { type: "string" },
        all_terms: { type: "boolean" },
        download_files: { type: "boolean" },
        include_announcements: { type: "boolean" },
        include_discussions: { type: "boolean" },
        page_bodies: { type: "boolean" },
        dry_run: { type: "boolean" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "canvas_download_course_files",
    description: "Descarga los archivos de un curso a la carpeta Descargas del vault y actualiza sus notas.",
    inputSchema: {
      type: "object",
      properties: {
        course_id: { type: "integer", minimum: 1 },
        force: { type: "boolean" },
        dry_run: { type: "boolean" },
      },
      required: ["course_id"],
      additionalProperties: false,
    },
  },
  {
    name: "canvas_download_pdf",
    description: "Descarga un PDF verificado del curso a la carpeta de salida y deja su nota en el vault.",
    inputSchema: {
      type: "object",
      properties: {
        course_id: { type: "integer", minimum: 1 },
        file_id: { type: "integer", minimum: 1 },
        dry_run: { type: "boolean" },
      },
      required: ["course_id", "file_id"],
      additionalProperties: false,
    },
  },
  {
    name: "canvas_export_course_sources",
    description: "Guarda las instrucciones originales, páginas, módulos, enlaces y adjuntos de un curso como JSON en la carpeta de salida.",
    inputSchema: {
      type: "object",
      properties: { course_id: { type: "integer", minimum: 1 } },
      required: ["course_id"],
      additionalProperties: false,
    },
  },
  {
    name: "canvas_submit_assignment",
    description: "Entrega uno o más archivos en una tarea de Canvas. ESCRIBE EN CANVAS Y NO SE DESHACE. Sin confirm:true solo valida y devuelve el plan; úsalo siempre primero y deja que la persona revise la tarea, la fecha y los archivos antes de confirmar.",
    inputSchema: {
      type: "object",
      properties: {
        course_id: { type: "integer", minimum: 1 },
        assignment_id: { type: "integer", minimum: 1 },
        file_path: { type: "string", description: "Ruta del archivo a entregar" },
        file_paths: {
          type: "array",
          items: { type: "string" },
          maxItems: 10,
          description: "Varias rutas, si la tarea admite más de un archivo",
        },
        comment: { type: "string", description: "Comentario opcional para el profesor" },
        confirm: {
          type: "boolean",
          description: "true sube y entrega de verdad. Omitirlo o dejarlo en false hace solo la validación.",
        },
        dry_run: { type: "boolean" },
      },
      required: ["course_id", "assignment_id"],
      additionalProperties: false,
    },
  },
  {
    name: "canvas_study_sources",
    description: "Junta el material de un curso que ya está sincronizado en el vault (texto de los adjuntos, tareas, páginas, módulos y anuncios) y lo devuelve en pasajes con su clave de cita. Es el paso previo obligatorio para escribir una guía de estudio: la guía se redacta SOLO con estos pasajes, sin agregar conocimiento propio. Filtra por tema para no traer el curso completo.",
    inputSchema: {
      type: "object",
      properties: {
        course_id: { type: "integer", minimum: 1 },
        tema: { type: "string", description: "Palabras clave; devuelve los pasajes que las mencionan" },
        file_ids: { type: "array", items: { type: "integer" }, description: "Limita a estos adjuntos" },
        tipos: {
          type: "array",
          items: { enum: ["archivo", "tarea", "pagina", "modulo", "anuncio", "discusion", "curso"] },
        },
        max_chars: { type: "integer", minimum: 1000, description: "Presupuesto de caracteres (60000 por defecto)" },
      },
      required: ["course_id"],
      additionalProperties: false,
    },
  },
  {
    name: "canvas_write_study_guide",
    description: "Escribe en el vault una guía de estudio que tú redactaste, con el frontmatter y los tags del ecosistema (tipo: guia_estudio). Cada sección debe declarar en `fuentes` las claves de cita que devolvió canvas_study_sources; si una clave no corresponde a material sincronizado de ese curso, la llamada falla. Así la guía queda anclada a Canvas y auditable.",
    inputSchema: {
      type: "object",
      properties: {
        course_id: { type: "integer", minimum: 1 },
        titulo: { type: "string", description: "Nombre de la nota, por ejemplo 'Prueba 2 - guia de estudio'" },
        tema: { type: "string" },
        secciones: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            properties: {
              encabezado: { type: "string" },
              cuerpo: { type: "string" },
              fuentes: {
                type: "array",
                minItems: 1,
                items: { type: "string" },
                description: "Claves de cita, por ejemplo archivo:1218706 o anuncio:130285",
              },
            },
            required: ["encabezado", "cuerpo", "fuentes"],
            additionalProperties: false,
          },
        },
        tags: { type: "array", items: { type: "string" }, description: "Tags extra, por ejemplo prueba-1" },
        fecha_prueba: { type: "string", description: "AAAA-MM-DD, si la guía es para una evaluación" },
        hora: { type: "string" },
        sala: { type: "string" },
        dry_run: { type: "boolean" },
      },
      required: ["course_id", "titulo", "secciones"],
      additionalProperties: false,
    },
  },
  {
    name: "canvas_vault_status",
    description: "Muestra dónde escribe el servidor, qué arquetipos maneja y qué carpetas de curso detecta en el vault.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];

export function dispatch(toolbox, name, args = {}) {
  switch (name) {
    case "canvas_test_connection": return toolbox.testConnection(args);
    case "canvas_list_courses": return toolbox.listCourses(args);
    case "canvas_list_active_tasks": return toolbox.listActiveTasks(args);
    case "canvas_list_course_assignments": return toolbox.listCourseAssignments(args);
    case "canvas_course_inventory": return toolbox.courseInventory(args);
    case "canvas_course_updates": return toolbox.courseUpdates(args);
    case "canvas_sync_course": return toolbox.syncCourse(args);
    case "canvas_sync_all_courses": return toolbox.syncAllCourses(args);
    case "canvas_download_course_files": return toolbox.downloadCourseFiles(args);
    case "canvas_download_pdf": return toolbox.downloadPdf(args);
    case "canvas_export_course_sources": return toolbox.exportCourseSources(args);
    case "canvas_submit_assignment": return toolbox.submitAssignment(args);
    case "canvas_study_sources": return toolbox.studySources(args);
    case "canvas_write_study_guide": return toolbox.writeStudyGuide(args);
    case "canvas_vault_status": return toolbox.vaultStatus(args);
    default: {
      const error = new Error(`Herramienta desconocida: ${name}`);
      error.code = -32602;
      throw error;
    }
  }
}
