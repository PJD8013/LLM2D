import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AnimationState, Skeleton, SkeletonData, resolveCurve, validate, type L2DAnimation, type L2DFile } from '@llm2d/core';
import { PRESETS, applyPreset, describePresets, mergeAnimations, patchAnimation } from '../src/index.ts';

const root = join(import.meta.dirname, '../../..');
const load = (name: string): L2DFile => JSON.parse(readFileSync(join(root, 'samples', name, `${name}.l2d.json`), 'utf8'));

const kitParams: Record<string, Record<string, unknown>> = {
  sway: { bones: ['tail1', 'tail2', 'tail3', 'tail4'] },
  breathe: { bone: 'hip' },
  blink: { slot: 'eyes', closed: 'eyes_closed', times: [0.5, 2] },
  talk: { slot: 'mouth', open: 'mouth_open', head: 'head' },
  nod: { bone: 'head' },
  wave: { upper: 'upper_arm_r', forearm: 'forearm_r', hand: 'hand_r' },
  jump: { hip: 'hip', feet: ['foot_l_ik', 'foot_r_ik'], arms: ['upper_arm_l', 'upper_arm_r'] },
  fade: { slots: ['eyes'] },
};
const gemParams: Record<string, Record<string, unknown>> = {
  symbol_win: { glow: 'glow', glowBone: 'glow', flash: 'gem_flash', sparkle: 'sparkle', sparkleBone: 'sparkle' },
  symbol_land: { flash: 'gem_flash' },
  big_win_title: { slots: ['gem'] },
  pop_in: { slots: ['gem'] },
  fade: { slots: ['glow'], from: 0, to: 1 },
  shine_sweep: { bone: 'sparkle' },
};

function withAnimation(file: L2DFile, name: string, anim: L2DAnimation): L2DFile {
  return { ...file, animations: { ...file.animations, [name]: anim } };
}

function playThrough(file: L2DFile, name: string) {
  const data = SkeletonData.fromJSON(file);
  const sk = new Skeleton(data);
  const state = new AnimationState(data);
  state.setAnimation(0, name, false);
  const out = new Float32Array(8192);
  for (let i = 0; i < 90; i++) {
    state.update(1 / 30);
    state.apply(sk);
    sk.updateWorldTransform();
    for (let s = 0; s < data.slots.length; s++) {
      const n = sk.computeSlotVertices(s, out);
      for (let k = 0; k < n * 2; k++) if (!Number.isFinite(out[k])) throw new Error(`NaN in ${name}`);
    }
  }
}

