/**
 * Starts the animation editor (apps/editor) on http://localhost:5174.
 *
 *   pnpm editor                       # samples/ and out/projects/
 *   pnpm editor out/projects/fox      # also this project folder (or a folder of projects)
 *   pnpm editor --port 5200
 *
 * Saving writes the project's animations.json and patches <name>.l2d.json, the same files the
 * MCP tools use, so Claude and the editor can take turns on one project.
 */
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createServer } from 'vite';

const { values, positionals } = parseArgs({ allowPositionals: true, options: { port: { type: 'string', default: '5174' } } });
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
process.env.LLM2D_EDITOR_DIRS = [process.env.LLM2D_EDITOR_DIRS, ...positionals.map((p) => resolve(p))].filter(Boolean).join(delimiter);
process.env.LLM2D_EDITOR_PORT = values.port;

const server = await createServer({ root: join(root, 'apps/editor'), configFile: join(root, 'apps/editor/vite.config.ts') });
await server.listen();
const first = positionals[0] ? `?project=${encodeURIComponent(resolve(positionals[0]).slice(root.length + 1).split('\\').join('/'))}` : '';
console.log(`LLM2D editor: http://localhost:${server.config.server.port}/${first}`);
