import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { compose } from "../src/frontmatter.mjs";
import { buildGuideNote, collectSources, inventory } from "../src/study.mjs";
import { VaultWriter } from "../src/vault.mjs";
import { CTX_2026_2, tempVault, testConfig } from "./helpers.mjs";

// Una guía solo puede apoyarse en material que vino de Canvas y quedó en el
// vault. Estas pruebas fijan ese anclaje.

const REL = path.join("Canvas", "Segundo semestre 2026", "4101-demo1001-101-teoria-2026-2-materia-de-ejemplo");

function nota(entries, cuerpo) {
  return compose(entries, cuerpo);
}

function montarCurso({ extraidas = true } = {}) {
  const vaultDir = tempVault("mcp-canvas-study-");
  const base = path.join(vaultDir, REL);
  for (const sub of ["Archivos", "Anuncios", "Tareas", "Descargas", "Fuentes extraidas"]) {
    fs.mkdirSync(path.join(base, sub), { recursive: true });
  }

  fs.writeFileSync(path.join(base, "Curso.md"), nota(
    [["tags", ["canvas"]], ["tipo", "curso"], ["course_id", 4101], ["course_code", "DEMO1001"]],
    "# DEMO1001-101-TEORIA-2026-2: MATERIA DE EJEMPLO\n\n## Syllabus\n\nPrograma del curso.",
  ));

  fs.writeFileSync(path.join(base, "Archivos", "501 - apunte.pdf.md"), nota(
    [["tags", ["canvas"]], ["tipo", "archivo"], ["course_id", 4101], ["file_id", 501], ["filename", "apunte.pdf"]],
    "# apunte.pdf",
  ));
  fs.writeFileSync(path.join(base, "Archivos", "502 - imagen.png.md"), nota(
    [["tags", ["canvas"]], ["tipo", "archivo"], ["course_id", 4101], ["file_id", 502], ["filename", "imagen.png"]],
    "# imagen.png",
  ));
  fs.writeFileSync(path.join(base, "Archivos", "503 - consultas.sql.md"), nota(
    [["tags", ["canvas"]], ["tipo", "archivo"], ["course_id", 4101], ["file_id", 503], ["filename", "consultas.sql"]],
    "# consultas.sql",
  ));
  fs.writeFileSync(path.join(base, "Anuncios", "601 - Aviso de prueba.md"), nota(
    [["tags", ["canvas"]], ["tipo", "anuncio"], ["course_id", 4101], ["announcement_id", 601]],
    "# Aviso de prueba\n\nLa prueba cubre el teorema del flujo y los condensadores.",
  ));

  if (extraidas) {
    fs.writeFileSync(
      path.join(base, "Fuentes extraidas", "501.txt"),
      "Capitulo 1. Introduccion general al curso.\n\n".repeat(20) +
      "Capitulo 7. El teorema del flujo dice que el flujo neto depende de la carga encerrada. " +
      "El teorema del flujo se aplica con simetria esferica.\n",
    );
  }
  // .sql se lee directo de Descargas, sin librerías
  fs.writeFileSync(path.join(base, "Descargas", "503-consultas.sql"), "SELECT * FROM condensadores;");

  const config = testConfig({ vaultDir });
  const writer = new VaultWriter(config, { dryRun: true });
  const folder = writer.courseFolder({ id: 4101, name: "DEMO1001-101-TEORIA-2026-2: MATERIA DE EJEMPLO", course_code: "DEMO1001" });
  return { vaultDir, config, folder, base };
}

test("el inventario encuentra el material de todas las subcarpetas", () => {
  const { folder } = montarCurso();
  const fuentes = inventory(folder);
  const citas = fuentes.map(f => f.cita).sort();
  assert.deepEqual(citas, ["anuncio:601", "archivo:501", "archivo:502", "archivo:503", "curso"]);
});

