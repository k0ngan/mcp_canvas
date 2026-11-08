import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { emit } from "../src/frontmatter.mjs";
import * as notes from "../src/notes.mjs";
import { CTX_2026_2, folderFor } from "./helpers.mjs";

// Estos bloques fijan el contrato de frontmatter del vault. Si una de estas
// pruebas falla, el servidor dejó de hablar el mismo idioma que las notas ya
// sincronizadas y las nuevas dejarían de ser indistinguibles de las viejas.

const FOLDER_ELECTRO = folderFor();
const FOLDER_SBD = folderFor("Canvas/Segundo semestre 2026/4102-demo2002-491-teoria-2026-2-otra-materia-de-ejemplo");
const CTX_SBD = { ...CTX_2026_2, courseId: 4102 };

function frontmatterOf(note) {
  return emit(note.entries);
}

test("paridad: nota de archivo", () => {
  const note = notes.fileNote(
    {
      id: 1218706,
      display_name: "GUIA.pdf",
      filename: "GUIA.pdf",
      "content-type": "application/pdf",
      size: 473737,
      updated_at: "2026-08-11T19:00:42Z",
    },
    FOLDER_ELECTRO,
    CTX_2026_2,
    { downloaded: true },
  );

  assert.equal(frontmatterOf(note), [
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
  ].join("\n"));

  assert.equal(note.relativePath, path.join(FOLDER_ELECTRO.relative, "Archivos", "1218706 - GUIA.pdf.md"));
  assert.ok(note.body.includes("## Archivo local"));
  assert.ok(note.body.includes(`[[${FOLDER_ELECTRO.wiki}/Descargas/1218706-GUIA.pdf]]`));
});

test("paridad: nombre de nota desde display_name y filename crudo de Canvas", () => {
  const file = {
    id: 1230937,
    display_name: "Descripción general.pdf",
    filename: "Descripci%C3%B3n+general.pdf",
    "content-type": "application/pdf",
    size: 45906,
    updated_at: "2026-08-14T17:01:08Z",
  };
  const note = notes.fileNote(file, FOLDER_SBD, CTX_SBD, { downloaded: false });
  assert.ok(note.relativePath.endsWith(path.join("Archivos", "1230937 - Descripción general.pdf.md")));
  assert.ok(frontmatterOf(note).includes("filename: Descripci%C3%B3n+general.pdf"));
  assert.equal(notes.downloadName(file), "1230937-Descripci%C3%B3n+general.pdf");
});

test("paridad: nota de curso con conteos", () => {
  const course = {
    id: 4101,
    name: "DEMO1001-101-TEORIA-2026-2: MATERIA DE EJEMPLO",
    course_code: "DEMO1001",
    term: { name: "2026-02-PREGRADO" },
    syllabus_body: "<p>Ponderación de las evaluaciones:</p>",
  };
  const inventory = {
    modules: new Array(4).fill({ id: 1, name: "m" }),
    files: new Array(22).fill({ id: 2, display_name: "f" }),
    assignments: [],
    pages: [],
    announcements: [],
  };
  const note = notes.courseNote(course, FOLDER_ELECTRO, CTX_2026_2, inventory);

  assert.equal(frontmatterOf(note), [
    "---",
    "tags:",
    "  - segundo-semestre",
    "  - canvas",
    "  - 2026-2",
    "  - canvas/curso",
    "tipo: curso",
    "course_id: 4101",
    "course_code: DEMO1001",
    "term: 2026-02-PREGRADO",
    "modulos: 4",
    "archivos: 22",
    "tareas: 0",
    "semestre: segundo semestre",
    "---",
  ].join("\n"));
  assert.ok(note.body.includes("## Syllabus"));
  assert.ok(note.body.includes("Ponderación de las evaluaciones:"));
  assert.ok(note.body.includes("_Sin tareas_"));
});

