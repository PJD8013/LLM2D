/**
 * The viewport: draws the skeleton at the playhead (plus onion skins), the bones over it, and
 * turns pointer drags on a bone into keys (rotate / move / scale, relative to setup).
 */
import { Application, Container, Graphics, Text } from 'pixi.js';
import { BONE_CHANNELS, CH_ROT, CH_SX, CH_SY, CH_X, CH_Y, type Skeleton } from '@llm2d/core';
import { Llm2dActor, type LoadedLlm2d } from '@llm2d/pixi';
import type { Editor } from './editor.svelte.ts';

const ONION_STEP = 0.1;

interface BoneDrag {
  kind: 'bone';
  bone: number;
  tool: 'rotate' | 'translate' | 'scale';
  start: { x: number; y: number };
  /** Pointer angle around the bone origin last seen (null while too close to the origin). */
  last: number | null;
  turned: number;
  /** Started on empty space: a click without movement deselects instead. */
  fromEmpty: boolean;
  moved: boolean;
  uniform: boolean;
  /** Local channel values at drag start. */
  rot: number;
  x: number;
  y: number;
  sx: number;
  sy: number;
}

export class Stage {
  readonly app = new Application();
  readonly view = new Container();
  private readonly ghosts = new Container();
  private readonly overlay = new Graphics();
  private readonly label = new Text({ text: '', style: { fontFamily: 'system-ui, sans-serif', fontSize: 13, fill: 0xffffff, fontWeight: '600' } });
  private actor: Llm2dActor | null = null;
  private onionActors: Llm2dActor[] = [];
  private zoom = 1;
  private pan = { x: 0, y: 0 };
  private drag: BoneDrag | { kind: 'pan'; x: number; y: number } | null = null;
  private hover = -1;
  private host: HTMLElement | null = null;
  private readonly editor: Editor;

  constructor(editor: Editor) {
    this.editor = editor;
  }

  get skeleton(): Skeleton | null {
    return this.actor?.skeleton ?? null;
  }

  async mount(host: HTMLElement) {
    this.host = host;
    await this.app.init({ resizeTo: host, backgroundAlpha: 0, antialias: true, preference: 'webgl', resolution: window.devicePixelRatio, autoDensity: true, preserveDrawingBuffer: true });
    host.appendChild(this.app.canvas);
    this.app.stage.addChild(this.view);
    this.view.addChild(this.ghosts);
    this.app.stage.addChild(this.overlay, this.label);
    this.app.renderer.on('resize', () => this.fit());
    this.app.ticker.add((t) => {
      this.editor.tick(t.deltaMS / 1000);
      this.drawOverlay();
    });
    const canvas = this.app.canvas;
    canvas.addEventListener('pointerdown', (e) => this.down(e));
    canvas.addEventListener('pointermove', (e) => this.move(e));
    canvas.addEventListener('pointerup', (e) => this.up(e));
    canvas.addEventListener('pointercancel', (e) => this.up(e));
    canvas.addEventListener('dblclick', () => this.resetView());
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('wheel', (e) => this.wheel(e), { passive: false });
    if (this.editor.loaded) this.setSkeleton(this.editor.loaded);
  }

  destroy() {
    this.app.destroy(true, { children: true });
  }

  /** Shows a skeleton; `keepView` keeps zoom and pan (reloading the same project). */
  setSkeleton(loaded: LoadedLlm2d, keepView = false) {
    if (!this.host) return;
    this.actor?.destroy();
    for (const g of this.onionActors) g.destroy();
    this.actor = new Llm2dActor({ ...loaded, autoUpdate: false });
    this.actor.state.defaultMix = 0;
    this.onionActors = [0xff5a5a, 0x4fd18b].map((tint) => {
      const a = new Llm2dActor({ ...loaded, autoUpdate: false });
      a.state.defaultMix = 0;
      a.alpha = 0.3;
      a.tint = tint;
      return a;
    });
    this.ghosts.addChild(...this.onionActors);
    this.view.addChild(this.actor);
    if (keepView) this.fit();
    else this.resetView();
  }