describe('presets', () => {
  for (const preset of PRESETS) {
    const useKit = preset.category === 'character' || preset.name in kitParams && !(preset.name in gemParams);
    const sample = useKit ? 'kit' : 'gem';
    const params = (useKit ? kitParams : gemParams)[preset.name] ?? {};
    it(`${preset.name} produces a valid animation on ${sample}`, () => {
      const file = load(sample);
      const anim = applyPreset(SkeletonData.fromJSON(file), preset.name, params);
      const merged = withAnimation(file, 'test', anim);
      const r = validate(merged);
      expect(r.errors).toEqual([]);
      playThrough(merged, 'test');
      if (preset.loops) {
        // Loops end where they start (timelines that span the loop seam, i.e. start at 0).
        for (const tl of Object.values(anim.bones ?? {}))
          for (const keys of [tl.rotate, tl.translate, tl.scale]) {
            if (!keys || keys.length < 2 || keys[0].time > 0) continue;
            expect(keys[keys.length - 1]).toMatchObject(Object.fromEntries(Object.entries(keys[0]).filter(([k]) => k !== 'time' && k !== 'curve')));
          }
      }
    });
  }

  it('reports unknown bones, params and attachments helpfully', () => {
    const data = SkeletonData.fromJSON(load('kit'));
    expect(() => applyPreset(data, 'sway', { bones: ['tail9'] })).toThrow(/unknown bone "tail9". Bones: root, hip/);
    expect(() => applyPreset(data, 'sway', { bones: ['tail1'], speed: 2 })).toThrow(/no parameter "speed"/);
    expect(() => applyPreset(data, 'blink', { slot: 'eyes', closed: 'shut' })).toThrow(/Attachments: eyes, eyes_closed/);
    expect(() => applyPreset(data, 'wobble')).toThrow(/Unknown preset "wobble"/);
  });

  it('defaults the bone to the main art and shifts by start', () => {
    const data = SkeletonData.fromJSON(load('gem'));
    const anim = applyPreset(data, 'symbol_land', { start: 0.5 });
    expect(Object.keys(anim.bones!)).toEqual(['gem']);
    expect(anim.bones!.gem.translate![0].time).toBe(0.5);
    expect(anim.events![0]).toMatchObject({ name: 'land', time: 0.62 });
  });

  it('sweeps a shine from just outside one side of the symbol to just outside the other', () => {
    const data = SkeletonData.fromJSON(load('coin'));
    const anim = applyPreset(data, 'shine_sweep', { bone: 'shine' });
    const [start, end, back] = anim.bones!.shine.translate!;
    const shine = data.attachments[data.findSlot('shine')][0].vertices;
    const xs = [...shine].filter((_, i) => i % 2 === 0);
    const b = data.bounds;
    expect(Math.max(...xs) + start.x!).toBeCloseTo(b.x, 0);
    expect(Math.min(...xs) + end.x!).toBeCloseTo(b.x + b.width, 0);
    expect([end.time, end.curve, back.time, back.x]).toEqual([0.6, 'stepped', 1.6, start.x]);
    expect(() => applyPreset(data, 'shine_sweep', {})).toThrow(/needs "bone"/);
  });

  it('raises arms outward on both sides', () => {
    const data = SkeletonData.fromJSON(load('kit'));
    const right = applyPreset(data, 'wave', { upper: 'upper_arm_r', forearm: 'forearm_r' });
    const left = applyPreset(data, 'wave', { upper: 'upper_arm_l', forearm: 'forearm_l' });
    expect(right.bones!.upper_arm_r.rotate![1].value).toBeLessThan(0);
    expect(left.bones!.upper_arm_l.rotate![1].value).toBeGreaterThan(0);
  });

  it('merges presets into one animation', () => {
    const data = SkeletonData.fromJSON(load('kit'));
    let idle = applyPreset(data, 'breathe', { bone: 'hip' });
    idle = mergeAnimations(idle, applyPreset(data, 'sway', { bones: ['tail1', 'tail2'] }));
    idle = mergeAnimations(idle, applyPreset(data, 'blink', { slot: 'eyes', closed: 'eyes_closed', times: [1.5] }));
    expect(Object.keys(idle.bones!).sort()).toEqual(['hip', 'tail1', 'tail2']);
    // Open until the blink at 1.5 s, shut, open again.
    expect(idle.slots!.eyes.attachment!.map((k) => [k.time, k.name])).toEqual([[0, 'eyes'], [1.5, 'eyes_closed'], [1.62, 'eyes']]);
  });

  it('re-applies a preset without doubling its events, and sequences presets on one bone', () => {
    const data = SkeletonData.fromJSON(load('gem'));
    let a = applyPreset(data, 'symbol_land', {});
    a = mergeAnimations(a, applyPreset(data, 'symbol_land', { drop: 60 }));
    expect(a.events!.map((e) => e.name)).toEqual(['land']);
    expect(a.bones!.gem.translate![0].y).toBe(-60);
    // land, then win from 0.5 s: the squash keys before 0.5 s stay.
    const seq = mergeAnimations(applyPreset(data, 'symbol_land', {}), applyPreset(data, 'symbol_win', { start: 0.5 }));
    const times = seq.bones!.gem.scale!.map((k) => k.time);
    expect(times[0]).toBe(0);
    expect(times).toContain(0.5);
    expect(seq.events!.map((e) => e.name)).toEqual(['land']);
  });

  it('sways with continuous speed, also across the loop seam', () => {
    const data = SkeletonData.fromJSON(load('kit'));
    const anim = applyPreset(data, 'sway', { bones: ['tail1', 'tail2', 'tail3', 'tail4'] });
    const keys = anim.bones!.tail4.rotate!;
    const period = keys[keys.length - 1].time;
    const value = (t: number) => {
      const i = keys.findIndex((k, j) => keys[j + 1] && t >= k.time && t <= keys[j + 1].time);
      const a = keys[i];
      const b = keys[i + 1];
      const u = (t - a.time) / (b.time - a.time);
      const ease = a.curve ? resolveCurve(a.curve)! : (x: number) => x;
      return a.value + (b.value - a.value) * ease(u);
    };
    const h = 1e-3;
    const speedEnd = (value(period) - value(period - h)) / h;
    const speedStart = (value(h) - value(0)) / h;
    expect(Math.abs(speedEnd - speedStart)).toBeLessThan(Math.max(1, Math.abs(speedStart) * 0.05));
    // And at every inner key.
    for (const k of keys.slice(1, -1)) expect(Math.abs((value(k.time + h) - value(k.time)) / h - (value(k.time) - value(k.time - h)) / h)).toBeLessThan(2);
  });

  it('defaults to the bone carrying most of the visible art, and keeps attachments at rest before "start"', () => {
    expect(Object.keys(applyPreset(SkeletonData.fromJSON(load('kit')), 'pop_in', {}).bones!)).toEqual(['hip']);
    expect(Object.keys(applyPreset(SkeletonData.fromJSON(load('coin')), 'pop_in', {}).bones!)).toEqual(['coin']);
    const talk = applyPreset(SkeletonData.fromJSON(load('kit')), 'talk', { slot: 'mouth', open: 'mouth_open', start: 1 });
    expect(talk.slots!.mouth.attachment![0]).toEqual({ time: 0, name: 'mouth' });
  });

  it('describes every preset', () => {
    const text = describePresets();
    for (const p of PRESETS) expect(text).toContain(p.name);
  });
});

