import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { createHandler } from "../src/server.mjs";
import { csrfToken } from "../src/upload.mjs";
import { json, reply, tempVault, testConfig } from "./helpers.mjs";

// Subir una entrega a Canvas no se deshace. El contrato es: sin confirm:true
// no se toca la red de escritura, y con confirm:true se valida todo antes.

const TAREA = {
  id: 68145,
  name: "[Laboratorio Nº1] - Ejercicio inicial",
  due_at: "2026-12-01T03:59:59Z",
  lock_at: null,
  points_possible: 10,
  submission_types: ["online_upload"],
  locked_for_user: false,
  submission: { workflow_state: "unsubmitted", attempt: 0 },
};

const CURSO = {
  id: 4102,
  name: "DEMO2002-491-TEORIA-2026-2: OTRA MATERIA DE EJEMPLO",
  course_code: "DEMO2002",
  workflow_state: "available",
  term: { name: "2026-02-PREGRADO" },
};

function entorno({ tarea = TAREA, archivos = { "entrega.pdf": "%PDF-1.7 contenido" }, env = {} } = {}) {
  const dir = tempVault("mcp-canvas-upload-");
  for (const [nombre, contenido] of Object.entries(archivos)) {
    fs.writeFileSync(path.join(dir, nombre), contenido);
  }
  const vaultDir = tempVault();
  const config = testConfig({ vaultDir, env });
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const target = new URL(url);
    calls.push({ method: options.method || "GET", path: target.pathname, host: target.host, headers: options.headers || {} });

    if (target.pathname === `/api/v1/courses/4102/assignments/68145`) return json(tarea);
    if (target.pathname === "/api/v1/courses") return json([CURSO]);
    if (target.pathname === "/api/v1/courses/4102") return json(CURSO);
    if (target.pathname === "/api/v1/courses/4102/assignments/68145/submissions/self/files") {
      return json({ upload_url: "https://storage.example.com/subida", upload_params: { key: "abc" } });
    }
    if (target.host === "storage.example.com") {
      return reply("", { status: 302, headers: { location: "https://canvas.example.edu/api/v1/files/999?confirm=1" } });
    }
    if (target.pathname === "/api/v1/files/999") return json({ id: 999, display_name: "entrega.pdf" });
    if (target.pathname === "/api/v1/courses/4102/assignments/68145/submissions") {
      return json({ id: 55, workflow_state: "submitted", submitted_at: "2026-11-08T04:00:00Z", attempt: 1, late: false });
    }
    throw new Error(`ruta no simulada: ${target.host}${target.pathname}`);
  };
  return { dir, vaultDir, calls, handle: createHandler(config, fetchImpl) };
}

async function call(handle, args) {
  const response = await handle({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "canvas_submit_assignment", arguments: args },
  });
  return response.result;
}

test("sin confirm devuelve el plan y no sube nada", async () => {
  const { dir, calls, handle } = entorno();
  const result = await call(handle, {
    course_id: 4102,
    assignment_id: 68145,
    file_path: path.join(dir, "entrega.pdf"),
  });
  assert.equal(result.isError, false, result.content[0].text);
  const data = result.structuredContent;
  assert.equal(data.enviado, false);
  assert.equal(data.dry_run, true);
  assert.equal(data.tarea, "[Laboratorio Nº1] - Ejercicio inicial");
  assert.equal(data.archivos[0].nombre, "entrega.pdf");
  assert.ok(data.nota.includes("confirm: true"));

  assert.equal(calls.filter(c => c.method === "POST").length, 0, "ningún POST en dry-run");
});

test("con confirm sube, entrega y devuelve el estado", async () => {
  const { dir, calls, handle } = entorno();
  const result = await call(handle, {
    course_id: 4102,
    assignment_id: 68145,
    file_path: path.join(dir, "entrega.pdf"),
    confirm: true,
    comment: "Entrega del laboratorio 1",
  });
  assert.equal(result.isError, false, result.content[0].text);
  const data = result.structuredContent;
  assert.equal(data.enviado, true);
  assert.equal(data.subidos[0].file_id, 999);
  assert.equal(data.submission.workflow_state, "submitted");
  assert.equal(data.submission.attempt, 1);

  const posts = calls.filter(c => c.method === "POST");
  assert.equal(posts.length, 3, "pedir slot, subir bytes y registrar la entrega");
  assert.equal(posts[0].path, "/api/v1/courses/4102/assignments/68145/submissions/self/files");
  assert.equal(posts[1].host, "storage.example.com");
  assert.equal(posts[2].path, "/api/v1/courses/4102/assignments/68145/submissions");
});

test("el storage externo no recibe la cookie ni el token CSRF", async () => {
  const { dir, calls, handle } = entorno();
  await call(handle, {
    course_id: 4102,
    assignment_id: 68145,
    file_path: path.join(dir, "entrega.pdf"),
    confirm: true,
  });
  const subida = calls.find(c => c.host === "storage.example.com");
  assert.equal(subida.headers.Cookie, undefined, "sin cookie al storage externo");
  assert.equal(subida.headers["X-CSRF-Token"], undefined, "sin CSRF al storage externo");

  const slot = calls.find(c => c.method === "POST" && c.path.endsWith("/submissions/self/files"));
  assert.ok(slot.headers.Cookie, "a Canvas sí");
  assert.ok(slot.headers["X-CSRF-Token"], "a Canvas sí");
});