  resetView() {
    this.zoom = 1;
    this.pan = { x: 0, y: 0 };
    this.fit();
  }

  fit() {
    if (!this.actor) return;
    const b = this.actor.data.bounds;
    const w = this.app.renderer.width / this.app.renderer.resolution;
    const h = this.app.renderer.height / this.app.renderer.resolution;
    const s = Math.min((w * 0.8) / Math.max(1, b.width), (h * 0.8) / Math.max(1, b.height)) * this.zoom;
    this.view.scale.set(s);
    this.view.position.set(w / 2 - (b.x + b.width / 2) * s + this.pan.x, h / 2 - (b.y + b.height / 2) * s + this.pan.y);
  }

  private static posed(actor: Llm2dActor, name: string, time: number) {
    actor.state.clearTracks();
    const e = actor.state.setAnimation(0, name, false);
    e.trackTime = time;
    actor.update(0);
  }

  poseAt(name: string, time: number) {
    if (!this.actor || !this.actor.data.animations.has(name)) return;
    Stage.posed(this.actor, name, time);
    const onion = this.editor.onion;
    this.ghosts.visible = onion;
    if (onion) {
      const d = this.actor.data.animations.get(name)!.duration;
      const wrap = (t: number) => (this.editor.loop && d > 0 ? ((t % d) + d) % d : Math.min(Math.max(t, 0), d));
      Stage.posed(this.onionActors[0], name, wrap(time - ONION_STEP));
      Stage.posed(this.onionActors[1], name, wrap(time + ONION_STEP));
    }
  }

  /** Renders the current view to a PNG data URL (tests, screenshots). */
  snapshot(): string {
    this.app.render();
    return this.app.canvas.toDataURL('image/png');
  }

  // ---------------- Bones overlay ----------------

  private keyedBones(): Set<string> {
    const anim = this.editor.data?.source.animations[this.editor.animName];
    return new Set(Object.keys(anim?.bones ?? {}));
  }

  private ikControlled(bone: number): string | null {
    const data = this.actor!.data;
    for (const c of data.ik) if (c.bones.includes(bone) && this.actor!.skeleton.channels[data.ikChannelBase + c.index] > 0) return data.bones[c.target].name;
    return null;
  }

  private drawOverlay() {
    const g = this.overlay;
    g.clear();
    this.label.visible = false;
    if (!this.actor) return;
    const sk = this.actor.skeleton;
    const data = this.actor.data;
    const keyed = this.keyedBones();
    const targets = new Set(data.ik.map((c) => c.target));
    const selected = this.editor.selectedBone ? data.findBone(this.editor.selectedBone) : -1;
    const toScreen = (x: number, y: number) => this.view.toGlobal({ x, y });
    for (const b of data.bones) {
      if (b.name === 'root' && b.length === 0 && b.index !== selected) continue;
      const o = toScreen(...sk.boneWorldPosition(b.index));
      const isSel = b.index === selected;
      const color = isSel ? 0xffb020 : targets.has(b.index) ? 0x6cff5a : keyed.has(b.name) ? 0x6fd3ff : 0xffffff;
      const alpha = isSel || b.index === this.hover ? 1 : 0.55;
      if (b.length > 0) {
        const t = toScreen(...sk.boneWorldTip(b.index));
        const dx = t.x - o.x;
        const dy = t.y - o.y;
        const len = Math.hypot(dx, dy) || 1;
        const wdt = Math.min(7, len * 0.12);
        const nx = (-dy / len) * wdt;
        const ny = (dx / len) * wdt;
        const kx = o.x + dx * 0.18;
        const ky = o.y + dy * 0.18;
        g.poly([o.x, o.y, kx + nx, ky + ny, t.x, t.y, kx - nx, ky - ny]).fill({ color, alpha: alpha * 0.35 }).stroke({ width: 1.5, color, alpha });
      }
      if (targets.has(b.index)) {
        g.circle(o.x, o.y, 8).stroke({ width: 2, color, alpha });
        g.moveTo(o.x - 11, o.y).lineTo(o.x + 11, o.y).moveTo(o.x, o.y - 11).lineTo(o.x, o.y + 11).stroke({ width: 1.5, color, alpha });
      } else g.circle(o.x, o.y, isSel ? 5 : 3.5).fill({ color, alpha });
    }
    if (selected >= 0) {
      const o = toScreen(...sk.boneWorldPosition(selected));
      const tool = this.editor.tool;
      if (tool === 'rotate') g.circle(o.x, o.y, 34).stroke({ width: 2, color: 0xffb020, alpha: 0.7 });
      else if (tool === 'translate') {
        g.moveTo(o.x - 30, o.y).lineTo(o.x + 30, o.y).moveTo(o.x, o.y - 30).lineTo(o.x, o.y + 30).stroke({ width: 2, color: 0xffb020, alpha: 0.8 });
        for (const [ax, ay] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) g.poly([o.x + ax * 34, o.y + ay * 34, o.x + ax * 26 - ay * 5, o.y + ay * 26 + ax * 5, o.x + ax * 26 + ay * 5, o.y + ay * 26 - ax * 5]).fill({ color: 0xffb020 });
      } else g.rect(o.x - 26, o.y - 26, 52, 52).stroke({ width: 2, color: 0xffb020, alpha: 0.7 });
      this.label.text = this.dragLabel() ?? data.bones[selected].name;
      this.label.position.set(o.x + 12, o.y - 30);
      this.label.visible = true;
    }
  }

