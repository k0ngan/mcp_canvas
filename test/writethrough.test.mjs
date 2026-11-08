import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { createHandler } from "../src/server.mjs";
import { json, reply, tempVault, testConfig } from "./helpers.mjs";

const CURSO = {
  id: 4101,
  name: "DEMO1001-101-TEORIA-2026-2: MATERIA DE EJEMPLO",
  course_code: "DEMO1001",
  workflow_state: "available",
  term: { name: "2026-02-PREGRADO" },
  syllabus_body: "<p>Ponderación de las evaluaciones</p>",
};

const ARCHIVO = {
  id: 1218706,
  display_name: "GUIA.pdf",
  filename: "GUIA.pdf",
  "content-type": "application/pdf",
  size: 8,
  updated_at: "2026-08-11T19:00:42Z",
  url: "https://canvas.example.edu/files/1218706/download?verifier=x",
};

const ANUNCIO = {
  id: 130285,
  title: "PRUEBA 1",
  posted_at: "2026-10-28T17:12:27Z",
  message: "<p>La prueba es el jueves.</p>",
  html_url: "https://canvas.example.edu/courses/4101/discussion_topics/130285",
};

const MODULO = {
  id: 83470,
  name: "Material de clases",
  position: 1,
  items: [{ type: "File", title: "GUIA.pdf", content_id: 1218706 }],
};

// Enruta por path para no depender del orden de las llamadas.
function fakeCanvas(extra = {}) {
  const routes = {
    "/api/v1/users/self/profile": { id: 7, name: "Francisco" },
    "/api/v1/courses": [CURSO],
    "/api/v1/courses/4101": CURSO,
    "/api/v1/courses/4101/files": [ARCHIVO],
    "/api/v1/courses/4101/modules": [MODULO],
    "/api/v1/courses/4101/pages": [],
    "/api/v1/courses/4101/assignments": [],
    "/api/v1/courses/4101/discussion_topics": [],
    "/api/v1/announcements": [ANUNCIO],
    ...extra,
  };
  const calls = [];
  const fetchImpl = async url => {
    const target = new URL(url);
    calls.push(target.pathname);
    if (!target.pathname.startsWith("/api/v1/")) return reply(Buffer.from("%PDF-1.7"));
    if (!(target.pathname in routes)) throw new Error(`ruta no simulada: ${target.pathname}`);
    return json(routes[target.pathname]);
  };
  return { fetchImpl, calls };
}

function setup(envOverrides = {}) {
  const vaultDir = tempVault();
  const config = testConfig({ vaultDir, env: envOverrides });
  const { fetchImpl, calls } = fakeCanvas();
  return { vaultDir, config, calls, handle: createHandler(config, fetchImpl) };
}

async function call(handle, name, args = {}) {
  const response = await handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
  assert.equal(response.result.isError, false, response.result.content?.[0]?.text);
  return response.result.structuredContent;
}

test("canvas_test_connection no escribe nada en el vault", async () => {
  const { handle, vaultDir } = setup();
  const data = await call(handle, "canvas_test_connection");
  assert.equal(data.connected, true);
  assert.equal(fs.existsSync(path.join(vaultDir, "Canvas")), false);
});

test("canvas_list_courses deja la nota de curso y el índice del semestre", async () => {
  const { handle, vaultDir } = setup();
  const data = await call(handle, "canvas_list_courses");
  assert.equal(data.cursos.length, 1);
  assert.ok(data.vault.creadas >= 2);

  const curso = path.join(vaultDir, "Canvas", "Segundo semestre 2026", "4101-demo1001-101-teoria-2026-2-materia-de-ejemplo", "Curso.md");
  assert.ok(fs.existsSync(curso), "nota de curso");
  const text = fs.readFileSync(curso, "utf8");
  assert.ok(text.includes("  - canvas/curso"));
  assert.ok(text.includes("  - segundo-semestre"));
  assert.ok(text.includes("course_code: DEMO1001"));

  const indice = path.join(vaultDir, "Canvas", "Segundo semestre 2026.md");
  assert.ok(fs.existsSync(indice), "índice del semestre");
  assert.ok(fs.readFileSync(indice, "utf8").includes("periodo: 2026-2"));
});

