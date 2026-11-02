#!/usr/bin/env node
/**
 * LLM2D MCP server (stdio). Lets Claude rig layered art, author animations with motion
 * presets or raw keys, and look at renders from the real PixiJS runtime.
 *
 *   node packages/mcp/src/server.ts
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { closeBrowser } from '@llm2d/preview';
import { createServer } from './tools.ts';

export { createServer };

const isMain = (() => {
  try {
    return realpathSync(process.argv[1] ?? '') === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isMain) {
  const { server, previewer } = createServer();
  const shutdown = async () => {
    await previewer.close().catch(() => {});
    await closeBrowser().catch(() => {});
    process.exit(0);
  };
  process.stdin.on('close', shutdown);
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  await server.connect(new StdioServerTransport());
}
