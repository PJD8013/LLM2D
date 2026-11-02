import { Application, Container, Texture } from 'pixi.js';
import { bendPoses, validate, type L2DImage, type TrackEntry } from '@llm2d/core';
import { Llm2dActor, cutTextures, fromLoaded, loadLlm2d, type LoadedLlm2d } from '@llm2d/pixi';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const ui = {
  stage: $<HTMLElement>('stage'),
  error: $<HTMLElement>('error'),
  sample: $<HTMLSelectElement>('sample'),
  files: $<HTMLInputElement>('files'),
  animations: $<HTMLElement>('animations'),
  loop: $<HTMLInputElement>('loop'),
  autoBlink: $<HTMLInputElement>('autoBlink'),
  speed: $<HTMLInputElement>('speed'),
  speedOut: $<HTMLOutputElement>('speedOut'),
  mix: $<HTMLInputElement>('mix'),
  mixOut: $<HTMLOutputElement>('mixOut'),
  play: $<HTMLButtonElement>('play'),
  time: $<HTMLOutputElement>('time'),
  scrub: $<HTMLInputElement>('scrub'),
  dbgBones: $<HTMLInputElement>('dbgBones'),
  dbgMeshes: $<HTMLInputElement>('dbgMeshes'),
  dbgIk: $<HTMLInputElement>('dbgIk'),
  bg: $<HTMLSelectElement>('bg'),
  info: $<HTMLElement>('info'),
  events: $<HTMLOListElement>('events'),
};

const params = new URLSearchParams(location.search);
const headless = params.has('headless');
if (headless) document.body.dataset.headless = 'true';

const app = new Application();
await app.init({
  resizeTo: ui.stage,
  backgroundAlpha: 0,
  antialias: true,
  preference: 'webgl',
  preserveDrawingBuffer: true,
  resolution: headless ? 1 : window.devicePixelRatio,
  autoDensity: true,
});
ui.stage.prepend(app.canvas);

const view = new Container();
app.stage.addChild(view);

let actor: Llm2dActor | null = null;
let current = '';
let playing = true;
let zoom = 1;
let pan = { x: 0, y: 0 };
let blinkTimer = 2;
/** Textures created by loadData (destroyed when the next skeleton is loaded that way). */
let ownedTextures: Texture[] = [];

function showError(message: string | null) {
  ui.error.hidden = !message;
  ui.error.textContent = message ?? '';
}

function logEvent(text: string, user = false) {
  const li = document.createElement('li');
  li.textContent = text;
  if (user) li.className = 'user';
  ui.events.prepend(li);
  while (ui.events.children.length > 40) ui.events.lastElementChild?.remove();
}

interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Centres `bounds` (default: the setup pose) in the stage, filling `fill` of it. */
function fit(bounds?: Bounds, fill = 0.8) {
  if (!actor) return;
  const b = bounds ?? actor.data.bounds;
  const w = app.renderer.width / app.renderer.resolution;
  const h = app.renderer.height / app.renderer.resolution;
  const s = Math.min((w * fill) / Math.max(1, b.width), (h * fill) / Math.max(1, b.height)) * zoom;
  view.scale.set(s);
  view.position.set(w / 2 - (b.x + b.width / 2) * s + pan.x, h / 2 - (b.y + b.height / 2) * s + pan.y);
}

/**
 * Skeleton-space bounds of everything an animation draws over its whole length (visible
 * attachments, clipping shapes left out), so frames of a jump or a win burst are not cut off.
 */
function motionBounds(name: string): Bounds {
  const a = actor!;
  const anim = a.data.animations.get(name);
  if (!anim) return a.data.bounds;
  const buf = new Float32Array(Math.max(8, ...a.data.attachments.flat().map((m) => m.vertexCount * 2)));
  let [minX, minY, maxX, maxY] = [Infinity, Infinity, -Infinity, -Infinity];
  const samples = Math.min(90, Math.max(2, Math.ceil(anim.duration * 30) + 1));
  for (let i = 0; i < samples; i++) {
    seek(name, (anim.duration * i) / (samples - 1));
    for (let slot = 0; slot < a.data.slots.length; slot++) {
      const index = a.skeleton.attachments[slot];
      if (index < 0 || a.data.attachments[slot][index].kind === 'clipping' || a.skeleton.slotColor(slot)[3] <= 0.01) continue;
      const n = a.skeleton.computeSlotVertices(slot, buf);
      for (let k = 0; k < n * 2; k += 2) {
        minX = Math.min(minX, buf[k]);
        maxX = Math.max(maxX, buf[k]);
        minY = Math.min(minY, buf[k + 1]);
        maxY = Math.max(maxY, buf[k + 1]);
      }
    }
  }
  return Number.isFinite(minX) ? { x: minX, y: minY, width: maxX - minX, height: maxY - minY } : a.data.bounds;
}

