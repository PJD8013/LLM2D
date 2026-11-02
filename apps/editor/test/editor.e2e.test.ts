/**
 * The editor in a real browser against its real dev server, on a temporary copy of the coin
 * project: rotate a bone by dragging, edit keys on the timeline, save, and pick up a change
 * made to animations.json from outside (as Claude does through MCP).
 */
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
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
    await expect.poll(async () => (await anim()).bones.star.rotate.map((k: any) => k.time)).toEqual([0, 0.5]);

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
    // Right after our own save: still noticed (own writes are recognised by content, not by time).
    writeFileSync(join(dir, 'animations.json'), JSON.stringify(saved, null, 2));
    await page.waitForFunction(() => (window as any).__editor.data.source.animations.pulse.bones.star.rotate[0].value === -33, null, { timeout: 15_000 });
    expect(await page.evaluate(() => (window as any).__editor.animName)).toBe('pulse');
    expect(errors).toEqual([]);
  });

  it('edits a key that sits between frames instead of adding one beside it', async () => {
    await page.evaluate(() => {
      const ed = (window as any).__editor;
      ed.edit((a: any) => (a.bones.star.rotate[1].time = 0.81));
      ed.seek(0.81, false);
      ed.selectBone('star');
    });
    const input = page.getByLabel('회전', { exact: true });
    await input.fill('12');
    await input.press('Tab');
    const keys = (await anim()).bones.star.rotate;
    expect(keys.map((k: any) => k.time)).toEqual([0, 0.81]);
    expect(keys[1].value).toBe(12);
  });

  it('keeps shortcuts after clicking a checkbox; Space plays instead of toggling it', async () => {
    await page.getByLabel('반복').click();
    const loop = await page.evaluate(() => (window as any).__editor.loop);
    await page.keyboard.press('t');
    expect(await page.evaluate(() => (window as any).__editor.tool)).toBe('translate');
    await page.keyboard.press(' ');
    expect(await page.evaluate(() => [(window as any).__editor.playing, (window as any).__editor.loop])).toEqual([true, loop]);
    await page.keyboard.press(' ');
    await page.keyboard.press('r');
  });

  it('keeps redo after a plain click on a bone and marks edits made during a save as unsaved', async () => {
    await page.evaluate(() => (window as any).__editor.seek(0.4));
    await page.keyboard.press('Shift+k');
    await page.keyboard.press('Control+z');
    expect(await page.evaluate(() => (window as any).__editor.canRedo)).toBe(true);
    const p = await bonePoint('star', 0);
    await page.mouse.click(p.ox, p.oy);
    expect(await page.evaluate(() => (window as any).__editor.canRedo)).toBe(true);

    // A slow save: an edit made while it runs must stay unsaved.
    await page.route('**/api/project/animations*', async (route) => {
      await new Promise((r) => setTimeout(r, 600));
      await route.continue();
    });
    const saving = page.evaluate(() => (window as any).__editor.save());
    await page.waitForFunction(() => (window as any).__editor.saving);
    await page.evaluate(() => (window as any).__editor.setDuration(1.5));
    await saving;
    await page.unroute('**/api/project/animations*');
    expect(await page.evaluate(() => (window as any).__editor.dirty)).toBe(true);
    await page.evaluate(() => (window as any).__editor.save());
    await page.waitForFunction(() => !(window as any).__editor.dirty && !(window as any).__editor.saving);
  });

  it('answers only requests addressed to this machine, and writes only for its own page', async () => {
    const url = new URL(server.resolvedUrls!.local[0]);
    const call = (path: string, headers: Record<string, string>, method = 'GET', body?: string) =>
      new Promise<number>((resolve, reject) => {
        const req = request({ host: url.hostname, port: url.port, path, method, headers }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        req.on('error', reject);
        req.end(body);
      });
    expect(await call('/api/projects', { host: 'evil.example' })).toBe(403);
    expect(await call('/api/projects', { host: url.host })).toBe(200);
    const put = `/api/project/animations?id=${encodeURIComponent(id)}`;
    expect(await call(put, { host: url.host, origin: 'http://localhost:9999', 'content-type': 'application/json' }, 'PUT', '{"animations":{}}')).toBe(403);
    expect(await call(`/files/${encodeURIComponent(id)}/coin.l2d.json`, { host: url.host })).toBe(200);
    expect(await call(`/files/${encodeURIComponent(id)}/art.ts`, { host: url.host })).toBe(403);
    expect(await call(`/files/${encodeURIComponent(id)}/%E0%A4%A`, { host: url.host })).toBe(400);
  });

  it('survives a reload in which the selected bone is gone (a rebuilt rig)', async () => {
    await page.evaluate(() => (window as any).__editor.selectBone('star'));
    // Rename the star (bone, slot and image) everywhere, as rebuilding the rig could.
    for (const f of ['coin.l2d.json', 'animations.json']) {
      const text = readFileSync(join(dir, f), 'utf8').replaceAll('"star"', '"emblem"');
      writeFileSync(join(dir, f), text);
    }
    await page.waitForFunction(() => (window as any).__editor.data.findBone('emblem') >= 0, null, { timeout: 15_000 });
    expect(await page.evaluate(() => (window as any).__editor.selectedBone)).toBeNull();
    await page.evaluate(() => (window as any).__editor.seek(0.3));
    await expect.poll(() => page.getByTestId('time').textContent()).toContain('0.30');
    expect(errors).toEqual([]);
  });

  it('turns a bone under a stretched, rotated parent the way the pointer goes', async () => {
    const f = JSON.parse(readFileSync(join(dir, 'coin.l2d.json'), 'utf8'));
    const parentName = f.bones.find((b: { name: string }) => b.name === 'emblem').parent;
    Object.assign(f.bones.find((b: { name: string }) => b.name === parentName), { rotation: 60, scaleX: 2, scaleY: 0.5 });
    writeFileSync(join(dir, 'coin.l2d.json'), JSON.stringify(f, null, 2));
    await page.waitForFunction((p) => (window as any).__editor.data.source.bones.find((b: any) => b.name === p).scaleX === 2, parentName, { timeout: 15_000 });
    const worldRotation = () =>
      page.evaluate(() => {
        const ed = (window as any).__editor;
        return ed.stage.skeleton.boneWorldRotation(ed.data.findBone('emblem')) as number;
      });
    await page.evaluate(() => {
      const ed = (window as any).__editor;
      ed.seek(0.2);
      ed.selectBone('emblem');
      ed.tool = 'rotate';
    });
    const before = await worldRotation();
    // Grab along the bone's direction and turn the pointer 45 degrees around its origin.
    const o = await bonePoint('emblem', 0);
    const a0 = (before * Math.PI) / 180;
    const r = 150;
    await page.mouse.move(o.ox + Math.cos(a0) * r, o.oy + Math.sin(a0) * r);
    await page.mouse.down();
    for (let i = 1; i <= 10; i++) {
      const a = a0 + (i / 10) * (Math.PI / 4);
      await page.mouse.move(o.ox + Math.cos(a) * r, o.oy + Math.sin(a) * r);
    }
    await page.mouse.up();
    const turned = ((((await worldRotation()) - before) % 360) + 540) % 360 - 180;
    expect(Math.abs(turned - 45)).toBeLessThan(3);
    expect(errors).toEqual([]);
  });
});