describe('patchAnimation', () => {
  const base = {
    duration: 2,
    bones: { arm: { rotate: [{ time: 0, value: 0 }, { time: 1, value: 30 }], scale: [{ time: 0, x: 1 }] }, leg: { rotate: [{ time: 0, value: 5 }] } },
    slots: { eyes: { alpha: [{ time: 0, value: 1 }] } },
    events: [{ time: 0.5, name: 'step' }],
  };

  it('replaces only the timelines it names and keeps the rest', () => {
    const out = patchAnimation(base, { bones: { arm: { rotate: [{ time: 0, value: 10 }] } } });
    expect(out.bones!.arm.rotate).toEqual([{ time: 0, value: 10 }]);
    expect(out.bones!.arm.scale).toEqual(base.bones.arm.scale);
    expect(out.bones!.leg).toEqual(base.bones.leg);
    expect(out.slots).toEqual(base.slots);
    expect(out.events).toEqual(base.events);
    expect(out.duration).toBe(2);
    expect(base.bones.arm.rotate[0].value).toBe(0); // base untouched
  });

  it('deletes timelines given as empty lists, replaces events and duration', () => {
    const out = patchAnimation(base, {
      duration: 1.5,
      bones: { leg: { rotate: [] }, arm: { scale: [] } },
      slots: { eyes: { alpha: [] } },
      events: [{ time: 1, name: 'land' }, { time: 0.2, name: 'jump' }],
    });
    expect(out.bones).toEqual({ arm: { rotate: base.bones.arm.rotate } });
    expect(out.slots).toBeUndefined();
    expect(out.events!.map((e) => e.name)).toEqual(['jump', 'land']);
    expect(out.duration).toBe(1.5);
    expect(patchAnimation(base, { events: [] }).events).toBeUndefined();
  });
});
