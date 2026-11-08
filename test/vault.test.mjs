import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { SENTINEL_END, SENTINEL_START, VaultWriter, slugify } from "../src/vault.mjs";
import { testConfig, tempVault } from "./helpers.mjs";

const COURSE = {
  id: 4101,
  name: "DEMO1001-101-TEORIA-2026-2: MATERIA DE EJEMPLO",
  course_code: "DEMO1001",
};

function writerFor(overrides = {}) {
  const vaultDir = tempVault();
  const config = testConfig({ vaultDir, ...overrides });
  return { config, vaultDir, writer: new VaultWriter(config, overrides.writerOptions) };
}

const NOTA = {
  entries: [["tags", ["segundo-semestre", "canvas", "2026-2", "canvas/archivo"]], ["tipo", "archivo"]],
  body: "# GUIA.pdf",
};

test("rechaza cualquier ruta que salga del vault", () => {
  const { writer } = writerFor();
  assert.throws(() => writer.resolve("../fuera.md"), /fuera del vault/);
  assert.throws(() => writer.resolve("Canvas/../../fuera.md"), /fuera del vault/);
  assert.ok(writer.resolve("Canvas/dentro.md"));
});

test("crea la nota con centinelas y una sección de notas propias", () => {
  const { writer, vaultDir } = writerFor();
  const result = writer.upsert("Canvas/prueba.md", NOTA);
  assert.equal(result.estado, "creada");
  const text = fs.readFileSync(path.join(vaultDir, "Canvas/prueba.md"), "utf8");
  assert.ok(text.includes(SENTINEL_START));
  assert.ok(text.includes(SENTINEL_END));
  assert.ok(text.includes("## Notas"));
  assert.ok(text.startsWith("---\ntags:\n  - segundo-semestre\n"));
});

test("regenera solo el bloque entre centinelas y deja intacto lo que está debajo", () => {
  const { writer, vaultDir } = writerFor();
  writer.upsert("Canvas/prueba.md", NOTA);
  const file = path.join(vaultDir, "Canvas/prueba.md");
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("## Notas\n", "## Notas\n\nEsto lo escribí yo.\n"));

  const result = writer.upsert("Canvas/prueba.md", { ...NOTA, body: "# GUIA.pdf\n\nCuerpo nuevo del servidor." });
  assert.equal(result.estado, "actualizada");
  const text = fs.readFileSync(file, "utf8");
  assert.ok(text.includes("Cuerpo nuevo del servidor."));
  assert.ok(text.includes("Esto lo escribí yo."), "lo de la persona sobrevive");
});

test("una nota heredada sin centinelas conserva su cuerpo y solo actualiza el frontmatter", () => {
  const { writer, vaultDir } = writerFor();
  const file = path.join(vaultDir, "Canvas/heredada.md");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, [
    "---",
    "tags:",
    "  - canvas",
    "  - 2026-2",
    "  - canvas/archivo",
    "tipo: archivo",
    "---",
    "",
    "# GUIA.pdf",
    "",
    "Cuerpo original del exportador viejo.",
    "",
  ].join("\n"));

  const result = writer.upsert("Canvas/heredada.md", { ...NOTA, body: "# OTRO TITULO" });
  assert.equal(result.estado, "cuerpo_preservado");
  const text = fs.readFileSync(file, "utf8");
  assert.ok(text.includes("Cuerpo original del exportador viejo."));
  assert.ok(!text.includes("OTRO TITULO"), "no se regenera el cuerpo heredado");
  assert.ok(text.includes("- segundo-semestre"), "el frontmatter sí se actualiza");
  assert.ok(!text.includes(SENTINEL_START), "no se le inyectan centinelas");
});