test("canvas_course_updates escribe anuncios, archivos y módulos con sus tags", async () => {
  const { handle, vaultDir } = setup();
  const data = await call(handle, "canvas_course_updates", { course_id: 4101 });
  assert.equal(data.announcements.length, 1);
  assert.equal(data.vault.creadas, 3);

  const base = path.join(vaultDir, "Canvas", "Segundo semestre 2026", "4101-demo1001-101-teoria-2026-2-materia-de-ejemplo");
  const anuncio = fs.readFileSync(path.join(base, "Anuncios", "130285 - PRUEBA 1.md"), "utf8");
  assert.ok(anuncio.includes("  - canvas/anuncio"));
  assert.ok(anuncio.includes("La prueba es el jueves."));

  const archivo = fs.readFileSync(path.join(base, "Archivos", "1218706 - GUIA.pdf.md"), "utf8");
  assert.ok(archivo.includes("  - canvas/archivo"));
  assert.ok(archivo.includes("size: 8"));
  assert.ok(!archivo.includes("downloaded: true"), "sin descargar no se marca como descargado");

  const modulo = fs.readFileSync(path.join(base, "Modulos", "83470 - Material de clases.md"), "utf8");
  assert.ok(modulo.includes("`File` GUIA.pdf -> [[Canvas/Segundo semestre 2026/4101-demo1001-101-teoria-2026-2-materia-de-ejemplo/Archivos/1218706 - GUIA.pdf]]"));
});

test("dry_run informa lo que haría y no crea ni un archivo", async () => {
  const { handle, vaultDir } = setup();
  const data = await call(handle, "canvas_course_updates", { course_id: 4101, dry_run: true });
  assert.equal(data.vault.dry_run, true);
  assert.equal(data.vault.creadas, 3);
  assert.equal(fs.existsSync(path.join(vaultDir, "Canvas")), false);
});

test("CANVAS_VAULT_WRITE=0 apaga la escritura y la lectura sigue funcionando", async () => {
  const { handle, vaultDir } = setup({ CANVAS_VAULT_WRITE: "0" });
  const data = await call(handle, "canvas_course_updates", { course_id: 4101 });
  assert.equal(data.announcements.length, 1);
  assert.equal(data.vault.activo, false);
  assert.equal(fs.existsSync(path.join(vaultDir, "Canvas")), false);
});

test("canvas_sync_course descarga el archivo y enlaza la copia local", async () => {
  const { handle, vaultDir } = setup();
  const data = await call(handle, "canvas_sync_course", { course_id: 4101, download_files: true });
  assert.equal(data.descargas, 1);

  const base = path.join(vaultDir, "Canvas", "Segundo semestre 2026", "4101-demo1001-101-teoria-2026-2-materia-de-ejemplo");
  const binario = path.join(base, "Descargas", "1218706-GUIA.pdf");
  assert.ok(fs.existsSync(binario));
  assert.equal(fs.readFileSync(binario).toString(), "%PDF-1.7");

  const archivo = fs.readFileSync(path.join(base, "Archivos", "1218706 - GUIA.pdf.md"), "utf8");
  assert.ok(archivo.includes("downloaded: true"));
  assert.ok(archivo.includes("## Archivo local"));
  assert.ok(archivo.includes("[[Canvas/Segundo semestre 2026/4101-demo1001-101-teoria-2026-2-materia-de-ejemplo/Descargas/1218706-GUIA.pdf]]"));
});

test("la segunda sincronización no reescribe nada", async () => {
  const { handle } = setup();
  await call(handle, "canvas_sync_course", { course_id: 4101 });
  const segunda = await call(handle, "canvas_sync_course", { course_id: 4101 });
  assert.equal(segunda.vault.creadas, 0);
  assert.equal(segunda.vault.actualizadas, 0);
  assert.ok(segunda.vault.sin_cambios > 0);
});

test("canvas_vault_status dice dónde escribe y qué cursos ve", async () => {
  const { handle, vaultDir } = setup();
  await call(handle, "canvas_list_courses");
  const data = await call(handle, "canvas_vault_status");
  assert.equal(data.configuracion.vault_dir, vaultDir);
  assert.equal(data.configuracion.escritura, true);
  assert.deepEqual(data.carpetas_de_curso, [
    "Canvas/Segundo semestre 2026/4101-demo1001-101-teoria-2026-2-materia-de-ejemplo",
  ]);
});

test("un course_id no numérico se rechaza antes de llamar a Canvas", async () => {
  const { handle, calls } = setup();
  const response = await handle({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "canvas_download_pdf", arguments: { course_id: "4101; rm -rf", file_id: 1 } },
  });
  assert.equal(response.result.isError, true);
  assert.match(response.result.content[0].text, /ID numérico/);
  assert.equal(calls.length, 0);
});

test("sin vault configurado las tools de lectura siguen funcionando", async () => {
  const { fetchImpl } = fakeCanvas();
  const config = testConfig({ config: { vaultDir: null, write: false } });
  const handle = createHandler(config, fetchImpl);

  const cursos = await call(handle, "canvas_list_courses");
  assert.equal(cursos.cursos.length, 1);
  assert.equal(cursos.vault.activo, false);

  const inventario = await call(handle, "canvas_course_inventory", { course_id: 4101 });
  assert.equal(inventario.cursos[0].counts.files, 1);
  assert.equal(inventario.vault.activo, false);

  const novedades = await call(handle, "canvas_course_updates", { course_id: 4101 });
  assert.equal(novedades.announcements.length, 1);
});