function setActor(loaded: LoadedLlm2d, label: string) {
  actor?.destroy();
  showError(null);
  ui.events.replaceChildren();
  actor = new Llm2dActor({ ...loaded, autoUpdate: false });
  view.addChild(actor);
  zoom = 1;
  pan = { x: 0, y: 0 };
  applyDebug();
  actor.state.defaultMix = Number(ui.mix.value);
  actor.state.timeScale = Number(ui.speed.value);
  actor.state.addListener({
    start: (e) => e.trackIndex === 0 && logEvent(`start ${e.animation.name}`),
    complete: (e) => e.trackIndex === 0 && logEvent(`complete ${e.animation.name}`),
    event: (_e, ev) => logEvent(`event ${ev.name}${Object.keys(ev.payload).length ? ' ' + JSON.stringify(ev.payload) : ''}`, true),
  });

  const names = [...actor.data.animations.keys()].filter((n) => n !== 'blink');
  ui.animations.replaceChildren(
    ...names.map((name) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = name;
      b.onclick = () => play(name);
      return b;
    }),
  );
  ui.autoBlink.parentElement!.hidden = !actor.data.animations.has('blink');

  const d = actor.data;
  const verts = d.attachments.flat().reduce((n, a) => n + a.vertexCount, 0);
  const warnings = validate(d.source).warnings;
  ui.info.textContent =
    `${label}\n뼈 ${d.bones.length} · 슬롯 ${d.slots.length} · 이미지 ${Object.keys(d.images).length}\n` +
    `첨부 ${d.attachments.flat().length} · 정점 ${verts} · IK ${d.ik.length}\n` +
    `애니메이션: ${[...d.animations.values()].map((a) => `${a.name} (${a.duration.toFixed(2)}s)`).join(', ')}` +
    (warnings.length ? `\n경고 ${warnings.length}: ${warnings.map((w) => w.path).join(', ')}` : '');

  const first = names.includes('idle') ? 'idle' : names[0];
  if (first) play(first, true);
  fit();
}

function play(name: string, immediate = false) {
  if (!actor) return;
  current = name;
  const mix = actor.state.defaultMix;
  if (immediate) actor.state.defaultMix = 0;
  actor.state.setAnimation(0, name, ui.loop.checked);
  actor.state.defaultMix = mix;
  for (const b of ui.animations.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.textContent === name));
  if (!playing) actor.update(0);
}

function entry(): TrackEntry | null {
  return actor?.state.getCurrent(0) ?? null;
}

function applyDebug() {
  if (actor) actor.debug = { bones: ui.dbgBones.checked, meshes: ui.dbgMeshes.checked, ik: ui.dbgIk.checked };
}

function setPlaying(value: boolean) {
  playing = value;
  ui.play.textContent = playing ? '일시정지' : '재생';
}

async function loadUrl(url: string) {
  try {
    setActor(await loadLlm2d(url), url);
  } catch (e) {
    showError(String((e as Error).message ?? e));
  }
}

async function loadFiles(list: FileList | File[]) {
  const files = [...list];
  const jsonFile = files.find((f) => f.name.endsWith('.json'));
  if (!jsonFile) return showError('.l2d.json 파일이 필요합니다.');
  try {
    const json = JSON.parse(await jsonFile.text());
    const byName = new Map(files.map((f) => [f.name, f]));
    const pages: Record<string, string> = {};
    for (const img of Object.values((json.images ?? {}) as Record<string, { path: string }>)) {
      const f = byName.get(img.path.split('/').pop()!);
      if (f && !pages[img.path]) pages[img.path] = URL.createObjectURL(f);
    }
    await loadData(json, pages, jsonFile.name);
    for (const url of Object.values(pages)) URL.revokeObjectURL(url);
  } catch (e) {
    showError(String((e as Error).message ?? e));
  }
}

