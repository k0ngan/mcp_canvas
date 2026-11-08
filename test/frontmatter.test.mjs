import assert from "node:assert/strict";
import test from "node:test";

import { compose, emit, get, mergeEntries, parse } from "../src/frontmatter.mjs";

const NOTA_REAL = [
  "---",
  "tags:",
  "  - segundo-semestre",
  "  - canvas",
  "  - 2026-2",
  "  - canvas/archivo",
  "tipo: archivo",
  "course_id: 4101",
  "file_id: 1218706",
  "filename: GUIA.pdf",
  "content_type: application/pdf",
  "size: 473737",
  'updated_at: "2026-08-11T19:00:42Z"',
  'download_url: "https://canvas.example.edu/files/1218706/download?download_frd=1"',
  "semestre: segundo semestre",
  "downloaded: true",
  "---",
].join("\n");

test("el ciclo parse/emit devuelve el mismo frontmatter de una nota real", () => {
  const parsed = parse(`${NOTA_REAL}\n\n# GUIA.pdf\n`);
  assert.equal(emit(parsed.entries), NOTA_REAL);
  assert.equal(parsed.body, "# GUIA.pdf\n");
});

test("reconoce los tipos escalares", () => {
  const parsed = parse(`${NOTA_REAL}\n\ncuerpo\n`);
  assert.equal(get(parsed.entries, "course_id"), 4101);
  assert.equal(get(parsed.entries, "downloaded"), true);
  assert.equal(get(parsed.entries, "filename"), "GUIA.pdf");
  assert.deepEqual(get(parsed.entries, "tags"), ["segundo-semestre", "canvas", "2026-2", "canvas/archivo"]);
});

test("un texto sin frontmatter se devuelve entero como cuerpo", () => {
  const parsed = parse("# Solo cuerpo\n\nnada de YAML.\n");
  assert.equal(parsed.hadFrontmatter, false);
  assert.deepEqual(parsed.entries, []);
  assert.equal(parsed.body, "# Solo cuerpo\n\nnada de YAML.\n");
});

test("las rutas de Windows salen con comillas simples y no rompen YAML", () => {
  const ruta = "C:\\vault\\Canvas\\Segundo semestre 2026\\curso\\Descargas\\1-x.pdf";
  const text = emit([["downloaded_to", ruta]]);
  assert.equal(text, `---\ndowncase\n---`.replace("downcase", `downloaded_to: '${ruta}'`));
  assert.equal(get(parse(`${text}\n\nx\n`).entries, "downloaded_to"), ruta);
});

test("no cita lo que el vault deja sin citar", () => {
  const text = emit([
    ["term", "2026-02-PREGRADO"],
    ["periodo", "2026-2"],
    ["semestre", "segundo semestre"],
    ["content_type", "application/pdf"],
    ["submission_types", "online_upload"],
  ]);
  assert.ok(text.includes("term: 2026-02-PREGRADO"));
  assert.ok(text.includes("periodo: 2026-2"));
  assert.ok(text.includes("semestre: segundo semestre"));
  assert.ok(text.includes("content_type: application/pdf"));
  assert.ok(text.includes("submission_types: online_upload"));
});

test("cita lo que YAML leería como otro tipo", () => {
  const text = emit([
    ["numerico", "473737"],
    ["fecha", "2026-08-11"],
    ["booleano", "true"],
    ["conDosPuntos", "clave: valor"],
    ["conGuion", "- lista"],
  ]);
  assert.ok(text.includes('numerico: "473737"'));
  assert.ok(text.includes('fecha: "2026-08-11"'));
  assert.ok(text.includes('booleano: "true"'));
  assert.ok(text.includes('conDosPuntos: "clave: valor"'));
  assert.ok(text.includes('conGuion: "- lista"'));
});

test("mergeEntries deja primero las claves del servidor y conserva las ajenas", () => {
  const existing = [["tags", ["canvas"]], ["tipo", "archivo"], ["mi_campo", "valor"]];
  const owned = [["tags", ["canvas", "2026-2"]], ["tipo", "archivo"], ["size", 10]];
  const merged = mergeEntries(existing, owned);
  assert.deepEqual(merged.map(entry => entry[0]), ["tags", "tipo", "size", "mi_campo"]);
  assert.equal(get(merged, "mi_campo"), "valor");
  assert.deepEqual(get(merged, "tags"), ["canvas", "2026-2"]);
});

test("compose termina siempre con un único salto de línea", () => {
  const text = compose([["tipo", "archivo"]], "# x\n\n\n");
  assert.ok(text.endsWith("# x\n"));
  assert.ok(!text.endsWith("\n\n"));
});

test("ignora una clave nula y no la emite", () => {
  const text = emit([["a", 1], ["b", null], ["c", undefined], ["d", 2]]);
  assert.equal(text, "---\na: 1\nd: 2\n---");
});