test("una extensión fuera de la allowlist se rechaza antes de tocar la red", async () => {
  const { dir, calls, handle } = entorno({ archivos: { "script.exe": "MZ" } });
  const result = await call(handle, {
    course_id: 4102,
    assignment_id: 68145,
    file_path: path.join(dir, "script.exe"),
    confirm: true,
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /no está permitida/);
  assert.equal(calls.length, 0);
});

test("la allowlist se puede ampliar por entorno", async () => {
  const { dir, handle } = entorno({
    archivos: { "entrega.zip": "PK" },
    env: { CANVAS_UPLOAD_EXTENSIONS: ".pdf,.zip" },
  });
  const result = await call(handle, {
    course_id: 4102,
    assignment_id: 68145,
    file_path: path.join(dir, "entrega.zip"),
  });
  assert.equal(result.isError, false, result.content[0].text);
  assert.equal(result.structuredContent.archivos[0].nombre, "entrega.zip");
});

test("un archivo fuera de CANVAS_UPLOAD_DIR se rechaza", async () => {
  const otro = tempVault("mcp-canvas-fuera-");
  fs.writeFileSync(path.join(otro, "ajeno.pdf"), "%PDF-1.7");
  const { dir, handle } = entorno({ env: { CANVAS_UPLOAD_DIR: null } });

  const limitado = entorno({ env: { CANVAS_UPLOAD_DIR: dir } });
  const result = await call(limitado.handle, {
    course_id: 4102,
    assignment_id: 68145,
    file_path: path.join(otro, "ajeno.pdf"),
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /fuera de CANVAS_UPLOAD_DIR/);
});

test("una tarea bloqueada no se intenta entregar", async () => {
  const { dir, calls, handle } = entorno({ tarea: { ...TAREA, locked_for_user: true } });
  const result = await call(handle, {
    course_id: 4102,
    assignment_id: 68145,
    file_path: path.join(dir, "entrega.pdf"),
    confirm: true,
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /bloqueada/);
  assert.equal(calls.filter(c => c.method === "POST").length, 0);
});

test("una tarea que no acepta online_upload se rechaza", async () => {
  const { dir, handle } = entorno({ tarea: { ...TAREA, submission_types: ["online_quiz"] } });
  const result = await call(handle, {
    course_id: 4102,
    assignment_id: 68145,
    file_path: path.join(dir, "entrega.pdf"),
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /online_upload/);
});

test("un plazo ya cerrado se rechaza", async () => {
  const { dir, handle } = entorno({ tarea: { ...TAREA, lock_at: "2020-01-01T00:00:00Z" } });
  const result = await call(handle, {
    course_id: 4102,
    assignment_id: 68145,
    file_path: path.join(dir, "entrega.pdf"),
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /plazo se cerró/);
});

test("un archivo vacío o inexistente se rechaza", async () => {
  const { dir, handle } = entorno({ archivos: { "vacio.pdf": "" } });
  const vacio = await call(handle, {
    course_id: 4102,
    assignment_id: 68145,
    file_path: path.join(dir, "vacio.pdf"),
  });
  assert.equal(vacio.isError, true);
  assert.match(vacio.content[0].text, /vacío/);

  const ausente = await call(handle, {
    course_id: 4102,
    assignment_id: 68145,
    file_path: path.join(dir, "no-existe.pdf"),
  });
  assert.equal(ausente.isError, true);
  assert.match(ausente.content[0].text, /No existe el archivo/);
});

test("tras entregar actualiza la nota de la tarea en el vault", async () => {
  const { dir, vaultDir, handle } = entorno();
  const result = await call(handle, {
    course_id: 4102,
    assignment_id: 68145,
    file_path: path.join(dir, "entrega.pdf"),
    confirm: true,
  });
  assert.equal(result.isError, false, result.content[0].text);
  assert.ok(result.structuredContent.vault.creadas >= 1);

  const nota = path.join(
    vaultDir,
    "Canvas",
    "Segundo semestre 2026",
    "4102-demo2002-491-teoria-2026-2-otra-materia-de-ejemplo",
    "Tareas",
    "68145 - [Laboratorio Nº1] - Ejercicio inicial.md",
  );
  assert.ok(fs.existsSync(nota), "la nota de la tarea quedó escrita");
  assert.ok(fs.readFileSync(nota, "utf8").includes("  - canvas/tarea"));
});

test("sin _csrf_token en la cookie el error dice qué hacer", () => {
  assert.throws(() => csrfToken("canvas_session=abc"), /_csrf_token/);
  assert.equal(csrfToken("canvas_session=abc; _csrf_token=tok%2Fen"), "tok/en");
});

test("más de 10 archivos se rechaza", async () => {
  const { dir, handle } = entorno();
  const result = await call(handle, {
    course_id: 4102,
    assignment_id: 68145,
    file_paths: new Array(11).fill(path.join(dir, "entrega.pdf")),
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Máximo 10 archivos/);
});