test("conserva los tags que puso la persona y reescribe los del servidor", () => {
  const { writer, vaultDir } = writerFor();
  const file = path.join(vaultDir, "Canvas/tags.md");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "---\ntags:\n  - canvas\n  - 2025-1\n  - canvas/archivo\n  - mi-tag-propio\ntipo: archivo\n---\n\n# x\n");

  writer.upsert("Canvas/tags.md", NOTA);
  const text = fs.readFileSync(file, "utf8");
  assert.ok(text.includes("- mi-tag-propio"), "el tag propio se conserva");
  assert.ok(text.includes("- 2026-2"), "el semestre nuevo entra");
  assert.ok(!text.includes("- 2025-1"), "el semestre viejo, que es del servidor, se limpia");
});

test("dry_run no toca el disco pero sí reporta", () => {
  const { writer, vaultDir } = writerFor({ writerOptions: { dryRun: true } });
  const result = writer.upsert("Canvas/seco.md", NOTA);
  assert.equal(result.estado, "creada");
  assert.equal(fs.existsSync(path.join(vaultDir, "Canvas/seco.md")), false);
  assert.equal(writer.report().dry_run, true);
  assert.equal(writer.report().creadas, 1);
});

test("una segunda pasada idéntica no reescribe nada", () => {
  const { writer } = writerFor();
  writer.upsert("Canvas/idem.md", NOTA);
  const again = writer.upsert("Canvas/idem.md", NOTA);
  assert.equal(again.estado, "sin_cambios");
});

test("reutiliza la carpeta de curso que ya existe en el vault", () => {
  const { writer, vaultDir } = writerFor();
  const legacy = path.join(vaultDir, "Canvas", "4101-nombre-viejo-distinto");
  fs.mkdirSync(legacy, { recursive: true });

  const folder = writer.courseFolder(COURSE);
  assert.equal(folder.reutilizada, true);
  assert.equal(folder.wiki, "Canvas/4101-nombre-viejo-distinto");
});

test("ante carpetas duplicadas gana la del semestre y queda el aviso", () => {
  const { writer, vaultDir } = writerFor();
  fs.mkdirSync(path.join(vaultDir, "Canvas", "4101-demo1001-101-teoria-2026-2-materia-de-ejemplo"), { recursive: true });
  fs.mkdirSync(path.join(vaultDir, "Canvas", "Segundo semestre 2026", "4101-demo1001-101-teoria-2026-2-materia-de-ejemplo"), { recursive: true });

  const folder = writer.courseFolder(COURSE);
  assert.equal(folder.wiki, "Canvas/Segundo semestre 2026/4101-demo1001-101-teoria-2026-2-materia-de-ejemplo");
  assert.equal(writer.avisos.length, 1);
  assert.equal(writer.avisos[0].carpetas.length, 2);
});

test("sin carpeta previa usa la carpeta del semestre y el slug canónico", () => {
  const { writer } = writerFor();
  const folder = writer.courseFolder(COURSE);
  assert.equal(folder.reutilizada, false);
  assert.equal(folder.wiki, "Canvas/Segundo semestre 2026/4101-demo1001-101-teoria-2026-2-materia-de-ejemplo");
});

test("sin CANVAS_VAULT_DIR la escritura queda desactivada en lugar de fallar", () => {
  const config = testConfig({ config: { vaultDir: null, write: false } });
  const writer = new VaultWriter(config);
  assert.equal(writer.enabled, false);
  assert.equal(writer.upsert("Canvas/x.md", NOTA).estado, "escritura_desactivada");
});

test("los slugs reproducen los nombres de carpeta del vault", () => {
  assert.equal(slugify("DEMO1001-101-TEORIA-2026-2: MATERIA DE EJEMPLO"), "demo1001-101-teoria-2026-2-materia-de-ejemplo");
  assert.equal(slugify("COORD. DEMO3003-TEORIA-2026-2: MATERIA CON PUNTO Y COMA"), "coord-demo3003-teoria-2026-2-materia-con-punto-y-coma");
  assert.equal(slugify("2026-2: MATERIA CON ACENTUACIÓN"), "2026-2-materia-con-acentuacion");
  assert.equal(slugify("DEMO2003-491-TEORIA-2026-2: MATERIA CON TILDE MINúSCULA"), "demo2003-491-teoria-2026-2-materia-con-tilde-minuscula");
});
