import { copyFileSync, existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/index.ts';

const root = join(import.meta.dirname, '../../..');
let client: Client;
let dir: string;
let previewer: { close(): Promise<void> };

type ToolResult = { content: { type: string; text?: string }[]; isError?: boolean };
async function call(name: string, args: Record<string, unknown>): Promise<ToolResult & { text: string }> {
  const res = (await client.callTool({ name, arguments: args })) as ToolResult;
  return { ...res, text: res.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n') };
}

beforeAll(async () => {
  const s = createServer();
  previewer = s.previewer;
  const [a, b] = InMemoryTransport.createLinkedPair();
  await s.server.connect(a);
  client = new Client({ name: 'test', version: '0' });
  await client.connect(b);
  const work = mkdtempSync(join(tmpdir(), 'llm2d-mcp-'));
  copyFileSync(join(root, 'samples/kit/source/kit.psd'), join(work, 'kit.psd'));
  dir = join(work, 'fox');
  await call('create_project', { dir, art: join(work, 'kit.psd'), kind: 'character', name: 'fox', image: false });
});

afterAll(async () => {
  await client.close();
  await previewer.close();
});

describe('llm2d MCP server', () => {
  it('lists its tools and instructions', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        'apply_preset',
        'bend_test',
        'build_rig',
        'create_project',
        'delete_animation',
        'describe_skeleton',
        'export_project',
        'get_animation',
        'get_rig_spec',
        'inspect_art',
        'list_presets',
        'render_animation',
        'render_frame',
        'set_animation',
        'set_rig_spec',
        'validate_project',
      ].sort(),
    );
    expect(client.getInstructions()).toMatch(/Workflow/);
    for (const t of tools) expect(t.description!.length).toBeGreaterThan(30);
  });

  it('starts a project with a guessed origin between the feet', async () => {
    const spec = JSON.parse((await call('get_rig_spec', { dir })).text);
    expect(spec.art).toBe('source/kit.psd');
    expect(spec.scale).toBe(0.5);
    expect(Math.abs(spec.origin[0] - 600)).toBeLessThan(12);
    expect(Math.abs(spec.origin[1] - 1544)).toBeLessThan(8);
  });

  it('rigs, describes, animates, validates and exports', async () => {
    const spec = JSON.parse(readFileSync(join(root, 'samples/kit/rig.json'), 'utf8'));
    const set = await call('set_rig_spec', { dir, spec: { ...spec, name: 'fox', meta: undefined }, image: false });
    expect(set.isError).toBeFalsy();
    expect(set.text).toContain('No naming problems found');

    const built = await call('build_rig', { dir, bend_sheet: false });
    expect(built.isError).toBeFalsy();
    expect(built.text).toMatch(/bend test: \d+ control\(s\), 9 weighted mesh\(es\); 0 error\(s\)/);

    const described = await call('describe_skeleton', { dir });
    expect(described.text).toContain('tail4 <- tail3');
    expect(described.text).toContain('eyes on head: eyes, eyes_closed');

    for (const [preset, params] of [
      ['breathe', { bone: 'hip' }],
      ['sway', { bones: ['tail1', 'tail2', 'tail3', 'tail4'] }],
      ['blink', { slot: 'eyes', closed: 'eyes_closed', times: [1.2] }],
    ] as const) {
      const r = await call('apply_preset', { dir, animation: 'idle', preset, params, preview: false });
      expect(r.isError, r.text).toBeFalsy();
    }
    const idle = JSON.parse((await call('get_animation', { dir, name: 'idle' })).text);
    expect(Object.keys(idle.bones).sort()).toEqual(['hip', 'tail1', 'tail2', 'tail3', 'tail4']);
    expect(idle.slots.eyes.attachment).toHaveLength(2);

    const valid = await call('validate_project', { dir });
    expect(valid.text).toContain('Skeleton is valid');
    const out = join(dir, '..', 'game');
    const exported = await call('export_project', { dir, dest: out });
    expect(exported.isError).toBeFalsy();
    expect(existsSync(join(out, 'fox', 'fox.l2d.json'))).toBe(true);
    expect(existsSync(join(out, 'fox', 'fox.png'))).toBe(true);
    expect(exported.text).toMatch(/Atlas pages: fox.png \d+x\d+/);
  });

  it('returns precise errors for bad animations and presets', async () => {
    const bad = await call('set_animation', {
      dir,
      name: 'oops',
      animation: { bones: { head: { rotate: [{ time: 0, value: 0, curve: 'easeOutBak' }] } } },
      preview: false,
    });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain('animations.oops.bones.head.rotate[0].curve');
    const preset = await call('apply_preset', { dir, animation: 'x', preset: 'sway', params: { bones: ['tail9'] }, preview: false });
    expect(preset.isError).toBe(true);
    expect(preset.text).toContain('unknown bone "tail9"');
    const missing = await call('delete_animation', { dir, name: 'nope' });
    expect(missing.isError).toBe(true);
  });
});
