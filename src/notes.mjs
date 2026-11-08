import path from "node:path";

import { buildTags } from "./tags.mjs";
import { sanitizeName } from "./vault.mjs";

// Constructores de notas. Cada arquetipo reproduce el orden de claves y el
// cuerpo que ya tienen las notas sincronizadas del vault.

const BLOCK = /<\/?(p|div|br|li|ul|ol|tr|table|h[1-6]|blockquote|section|article|header|footer|pre)\b[^>]*>/gi;

export function htmlToText(html) {
  if (!html) return "";
  return String(html)
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(BLOCK, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/[ \t]+/g, " ")
    .split("\n")
    .map(line => line.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function tagsFor(tipo, ctx) {
  return buildTags({
    tipo,
    term: ctx.term,
    campaignTag: ctx.campaignTag,
    subject: ctx.subject,
  });
}

function withSemestre(entries, ctx) {
  if (!ctx.semestre) return entries;
  return [...entries, ["semestre", ctx.semestre]];
}

function link(folder, name) {
  return `[[${folder.wiki}/${name}]]`;
}

// --- archivo -------------------------------------------------------------

export function fileNoteName(file) {
  return sanitizeName(file.display_name || file.filename || `archivo-${file.id}`);
}

export function fileNote(file, folder, ctx, { downloaded = false } = {}) {
  const name = fileNoteName(file);
  const entries = withSemestre([
    ["tags", tagsFor("archivo", ctx)],
    ["tipo", "archivo"],
    ["course_id", ctx.courseId],
    ["file_id", file.id],
    ["filename", file.filename || name],
    ["content_type", file["content-type"] || file.content_type || "application/octet-stream"],
    ["size", file.size ?? 0],
    ["updated_at", file.updated_at || file.created_at || null],
    ["download_url", `${ctx.baseUrl}/files/${file.id}/download?download_frd=1`],
  ], ctx);
  if (downloaded) entries.push(["downloaded", true]);

  const lines = [`# ${name}`];
  if (downloaded) {
    lines.push("", "## Archivo local", "", link(folder, `Descargas/${downloadName(file)}`));
  }
  return {
    relativePath: path.join(folder.relative, "Archivos", `${file.id} - ${name}.md`),
    entries: entries.filter(entry => entry[1] !== null),
    body: lines.join("\n"),
  };
}

export function downloadName(file) {
  return `${file.id}-${sanitizeName(file.filename || file.display_name || `archivo-${file.id}`)}`;
}

// --- tarea ---------------------------------------------------------------

export function assignmentNote(assignment, folder, ctx) {
  const name = sanitizeName(assignment.name || `tarea-${assignment.id}`);
  const submissionTypes = Array.isArray(assignment.submission_types)
    ? assignment.submission_types.join(", ")
    : assignment.submission_types || null;
  const entries = withSemestre([
    ["tags", tagsFor("tarea", ctx)],
    ["tipo", "tarea"],
    ["course_id", ctx.courseId],
    ["assignment_id", assignment.id],
    ["points_possible", assignment.points_possible ?? 0],
    ["due_at", assignment.due_at || null],
    ["submission_types", submissionTypes],
  ], ctx).filter(entry => entry[1] !== null);

  const text = htmlToText(assignment.description);
  return {
    relativePath: path.join(folder.relative, "Tareas", `${assignment.id} - ${name}.md`),
    entries,
    body: [`# ${name}`, "", text || "_Sin descripción_"].join("\n"),
  };
}

// --- pagina --------------------------------------------------------------

export function pageNote(page, folder, ctx) {
  const name = sanitizeName(page.title || page.url || `pagina-${page.page_id}`);
  const entries = withSemestre([
    ["tags", tagsFor("pagina", ctx)],
    ["tipo", "pagina"],
    ["course_id", ctx.courseId],
    ["page_id", page.page_id],
    ["updated_at", page.updated_at || null],
  ], ctx).filter(entry => entry[1] !== null);

  const text = htmlToText(page.body);
  return {
    relativePath: path.join(folder.relative, "Paginas", `${page.page_id} - ${name}.md`),
    entries,
    body: [`# ${name}`, "", text || "_Sin contenido_"].join("\n"),
  };
}

// --- modulo --------------------------------------------------------------

export function moduleNote(module, folder, ctx, resolver) {
  const name = sanitizeName(module.name || `modulo-${module.id}`);
  const entries = withSemestre([
    ["tags", tagsFor("modulo", ctx)],
    ["tipo", "modulo"],
    ["course_id", ctx.courseId],
    ["module_id", module.id],
    ["position", module.position ?? 0],
  ], ctx);

  const items = (module.items || []).map(item => {
    const label = `\`${item.type}\` ${item.title || ""}`.trim();
    const target = resolver ? resolver(item) : null;
    return target ? `${label} -> ${link(folder, target)}` : label;
  });

  return {
    relativePath: path.join(folder.relative, "Modulos", `${module.id} - ${name}.md`),
    entries,
    body: [`# ${name}`, "", "## Items", "", items.length ? items.map(i => `- ${i}`).join("\n") : "_Sin items_"].join("\n"),
  };
}

// Traduce un item de módulo a la nota del vault que le corresponde.
export function moduleItemResolver({ files = [], pages = [], assignments = [], discussions = [] }) {
  const byFile = new Map(files.map(file => [Number(file.id), `Archivos/${file.id} - ${fileNoteName(file)}`]));
  const byPageUrl = new Map(pages.map(page => [String(page.url), `Paginas/${page.page_id} - ${sanitizeName(page.title || page.url)}`]));
  const byAssignment = new Map(assignments.map(item => [Number(item.id), `Tareas/${item.id} - ${sanitizeName(item.name || "")}`]));
  const byDiscussion = new Map(discussions.map(item => [Number(item.id), `Discusiones/${item.id} - ${sanitizeName(item.title || "")}`]));

  return item => {
    const id = Number(item.content_id);
    if (item.type === "File") return byFile.get(id) || null;
    if (item.type === "Page") return byPageUrl.get(String(item.page_url)) || null;
    if (item.type === "Assignment") return byAssignment.get(id) || null;
    if (item.type === "Discussion") return byDiscussion.get(id) || null;
    return null;
  };
}

// --- anuncio -------------------------------------------------------------

export function announcementNote(announcement, folder, ctx) {
  const name = sanitizeName(announcement.title || `anuncio-${announcement.id}`);
  const entries = withSemestre([
    ["tags", tagsFor("anuncio", ctx)],
    ["tipo", "anuncio"],
    ["course_id", ctx.courseId],
    ["announcement_id", announcement.id],
    ["posted_at", announcement.posted_at || announcement.created_at || null],
  ], ctx).filter(entry => entry[1] !== null);

  const text = htmlToText(announcement.message);
  return {
    relativePath: path.join(folder.relative, "Anuncios", `${announcement.id} - ${name}.md`),
    entries,
    body: [`# ${name}`, "", text || "_Sin mensaje_"].join("\n"),
  };
}

// --- discusion -----------------------------------------------------------

export function discussionNote(discussion, folder, ctx) {
  const name = sanitizeName(discussion.title || `discusion-${discussion.id}`);
  const entries = withSemestre([
    ["tags", tagsFor("discusion", ctx)],
    ["tipo", "discusion"],
    ["course_id", ctx.courseId],
    ["discussion_id", discussion.id],
  ], ctx);

  const text = htmlToText(discussion.message);
  return {
    relativePath: path.join(folder.relative, "Discusiones", `${discussion.id} - ${name}.md`),
    entries,
    body: [`# ${name}`, "", text || "_Sin mensaje_"].join("\n"),
  };
}

// --- curso ---------------------------------------------------------------

// `inventory` en null significa que esta llamada no conoce los conteos ni los
// listados: en ese caso no se emiten esas claves, así que las que ya tiene la
// nota sobreviven intactas en lugar de quedar en cero.
export function courseNote(course, folder, ctx, inventory) {
  const header = [
    ["tags", tagsFor("curso", ctx)],
    ["tipo", "curso"],
    ["course_id", ctx.courseId],
    ["course_code", course.course_code || null],
    ["term", course.term?.name || course.term || null],
  ];

  if (!inventory) {
    return {
      relativePath: path.join(folder.relative, "Curso.md"),
      entries: withSemestre(header, ctx).filter(entry => entry[1] !== null),
      body: [
        `# ${course.name || `Curso ${ctx.courseId}`}`,
        "",
        "## Syllabus",
        "",
        htmlToText(course.syllabus_body) || "_Sin syllabus_",
      ].join("\n"),
    };
  }

  const { modules = [], pages = [], assignments = [], announcements = [], files = [] } = inventory;
  const entries = withSemestre([
    ...header,
    ["modulos", modules.length],
    ["archivos", files.length],
    ["tareas", assignments.length],
  ], ctx).filter(entry => entry[1] !== null);

  const body = [
    `# ${course.name || `Curso ${ctx.courseId}`}`,
    "",
    "## Syllabus",
    "",
    htmlToText(course.syllabus_body) || "_Sin syllabus_",
    "",
    "## Modulos",
    "",
    named(modules, folder, "Modulos", item => `${item.id} - ${sanitizeName(item.name || "")}`, "_Sin modulos_"),
    "",
    "## Paginas",
    "",
    named(pages, folder, "Paginas", item => `${item.page_id} - ${sanitizeName(item.title || item.url || "")}`, "_Sin paginas_"),
    "",
    "## Tareas",
    "",
    named(assignments, folder, "Tareas", item => `${item.id} - ${sanitizeName(item.name || "")}`, "_Sin tareas_"),
    "",
    "## Anuncios",
    "",
    named(announcements, folder, "Anuncios", item => `${item.id} - ${sanitizeName(item.title || "")}`, "_Sin anuncios_"),
    "",
    "## Archivos",
    "",
    named(files, folder, "Archivos", file => `${file.id} - ${fileNoteName(file)}`, "_Sin archivos_"),
  ].join("\n");

  return {
    relativePath: path.join(folder.relative, "Curso.md"),
    entries,
    body,
  };
}

function named(items, folder, subfolder, toName, empty) {
  if (!items.length) return empty;
  return items.map(item => `- ${link(folder, `${subfolder}/${toName(item)}`)}`).join("\n");
}

// --- índice del semestre -------------------------------------------------

export function termIndexNote(config, parts, courses, folders, sincronizado) {
  const entries = [
    ["tags", ["canvas", parts.campaignTag]],
    ["semestre", parts.semestre],
    ["periodo", `${parts.year}-${parts.half}`],
  ];
  const lines = courses.map((course, index) => {
    const folder = folders[index];
    return `- [[${folder.wiki}/Curso]] — ${course.name}`;
  });
  const body = [
    `# ${parts.folder}`,
    "",
    `Sincronizado desde Canvas: ${sincronizado}.`,
    "",
    "## Cursos",
    "",
    lines.length ? lines.join("\n") : "_Sin cursos_",
    "",
    `Cursos sincronizados: ${courses.length}.`,
  ].join("\n");

  return {
    relativePath: path.join(config.subdir, `${parts.folder}.md`),
    entries,
    body,
  };
}
