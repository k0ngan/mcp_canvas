import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { VaultWriter } from "../src/vault.mjs";
import { tempVault, testConfig } from "./helpers.mjs";

// Un vault creado en Windows tiene sus notas en CRLF. Si el servidor
// escribiera LF, cada pasada reescribiría el vault completo sin cambiar un dato.

const NOTA = {
  entries: [["tags", ["segundo-semestre", "canvas", "2026-2", "canvas/archivo"]], ["tipo", "archivo"], ["size", 10]],
  body: "# GUIA.pdf",
};

function seed(vaultDir, relative, lines, eol) {
  const file = path.join(vaultDir, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.join(eol) + eol);
  return file;
}

const HEREDADA = [
  "---",
  "tags:",
  "  - segundo-semestre",
  "  - canvas",
  "  - 2026-2",
  "  - canvas/archivo",
  "tipo: archivo",
  "size: 9",
  "---",
  "",
  "# GUIA.pdf",
  "",
  "Cuerpo del exportador viejo.",
];

test("una nota existente en CRLF se reescribe en CRLF", () => {
  const vaultDir = tempVault();
  const writer = new VaultWriter(testConfig({ vaultDir, env: { CANVAS_EOL: "lf" } }));
  const file = seed(vaultDir, "Canvas/crlf.md", HEREDADA, "\r\n");

  writer.upsert("Canvas/crlf.md", NOTA);
  const text = fs.readFileSync(file, "utf8");
  assert.ok(text.includes("\r\n"), "mantiene CRLF");
  assert.ok(!/[^\r]\n/.test(text), "no quedan saltos LF sueltos");
  assert.ok(text.includes("size: 10"), "el dato sí se actualizó");
  assert.ok(text.includes("Cuerpo del exportador viejo."), "el cuerpo heredado sigue ahí");
});

test("una nota existente en LF se reescribe en LF", () => {
  const vaultDir = tempVault();
  const writer = new VaultWriter(testConfig({ vaultDir, env: { CANVAS_EOL: "crlf" } }));
  const file = seed(vaultDir, "Canvas/lf.md", HEREDADA, "\n");

  writer.upsert("Canvas/lf.md", NOTA);
  const text = fs.readFileSync(file, "utf8");
  assert.ok(!text.includes("\r"), "mantiene LF");
  assert.ok(text.includes("size: 10"));
});

test("una nota en CRLF sin cambios reales no se reescribe", () => {
  const vaultDir = tempVault();
  const writer = new VaultWriter(testConfig({ vaultDir, env: { CANVAS_EOL: "lf" } }));
  seed(vaultDir, "Canvas/igual.md", HEREDADA, "\r\n");

  const nota = { ...NOTA, entries: [...NOTA.entries.slice(0, 2), ["size", 9]] };
  const primera = writer.upsert("Canvas/igual.md", nota);
  assert.equal(primera.estado, "sin_cambios", "el frontmatter ya coincidía y el EOL también");
});

test("las notas nuevas usan el fin de línea configurado", () => {
  const vaultDir = tempVault();
  const crlf = new VaultWriter(testConfig({ vaultDir, env: { CANVAS_EOL: "crlf" } }));
  crlf.upsert("Canvas/nueva-crlf.md", NOTA);
  assert.ok(fs.readFileSync(path.join(vaultDir, "Canvas/nueva-crlf.md"), "utf8").includes("\r\n"));

  const lf = new VaultWriter(testConfig({ vaultDir, env: { CANVAS_EOL: "lf" } }));
  lf.upsert("Canvas/nueva-lf.md", NOTA);
  assert.ok(!fs.readFileSync(path.join(vaultDir, "Canvas/nueva-lf.md"), "utf8").includes("\r"));
});
