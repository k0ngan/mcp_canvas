import readline from "node:readline";

import { loadConfig } from "./config.mjs";
import { TOOLS, Toolbox, dispatch } from "./tools.mjs";

const SERVER = { name: "mcp-canvas", version: "2.0.0" };
const PROTOCOL = "2025-11-25";

export function createHandler(config = loadConfig(), fetchImpl = globalThis.fetch) {
  const toolbox = new Toolbox(config, fetchImpl);

  return async function handle(message) {
    if (!message || message.id === undefined) return null;
    const { id, method, params = {} } = message;

    if (method === "initialize") {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: params.protocolVersion || PROTOCOL,
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER,
        },
      };
    }
    if (method === "ping") return { jsonrpc: "2.0", id, result: {} };
    if (method === "tools/list") return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
    if (method === "tools/call") {
      try {
        const data = await dispatch(toolbox, params.name, params.arguments || {});
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
            structuredContent: data,
            isError: false,
          },
        };
      } catch (error) {
        return {
          jsonrpc: "2.0",
          id,
          result: { content: [{ type: "text", text: error.message }], isError: true },
        };
      }
    }
    return { jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } };
  };
}

export async function main() {
  const handle = createHandler();
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of input) {
    if (!line.trim()) continue;
    let response;
    try {
      response = await handle(JSON.parse(line));
    } catch {
      response = { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } };
    }
    if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
  }
}