test("sin inventario la nota de curso no emite los conteos, así no los pisa con cero", () => {
  const course = { id: 4101, name: "x", course_code: "DEMO1001", term: { name: "2026-02-PREGRADO" } };
  const note = notes.courseNote(course, FOLDER_ELECTRO, CTX_2026_2, null);
  const text = frontmatterOf(note);
  assert.ok(!text.includes("modulos:"));
  assert.ok(!text.includes("archivos:"));
  assert.ok(!text.includes("tareas:"));
  assert.ok(text.includes("course_code: DEMO1001"));
});

test("paridad: nota de tarea", () => {
  const note = notes.assignmentNote(
    {
      id: 68145,
      name: "[Laboratorio Nº1] - Ejercicio inicial",
      points_possible: 0,
      due_at: "2026-08-17T03:59:59Z",
      submission_types: ["online_upload"],
      description: "<p>Laboratorio:</p>",
    },
    FOLDER_SBD,
    CTX_SBD,
  );

  assert.equal(frontmatterOf(note), [
    "---",
    "tags:",
    "  - segundo-semestre",
    "  - canvas",
    "  - 2026-2",
    "  - canvas/tarea",
    "tipo: tarea",
    "course_id: 4102",
    "assignment_id: 68145",
    "points_possible: 0",
    'due_at: "2026-08-17T03:59:59Z"',
    "submission_types: online_upload",
    "semestre: segundo semestre",
    "---",
  ].join("\n"));
  assert.ok(note.relativePath.endsWith(path.join("Tareas", "68145 - [Laboratorio Nº1] - Ejercicio inicial.md")));
});

test("paridad: nota de página", () => {
  const note = notes.pageNote(
    { page_id: 275867, title: "Bienvenida al curso de ejemplo", updated_at: "2026-08-14T15:19:16Z", body: "<p>Hola</p>" },
    FOLDER_SBD,
    CTX_SBD,
  );
  assert.equal(frontmatterOf(note), [
    "---",
    "tags:",
    "  - segundo-semestre",
    "  - canvas",
    "  - 2026-2",
    "  - canvas/pagina",
    "tipo: pagina",
    "course_id: 4102",
    "page_id: 275867",
    'updated_at: "2026-08-14T15:19:16Z"',
    "semestre: segundo semestre",
    "---",
  ].join("\n"));
});

test("paridad: nota de módulo con el formato de items del vault", () => {
  const resolver = notes.moduleItemResolver({
    discussions: [{ id: 120901, title: "Anuncios del curso" }],
  });
  const note = notes.moduleNote(
    {
      id: 86294,
      name: "Anuncios",
      position: 1,
      items: [{ type: "Discussion", title: "Anuncios del curso", content_id: 120901 }],
    },
    FOLDER_SBD,
    CTX_SBD,
    resolver,
  );

  assert.equal(frontmatterOf(note), [
    "---",
    "tags:",
    "  - segundo-semestre",
    "  - canvas",
    "  - 2026-2",
    "  - canvas/modulo",
    "tipo: modulo",
    "course_id: 4102",
    "module_id: 86294",
    "position: 1",
    "semestre: segundo semestre",
    "---",
  ].join("\n"));
  assert.ok(note.body.includes(
    "- `Discussion` Anuncios del curso -> " +
    `[[${FOLDER_SBD.wiki}/Discusiones/120901 - Anuncios del curso]]`,
  ));
});

test("un item de módulo sin destino resoluble queda sin enlace", () => {
  const note = notes.moduleNote(
    { id: 84176, name: "Presentación", position: 3, items: [{ type: "SubHeader", title: "Descripción de la asignatura" }] },
    FOLDER_SBD,
    CTX_SBD,
    notes.moduleItemResolver({}),
  );
  assert.ok(note.body.includes("- `SubHeader` Descripción de la asignatura"));
  assert.ok(!note.body.includes("->"));
});