  private dragLabel(): string | null {
    const d = this.drag;
    if (!d || d.kind !== 'bone' || !this.actor) return null;
    const ch = this.actor.skeleton.channels;
    const setup = this.actor.data.setupChannels;
    const o = d.bone * BONE_CHANNELS;
    if (d.tool === 'rotate') return `회전 ${(ch[o + CH_ROT] - setup[o + CH_ROT]).toFixed(1)}°`;
    if (d.tool === 'translate') return `이동 ${(ch[o + CH_X] - setup[o + CH_X]).toFixed(1)}, ${(ch[o + CH_Y] - setup[o + CH_Y]).toFixed(1)}`;
    return `크기 ${(ch[o + CH_SX] / (setup[o + CH_SX] || 1)).toFixed(2)} × ${(ch[o + CH_SY] / (setup[o + CH_SY] || 1)).toFixed(2)}`;
  }

  // ---------------- Picking and dragging ----------------

  private local(e: PointerEvent): { x: number; y: number } {
    const r = this.app.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  /**
   * Angle of a screen point around a bone's origin, measured in the bone's parent space where
   * its rotation lives, so the bone follows the pointer under scaled or mirrored parents.
   */
  private angleAround(bone: number, p: { x: number; y: number }): number {
    const sk = this.actor!.skeleton;
    const q = this.view.toLocal(p);
    let x = q.x;
    let y = q.y;
    const parent = this.actor!.data.bones[bone].parent;
    if (parent >= 0) {
      const m = sk.world[parent];
      const det = m[0] * m[3] - m[1] * m[2] || 1;
      const rx = x - m[4];
      const ry = y - m[5];
      x = (m[3] * rx - m[2] * ry) / det;
      y = (-m[1] * rx + m[0] * ry) / det;
    }
    const o = bone * BONE_CHANNELS;
    return Math.atan2(y - sk.channels[o + CH_Y], x - sk.channels[o + CH_X]);
  }

  /** The bone under a screen point (nearest within a few pixels), or -1. */
  pick(p: { x: number; y: number }): number {
    if (!this.actor) return -1;
    const sk = this.actor.skeleton;
    let best = -1;
    let bestD = Infinity;
    for (const b of this.actor.data.bones) {
      if (b.name === 'root' && b.length === 0) continue;
      const o = this.view.toGlobal({ x: sk.boneWorldPosition(b.index)[0], y: sk.boneWorldPosition(b.index)[1] });
      let d: number;
      if (b.length > 0) {
        const t = this.view.toGlobal({ x: sk.boneWorldTip(b.index)[0], y: sk.boneWorldTip(b.index)[1] });
        const vx = t.x - o.x;
        const vy = t.y - o.y;
        const u = Math.max(0, Math.min(1, ((p.x - o.x) * vx + (p.y - o.y) * vy) / (vx * vx + vy * vy || 1)));
        d = Math.hypot(p.x - (o.x + vx * u), p.y - (o.y + vy * u));
      } else d = Math.hypot(p.x - o.x, p.y - o.y) - 4;
      // Later bones (children) win ties, so the tip of a limb picks the limb, not its parent.
      if (d <= 9 && d <= bestD + 0.5) {
        best = b.index;
        bestD = d;
      }
    }
    return best;
  }

  private down(e: PointerEvent) {
    if (!this.actor) return;
    this.app.canvas.setPointerCapture(e.pointerId);
    const p = this.local(e);
    const data = this.actor.data;
    const hit = e.button === 0 && !e.altKey ? this.pick(p) : -1;
    const selected = this.editor.selectedBone ? data.findBone(this.editor.selectedBone) : -1;
    // Left drag: on a bone selects and edits it; on empty space edits the selected bone (so
    // small or zero-length bones can be turned from anywhere around them). Otherwise: pan.
    const bone = hit >= 0 ? hit : e.button === 0 && !e.altKey ? selected : -1;
    if (bone < 0) {
      this.drag = { kind: 'pan', x: p.x - this.pan.x, y: p.y - this.pan.y };
      return;
    }
    const name = data.bones[bone].name;
    this.editor.selectBone(name);
    this.editor.playing = false;
    const ik = this.ikControlled(bone);
    const tool = this.editor.tool;
    if (ik && tool === 'rotate') this.editor.say('info', `${name}은(는) IK로 움직입니다. 목표 뼈 ${ik}을(를) 이동 도구로 옮기세요.`);
    const ch = this.actor.skeleton.channels;
    const o = bone * BONE_CHANNELS;
    const w = this.actor.skeleton.boneWorldPosition(bone);
    const origin = this.view.toGlobal({ x: w[0], y: w[1] });
    this.drag = {
      kind: 'bone',
      bone,
      tool,
      start: p,
      last: Math.hypot(p.x - origin.x, p.y - origin.y) > 10 ? this.angleAround(bone, p) : null,
      turned: 0,
      fromEmpty: hit < 0,
      moved: false,
      uniform: !e.shiftKey,
      rot: ch[o + CH_ROT],
      x: ch[o + CH_X],
      y: ch[o + CH_Y],
      sx: ch[o + CH_SX],
      sy: ch[o + CH_SY],
    };
    this.editor.beginDrag();
  }

  private move(e: PointerEvent) {
    const p = this.local(e);
    const d = this.drag;
    if (!d) {
      const h = this.pick(p);
      if (h !== this.hover) {
        this.hover = h;
        this.app.canvas.style.cursor = h >= 0 ? 'pointer' : 'grab';
      }
      return;
    }
    if (d.kind === 'pan') {
      this.pan = { x: p.x - d.x, y: p.y - d.y };
      this.fit();
      return;
    }
    if (!this.actor) return;
    if (!d.moved && Math.hypot(p.x - d.start.x, p.y - d.start.y) < 3) return;
    d.moved = true;
    const data = this.actor.data;
    const sk = this.actor.skeleton;
    const name = data.bones[d.bone].name;
    const setup = data.setupChannels;
    const o = d.bone * BONE_CHANNELS;
    const w = sk.boneWorldPosition(d.bone);
    const origin = this.view.toGlobal({ x: w[0], y: w[1] });
    const parent = data.bones[d.bone].parent;
    const pw = parent >= 0 ? sk.world[parent] : null;
    const r3 = (v: number, k = 100) => Math.round(v * k) / k;

    if (d.tool === 'rotate') {
      // Angles right next to the pivot are noise: count turning only from 10 px away.
      if (Math.hypot(p.x - origin.x, p.y - origin.y) < 10) return;
      const a = this.angleAround(d.bone, p);
      if (d.last === null) d.last = a;
      let delta = a - d.last;
      while (delta > Math.PI) delta -= 2 * Math.PI;
      while (delta < -Math.PI) delta += 2 * Math.PI;
      d.turned += delta;
      d.last = a;
      const deg = (d.turned * 180) / Math.PI;
      this.editor.keyBone(name, 'rotate', { value: r3(d.rot + deg - setup[o + CH_ROT]) }, false);
    } else if (d.tool === 'translate') {
      // Screen delta -> skeleton space -> parent's local space.
      const a0 = this.view.toLocal(d.start);
      const a1 = this.view.toLocal(p);
      let dx = a1.x - a0.x;
      let dy = a1.y - a0.y;
      if (pw) {
        const det = pw[0] * pw[3] - pw[1] * pw[2] || 1;
        [dx, dy] = [(pw[3] * dx - pw[2] * dy) / det, (-pw[1] * dx + pw[0] * dy) / det];
      }
      this.editor.keyBone(name, 'translate', { x: r3(d.x + dx - setup[o + CH_X]), y: r3(d.y + dy - setup[o + CH_Y]) }, false);
    } else {
      const d0 = Math.hypot(d.start.x - origin.x, d.start.y - origin.y);
      const d1 = Math.hypot(p.x - origin.x, p.y - origin.y);
      if (d0 < 4) return;
      let fx = d1 / d0;
      let fy = fx;
      if (!d.uniform) {
        // Along the bone's own axes.
        const bw = sk.world[d.bone];
        const ex = Math.hypot(bw[0], bw[1]) || 1;
        const ey = Math.hypot(bw[2], bw[3]) || 1;
        const axis = (px: number, py: number, ax: number, ay: number) => px * ax + py * ay;
        const s0 = { x: d.start.x - origin.x, y: d.start.y - origin.y };
        const s1 = { x: p.x - origin.x, y: p.y - origin.y };
        const along = Math.abs(axis(s0.x, s0.y, bw[0] / ex, bw[1] / ex)) >= Math.abs(axis(s0.x, s0.y, bw[2] / ey, bw[3] / ey));
        if (along) {
          fx = axis(s1.x, s1.y, bw[0] / ex, bw[1] / ex) / (axis(s0.x, s0.y, bw[0] / ex, bw[1] / ex) || 1);
          fy = 1;
        } else {
          fy = axis(s1.x, s1.y, bw[2] / ey, bw[3] / ey) / (axis(s0.x, s0.y, bw[2] / ey, bw[3] / ey) || 1);
          fx = 1;
        }
      }
      const sx = (d.sx * fx) / (setup[o + CH_SX] || 1);
      const sy = (d.sy * fy) / (setup[o + CH_SY] || 1);
      this.editor.keyBone(name, 'scale', { x: r3(sx, 1000), y: r3(sy, 1000) }, false);
    }
  }

  private up(e: PointerEvent) {
    if (this.app.canvas.hasPointerCapture(e.pointerId)) this.app.canvas.releasePointerCapture(e.pointerId);
    const d = this.drag;
    if (d?.kind === 'bone') {
      this.editor.endDrag();
      if (d.fromEmpty && !d.moved) this.editor.selectBone(null);
    }
    this.drag = null;
  }

  private wheel(e: WheelEvent) {
    e.preventDefault();
    const p = this.local(e as unknown as PointerEvent);
    const before = this.view.toLocal(p);
    this.zoom = Math.min(12, Math.max(0.15, this.zoom * Math.exp(-e.deltaY * 0.0015)));
    this.fit();
    // Keep the point under the cursor in place.
    const after = this.view.toGlobal(before);
    this.pan.x += p.x - after.x;
    this.pan.y += p.y - after.y;
    this.fit();
  }
}
