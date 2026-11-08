#!/usr/bin/env node
import { main } from "../src/server.mjs";

main().catch(error => {
  process.stderr.write(`mcp-canvas: ${error.message}\n`);
  process.exit(1);
});