test("paridad: nota de anuncio", () => {
  const note = notes.announcementNote(
    { id: 130285, title: "PRUEBA 1", posted_at: "2026-10-28T17:12:27Z", message: "<p>Estimadas y estimados</p>" },
    FOLDER_ELECTRO,
    CTX_2026_2,
  );
  assert.equal(frontmatterOf(note), [
    "---",
    "tags:",
    "  - segundo-semestre",
    "  - canvas",
    "  - 2026-2",
    "  - canvas/anuncio",
    "tipo: anuncio",
    "course_id: 4101",
    "announcement_id: 130285",
    'posted_at: "2026-10-28T17:12:27Z"',
    "semestre: segundo semestre",
    "---",
  ].join("\n"));
});

test("paridad: nota de discusión vacía", () => {
  const note = notes.discussionNote(
    { id: 120901, title: "Anuncios del curso", message: "" },
    FOLDER_SBD,
    CTX_SBD,
  );
  assert.equal(frontmatterOf(note), [
    "---",
    "tags:",
    "  - segundo-semestre",
    "  - canvas",
    "  - 2026-2",
    "  - canvas/discusion",
    "tipo: discusion",
    "course_id: 4102",
    "discussion_id: 120901",
    "semestre: segundo semestre",
    "---",
  ].join("\n"));
  assert.ok(note.body.includes("_Sin mensaje_"));
});

test("un curso de primer semestre usa el tag de campaña que le toca", () => {
  const ctx = { ...CTX_2026_2, term: "2026-1", campaignTag: "primer-semestre", semestre: "primer semestre" };
  const note = notes.announcementNote({ id: 1, title: "x", posted_at: "2026-03-01T00:00:00Z" }, FOLDER_ELECTRO, ctx);
  const text = frontmatterOf(note);
  assert.ok(text.includes("  - primer-semestre"));
  assert.ok(text.includes("  - 2026-1"));
  assert.ok(text.includes("semestre: primer semestre"));
});

test("el tag temático entra solo si la asignatura está mapeada", () => {
  const conMapa = { ...CTX_2026_2, subject: "materia-de-ejemplo" };
  assert.ok(frontmatterOf(notes.announcementNote({ id: 1, title: "x" }, FOLDER_ELECTRO, conMapa)).includes("  - materia-de-ejemplo"));
  assert.ok(!frontmatterOf(notes.announcementNote({ id: 1, title: "x" }, FOLDER_ELECTRO, CTX_2026_2)).includes("materia-de-ejemplo"));
});

test("htmlToText limpia el HTML de Canvas sin dejar etiquetas", () => {
  const text = notes.htmlToText('<p>Hola <strong>mundo</strong></p><ul><li>uno</li><li>dos</li></ul><script>alert(1)</script>&amp; fin');
  assert.ok(!text.includes("<"));
  assert.ok(!text.includes("alert(1)"));
  assert.ok(text.includes("Hola mundo"));
  assert.ok(text.includes("uno"));
  assert.ok(text.includes("& fin"));
});

test("el índice del semestre reproduce el frontmatter del vault", () => {
  const parts = { year: "2026", half: 2, campaignTag: "segundo-semestre", semestre: "segundo semestre", folder: "Segundo semestre 2026" };
  const note = notes.termIndexNote(
    { subdir: "Canvas" },
    parts,
    [{ name: "DEMO1001-101-TEORIA-2026-2: MATERIA DE EJEMPLO" }],
    [FOLDER_ELECTRO],
    "2026-11-08 02:00 UTC",
  );
  assert.equal(frontmatterOf(note), [
    "---",
    "tags:",
    "  - canvas",
    "  - segundo-semestre",
    "semestre: segundo semestre",
    "periodo: 2026-2",
    "---",
  ].join("\n"));
  assert.equal(note.relativePath, path.join("Canvas", "Segundo semestre 2026.md"));
  assert.ok(note.body.includes(`- [[${FOLDER_ELECTRO.wiki}/Curso]] — DEMO1001-101-TEORIA-2026-2: MATERIA DE EJEMPLO`));
});
