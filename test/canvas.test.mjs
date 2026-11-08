import assert from "node:assert/strict";
import test from "node:test";

import { CanvasClient, nextLink, numericId } from "../src/canvas.mjs";
import { json, reply, testConfig } from "./helpers.mjs";

test("solo acepta URLs de la API del Canvas configurado", () => {
  const client = new CanvasClient(testConfig(), async () => json([]));
  assert.ok(client.apiUrl("/api/v1/courses"));
  assert.throws(() => client.apiUrl("https://evil.example.com/api/v1/courses"), /fuera de la API/);
  assert.throws(() => client.apiUrl("/login/oauth2/token"), /fuera de la API/);
});

test("rechaza un enlace de paginación que apunta fuera de la API", async () => {
  const config = testConfig();
  const client = new CanvasClient(config, async () =>
    json([{ id: 1 }], { link: '<https://evil.example.com/api/v1/courses?page=2>; rel="next"' }));
  await assert.rejects(client.list("/api/v1/courses"), /fuera de la API/);
});

test("corta la paginación en el tope de páginas", async () => {
  const config = { ...testConfig(), maxPages: 3 };
  let calls = 0;
  const client = new CanvasClient(config, async () => {
    calls++;
    return json([{ id: calls }], { link: '<https://canvas.example.edu/api/v1/courses?page=9>; rel="next"' });
  });
  await assert.rejects(client.list("/api/v1/courses"), /límite de páginas/);
  assert.equal(calls, 3);
});

test("la cookie no viaja a un host externo durante una descarga", async () => {
  const seen = [];
  const client = new CanvasClient(testConfig(), async (url, options) => {
    seen.push({ host: new URL(url).host, cookie: options.headers?.Cookie ?? null });
    if (seen.length === 1) {
      return reply("", { status: 302, headers: { location: "https://cdn.example.com/firmado.pdf" } });
    }
    return reply(Buffer.from("%PDF-1.7"));
  });
  const { bytes } = await client.download("https://canvas.example.edu/files/1/download", 1_000_000);
  assert.equal(bytes.toString(), "%PDF-1.7");
  assert.equal(seen[0].host, "canvas.example.edu");
  assert.ok(seen[0].cookie, "al origen de Canvas sí se le manda la cookie");
  assert.equal(seen[1].host, "cdn.example.com");
  assert.equal(seen[1].cookie, null, "al CDN externo no se le manda la cookie");
});

test("rechaza una URL de descarga que no es de Canvas", async () => {
  const client = new CanvasClient(testConfig(), async () => reply(""));
  await assert.rejects(
    client.download("https://cdn.example.com/x.pdf", 10),
    /fuera de Canvas/,
  );
});

test("rechaza una redirección de descarga que baja a http", async () => {
  const client = new CanvasClient(testConfig(), async () =>
    reply("", { status: 302, headers: { location: "http://canvas.example.edu/x" } }));
  await assert.rejects(
    client.download("https://canvas.example.edu/files/1/download", 10),
    /insegura/,
  );
});

test("corta la descarga que supera el límite de bytes", async () => {
  const client = new CanvasClient(testConfig(), async () => reply(Buffer.alloc(50)));
  await assert.rejects(
    client.download("https://canvas.example.edu/files/1/download", 10),
    /límite permitido/,
  );
});

test("401 y 403 piden refrescar la cookie", async () => {
  const client = new CanvasClient(testConfig(), async () => reply("", { status: 401 }));
  await assert.rejects(client.getJson("/api/v1/users/self/profile"), /Actualiza canvas_session/);
});

test("exige JSON en las respuestas de la API", async () => {
  const client = new CanvasClient(testConfig(), async () => reply("<html>", { headers: { "content-type": "text/html" } }));
  await assert.rejects(client.getJson("/api/v1/users/self/profile"), /no devolvió JSON/);
});

test("normaliza la cookie en sus distintos formatos", () => {
  const desnuda = new CanvasClient(testConfig({ env: { CANVAS_COOKIE_HEADER: "abc123" } }), async () => json([]));
  assert.equal(desnuda.cookieHeader(), "canvas_session=abc123");

  const conPrefijo = new CanvasClient(
    testConfig({ env: { CANVAS_COOKIE_HEADER: "Cookie: canvas_session=xyz; otra=1" } }),
    async () => json([]),
  );
  assert.equal(conPrefijo.cookieHeader(), "canvas_session=xyz; otra=1");

  const invalida = new CanvasClient(testConfig({ env: { CANVAS_COOKIE_HEADER: "otra=1; mas=2" } }), async () => json([]));
  assert.throws(() => invalida.cookieHeader(), /canvas_session/);
});

test("nextLink lee solo el rel=next", () => {
  const header = '<https://x/a?page=1>; rel="current",<https://x/a?page=2>; rel="next",<https://x/a?page=9>; rel="last"';
  assert.equal(nextLink(header), "https://x/a?page=2");
  assert.equal(nextLink(""), null);
  assert.equal(nextLink(null), null);
});

test("numericId solo acepta enteros positivos", () => {
  assert.equal(numericId("4101"), 4101);
  assert.throws(() => numericId("0"), /ID numérico/);
  assert.throws(() => numericId("-1"), /ID numérico/);
  assert.throws(() => numericId("4101; DROP"), /ID numérico/);
  assert.throws(() => numericId(".."), /ID numérico/);
});
