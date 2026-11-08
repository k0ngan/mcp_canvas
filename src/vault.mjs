import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { compose, get, mergeEntries, parse } from "./frontmatter.mjs";
import { detectTerm, mergeTags, subjectTag, termParts } from "./tags.mjs";

export const SENTINEL_START = "<!-- canvas:inicio -->";
export const SENTINEL_END = "<!-- canvas:fin -->";

const ILLEGAL = /[<>:"/\\|?*\x00-\x1f]/g;
const ACCENTS = /[\u0300-\u036f]/g;

export class VaultError extends Error {
  constructor(message) {
    super(message);
    this.name = "VaultError";
  }
}

export function slugify(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(ACCENTS, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

export function sanitizeName(value, fallback = "sin-nombre") {
  const clean = String(value ?? "")
    .replace(ILLEGAL, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "")
    .slice(0, 150);
  return clean || fallback;
}

export class VaultWriter {
  constructor(config, { dryRun = false } = {}) {
    this.config = config;
    this.enabled = Boolean(config.write);
    this.dryRun = Boolean(dryRun || config.dryRun);
    this.creadas = [];
    this.actualizadas = [];
    this.cuerpoPreservado = [];
    this.sinCambios = [];
    this.binarios = [];
    this.avisos = [];
  }

  get root() {
    if (!this.config.vaultDir) throw new VaultError("CANVAS_VAULT_DIR no está configurado.");
    return path.join(this.config.vaultDir, this.config.subdir);
  }

  // Resuelve la carpeta del curso reutilizando la que ya exista en el vault.
  // Sin esto aparecerían carpetas gemelas por cada curso ya sincronizado.
  courseFolder(course) {
    const courseId = Number(course.id);
    const term = detectTerm(course);
    const parts = termParts(term);
    const slug = `${courseId}-${slugify(course.name)}`;
    const expectedRel = this.config.termFolder && parts
      ? path.join(this.config.subdir, parts.folder, slug)
      : path.join(this.config.subdir, slug);

    const existing = this.findExisting(courseId, parts);
    const relative = existing || expectedRel;
    return {
      term,
      parts,
      relative,
      absolute: path.join(this.config.vaultDir, relative),
      wiki: relative.split(path.sep).join("/"),
      reutilizada: Boolean(existing),
    };
  }

  findExisting(courseId, parts) {
    if (!this.config.vaultDir || !fs.existsSync(this.root)) return null;
    const prefix = `${courseId}-`;
    const matches = [];
    for (const entry of safeReaddir(this.root)) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(prefix)) {
        matches.push(path.join(this.config.subdir, entry.name));
        continue;
      }
      const nested = path.join(this.root, entry.name);
      for (const child of safeReaddir(nested)) {
        if (child.isDirectory() && child.name.startsWith(prefix)) {
          matches.push(path.join(this.config.subdir, entry.name, child.name));
        }
      }
    }
    if (matches.length === 0) return null;
    if (matches.length === 1) return matches[0];
    // Varias carpetas para el mismo curso: gana la que está dentro de la
    // carpeta del semestre, que es la convención vigente del vault.
    const preferred = parts
      ? matches.find(rel => rel.split(path.sep)[1] === parts.folder)
      : null;
    const chosen = preferred || matches.slice().sort()[0];
    // La carpeta se resuelve más de una vez por curso en una misma pasada; el
    // aviso se reporta una sola.
    if (!this.avisos.some(aviso => aviso.curso === courseId)) {
      this.avisos.push({
        curso: courseId,
        aviso: "hay más de una carpeta para este curso en el vault",
        carpetas: matches.map(rel => rel.split(path.sep).join("/")),
        usada: chosen.split(path.sep).join("/"),
      });
    }
    return chosen;
  }

  resolve(relativePath) {
    if (!this.config.vaultDir) throw new VaultError("CANVAS_VAULT_DIR no está configurado.");
    const absolute = path.resolve(this.config.vaultDir, relativePath);
    const root = path.resolve(this.config.vaultDir);
    if (absolute !== root && !absolute.startsWith(root + path.sep)) {
      throw new VaultError(`Ruta fuera del vault: ${relativePath}`);
    }
    return absolute;
  }

  // Escribe o actualiza una nota. El frontmatter es del servidor; el cuerpo
  // solo se regenera si la nota lleva los centinelas que puso este servidor.
  upsert(relativePath, { entries, body }) {
    if (!this.enabled) return { estado: "escritura_desactivada", ruta: relativePath };
    const absolute = this.resolve(relativePath);
    const generated = `${SENTINEL_START}\n${String(body ?? "").trim()}\n${SENTINEL_END}`;

    let finalEntries = entries;
    let finalBody = `${generated}\n\n## Notas\n`;
    let estado = "creada";

    if (fs.existsSync(absolute)) {
      const previous = fs.readFileSync(absolute, "utf8");
      // Una nota que ya existe conserva su fin de línea. Sin esto, reescribir
      // el vault en Windows cambiaría CRLF por LF en cada nota y produciría un
      // churn enorme sin tocar ni un dato.
      const eol = previous.includes("\r\n") ? "\r\n" : "\n";
      const parsed = parse(previous);
      finalEntries = mergeEntries(parsed.entries, withMergedTags(parsed.entries, entries, this.config.subjectTags));
      if (parsed.body.includes(SENTINEL_START) && parsed.body.includes(SENTINEL_END)) {
        finalBody = replaceBlock(parsed.body, generated);
        estado = "actualizada";
      } else {
        finalBody = parsed.body;
        estado = "cuerpo_preservado";
      }
      const next = applyEol(compose(finalEntries, finalBody), eol);
      if (next === previous) {
        this.sinCambios.push(relativePath);
        return { estado: "sin_cambios", ruta: relativePath };
      }
      if (!this.dryRun) atomicWrite(absolute, next);
    } else {
      const next = applyEol(compose(finalEntries, finalBody), this.config.eol || "\n");
      if (!this.dryRun) atomicWrite(absolute, next);
    }

    const bucket = estado === "creada"
      ? this.creadas
      : estado === "actualizada"
        ? this.actualizadas
        : this.cuerpoPreservado;
    bucket.push(relativePath);
    return { estado, ruta: relativePath };
  }

  writeBinary(relativePath, bytes) {
    if (!this.enabled) return { estado: "escritura_desactivada", ruta: relativePath };
    const absolute = this.resolve(relativePath);
    if (fs.existsSync(absolute) && fs.statSync(absolute).size === bytes.length) {
      this.sinCambios.push(relativePath);
      return { estado: "sin_cambios", ruta: relativePath };
    }
    if (!this.dryRun) atomicWrite(absolute, bytes);
    this.binarios.push(relativePath);
    return { estado: "descargado", ruta: relativePath };
  }

  report() {
    return {
      activo: this.enabled,
      dry_run: this.dryRun,
      vault_dir: this.config.vaultDir,
      creadas: this.creadas.length,
      actualizadas: this.actualizadas.length,
      cuerpo_preservado: this.cuerpoPreservado.length,
      sin_cambios: this.sinCambios.length,
      binarios: this.binarios.length,
      rutas: [...this.creadas, ...this.actualizadas, ...this.cuerpoPreservado]
        .slice(0, 200)
        .map(rel => rel.split(path.sep).join("/")),
      avisos: this.avisos,
    };
  }
}

// Los tags propios se reescriben y los ajenos se conservan.
function withMergedTags(existingEntries, ownedEntries, subjectTags) {
  const previous = get(existingEntries, "tags");
  if (!Array.isArray(previous) || previous.length === 0) return ownedEntries;
  return ownedEntries.map(entry => {
    if (entry[0] !== "tags" || !Array.isArray(entry[1])) return entry;
    return ["tags", mergeTags(previous, entry[1], subjectTags)];
  });
}

function replaceBlock(body, generated) {
  const start = body.indexOf(SENTINEL_START);
  const end = body.indexOf(SENTINEL_END);
  if (start === -1 || end === -1 || end < start) return body;
  return body.slice(0, start) + generated + body.slice(end + SENTINEL_END.length);
}

function applyEol(text, eol) {
  return eol === "\n" ? text : text.replace(/\r?\n/g, eol);
}

function atomicWrite(absolute, data) {
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  const temporary = `${absolute}.${randomUUID()}.part`;
  try {
    fs.writeFileSync(temporary, data, { flag: "wx" });
    fs.renameSync(temporary, absolute);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function safeReaddir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

// Metadatos comunes a toda nota sincronizada: tag de campaña, tag de semestre,
// arquetipo y, si está mapeada, la asignatura.
export function commonTagContext(course, config) {
  const term = detectTerm(course);
  const parts = termParts(term);
  return {
    term,
    campaignTag: parts?.campaignTag || null,
    semestre: parts?.semestre || null,
    subject: subjectTag(course, config.subjectTags),
  };
}