test("usa el texto extraído, lee directo los formatos de texto y reporta lo que no tiene", () => {
  const { folder } = montarCurso();
  const paquete = collectSources(folder, { tema: "teorema del flujo" });

  const usadas = paquete.fuentes.map(f => f.cita);
  assert.ok(usadas.includes("archivo:501"), "el PDF con texto extraído entra");
  assert.equal(paquete.fuentes.find(f => f.cita === "archivo:501").origen, "fuente_extraida");

  const sinTexto = paquete.excluidas.find(e => e.cita === "archivo:502");
  assert.equal(sinTexto.motivo, "sin texto extraído", "la imagen se reporta, no se omite en silencio");
});

test("lee un .sql directo de Descargas sin librerías", () => {
  const { folder } = montarCurso();
  const paquete = collectSources(folder, { tema: "condensadores" });
  const sql = paquete.fuentes.find(f => f.cita === "archivo:503");
  assert.ok(sql, "el .sql entra");
  assert.equal(sql.origen, "descarga_directa");
  assert.ok(sql.pasajes[0].includes("condensadores"));
});

test("elige el pasaje que explica el tema, no el índice que solo lo menciona", () => {
  const { base, folder } = montarCurso();
  fs.writeFileSync(path.join(base, "Fuentes extraidas", "501.txt"), [
    "Indice",
    "Tema 1 flujo .............................. 3",
    "Tema 2 flujo .............................. 9",
    "Tema 3 flujo ............................. 14",
    "Tema 4 flujo ............................. 20",
    "Tema 5 flujo ............................. 25",
    "",
    "x".repeat(3000),
    "",
    "Desarrollo: el flujo electrico neto atraviesa la superficie cerrada y el flujo depende de la carga.",
  ].join("\n"));

  const paquete = collectSources(folder, { tema: "flujo", ventana: 600, maxChars: 900 });
  const fuente = paquete.fuentes.find(f => f.cita === "archivo:501");
  assert.ok(fuente.pasajes[0].includes("Desarrollo"), "gana el desarrollo");
  assert.ok(!fuente.pasajes[0].includes(".........."), "el índice queda fuera");
});

test("sin tema devuelve el inicio de cada fuente y respeta el presupuesto", () => {
  const { folder } = montarCurso();
  const paquete = collectSources(folder, { maxChars: 500, ventana: 200 });
  assert.ok(paquete.caracteres_usados <= 500);
  assert.ok(paquete.fuentes.length >= 1);
  assert.equal(paquete.terminos_buscados.length, 0);
});

test("lo que no cabe en el presupuesto se reporta con su motivo", () => {
  const { folder } = montarCurso();
  const paquete = collectSources(folder, { maxChars: 1200, ventana: 1000 });
  const total = paquete.fuentes.length + paquete.excluidas.length;
  assert.equal(total, inventory(folder).length, "cada fuente está o usada o excluida con motivo");
});

test("un curso sin material sincronizado lo dice en vez de devolver vacío", () => {
  const vaultDir = tempVault("mcp-canvas-vacio-");
  const config = testConfig({ vaultDir });
  const writer = new VaultWriter(config, { dryRun: true });
  const folder = writer.courseFolder({ id: 4999, name: "SIN-2026-2: NADA" });
  assert.throws(() => collectSources(folder), /No hay material sincronizado/);
});

test("el cuerpo que escribió la persona no entra en el material de la guía", () => {
  const { base, folder } = montarCurso();
  const archivo = path.join(base, "Anuncios", "601 - Aviso de prueba.md");
  fs.writeFileSync(archivo, [
    "---",
    "tags:",
    "  - canvas",
    "tipo: anuncio",
    "course_id: 4101",
    "announcement_id: 601",
    "---",
    "",
    "<!-- canvas:inicio -->",
    "# Aviso de prueba",
    "",
    "La prueba cubre el teorema del flujo.",
    "<!-- canvas:fin -->",
    "",
    "## Notas",
    "",
    "Mi apunte personal sobre el teorema del flujo que no viene de Canvas.",
    "",
  ].join("\n"));

  const paquete = collectSources(folder, { tema: "teorema del flujo" });
  const anuncio = paquete.fuentes.find(f => f.cita === "anuncio:601");
  assert.ok(anuncio.pasajes.join(" ").includes("La prueba cubre"));
  assert.ok(
    !anuncio.pasajes.join(" ").includes("Mi apunte personal"),
    "lo que la persona anotó no se le devuelve como fuente de Canvas",
  );
});

