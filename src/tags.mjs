// Taxonomía de tags del vault. Nada de esto lo decide el modelo: el servidor
// reproduce el contrato que ya usan las notas sincronizadas del vault.

export const ARCHETYPES = ["curso", "archivo", "tarea", "pagina", "modulo", "anuncio", "discusion"];

const TERM_RE = /\b(20\d{2})[-_ ]([12])\b/;
const TERM_TAG_RE = /^20\d{2}-[12]$/;
const CAMPAIGN_TAGS = new Set(["primer-semestre", "segundo-semestre"]);

const ORDINAL = { 1: "primer", 2: "segundo" };
const FOLDER_ORDINAL = { 1: "Primer", 2: "Segundo" };

export function detectTerm(course) {
  const match = `${course?.name || ""} ${course?.course_code || ""}`.match(TERM_RE);
  return match ? `${match[1]}-${match[2]}` : null;
}

export function latestTerm(courses) {
  const terms = (courses || []).map(detectTerm).filter(Boolean).sort();
  return terms.at(-1) || null;
}

// "2026-2" -> { year: "2026", half: 2, campaignTag, semestre, folder }
export function termParts(term) {
  if (!term || !TERM_TAG_RE.test(term)) return null;
  const [year, half] = term.split("-");
  const n = Number(half);
  return {
    year,
    half: n,
    campaignTag: `${ORDINAL[n]}-semestre`,
    semestre: `${ORDINAL[n]} semestre`,
    folder: `${FOLDER_ORDINAL[n]} semestre ${year}`,
  };
}

export function subjectTag(course, subjectTags = {}) {
  const code = String(course?.course_code || "").trim().toUpperCase();
  if (code && subjectTags[code]) return subjectTags[code];
  const bare = code.split("-")[0];
  return bare && subjectTags[bare] ? subjectTags[bare] : null;
}

// Orden observado en el vault: campaña, canvas, semestre, canvas/<tipo>, temático.
export function buildTags({ tipo, term, campaignTag, subject }) {
  const tags = [];
  if (campaignTag) tags.push(campaignTag);
  tags.push("canvas");
  if (term) tags.push(term);
  if (tipo) tags.push(`canvas/${tipo}`);
  if (subject) tags.push(subject);
  return dedupe(tags);
}

export function isOwnedTag(tag, subjectTags = {}) {
  const value = String(tag || "").trim();
  if (!value) return false;
  if (value === "canvas" || value.startsWith("canvas/")) return true;
  if (TERM_TAG_RE.test(value)) return true;
  if (CAMPAIGN_TAGS.has(value)) return true;
  return Object.values(subjectTags).includes(value);
}

// Los tags del servidor se reescriben; los que puso la persona se conservan.
export function mergeTags(existing, owned, subjectTags = {}) {
  const foreign = (existing || [])
    .map(tag => String(tag).trim())
    .filter(tag => tag && !isOwnedTag(tag, subjectTags) && !owned.includes(tag));
  return dedupe([...owned, ...foreign]);
}

function dedupe(values) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}
