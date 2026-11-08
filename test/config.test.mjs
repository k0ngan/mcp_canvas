import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { describeConfig, loadConfig } from "../src/config.mjs";

const BASE = { CANVAS_BASE_URL: "https://canvas.example.edu" };

test("la instancia de Canvas es obligatoria: no hay institución por defecto", () => {
  assert.throws(() => loadConfig({}), /Falta CANVAS_BASE_URL/);
  assert.throws(() => loadConfig({ CANVAS_BASE_URL: "   " }), /Falta CANVAS_BASE_URL/);
});

test("exige https y una URL válida", () => {
  assert.throws(() => loadConfig({ CANVAS_BASE_URL: "http://canvas.example.edu" }), /debe usar https/);
  assert.throws(() => loadConfig({ CANVAS_BASE_URL: "no-es-una-url" }), /no es una URL válida/);
});

test("normaliza la barra final y deriva el origen", () => {
  const config = loadConfig({ CANVAS_BASE_URL: "https://canvas.example.edu/" });
  assert.equal(config.baseUrl, "https://canvas.example.edu");
  assert.equal(config.origin, "https://canvas.example.edu");
});

test("sin vault la escritura queda apagada y no revienta", () => {
  const config = loadConfig(BASE);
  assert.equal(config.vaultDir, null);
  assert.equal(config.write, false);
});

test("la carpeta de la cookie por defecto no nombra ninguna institución", () => {
  const config = loadConfig({ ...BASE, LOCALAPPDATA: path.join("C:", "datos") });
  assert.equal(config.cookieFile, path.join("C:", "datos", "mcp-canvas", "canvas_session"));
});

test("la allowlist de subida es corta por defecto y ampliable", () => {
  assert.deepEqual([...loadConfig(BASE).uploadExtensions].sort(), [".pbix", ".pdf", ".sql"]);

  const ampliada = loadConfig({ ...BASE, CANVAS_UPLOAD_EXTENSIONS: "pdf, .ZIP , ipynb" });
  assert.deepEqual([...ampliada.uploadExtensions].sort(), [".ipynb", ".pdf", ".zip"]);
});

test("describeConfig no expone la cookie, solo si viene del entorno", () => {
  const descrito = describeConfig(loadConfig({ ...BASE, CANVAS_COOKIE_HEADER: "canvas_session=secreto" }));
  assert.equal(descrito.cookie_desde_entorno, true);
  assert.equal(JSON.stringify(descrito).includes("secreto"), false);
});

test("el token de API se ignora a propósito", () => {
  const config = loadConfig({ ...BASE, CANVAS_TOKEN: "no-deberia-usarse" });
  assert.equal(config.token, undefined);
  assert.equal(JSON.stringify(describeConfig(config)).includes("no-deberia-usarse"), false);
});