// ---- UI wiring ----
ui.sample.onchange = () => loadUrl(ui.sample.value);
ui.files.onchange = () => ui.files.files && loadFiles(ui.files.files);
ui.loop.onchange = () => {
  const e = entry();
  if (e) e.loop = ui.loop.checked;
};
ui.speed.oninput = () => {
  ui.speedOut.textContent = `${Number(ui.speed.value).toFixed(2)}x`;
  if (actor) actor.state.timeScale = Number(ui.speed.value);
};
ui.mix.oninput = () => {
  ui.mixOut.textContent = `${Number(ui.mix.value).toFixed(2)}s`;
  if (actor) actor.state.defaultMix = Number(ui.mix.value);
};
ui.play.onclick = () => setPlaying(!playing);
ui.scrub.oninput = () => {
  const e = entry();
  if (!e || !actor) return;
  setPlaying(false);
  e.trackTime = Number(ui.scrub.value) * e.animation.duration;
  e.mixingFrom = null;
  actor.update(0);
};
for (const el of [ui.dbgBones, ui.dbgMeshes, ui.dbgIk]) el.onchange = applyDebug;
ui.bg.onchange = () => (ui.stage.dataset.bg = ui.bg.value);

ui.stage.addEventListener('dragover', (e) => {
  e.preventDefault();
  ui.stage.classList.add('dragging');
});
ui.stage.addEventListener('dragleave', () => ui.stage.classList.remove('dragging'));
ui.stage.addEventListener('drop', (e) => {
  e.preventDefault();
  ui.stage.classList.remove('dragging');
  if (e.dataTransfer?.files.length) loadFiles(e.dataTransfer.files);
});
ui.stage.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    zoom = Math.min(8, Math.max(0.2, zoom * Math.exp(-e.deltaY * 0.001)));
    fit();
  },
  { passive: false },
);
let drag: { x: number; y: number } | null = null;
ui.stage.addEventListener('pointerdown', (e) => (drag = { x: e.clientX - pan.x, y: e.clientY - pan.y }));
window.addEventListener('pointerup', () => (drag = null));
window.addEventListener('pointermove', (e) => {
  if (!drag) return;
  pan = { x: e.clientX - drag.x, y: e.clientY - drag.y };
  fit();
});
ui.stage.addEventListener('dblclick', () => {
  zoom = 1;
  pan = { x: 0, y: 0 };
  fit();
});
app.renderer.on('resize', () => fit());

app.ticker.add((ticker) => {
  if (!actor) return;
  const dt = ticker.deltaMS / 1000;
  if (playing && !headless) {
    if (ui.autoBlink.checked && actor.data.animations.has('blink') && current === 'idle') {
      blinkTimer -= dt;
      if (blinkTimer <= 0) {
        actor.state.setAnimation(1, 'blink', false);
        actor.state.addEmptyAnimation(1, 0, 0);
        blinkTimer = 2 + Math.random() * 2.5;
      }
    }
    actor.update(dt);
  }
  const e = entry();
  if (e) {
    const d = e.animation.duration;
    ui.time.textContent = `${e.animationTime.toFixed(2)} / ${d.toFixed(2)}s`;
    if (playing) ui.scrub.value = String(d > 0 ? e.animationTime / d : 0);
  }
});

// ---- Headless API (used by scripts/render.ts and, later, the MCP server) ----
async function contactSheet(name: string, frames = 8, cell = 256, columns = 4): Promise<string> {
  if (!actor) throw new Error('No skeleton loaded');
  setPlaying(false);
  const anim = actor.data.animations.get(name);
  if (!anim) throw new Error(`Unknown animation ${name}`);
  const rows = Math.ceil(frames / columns);
  const sheet = document.createElement('canvas');
  sheet.width = cell * columns;
  sheet.height = cell * rows;
  const ctx = sheet.getContext('2d')!;
  ctx.fillStyle = backgroundColor();
  ctx.fillRect(0, 0, sheet.width, sheet.height);
  // Same framing in every cell, wide enough for the whole motion.
  fit(motionBounds(name), 0.9);
  for (let i = 0; i < frames; i++) {
    const t = frames === 1 ? 0 : (anim.duration * i) / (frames - 1);
    seek(name, t);
    app.render();
    const x = (i % columns) * cell;
    const y = Math.floor(i / columns) * cell;
    ctx.fillStyle = backgroundColor();
    ctx.fillRect(x, y, cell, cell);
    const src = app.canvas;
    const s = Math.min(cell / src.width, cell / src.height);
    ctx.drawImage(src, x + (cell - src.width * s) / 2, y + (cell - src.height * s) / 2, src.width * s, src.height * s);
    drawLabel(ctx, `${name} ${t.toFixed(2)}s`, x, y, cell);
  }
  fit();
  return sheet.toDataURL('image/png');
}

