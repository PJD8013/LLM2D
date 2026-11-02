import { describe, expect, it } from 'vitest';
import {
  AnimationState,
  EASINGS,
  bendPoses,
  bendTest,
  Skeleton,
  SkeletonData,
  cubicBezier,
  math,
  validate,
  type EventData,
} from '../src/index.ts';
import { armFile } from './fixtures.ts';

const close = (a: number, b: number, eps = 1e-3) => expect(Math.abs(a - b)).toBeLessThan(eps);

describe('math', () => {
  it('composes, multiplies and inverts affine matrices', () => {
    const m = math.compose(math.mat(), 10, 20, 90, 2, 3);
    close(math.applyX(m, 1, 0), 10);
    close(math.applyY(m, 1, 0), 22);
    const inv = math.invert(math.mat(), m);
    const id = math.multiply(math.mat(), m, inv);
    [1, 0, 0, 1, 0, 0].forEach((v, i) => close(id[i], v));
  });

  it('wraps and interpolates angles along the shortest arc', () => {
    close(math.wrapDeg(190), -170);
    close(math.lerpAngle(170, -170, 0.5), 180);
  });
});

describe('curves', () => {
  it('named easings hit both endpoints', () => {
    for (const [name, fn] of Object.entries(EASINGS)) {
      close(fn(0), 0, 1e-6);
      close(fn(1), 1, 1e-6);
      expect(Number.isFinite(fn(0.5)), name).toBe(true);
    }
  });

  it('cubic bezier matches the linear case and stays monotonic for ease', () => {
    const lin = cubicBezier(0, 0, 1, 1);
    close(lin(0.3), 0.3);
    const ease = cubicBezier(0.25, 0.1, 0.25, 1);
    let prev = 0;
    for (let x = 0; x <= 1; x += 0.05) {
      const y = ease(x);
      expect(y).toBeGreaterThanOrEqual(prev - 1e-6);
      prev = y;
    }
  });
});

