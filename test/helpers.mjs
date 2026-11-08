import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadConfig } from "../src/config.mjs";

export function reply(body, { status = 200, headers = {} } = {}) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: name => lower[String(name).toLowerCase()] ?? null },
    json: async () => body,
    arrayBuffer: async () => (Buffer.isBuffer(body) ? body : Buffer.from(String(body))),
  };
}

export function json(body, headers = {}) {
  return reply(body, { headers: { "content-type": "application/json", ...headers } });
}

export function tempVault(prefix = "mcp-canvas-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function testConfig(overrides = {}) {
  const vaultDir = overrides.vaultDir ?? tempVault();
  const config = loadConfig({
    CANVAS_BASE_URL: "https://canvas.example.edu",
    CANVAS_COOKIE_HEADER: "canvas_session=abc; _csrf_token=tok%2Fen",
    CANVAS_EOL: "lf",
    CANVAS_VAULT_DIR: vaultDir,
    LOCALAPPDATA: vaultDir,
    ...overrides.env,
  });
  return { ...config, ...overrides.config };
}

// Contexto equivalente al de un curso 2026-2, para las pruebas de paridad.
export const CTX_2026_2 = {
  courseId: 4101,
  term: "2026-2",
  campaignTag: "segundo-semestre",
  semestre: "segundo semestre",
  subject: null,
  baseUrl: "https://canvas.example.edu",
};

export function folderFor(relative = "Canvas/Segundo semestre 2026/4101-demo1001-101-teoria-2026-2-materia-de-ejemplo", vaultDir = "/vault") {
  const native = relative.split("/").join(path.sep);
  return {
    relative: native,
    absolute: path.join(vaultDir, native),
    wiki: relative,
    reutilizada: false,
    term: "2026-2",
  };
}