// --- escritura de la guía ------------------------------------------------

const CATALOGO = [
  { cita: "archivo:501", nota: `${REL.split(path.sep).join("/")}/Archivos/501 - apunte.pdf`, titulo: "501 - apunte.pdf" },
  { cita: "anuncio:601", nota: `${REL.split(path.sep).join("/")}/Anuncios/601 - Aviso de prueba`, titulo: "601 - Aviso de prueba" },
];

function folderBase() {
  return { relative: REL, wiki: REL.split(path.sep).join("/"), absolute: path.join("/vault", REL) };
}

test("rechaza una cita que no corresponde a material del curso", () => {
  assert.throws(
    () => buildGuideNote(folderBase(), CTX_2026_2, {
      titulo: "Guia",
      catalogo: CATALOGO,
      secciones: [{ encabezado: "X", cuerpo: "y", fuentes: ["archivo:999999"] }],
    }),
    /no corresponden a material sincronizado/,
  );
});

test("rechaza una sección sin fuentes y una vacía", () => {
  assert.throws(
    () => buildGuideNote(folderBase(), CTX_2026_2, {
      titulo: "Guia",
      catalogo: CATALOGO,
      secciones: [{ encabezado: "X", cuerpo: "y", fuentes: [] }],
    }),
    /no declara fuentes/,
  );
  assert.throws(
    () => buildGuideNote(folderBase(), CTX_2026_2, {
      titulo: "Guia",
      catalogo: CATALOGO,
      secciones: [{ encabezado: "X", cuerpo: "   ", fuentes: ["archivo:501"] }],
    }),
    /está vacía/,
  );
});

test("la guía sale con el frontmatter del ecosistema y el material citado", () => {
  const note = buildGuideNote(folderBase(), { ...CTX_2026_2, subject: "materia-de-ejemplo" }, {
    titulo: "Prueba 2 - guia de estudio",
    tema: "Teorema del flujo",
    tagsExtra: ["prueba-2"],
    fechaPrueba: "2026-12-04",
    hora: "18:00",
    sala: "M1-307",
    catalogo: CATALOGO,
    secciones: [
      { encabezado: "Teorema del flujo", cuerpo: "Depende solo de la carga encerrada.", fuentes: ["archivo:501"] },
      { encabezado: "Lo que anunciaron", cuerpo: "Entra el teorema del flujo.", fuentes: ["anuncio:601"] },
    ],
  });

  const texto = compose(note.entries, note.body);
  assert.ok(texto.includes("tipo: guia_estudio"));
  assert.ok(texto.includes("  - canvas\n"));
  assert.ok(texto.includes("  - 2026-2\n"));
  assert.ok(texto.includes("  - materia-de-ejemplo\n"));
  assert.ok(texto.includes("  - estudio\n"));
  assert.ok(texto.includes("  - prueba-2\n"));
  assert.ok(texto.includes('hora: "18:00"'), "la hora va citada o YAML la lee como número");
  assert.ok(texto.includes("sala: M1-307"));
  assert.ok(texto.includes("fuentes:\n  - archivo:501\n  - anuncio:601"));
  assert.ok(note.body.includes("## Material citado"));
  assert.ok(note.body.includes("[[" + CATALOGO[0].nota + "]]"), "la cita enlaza a la nota de Canvas");
  assert.deepEqual(note.citas, ["archivo:501", "anuncio:601"]);
  assert.equal(note.relativePath, path.join(REL, "Prueba 2 - guia de estudio.md"));
});

test("una guía sin título o sin secciones se rechaza", () => {
  assert.throws(
    () => buildGuideNote(folderBase(), CTX_2026_2, { titulo: "  ", catalogo: CATALOGO, secciones: [{ encabezado: "a", cuerpo: "b", fuentes: ["archivo:501"] }] }),
    /necesita un título/,
  );
  assert.throws(
    () => buildGuideNote(folderBase(), CTX_2026_2, { titulo: "Guia", catalogo: CATALOGO, secciones: [] }),
    /al menos una sección/,
  );
});
