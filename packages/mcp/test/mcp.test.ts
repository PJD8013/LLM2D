import { copyFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createImage, encodePng, readPsd } from '@llm2d/rig';
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
        'segment_art',
        'set_animation',
        'set_rig_spec',
        'split_art',
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

  it('rigs, describes, animates, validates and exports', { timeout: 60_000 }, async () => {
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
    expect(idle.slots.eyes.attachment.map((k: { name: string }) => k.name)).toEqual(['eyes', 'eyes_closed', 'eyes']);

    // Patch only the tail of idle: the other timelines stay.
    const patched = await call('set_animation', { dir, name: 'idle', mode: 'patch', animation: { bones: { tail4: { rotate: [{ time: 0, value: 5 }, { time: 1, value: -5 }] }, tail3: { rotate: [] } } }, preview: false });
    expect(patched.isError, patched.text).toBeFalsy();
    const after = JSON.parse((await call('get_animation', { dir, name: 'idle' })).text);
    expect(Object.keys(after.bones).sort()).toEqual(['hip', 'tail1', 'tail2', 'tail4']);
    expect(after.bones.tail4.rotate).toHaveLength(2);
    expect(after.slots.eyes.attachment).toHaveLength(3);
    expect((await call('set_animation', { dir, name: 'nope', mode: 'patch', animation: {}, preview: false })).isError).toBe(true);

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

  it('keeps parallel writes, survives renamed bones, refuses unsafe exports and misspelled arguments', { timeout: 60_000 }, async () => {
    // Four presets into four animations at once: none lost, files intact.
    const results = await Promise.all(
      ['a1', 'a2', 'a3', 'a4'].map((animation) => call('apply_preset', { dir, animation, preset: 'breathe', params: { bone: 'hip' }, preview: false })),
    );
    for (const r of results) expect(r.isError, r.text).toBeFalsy();
    const saved = JSON.parse(readFileSync(join(dir, 'animations.json'), 'utf8'));
    expect(['a1', 'a2', 'a3', 'a4'].every((n) => n in saved)).toBe(true);
    expect(Object.keys(JSON.parse(readFileSync(join(dir, 'fox.l2d.json'), 'utf8')).animations)).toEqual(expect.arrayContaining(['a1', 'a2', 'a3', 'a4']));

    // Rename the hip: rebuilding drops the keys of the old name and says so.
    const spec = JSON.parse((await call('get_rig_spec', { dir })).text);
    const renamed = JSON.parse(JSON.stringify(spec).replaceAll('"hip"', '"pelvis"'));
    delete renamed.scale; // left out: keeps the saved scale
    expect((await call('set_rig_spec', { dir, spec: renamed, image: false })).isError).toBeFalsy();
    expect(JSON.parse((await call('get_rig_spec', { dir })).text).scale).toBe(spec.scale);
    const built = await call('build_rig', { dir, bend_sheet: false });
    expect(built.isError, built.text).toBeFalsy();
    expect(built.text).toContain('animations.a1.bones.hip');
    expect((await call('apply_preset', { dir, animation: 'a1', preset: 'breathe', params: { bone: 'pelvis' }, preview: false })).isError).toBeFalsy();

    // Exporting into the project's parent would overwrite the project's skeleton.
    const self = await call('export_project', { dir, dest: join(dir, '..') });
    expect(self.isError).toBe(true);
    expect(self.text).toMatch(/overwrite/);
    // A misspelled argument is reported, not ignored.
    const typo = await call('export_project', { dir, dest: join(dir, '..', 'game2'), maxSize: 512 });
    expect(typo.isError).toBe(true);
    expect(typo.text).toMatch(/maxSize/);
    // A bad art path is refused before rig.json changes.
    expect((await call('set_rig_spec', { dir, spec: { ...renamed, art: 'nope.psd' }, image: false })).isError).toBe(true);
    expect(JSON.parse((await call('get_rig_spec', { dir })).text).art).toBe(spec.art);
  });

  it('starts from a flat picture: regions, split into layers, rig', { timeout: 60_000 }, async () => {
    // An outlined orange tail behind an outlined teal body, on white.
    const w = 300;
    const h = 240;
    const img = createImage(w, h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const body = Math.max(Math.abs(x - 110) - 50, Math.abs(y - 130) - 90);
        const tail = Math.hypot((x - 200) / 80, (y - 150) / 30) - 1;
        const c = body <= 0 ? (body > -5 ? [40, 30, 25] : [40, 130, 120]) : tail <= 0 ? (tail > -0.08 ? [40, 30, 25] : [240, 140, 60]) : [255, 255, 255];
        img.data.set([...c, 255], (y * w + x) * 4);
      }
    const work = mkdtempSync(join(tmpdir(), 'llm2d-flat-'));
    writeFileSync(join(work, 'critter.png'), encodePng(img));
    const flat = join(work, 'critter');
    const created = await call('create_project', { dir: flat, art: join(work, 'critter.png'), kind: 'character', image: false });
    expect(created.isError, created.text).toBeFalsy();
    expect(created.text).toContain('removed background #ffffff');
    expect(created.text).toMatch(/2 regions, outlines about/);
    expect(created.text).toContain('Next: split_art');
    expect((await call('inspect_art', { dir: flat })).text).toContain('Call split_art first');

    const unassigned = await call('split_art', { dir: flat, parts: [{ name: 'tail', regions: [[250, 150]] }], image: false });
    expect(unassigned.isError).toBe(true);
    expect(unassigned.text).toMatch(/Regions not in any part/);

    const split = await call('split_art', {
      dir: flat,
      parts: [
        { name: 'tail', regions: [[250, 150]] },
        { name: 'body', regions: [[110, 130]] },
      ],
      image: false,
    });
    expect(split.isError, split.text).toBeFalsy();
    expect(split.text).toContain('Restacked layers match the picture exactly');
    expect(split.text).toMatch(/tail: \d+ px \+ \d+ rebuilt/);
    const psd = readPsd(readFileSync(join(flat, 'source', 'critter.psd')));
    expect(psd.layers.map((l) => l.name)).toEqual(['tail', 'body']);
    const saved = JSON.parse(readFileSync(join(flat, 'split.json'), 'utf8'));
    expect(saved.picture).toBe('source/critter.png');
    expect(saved.parts).toHaveLength(2);

    const spec = JSON.parse((await call('get_rig_spec', { dir: flat })).text);
    spec.bones = [
      { name: 'hip', from: [110, 200], to: [110, 60] },
      { name: 'tail1', parent: 'hip', from: [150, 150], to: [210, 150] },
      { name: 'tail2', parent: 'tail1', from: [210, 150], to: [275, 150] },
    ];
    spec.parts = { tail: { bones: ['tail1', 'tail2'] }, body: { bone: 'hip' } };
    expect((await call('set_rig_spec', { dir: flat, spec, image: false })).text).toContain('No naming problems found');
    const built = await call('build_rig', { dir: flat, bend_sheet: false });
    expect(built.isError, built.text).toBeFalsy();
    expect(built.text).toMatch(/tail: mesh \d+v -> tail1, tail2/);
    expect(built.text).toMatch(/bend test: .*(clean|0 error)/);
  });
});