describe('validate', () => {
  it('accepts a correct file', () => {
    const r = validate(armFile());
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('reports actionable errors with paths', () => {
    const f = armFile() as any;
    f.bones.push({ name: 'orphan', parent: 'nope' });
    f.slots[0].bone = 'missing';
    f.attachments.strip.strip.triangles.push(0, 1, 99);
    f.attachments.strip.strip.weights[0] = [5, 1];
    f.ik[0].target = 'lower';
    f.animations.swing.bones.upper.rotate[2].time = 0.5;
    f.animations.swing.bones.upper.rotate[0].curve = 'wobble';
    f.animations.grow.slots.hand.attachment[0].name = 'claw';
    const r = validate(f);
    const paths = r.errors.map((e) => e.path);
    expect(paths).toContain('bones[4].parent');
    expect(paths).toContain('slots[0].bone');
    expect(paths).toContain('attachments.strip.strip.triangles');
    expect(paths).toContain('attachments.strip.strip.weights[0]');
    expect(paths).toContain('ik[0].target');
    expect(paths).toContain('animations.swing.bones.upper.rotate[2].time');
    expect(paths).toContain('animations.swing.bones.upper.rotate[0].curve');
    expect(paths).toContain('animations.grow.slots.hand.attachment[0].name');
    expect(() => SkeletonData.fromJSON(f)).toThrow(/Invalid LLM2D file/);
  });
});

describe('skeleton', () => {
  it('propagates parent rotation to children', () => {
    const data = SkeletonData.fromJSON(armFile());
    const sk = new Skeleton(data);
    sk.setBoneLocal('upper', { rotation: 90 });
    sk.updateWorldTransform();
    const [x, y] = sk.boneWorldTip(data.findBone('lower'));
    close(x, 0);
    close(y, 100);
  });

  it('skins weighted and rigid meshes', () => {
    const data = SkeletonData.fromJSON(armFile());
    const sk = new Skeleton(data);
    const out = new Float32Array(32);
    // Setup pose: vertices are unchanged.
    sk.computeSlotVertices(0, out);
    close(out[4], 100);
    close(out[5], -5);
    // Bend the elbow 90 degrees: the far vertices swing down around (50, 0).
    sk.setBoneLocal('lower', { rotation: 90 });
    sk.updateWorldTransform();
    sk.computeSlotVertices(0, out);
    close(out[4], 55); // (100, -5) rotated 90deg about (50, 0) -> (55, 50)
    close(out[5], 50);
    close(out[0], 0); // vertex 0 is fully on the upper bone
    close(out[1], -5);
    // Region attached to the lower bone follows it as a whole.
    const n = sk.computeSlotVertices(1, out);
    expect(n).toBe(4);
    const cx = (out[0] + out[2] + out[4] + out[6]) / 4;
    const cy = (out[1] + out[3] + out[5] + out[7]) / 4;
    close(cx, 50);
    close(cy, 50);
  });

  it('solves two-bone IK to reach the target and respects bend direction', () => {
    const data = SkeletonData.fromJSON(armFile());
    for (const bendPositive of [true, false]) {
      data.ik[0].bendPositive = bendPositive;
      const sk = new Skeleton(data);
      sk.channels[data.ikChannelBase] = 1;
      sk.setBoneLocal('target', { x: 60, y: 40 });
      sk.updateWorldTransform();
      const lower = data.findBone('lower');
      const [tx, ty] = sk.boneWorldTip(lower);
      close(tx, 60, 1e-2);
      close(ty, 40, 1e-2);
      const bend = math.wrapDeg(sk.boneWorldRotation(lower) - sk.boneWorldRotation(data.findBone('upper')));
      expect(Math.sign(bend)).toBe(bendPositive ? 1 : -1);
    }
    data.ik[0].bendPositive = true;
  });

  it('straightens toward unreachable IK targets', () => {
    const data = SkeletonData.fromJSON(armFile());
    const sk = new Skeleton(data);
    sk.channels[data.ikChannelBase] = 1;
    sk.setBoneLocal('target', { x: 0, y: 300 });
    sk.updateWorldTransform();
    close(sk.boneWorldRotation(data.findBone('upper')), 90, 0.1);
    close(sk.boneWorldRotation(data.findBone('lower')), 90, 0.1);
  });
});

describe('animation', () => {
  it('samples keys with curves, stepped keys and relative values', () => {
    const data = SkeletonData.fromJSON(armFile());
    const sk = new Skeleton(data);
    const state = new AnimationState(data);
    state.setAnimation(0, 'swing', false);
    const rot = () => sk.channels[data.boneChannel(data.findBone('upper'), 0)];
    state.update(0.5);
    state.apply(sk);
    close(rot(), 45);
    state.update(1); // t = 1.5, stepped from key 1 -> stays at 90
    state.apply(sk);
    close(rot(), 90);
    state.update(10); // clamps to the last key
    state.apply(sk);
    close(rot(), 45);
  });

  it('recompiles or removes one animation (for editors)', () => {
    const data = SkeletonData.fromJSON(armFile());
    const sk = new Skeleton(data);
    const state = new AnimationState(data);
    const rot = () => sk.channels[data.boneChannel(data.findBone('upper'), 0)];
    const swing = data.setAnimation('swing', { bones: { upper: { rotate: [{ time: 0, value: 10 }, { time: 1, value: 30 }] } } });
    expect(data.animations.get('swing')).toBe(swing);
    expect(swing.duration).toBe(1);
    expect(data.source.animations.swing.bones?.upper.rotate).toHaveLength(2);
    state.setAnimation(0, 'swing', false);
    state.update(0.5);
    state.apply(sk);
    close(rot(), 20);
    data.setAnimation('wave', { duration: 2, events: [{ time: 1, name: 'hi' }] });
    expect(data.animations.get('wave')!.duration).toBe(2);
    data.removeAnimation('wave');
    expect(data.animations.has('wave')).toBe(false);
    expect(data.source.animations.wave).toBeUndefined();
  });

  it('multiplies scale, sets color and switches attachments', () => {
    const data = SkeletonData.fromJSON(armFile());
    const sk = new Skeleton(data);
    const state = new AnimationState(data);
    state.setAnimation(0, 'grow', false);
    state.update(0.75);
    state.apply(sk);
    close(sk.channels[data.boneChannel(data.findBone('lower'), 3)], 1.75);
    const [r, g, b, a] = sk.slotColor(1);
    close(r, 0.25);
    close(g, 0.25);
    close(b, 0.25);
    close(a, 1);
    expect(sk.attachments[1]).toBe(data.findAttachment(1, 'fist'));
  });

  it('crossfades between animations and returns unkeyed channels to setup', () => {
    const data = SkeletonData.fromJSON(armFile());
    const sk = new Skeleton(data);
    const state = new AnimationState(data);
    state.defaultMix = 1;
    state.setAnimation(0, 'swing', true);
    state.update(1); // upper rotate = 90 (stepped key at t=1)
    state.setAnimation(0, 'grow', false);
    state.update(0.5); // halfway through the mix; swing is at t=1.5 -> 90
    state.apply(sk);
    close(sk.channels[data.boneChannel(data.findBone('upper'), 0)], 45); // 90 -> setup 0
    close(sk.channels[data.boneChannel(data.findBone('lower'), 3)], 1.25); // setup 1 -> 1.5, half mixed
    state.update(0.6);
    expect(state.getCurrent(0)!.mixingFrom).toBeNull();
    state.apply(sk);
    close(sk.channels[data.boneChannel(data.findBone('upper'), 0)], 0);
  });

  it('fires events once per loop, plus complete on every loop', () => {
    const data = SkeletonData.fromJSON(armFile());
    const state = new AnimationState(data);
    const events: string[] = [];
    state.addListener({
      event: (_e, ev: EventData) => events.push(ev.name),
      complete: () => events.push('complete'),
    });
    state.setAnimation(0, 'swing', true);
    for (let i = 0; i < 50; i++) state.update(0.1); // 5 seconds = 2.5 loops of 2s
    expect(events).toEqual(['start', 'mid', 'complete', 'start', 'mid', 'complete', 'start', 'mid']);
  });

  it('passes event payloads through', () => {
    const data = SkeletonData.fromJSON(armFile());
    const state = new AnimationState(data);
    let payload: unknown;
    state.addListener({ event: (_e, ev) => ev.name === 'mid' && (payload = ev.payload) });
    state.setAnimation(0, 'swing', false);
    state.update(1);
    expect(payload).toEqual({ strength: 2 });
  });

  it('starts queued animations when the previous one ends', () => {
    const data = SkeletonData.fromJSON(armFile());
    const state = new AnimationState(data);
    state.defaultMix = 0;
    const started: string[] = [];
    state.addListener({ start: (e) => started.push(e.animation.name) });
    state.setAnimation(0, 'grow', false);
    state.addAnimation(0, 'swing', true);
    state.update(0.9);
    expect(state.getCurrent(0)!.animation.name).toBe('grow');
    state.update(0.2);
    expect(state.getCurrent(0)!.animation.name).toBe('swing');
    close(state.getCurrent(0)!.trackTime, 0.1);
    expect(started).toEqual(['grow', 'swing']);
  });

  it('layers a higher track over a lower one and fades out with an empty animation', () => {
    const data = SkeletonData.fromJSON(armFile());
    const sk = new Skeleton(data);
    const state = new AnimationState(data);
    const upperRot = data.boneChannel(data.findBone('upper'), 0);
    const lowerScale = data.boneChannel(data.findBone('lower'), 3);
    state.setAnimation(0, 'swing', true);
    state.setAnimation(1, 'grow', false);
    state.update(0.5);
    state.apply(sk);
    close(sk.channels[upperRot], 45); // from track 0
    close(sk.channels[lowerScale], 1.5); // from track 1
    state.setEmptyAnimation(1, 1);
    state.update(0.5);
    state.apply(sk);
    close(sk.channels[lowerScale], 1.5); // grow held at its end (2) mixed halfway to setup (1)
    state.update(0.6);
    expect(state.getCurrent(1)).toBeNull();
  });

  it('drives IK mix and targets from animations', () => {
    const data = SkeletonData.fromJSON(armFile());
    const sk = new Skeleton(data);
    const state = new AnimationState(data);
    state.setAnimation(0, 'reach', true);
    state.update(0.1);
    state.apply(sk);
    sk.updateWorldTransform();
    const [x, y] = sk.boneWorldTip(data.findBone('lower'));
    close(x, 70, 1e-2);
    close(y, 40, 1e-2);
  });
});

describe('bend test', () => {
  it('passes a well-weighted mesh and catches folding weights', () => {
    const good = SkeletonData.fromJSON(armFile());
    const report = bendTest(good, { angles: [45], stress: [] });
    expect(report.tested.map((t) => t.control)).toContain('lower');
    expect(report.ok).toBe(true);

    // Scrambled weights: the top and bottom edges follow different bones, so the strip tears.
    const f = armFile();
    const strip = f.attachments.strip.strip as any;
    strip.weights = [[0, 1], [1, 1], [0, 1], [1, 1], [0, 1], [1, 1]];
    const bad = bendTest(SkeletonData.fromJSON(f), { angles: [45], stress: [] });
    expect(bad.ok).toBe(false);
    expect(bad.issues[0].message).toMatch(/fold over/);
  });

  it('checks IK chains by moving their targets', () => {
    const f = armFile();
    f.ik![0].mix = 1;
    const report = bendTest(SkeletonData.fromJSON(f));
    expect(report.tested.find((t) => t.control === 'arm_ik')?.poses).toEqual(
      expect.arrayContaining(['crouch 20%', 'swing -20°', 'swing +20°']),
    );
  });

  it('turns one-bone aim IK by moving its target around the joint', () => {
    const f = armFile();
    f.ik = [{ name: 'aim', bones: ['lower'], target: 'target', mix: 1 }];
    delete f.animations.reach;
    const data = SkeletonData.fromJSON(f);
    const report = bendTest(data, { stress: [] });
    expect(report.tested.find((t) => t.control === 'aim')?.poses).toEqual(['aim -45°', 'aim +45°']);
    expect(report.tested.some((t) => t.control === 'lower')).toBe(false);
    expect(report.ok).toBe(true);
    // The pose really turns the bone by that much.
    const pose = bendPoses(data).find((p) => p.control === 'aim' && p.pose === 'aim +45°')!;
    const sk = new Skeleton(data);
    pose.apply(sk);
    sk.updateWorldTransform();
    close(sk.boneWorldRotation(data.findBone('lower')), 45, 1e-6);
    // Weights that tear when the joint turns are caught through the aim too.
    const strip = f.attachments.strip.strip as any;
    strip.weights = [[0, 1], [1, 1], [0, 1], [1, 1], [0, 1], [1, 1]];
    const bad = bendTest(SkeletonData.fromJSON(f), { stress: [] });
    expect(bad.ok).toBe(false);
    expect(bad.issues[0]).toMatchObject({ control: 'aim' });
  });
});
