import fs from "node:fs";
import path from "node:path";

import { parse, get } from "./frontmatter.mjs";
import { sanitizeName } from "./vault.mjs";

// Material de estudio. Este módulo NO escribe prosa: junta el material que ya
// está en el vault, con su procedencia, para que el agente redacte la guía
// citando solo eso. Lo que no viene de Canvas no entra acá.

// Extensiones que se pueden leer directo del binario descargado, sin librerías.
const TEXTO_DIRECTO = new Set([".txt", ".md", ".sql", ".csv", ".json", ".tex", ".py", ".cpp", ".h", ".c", ".java", ".r"]);

const SUBCARPETAS = {
  archivo: "Archivos",
  tarea: "Tareas",
  pagina: "Paginas",
  modulo: "Modulos",
  anuncio: "Anuncios",
  discusion: "Discusiones",
};

export class StudyError extends Error {
  constructor(message) {
    super(message);
    this.name = "StudyError";
  }
}

function normalizar(texto) {
  return String(texto ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

function leerDirectorio(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

// Inventario de todo lo que la sincronización dejó para este curso.
export function inventory(folder) {
  const fuentes = [];
  for (const [tipo, sub] of Object.entries(SUBCARPETAS)) {
    const dir = path.join(folder.absolute, sub);
    for (const entry of leerDirectorio(dir)) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const ruta = path.join(dir, entry.name);
      let entries = [];
      let cuerpo = "";
      try {
        const parsed = parse(fs.readFileSync(ruta, "utf8"));
        entries = parsed.entries;
        cuerpo = parsed.body;
      } catch {
        continue;
      }
      if (get(entries, "tipo") !== tipo) continue;
      fuentes.push({
        tipo,
        cita: citaPara(tipo, entries),
        titulo: entry.name.replace(/\.md$/, ""),
        nota: `${folder.wiki}/${sub}/${entry.name.replace(/\.md$/, "")}`,
        archivo_md: ruta,
        file_id: get(entries, "file_id") ?? null,
        filename: get(entries, "filename") ?? null,
        content_type: get(entries, "content_type") ?? null,
        size: get(entries, "size") ?? null,
        updated_at: get(entries, "updated_at") ?? get(entries, "posted_at") ?? null,
        cuerpo: limpiarCuerpo(cuerpo),
      });
    }
  }
  const curso = path.join(folder.absolute, "Curso.md");
  if (fs.existsSync(curso)) {
    const parsed = parse(fs.readFileSync(curso, "utf8"));
    fuentes.push({
      tipo: "curso",
      cita: "curso",
      titulo: "Curso",
      nota: `${folder.wiki}/Curso`,
      archivo_md: curso,
      file_id: null,
      cuerpo: limpiarCuerpo(parsed.body),
    });
  }
  return fuentes;
}

// Quita los centinelas y la sección de notas propias: la guía se arma con lo
// que vino de Canvas, no con lo que la persona anotó encima.
function limpiarCuerpo(cuerpo) {
  let texto = String(cuerpo ?? "");
  texto = texto.replace(/<!--\s*canvas:inicio\s*-->/g, "").replace(/<!--\s*canvas:fin\s*-->[\s\S]*$/g, "");
  texto = texto.replace(/\n## Notas\s*$/g, "");
  return texto.trim();
}

function citaPara(tipo, entries) {
  if (tipo === "archivo") return `archivo:${get(entries, "file_id")}`;
  if (tipo === "tarea") return `tarea:${get(entries, "assignment_id")}`;
  if (tipo === "pagina") return `pagina:${get(entries, "page_id")}`;
  if (tipo === "modulo") return `modulo:${get(entries, "module_id")}`;
  if (tipo === "anuncio") return `anuncio:${get(entries, "announcement_id")}`;
  if (tipo === "discusion") return `discusion:${get(entries, "discussion_id")}`;
  return tipo;
}

// Texto completo de una fuente: el extraído del adjunto si existe, y si no el
// cuerpo de la propia nota.
export function textoDe(fuente, folder) {
  if (fuente.file_id != null) {
    const extraido = path.join(folder.absolute, "Fuentes extraidas", `${fuente.file_id}.txt`);
    if (fs.existsSync(extraido)) {
      return { texto: fs.readFileSync(extraido, "utf8").trim(), origen: "fuente_extraida" };
    }
    const directo = leerDescargaDirecta(fuente, folder);
    if (directo) return { texto: directo, origen: "descarga_directa" };
    return { texto: "", origen: "sin_extraccion" };
  }
  return { texto: fuente.cuerpo || "", origen: "nota" };
}

function leerDescargaDirecta(fuente, folder) {
  const dir = path.join(folder.absolute, "Descargas");
  const prefijo = `${fuente.file_id}-`;
  for (const entry of leerDirectorio(dir)) {
    if (!entry.isFile() || !entry.name.startsWith(prefijo)) continue;
    const extension = path.extname(entry.name).toLowerCase();
    const ruta = path.join(dir, entry.name);
    if (extension === ".ipynb") {
      try {
        const nb = JSON.parse(fs.readFileSync(ruta, "utf8"));
        return (nb.cells || [])
          .map(celda => (Array.isArray(celda.source) ? celda.source.join("") : celda.source || ""))
          .join("\n\n")
          .trim();
      } catch {
        return null;
      }
    }
    if (!TEXTO_DIRECTO.has(extension)) return null;
    try {
      return fs.readFileSync(ruta, "utf8").replace(/﻿/g, "").trim();
    } catch {
      return null;
    }
  }
  return null;
}

// Pasajes que mencionan el tema, con contexto alrededor. Sin tema, devuelve el
// principio del documento.
function pasajes(texto, terminos, { ventana = 1200, maximo = 3 }) {
  if (!texto) return [];
  if (!terminos.length) return [{ texto: texto.slice(0, ventana), desde: 0 }];
  const plano = normalizar(texto);
  // El tope es por término, no global: si no, un término repetido en el índice
  // agota la cuota y los pasajes del final del documento nunca se miran.
  const POR_TERMINO = 200;
  const encontrados = [];
  for (const termino of terminos) {
    let desde = 0;
    let vistos = 0;
    while (vistos < POR_TERMINO) {
      const posicion = plano.indexOf(termino, desde);
      if (posicion === -1) break;
      encontrados.push(posicion);
      desde = posicion + termino.length;
      vistos++;
    }
  }
  if (!encontrados.length) return [];
  encontrados.sort((a, b) => a - b);

  // Ventanas candidatas, fusionando las que se solapan.
  const candidatas = [];
  for (const posicion of encontrados) {
    const inicio = Math.max(0, posicion - Math.floor(ventana / 3));
    const fin = Math.min(texto.length, inicio + ventana);
    const ultima = candidatas.at(-1);
    if (ultima && inicio <= ultima.fin) {
      ultima.fin = Math.max(ultima.fin, fin);
      continue;
    }
    candidatas.push({ inicio, fin });
  }

  // Se eligen por densidad de términos distintos, no por aparecer primero: si
  // no, el índice de un PDF le gana al capítulo que de verdad explica el tema.
  const puntuadas = candidatas.map(bloque => {
    const trozo = texto.slice(bloque.inicio, bloque.fin);
    const plano = normalizar(trozo);
    let distintos = 0;
    let total = 0;
    for (const termino of terminos) {
      const hits = plano.split(termino).length - 1;
      if (hits > 0) {
        distintos++;
        total += hits;
      }
    }
    return { ...bloque, trozo, puntaje: distintos * 10 + total - penalizacionIndice(trozo) };
  });

  // Se devuelven ordenados por puntaje: quien recorte por presupuesto se
  // queda con los mejores, no con los que aparecen primero en el documento.
  puntuadas.sort((a, b) => b.puntaje - a.puntaje || a.inicio - b.inicio);
  // Una ventana con puntaje no positivo es ruido —típicamente un índice que
  // nombra el tema sin explicarlo—. Solo se conserva si no hay nada mejor.
  const utiles = puntuadas.filter(b => b.puntaje > 0);
  const elegidas = utiles.length ? utiles : puntuadas.slice(0, 1);
  return elegidas
    .slice(0, maximo)
    .map(b => ({ texto: b.trozo.trim(), desde: b.inicio, puntaje: b.puntaje }));
}

// Los índices y tablas de contenido mencionan todos los temas y no explican
// ninguno. Se reconocen por las líneas de puntos conductores.
function penalizacionIndice(trozo) {
  const lineas = trozo.split("\n");
  if (lineas.length < 3) return 0;
  const conPuntos = lineas.filter(linea => /\.{4,}/.test(linea)).length;
  return conPuntos / lineas.length > 0.3 ? 25 : 0;
}

function puntuar(texto, terminos) {
  if (!terminos.length) return 0;
  const plano = normalizar(texto);
  let total = 0;
  for (const termino of terminos) {
    const partes = plano.split(termino).length - 1;
    if (partes > 0) total += partes + 5; // premia cubrir términos distintos
  }
  return total;
}

export function collectSources(folder, {
  tema = "",
  fileIds = null,
  tipos = null,
  maxChars = 60_000,
  ventana = 1200,
} = {}) {
  const todas = inventory(folder);
  if (!todas.length) {
    throw new StudyError(
      `No hay material sincronizado para este curso en ${folder.wiki}. Corre canvas_sync_course antes de armar una guía.`,
    );
  }

  const terminos = normalizar(tema)
    .split(/[^a-z0-9ñ]+/)
    .filter(t => t.length >= 3);

  const pedidos = Array.isArray(fileIds) && fileIds.length
    ? new Set(fileIds.map(Number))
    : null;
  const tiposPedidos = Array.isArray(tipos) && tipos.length ? new Set(tipos) : null;

  const candidatas = todas.filter(f => {
    if (pedidos && (f.file_id == null || !pedidos.has(Number(f.file_id)))) return false;
    if (tiposPedidos && !tiposPedidos.has(f.tipo)) return false;
    return true;
  });

  const sinExtraccion = [];
  const evaluadas = [];
  for (const fuente of candidatas) {
    const { texto, origen } = textoDe(fuente, folder);
    if (origen === "sin_extraccion" || !texto) {
      sinExtraccion.push({ cita: fuente.cita, titulo: fuente.titulo, motivo: origen === "sin_extraccion" ? "sin texto extraído" : "vacía" });
      continue;
    }
    evaluadas.push({ fuente, texto, origen, puntaje: puntuar(texto, terminos) });
  }

  const conTema = terminos.length ? evaluadas.filter(e => e.puntaje > 0) : evaluadas;
  conTema.sort((a, b) => b.puntaje - a.puntaje || String(a.fuente.titulo).localeCompare(String(b.fuente.titulo)));

  const seleccion = [];
  const omitidas = [];
  let usados = 0;
  for (const item of conTema) {
    const bloques = pasajes(item.texto, terminos, { ventana });
    if (!bloques.length) continue;
    // Los pasajes vienen por puntaje: se aceptan los que caben y recién al
    // final se reordenan por posición, para que la guía se lea en orden.
    const aceptados = [];
    for (const bloque of bloques) {
      if (usados + bloque.texto.length > maxChars) continue;
      aceptados.push(bloque);
      usados += bloque.texto.length;
    }
    const recortados = aceptados
      .sort((a, b) => a.desde - b.desde)
      .map(bloque => bloque.texto);
    if (!recortados.length) {
      omitidas.push({ cita: item.fuente.cita, titulo: item.fuente.titulo, motivo: "no cabía en el presupuesto de caracteres" });
      continue;
    }
    seleccion.push({
      cita: item.fuente.cita,
      tipo: item.fuente.tipo,
      titulo: item.fuente.titulo,
      nota: item.fuente.nota,
      file_id: item.fuente.file_id,
      origen: item.origen,
      updated_at: item.fuente.updated_at,
      relevancia: item.puntaje,
      pasajes: recortados,
      texto_completo: recortados.join("\n\n").length >= item.texto.length,
    });
  }

  const sinTema = terminos.length
    ? evaluadas.filter(e => e.puntaje === 0).map(e => ({ cita: e.fuente.cita, titulo: e.fuente.titulo, motivo: "no menciona el tema" }))
    : [];

  return {
    carpeta: folder.wiki,
    tema: tema || null,
    terminos_buscados: terminos,
    presupuesto_caracteres: maxChars,
    caracteres_usados: usados,
    fuentes: seleccion,
    inventario: {
      total: todas.length,
      con_texto: evaluadas.length,
      usadas: seleccion.length,
    },
    // Nada se descarta en silencio: todo lo que quedó fuera va con su motivo.
    excluidas: [...sinExtraccion, ...omitidas, ...sinTema],
    citas_validas: seleccion.map(f => f.cita),
    nota: "Redacta la guía usando únicamente estos pasajes y cita la clave `cita` de cada fuente que uses. Si falta material para una sección, dilo en la guía en lugar de completarlo con conocimiento propio.",
  };
}

// --- escritura de la guía ------------------------------------------------

export function buildGuideNote(folder, ctx, {
  titulo,
  secciones,
  catalogo = [],
  tagsExtra = [],
  fechaPrueba = null,
  hora = null,
  sala = null,
  tema = null,
}) {
  if (!titulo || !String(titulo).trim()) throw new StudyError("La guía necesita un título.");
  if (!Array.isArray(secciones) || !secciones.length) {
    throw new StudyError("La guía necesita al menos una sección.");
  }

  const validas = new Set(catalogo.map(fuente => fuente.cita));
  const desconocidas = [];
  const usadas = [];
  secciones.forEach((seccion, indice) => {
    if (!seccion || !String(seccion.encabezado || "").trim()) {
      throw new StudyError(`La sección ${indice + 1} no tiene encabezado.`);
    }
    if (!String(seccion.cuerpo || "").trim()) {
      throw new StudyError(`La sección "${seccion.encabezado}" está vacía.`);
    }
    const citas = Array.isArray(seccion.fuentes) ? seccion.fuentes.filter(Boolean) : [];
    if (!citas.length) {
      throw new StudyError(
        `La sección "${seccion.encabezado}" no declara fuentes. Cada sección tiene que citar el material de Canvas en que se apoya.`,
      );
    }
    for (const cita of citas) {
      if (!validas.has(cita)) desconocidas.push({ seccion: seccion.encabezado, cita });
      else usadas.push(cita);
    }
  });

  if (desconocidas.length) {
    throw new StudyError(
      `Estas citas no corresponden a material sincronizado de este curso: ${desconocidas
        .map(d => `${d.cita} (en "${d.seccion}")`)
        .join(", ")}. Usa solo las claves que devolvió canvas_study_sources.`,
    );
  }

  const unicas = [...new Set(usadas)];
  const tags = ["canvas"];
  if (ctx.term) tags.push(ctx.term);
  if (ctx.subject) tags.push(ctx.subject);
  tags.push("estudio");
  for (const tag of tagsExtra) {
    const limpio = String(tag).trim().toLowerCase().replace(/\s+/g, "-");
    if (limpio && !tags.includes(limpio)) tags.push(limpio);
  }

  const entries = [
    ["tags", tags],
    ["tipo", "guia_estudio"],
    ["course_id", ctx.courseId],
  ];
  if (fechaPrueba) entries.push(["fecha_prueba", fechaPrueba]);
  if (hora) entries.push(["hora", hora]);
  if (sala) entries.push(["sala", sala]);
  if (tema) entries.push(["tema", tema]);
  entries.push(["fuentes", unicas]);
  if (ctx.semestre) entries.push(["semestre", ctx.semestre]);

  const cuerpo = [`# ${titulo}`, ""];
  if (tema) cuerpo.push(`Tema: ${tema}.`, "");
  cuerpo.push(
    `Armada solo con el material sincronizado de Canvas del curso ${ctx.courseId}. Cada sección indica de qué fuente sale.`,
    "",
  );
  for (const seccion of secciones) {
    cuerpo.push(`## ${seccion.encabezado}`, "");
    cuerpo.push(String(seccion.cuerpo).trim(), "");
    cuerpo.push(`Fuentes: ${seccion.fuentes.join(", ")}`, "");
  }
  cuerpo.push("## Material citado", "");
  for (const cita of unicas) {
    const fuente = catalogo.find(item => item.cita === cita);
    cuerpo.push(fuente?.nota ? `- \`${cita}\` → [[${fuente.nota}]]` : `- \`${cita}\``);
  }

  return {
    relativePath: path.join(folder.relative, `${sanitizeName(titulo)}.md`),
    entries,
    body: cuerpo.join("\n").trim(),
    citas: unicas,
  };
}