function drawLabel(ctx: CanvasRenderingContext2D, label: string, x: number, y: number, cell: number, color = '#ffffff') {
  ctx.font = '600 13px system-ui, sans-serif';
  ctx.fillStyle = '#000000aa';
  ctx.fillRect(x + 4, y + 4, ctx.measureText(label).width + 10, 20);
  ctx.fillStyle = color;
  ctx.fillText(label, x + 9, y + 18);
  ctx.strokeStyle = '#00000055';
  ctx.strokeRect(x + 0.5, y + 0.5, cell - 1, cell - 1);
}

/**
 * Renders the bend test poses: one row per control (bone or IK chain), zoomed on the
 * meshes that bend. Cells whose mesh folds in the bend test are labelled red.
 */
async function bendSheet(cell = 220, stress = false): Promise<string> {
  if (!actor) throw new Error('No skeleton loaded');
  const a = actor;
  setPlaying(false);
  a.state.clearTracks();
  const poses = bendPoses(a.data).filter((p) => stress || p.hard);
  const controls = [...new Set(poses.map((p) => p.control))];
  const columns = 1 + Math.max(1, ...controls.map((c) => poses.filter((p) => p.control === c).length));
  const sheet = document.createElement('canvas');
  sheet.width = cell * columns;
  sheet.height = cell * Math.max(1, controls.length);
  const ctx = sheet.getContext('2d')!;
  ctx.fillStyle = backgroundColor();
  ctx.fillRect(0, 0, sheet.width, sheet.height);
  if (!controls.length) {
    ctx.font = '600 14px system-ui, sans-serif';
    ctx.fillStyle = '#ffffff';
    ctx.fillText('No mesh bends with these bones:', 12, cell / 2 - 10);
    ctx.fillText('nothing to bend-test.', 12, cell / 2 + 10);
    return sheet.toDataURL('image/png');
  }
  const w = app.renderer.width / app.renderer.resolution;
  const h = app.renderer.height / app.renderer.resolution;
  const buf = new Float32Array(8192);
  controls.forEach((control, row) => {
    const list = poses.filter((p) => p.control === control);
    // Frame the setup-pose bounds of the meshes this control bends.
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const [slot, index] of list[0].meshes) {
      const v = a.data.attachments[slot][index].vertices;
      for (let i = 0; i < v.length; i += 2) {
        minX = Math.min(minX, v[i]);
        maxX = Math.max(maxX, v[i]);
        minY = Math.min(minY, v[i + 1]);
        maxY = Math.max(maxY, v[i + 1]);
      }
    }
    if (!Number.isFinite(minX)) ({ x: minX, y: minY } = a.data.bounds), (maxX = minX + a.data.bounds.width), (maxY = minY + a.data.bounds.height);
    const pad = Math.max(maxX - minX, maxY - minY) * 0.35;
    const s = Math.min(w / (maxX - minX + pad * 2), h / (maxY - minY + pad * 2));
    view.scale.set(s);
    view.position.set(w / 2 - ((minX + maxX) / 2) * s, h / 2 - ((minY + maxY) / 2) * s);
    [null, ...list].forEach((p, col) => {
      a.skeleton.setToSetupPose();
      p?.apply(a.skeleton);
      a.refresh();
      app.render();
      // Fold check for the label colour.
      let folded = false;
      if (p)
        for (const [slot, index] of p.meshes) {
          const mesh = a.data.attachments[slot][index];
          a.skeleton.attachments[slot] = index;
          a.skeleton.computeSlotVertices(slot, buf);
          const v0 = mesh.vertices;
          const t = mesh.triangles;
          for (let i = 0; i < t.length && !folded; i += 3) {
            const area = (v: Float32Array) =>
              (v[t[i + 1] * 2] - v[t[i] * 2]) * (v[t[i + 2] * 2 + 1] - v[t[i] * 2 + 1]) -
              (v[t[i + 2] * 2] - v[t[i] * 2]) * (v[t[i + 1] * 2 + 1] - v[t[i] * 2 + 1]);
            const a0 = area(v0);
            if (Math.abs(a0) > 1e-3 && area(buf) / a0 <= 0) folded = true;
          }
        }
      const x = col * cell;
      const y = row * cell;
      ctx.fillStyle = backgroundColor();
      ctx.fillRect(x, y, cell, cell);
      const src = app.canvas;
      const k = Math.min(cell / src.width, cell / src.height);
      ctx.drawImage(src, x + (cell - src.width * k) / 2, y + (cell - src.height * k) / 2, src.width * k, src.height * k);
      drawLabel(ctx, p ? `${control} ${p.pose}` : `${control} setup`, x, y, cell, folded ? '#ff6b6b' : '#ffffff');
    });
  });
  a.skeleton.setToSetupPose();
  a.refresh();
  fit();
  return sheet.toDataURL('image/png');
}

