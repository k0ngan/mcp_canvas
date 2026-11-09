// YAML mínimo, sin dependencias, para el subconjunto que usan las notas del
// vault: pares clave/valor y listas de una línea por elemento (los tags).
// Preserva el orden de las claves y devuelve los valores como texto crudo
// cuando no son escalares reconocibles.

const FORCE_QUOTE = new Set([
  "updated_at",
  "download_url",
  "due_at",
  "lock_at",
  "posted_at",
  "created_at",
  "downloaded_to",
  "sincronizado",
]);

export function parse(text) {
  const source = String(text ?? "");
  const lines = source.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return { entries: [], body: source, hadFrontmatter: false };

  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      end = i;
      break;
    }
  }
  if (end === -1) return { entries: [], body: source, hadFrontmatter: false };

  const entries = [];
  for (let i = 1; i < end; i++) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const item = line.match(/^\s+-\s*(.*)$/);
    if (item) {
      const last = entries.at(-1);
      if (last) {
        if (!Array.isArray(last[1])) last[1] = [];
        last[1].push(unquote(item[1]));
      }
      continue;
    }
    const pair = line.match(/^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/);
    if (!pair) continue;
    const raw = pair[2].trim();
    entries.push([pair[1], raw === "" ? [] : scalar(raw)]);
  }

  const body = lines.slice(end + 1).join("\n").replace(/^\n/, "");
  return { entries, body, hadFrontmatter: true };
}

export function emit(entries) {
  const out = ["---"];
  for (const [key, value] of entries) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      out.push(`${key}:`);
      for (const item of value) out.push(`  - ${String(item)}`);
      continue;
    }
    out.push(`${key}: ${renderScalar(key, value)}`);
  }
  out.push("---");
  return out.join("\n");
}

export function compose(entries, body) {
  const text = String(body ?? "").replace(/\s+$/, "");
  return `${emit(entries)}\n\n${text}\n`.replace(/\n{3,}$/, "\n");
}

export function get(entries, key) {
  const found = (entries || []).find(entry => entry[0] === key);
  return found ? found[1] : undefined;
}

// Las claves que genera el servidor se sobreescriben con el valor nuevo y
// mantienen el orden canónico; las que puso la persona se conservan al final.
export function mergeEntries(existing, owned) {
  const ownedKeys = new Set(owned.map(entry => entry[0]));
  const extra = (existing || []).filter(entry => !ownedKeys.has(entry[0]));
  return [...owned, ...extra];
}

function scalar(raw) {
  if (/^-?\d+$/.test(raw)) return Number(raw);
  if (/^-?\d+\.\d+$/.test(raw)) return Number(raw);
  if (/^(true|false)$/i.test(raw)) return /^true$/i.test(raw);
  return unquote(raw);
}

function unquote(raw) {
  const value = String(raw).trim();
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1);
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  return value;
}

function renderScalar(key, value) {
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  const text = String(value);
  if (text === "") return '""';
  // Las rutas de Windows llevan barras invertidas: entre comillas dobles YAML
  // las leería como escapes inválidos, así que van con comillas simples.
  if (text.includes("\\")) return `'${text.replace(/'/g, "''")}'`;
  if (FORCE_QUOTE.has(key) || needsQuotes(text)) return `"${text.replace(/"/g, '\\"')}"`;
  return text;
}

function needsQuotes(text) {
  if (/^\s|\s$/.test(text)) return true;
  if (/[:#]\s/.test(text) || text.endsWith(":")) return true;
  if (/^[-?:,[\]{}&*!|>'"%@`]/.test(text)) return true;
  if (/[\r\n]/.test(text)) return true;
  if (/^(true|false|null|~|yes|no|on|off)$/i.test(text)) return true;
  // Solo se citan los valores que YAML leería como algo distinto de texto: un
  // número o una fecha completa. "2026-2" o "2026-02-PREGRADO" van sin
  // comillas, igual que en las notas del vault.
  if (/^-?\d+(\.\d+)?$/.test(text)) return true;
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return true;
  // "18:00" lo leería YAML 1.1 como un número sexagesimal, no como una hora.
  if (/^\d+:\d+/.test(text)) return true;
  return false;
}
