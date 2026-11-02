/**
 * The editor in a real browser against its real dev server, on a temporary copy of the coin
 * project: rotate a bone by dragging, edit keys on the timeline, save, and pick up a change
 * made to animations.json from outside (as Claude does through MCP).
 */
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { createServer, type ViteDevServer } from 'vite';
import { validate } from '@llm2d/core';

const repo = join(import.meta.dirname, '../../..');
let server: ViteDevServer;
let browser: Browser;
let page: Page;
let dir: string;
let id: string;
const errors: string[] = [];

beforeAll(async () => {
  dir = join(mkdtempSync(join(tmpdir(), 'llm2d-editor-')), 'coin');
  cpSync(join(repo, 'samples/coin'), dir, { recursive: true });
  id = relative(repo, dir).split('\\').join('/');
  process.env.LLM2D_EDITOR_DIRS = dir;
  server = await createServer({
    root: join(repo, 'apps/editor'),
    configFile: join(repo, 'apps/editor/vite.config.ts'),
    server: { port: 0, host: '127.0.0.1' },
    logLevel: 'silent',
  });
  await server.listen();
  const url = server.resolvedUrls!.local[0];
  browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('dialog', (d) => d.accept('pulse'));
  await page.goto(`${url}?project=${encodeURIComponent(id)}`);
  await page.waitForFunction(() => (window as any).__editor?.data && (window as any).__editor.animName, null, { timeout: 60_000 });
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

const anim = () => page.evaluate(() => {
  const ed = (window as any).__editor;
  return ed.data.source.animations[ed.animName];
});

/** Screen position of a bone's origin and of a point along it. */
const bonePoint = (bone: string, along: number) =>
  page.evaluate(
    ([bone, along]) => {
      const ed = (window as any).__editor;
      const st = ed.stage;
      const b = ed.data.findBone(bone);
      const o = st.skeleton.boneWorldPosition(b);
      const t = st.skeleton.boneWorldTip(b);
      const r = st.app.canvas.getBoundingClientRect();
      const g = (x: number, y: number) => st.view.toGlobal({ x, y });
      const p = g(o[0] + (t[0] - o[0]) * along, o[1] + (t[1] - o[1]) * along);
      const q = g(o[0], o[1]);
      return { x: p.x + r.left, y: p.y + r.top, ox: q.x + r.left, oy: q.y + r.top };
    },
    [bone, along] as const,
  );

describe('animation editor', () => {
  it('lists projects and opens the coin with its animations', async () => {
    const projects = await page.evaluate(() => (window as any).__editor.projects.map((p: any) => [p.id, p.editable]));
    expect(projects).toContainEqual([id, true]);
    expect(projects).toContainEqual(['samples/kit', false]);
    expect(await page.evaluate(() => (window as any).__editor.animNames)).toEqual(['idle', 'land', 'win']);
  });

  it('rotates a bone by dragging around it, which keys the playhead', async () => {
    await page.getByRole('button', { name: '새로' }).click(); // prompt answers "pulse"
    expect(await page.evaluate(() => (window as any).__editor.animName)).toBe('pulse');
    await page.evaluate(() => (window as any).__editor.seek(0.5));
    // The coin's bones are pivots: select the star, then turn it by dragging around it.
    await page.evaluate(() => (window as any).__editor.selectBone('star'));
    const o = await bonePoint('star', 0);
    const p = { ...o, x: o.ox + 120, y: o.oy };
    await page.mouse.move(p.x, p.y);
    await page.mouse.down();
    const r = 120;
    const a0 = 0;
    for (let i = 1; i <= 10; i++) {
      const a = a0 + (i / 10) * (Math.PI / 4);
      await page.mouse.move(p.ox + Math.cos(a) * r, p.oy + Math.sin(a) * r);
    }
    await page.mouse.up();
    const keys = (await anim()).bones.star.rotate;
    expect(keys).toHaveLength(1);
    expect(keys[0].time).toBe(0.5);
    expect(keys[0].value).toBeGreaterThan(40);
    expect(keys[0].value).toBeLessThan(50);
    expect(await page.evaluate(() => (window as any).__editor.selectedBone)).toBe('star');
  });

  it('keys with K, moves a key on the timeline, sets its curve, undoes', async () => {
    await page.evaluate(() => (window as any).__editor.seek(0));
    await page.keyboard.press('k');
    expect((await anim()).bones.star.rotate.map((k: any) => k.time)).toEqual([0, 0.5]);

    // Drag the 0.5s key to 0.8s on the timeline (row 1: the star bone).
    const tl = page.getByTestId('timeline');
    const box = (await tl.boundingBox())!;
    const g = await tl.evaluate((c) => ({ pps: Number(c.dataset.pps), sx: Number(c.dataset.scrollx) }));
    const x = box.x + 180 + (0.5 - g.sx) * g.pps;
    const y = box.y + 26 + 22 + 11;
    await page.mouse.click(x, y);
    expect(await page.evaluate(() => (window as any).__editor.selectedKeys.map((k: any) => k.time))).toEqual([0.5]);
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 0.3 * g.pps, y, { steps: 6 });
    await page.mouse.up();
    expect((await anim()).bones.star.rotate.map((k: any) => k.time)).toEqual([0, 0.8]);

    await page.getByLabel('곡선', { exact: true }).selectOption('easeOutBack');
    expect((await anim()).bones.star.rotate[1].curve).toBe('easeOutBack');
    await page.keyboard.press('Control+z');
    expect((await anim()).bones.star.rotate[1].curve).toBeUndefined();
    await page.keyboard.press('Control+z');
    expect((await anim()).bones.star.rotate.map((k: any) => k.time)).toEqual([0, 0.5]);
    await page.keyboard.press('Control+Shift+z');
    expect((await anim()).bones.star.rotate.map((k: any) => k.time)).toEqual([0, 0.8]);
  });

  it('saves to animations.json and the skeleton, valid', async () => {
    await page.getByTestId('save').click();
    await page.waitForFunction(() => !(window as any).__editor.dirty && !(window as any).__editor.saving);
    const saved = JSON.parse(readFileSync(join(dir, 'animations.json'), 'utf8'));
    expect(saved.pulse.bones.star.rotate.map((k: { time: number }) => k.time)).toEqual([0, 0.8]);
    expect(Object.keys(saved).sort()).toEqual(['idle', 'land', 'pulse', 'win']);
    const skeleton = JSON.parse(readFileSync(join(dir, 'coin.l2d.json'), 'utf8'));
    expect(skeleton.animations.pulse).toEqual(saved.pulse);
    expect(validate(skeleton).ok).toBe(true);
  });

  it('reloads when animations.json changes outside while nothing is unsaved', async () => {
    const saved = JSON.parse(readFileSync(join(dir, 'animations.json'), 'utf8'));
    saved.pulse.bones.star.rotate[0].value = -33;
    await new Promise((r) => setTimeout(r, 2200)); // past the "own save" window
    writeFileSync(join(dir, 'animations.json'), JSON.stringify(saved, null, 2));
    await page.waitForFunction(() => (window as any).__editor.data.source.animations.pulse.bones.star.rotate[0].value === -33, null, { timeout: 15_000 });
    expect(await page.evaluate(() => (window as any).__editor.animName)).toBe('pulse');
    expect(errors).toEqual([]);
  });
});
