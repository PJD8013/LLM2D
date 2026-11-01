/**
 * Calls the LLM2D MCP server over stdio, the way Claude Code does. For trying tools by hand
 * and for end-to-end checks. Image results are saved as PNG files.
 *
 *   node scripts/mcp-call.ts list
 *   node scripts/mcp-call.ts <tool> '<json arguments>' [--out out/mcp]
 *   node scripts/mcp-call.ts batch calls.json [--out out/mcp]   # [{ "tool": "...", "args": {...} }, ...]
 */
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { values, positionals } = parseArgs({ allowPositionals: true, options: { out: { type: 'string', default: 'out/mcp' } } });
const [command, arg] = positionals;
if (!command) {
  console.error("usage: node scripts/mcp-call.ts list | <tool> '<json>' | batch <file.json>");
  process.exit(2);
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(root, 'packages/mcp/src/server.ts')],
  cwd: process.cwd(),
  env: process.env as Record<string, string>,
  stderr: 'inherit',
});
const client = new Client({ name: 'llm2d-cli', version: '0.1.0' });
await client.connect(transport);
await mkdir(values.out!, { recursive: true });

// Number images across runs so repeated calls do not overwrite each other.
let counter = (await readdir(values.out!)).filter((f) => f.endsWith('.png')).length;
async function call(tool: string, args: Record<string, unknown>) {
  const started = Date.now();
  const res = (await client.callTool({ name: tool, arguments: args })) as { content: any[]; isError?: boolean };
  console.log(`\n=== ${tool} ${res.isError ? '(ERROR) ' : ''}${((Date.now() - started) / 1000).toFixed(1)}s`);
  for (const c of res.content) {
    if (c.type === 'text') console.log(c.text);
    else if (c.type === 'image') {
      const file = join(values.out!, `${String(++counter).padStart(2, '0')}-${tool}.png`);
      await writeFile(file, Buffer.from(c.data, 'base64'));
      console.log(`[image] ${file}`);
    }
  }
  return res;
}

try {
  if (command === 'list') {
    const { tools } = await client.listTools();
    console.log(client.getInstructions());
    for (const t of tools) console.log(`\n${t.name}: ${t.description}\n  args: ${Object.keys((t.inputSchema as any).properties ?? {}).join(', ')}`);
  } else if (command === 'batch') {
    const calls = JSON.parse(await readFile(arg, 'utf8')) as { tool: string; args: Record<string, unknown> }[];
    for (const c of calls) {
      const res = await call(c.tool, c.args);
      if (res.isError) break;
    }
  } else {
    await call(command, arg ? JSON.parse(arg) : {});
  }
} finally {
  await client.close();
}
