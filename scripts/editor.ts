/**
 * Starts the animation editor (apps/editor) on http://localhost:5174.
 *
 *   pnpm editor                       # samples/ and out/projects/
 *   pnpm editor out/projects/fox      # also this project folder (or a folder of projects)
 *   pnpm editor --port 5200
 *   pnpm editor --host 0.0.0.0        # reachable from other machines (default: this one only)
 *
 * Saving writes the project's animations.json and patches <name>.l2d.json, the same files the
 * MCP tools use, so Claude and the editor can take turns on one project.
 */
import { delimiter, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createServer } from 'vite';

const { values, positionals } = parseArgs({ allowPositionals: true, options: { port: { type: 'string', default: '5174' }, host: { type: 'string' } } });
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
process.env.LLM2D_EDITOR_DIRS = [process.env.LLM2D_EDITOR_DIRS, ...positionals.map((p) => resolve(p))].filter(Boolean).join(delimiter);
process.env.LLM2D_EDITOR_PORT = values.port;
if (values.host) process.env.LLM2D_EDITOR_HOST = values.host;

const server = await createServer({ root: join(root, 'apps/editor'), configFile: join(root, 'apps/editor/vite.config.ts') });
await server.listen();
// Project ids are paths relative to the repository (with ../ for folders outside it).
const first = positionals[0] ? `?project=${encodeURIComponent(relative(root, resolve(positionals[0])).split(sep).join('/'))}` : '';
const base = server.resolvedUrls?.local[0] ?? `http://localhost:${server.config.server.port}/`;
console.log(`LLM2D editor: ${base}${first}`);
if (values.host) console.log(`  also on the network (--host ${values.host}): anyone who can reach this port can read and change the projects.`);