function backgroundColor(): string {
  const bg = getComputedStyle(ui.stage).backgroundColor;
  return bg === 'rgba(0, 0, 0, 0)' ? '#1d2030' : bg;
}

/** Loads a skeleton from JSON plus images given as data/object URLs (used by headless tools). */
/**
 * Loads a skeleton from JSON plus its PNGs, given as data/object URLs keyed by the image path
 * in the file (atlas pages are shared by several images). Used by drag & drop and headless tools.
 */
async function loadData(json: unknown, pages: Record<string, string>, label = 'data') {
  const fresh: Texture[] = [];
  try {
    const pageTextures: Record<string, Texture> = {};
    for (const [path, url] of Object.entries(pages)) {
      const blob = await (await fetch(url)).blob();
      const t = Texture.from(await createImageBitmap(blob));
      pageTextures[path] = t;
      fresh.push(t);
    }
    const images = ((json as { images?: Record<string, L2DImage> }).images ?? {}) as Record<string, L2DImage>;
    // Older callers keyed the PNGs by image name instead of path.
    for (const [name, img] of Object.entries(images)) pageTextures[img.path] ??= pageTextures[name];
    setActor(fromLoaded(json, cutTextures(images, pageTextures)), label);
  } catch (e) {
    for (const t of fresh) t.destroy(true);
    throw e;
  }
  for (const t of ownedTextures) t.destroy(true);
  ownedTextures = fresh;
  return api.info();
}

/** One frame (setup pose when `name` is null) composited on the background, as a PNG data URL. */
function frame(name: string | null, time = 0): string {
  if (!actor) throw new Error('No skeleton loaded');
  if (name) {
    fit(motionBounds(name), 0.9);
    seek(name, time);
  } else {
    setPlaying(false);
    actor.state.clearTracks();
    actor.skeleton.setToSetupPose();
    actor.refresh();
  }
  app.render();
  const src = app.canvas;
  const out = document.createElement('canvas');
  out.width = src.width;
  out.height = src.height;
  const ctx = out.getContext('2d')!;
  ctx.fillStyle = backgroundColor();
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(src, 0, 0);
  if (name) fit();
  return out.toDataURL('image/png');
}

function seek(name: string, time: number) {
  if (!actor) throw new Error('No skeleton loaded');
  setPlaying(false);
  const mix = actor.state.defaultMix;
  actor.state.defaultMix = 0;
  actor.state.clearTracks();
  const e = actor.state.setAnimation(0, name, false);
  actor.state.defaultMix = mix;
  e.trackTime = time;
  actor.update(0);
}

const api = {
  load: loadUrl,
  play: (name: string) => {
    setPlaying(true);
    play(name);
  },
  seek,
  frame,
  loadData,
  contactSheet,
  bendSheet,
  setBackground: (bg: string) => {
    ui.bg.value = ui.stage.dataset.bg = bg;
  },
  resize: () => app.resize(),
  debug: (on: boolean) => {
    ui.dbgBones.checked = ui.dbgMeshes.checked = ui.dbgIk.checked = on;
    applyDebug();
  },
  info: () =>
    actor && {
      name: actor.data.name,
      animations: [...actor.data.animations.values()].map((a) => ({ name: a.name, duration: a.duration })),
    },
};
(window as unknown as { __llm2d: typeof api }).__llm2d = api;

const initial = params.get('file') ?? ui.sample.value;
if ([...ui.sample.options].some((o) => o.value === initial)) ui.sample.value = initial;
if (params.get('bg')) ui.bg.value = ui.stage.dataset.bg = params.get('bg')!;
if (params.has('debug')) api.debug(true);
await loadUrl(initial);
document.body.dataset.ready = 'true';
