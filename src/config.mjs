import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_SUBDIR = "Canvas";
const DEFAULT_TIMEOUT_SEC = 30;
const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGES = 30;
const MAX_COOKIE_BYTES = 16_384;
const MAX_PDF_BYTES = 50_000_000;
const MAX_FILE_BYTES = 25_000_000;
const DEFAULT_UPLOAD_MAX_BYTES = 50_000_000;
// Allowlist de subida. Es deliberadamente corta: subir un archivo a Canvas no
// se deshace, así que ampliarla tiene que ser una decisión explícita.
const DEFAULT_UPLOAD_EXTENSIONS = ".pdf,.sql,.pbix";

function flag(value, fallback) {
  if (value === undefined || value === null || String(value).trim() === "") return fallback;
  return !/^(0|false|no|off)$/i.test(String(value).trim());
}

function positiveInt(value, fallback, max) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return max ? Math.min(parsed, max) : parsed;
}

function home(env) {
  return env.USERPROFILE || env.HOME || process.cwd();
}

function readSubjectTags(file) {
  if (!file || !fs.existsSync(file)) return {};
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`No se pudo leer el mapa de tags ${file}: ${error.message}`);
  }
  const map = {};
  for (const [code, tag] of Object.entries(parsed || {})) {
    if (typeof tag !== "string" || !tag.trim()) continue;
    map[String(code).trim().toUpperCase()] = tag.trim();
  }
  return map;
}

export function loadConfig(env = process.env) {
  // Sin institución por defecto: la instancia de Canvas se declara siempre.
  const declared = String(env.CANVAS_BASE_URL || "").trim();
  if (!declared) {
    throw new Error("Falta CANVAS_BASE_URL con la instancia de Canvas (por ejemplo https://canvas.tu-institucion.edu).");
  }
  const baseUrl = declared.replace(/\/+$/, "");
  let origin;
  try {
    origin = new URL(baseUrl).origin;
  } catch {
    throw new Error("CANVAS_BASE_URL no es una URL válida.");
  }
  if (!baseUrl.startsWith("https://")) throw new Error("CANVAS_BASE_URL debe usar https.");

  const localAppData = env.LOCALAPPDATA || path.join(home(env), "AppData", "Local");
  const cookieFile = env.CANVAS_COOKIE_FILE
    ? path.resolve(env.CANVAS_COOKIE_FILE)
    : path.join(localAppData, "mcp-canvas", "canvas_session");

  const vaultDir = env.CANVAS_VAULT_DIR && env.CANVAS_VAULT_DIR.trim()
    ? path.resolve(env.CANVAS_VAULT_DIR.trim())
    : null;
  const subdir = (env.CANVAS_SUBDIR || DEFAULT_SUBDIR).replace(/[\\/]+$/, "");

  const outputDir = env.CANVAS_OUTPUT_DIR && env.CANVAS_OUTPUT_DIR.trim()
    ? path.resolve(env.CANVAS_OUTPUT_DIR.trim())
    : vaultDir
      ? path.resolve(vaultDir, "..", "output", "pdf")
      : path.resolve(process.cwd(), "output", "pdf");

  const tagsFile = env.CANVAS_TAGS_FILE && env.CANVAS_TAGS_FILE.trim()
    ? path.resolve(env.CANVAS_TAGS_FILE.trim())
    : vaultDir
      ? path.join(vaultDir, subdir, "vault-tags.json")
      : null;

  const timeoutSec = positiveInt(env.CANVAS_TIMEOUT_SEC, DEFAULT_TIMEOUT_SEC, 600);

  // Las notas que ya están en el vault conservan su propio fin de línea. Este
  // valor solo decide el de las notas nuevas; en Windows el vault usa CRLF.
  const eol = /^lf$/i.test(String(env.CANVAS_EOL || "")) ? "\n"
    : /^crlf$/i.test(String(env.CANVAS_EOL || "")) ? "\r\n"
      : os.EOL;

  const uploadExtensions = new Set(
    String(env.CANVAS_UPLOAD_EXTENSIONS || DEFAULT_UPLOAD_EXTENSIONS)
      .split(",")
      .map(ext => ext.trim().toLowerCase())
      .filter(Boolean)
      .map(ext => (ext.startsWith(".") ? ext : `.${ext}`)),
  );
  const uploadDir = env.CANVAS_UPLOAD_DIR && env.CANVAS_UPLOAD_DIR.trim()
    ? path.resolve(env.CANVAS_UPLOAD_DIR.trim())
    : null;

  return {
    baseUrl,
    origin,
    cookieFile,
    uploadExtensions,
    uploadDir,
    uploadMaxBytes: positiveInt(env.CANVAS_UPLOAD_MAX_BYTES, DEFAULT_UPLOAD_MAX_BYTES),
    cookieHeaderEnv: env.CANVAS_COOKIE_HEADER || "",
    vaultDir,
    subdir,
    termFolder: flag(env.CANVAS_TERM_FOLDER, true),
    outputDir,
    write: flag(env.CANVAS_VAULT_WRITE, true) && Boolean(vaultDir),
    dryRun: flag(env.CANVAS_VAULT_DRY_RUN, false),
    eol,
    timeoutMs: timeoutSec * 1000,
    downloadTimeoutMs: Math.max(timeoutSec, 60) * 1000,
    pageSize: positiveInt(env.CANVAS_PAGE_SIZE, DEFAULT_PAGE_SIZE, 100),
    maxPages: MAX_PAGES,
    maxCookieBytes: MAX_COOKIE_BYTES,
    maxPdfBytes: MAX_PDF_BYTES,
    maxFileBytes: MAX_FILE_BYTES,
    subjectTags: readSubjectTags(tagsFile),
    tagsFile,
  };
}

export function describeConfig(config) {
  return {
    base_url: config.baseUrl,
    cookie_file: config.cookieFile,
    cookie_desde_entorno: Boolean(config.cookieHeaderEnv),
    vault_dir: config.vaultDir,
    subdir: config.subdir,
    carpeta_por_semestre: config.termFolder,
    output_dir: config.outputDir,
    escritura: config.write,
    dry_run: config.dryRun,
    fin_de_linea: config.eol === "\r\n" ? "crlf" : "lf",
    mapa_de_tags: config.tagsFile,
    asignaturas_mapeadas: Object.keys(config.subjectTags).length,
    subida_extensiones: [...config.uploadExtensions].sort(),
    subida_carpeta_permitida: config.uploadDir,
    subida_max_bytes: config.uploadMaxBytes,
  };
}
