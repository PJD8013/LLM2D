import { describe, expect, it } from 'vitest';
import { AnimationState, Skeleton, SkeletonData, validate, type L2DAnimation, type L2DFile, type TrackEntry } from '../src/index.ts';
import { armFile } from './fixtures.ts';

const close = (a: number, b: number, eps = 1e-3) => expect(Math.abs(a - b)).toBeLessThan(eps);

/** A small skeleton (bone `a`, slots s1/s2) with the given animations. */
function file(animations: Record<string, L2DAnimation>): L2DFile {
  return {
    format: 'llm2d',
    version: '0.1',
    name: 't',
    images: { box: { path: 'box.png', width: 10, height: 10 } },
    bones: [{ name: 'root' }, { name: 'a', parent: 'root', length: 10 }],
    slots: [
      { name: 's1', bone: 'a', attachment: 'one' },
      { name: 's2', bone: 'a', attachment: 'one' },
    ],
    attachments: {
      s1: { one: { type: 'region', image: 'box', x: 5, y: 0 }, two: { type: 'region', image: 'box', x: 5, y: 0, scaleX: 2 } },
      s2: { one: { type: 'region', image: 'box', x: 5, y: 0 } },
    },
    animations,
  };
}

const spin: L2DAnimation = { bones: { a: { rotate: [{ time: 0, value: 0 }, { time: 1, value: 90 }] } } };

/** Records listener calls as "type name" strings. */
function record(state: AnimationState) {
  const log: string[] = [];
  state.addListener({
    start: (e) => log.push(`start ${e.animation.name}`),
    interrupt: (e) => log.push(`interrupt ${e.animation.name}`),
    end: (e) => log.push(`end ${e.animation.name}`),
    complete: (e) => log.push(`complete ${e.animation.name}`),
    event: (_e, ev) => log.push(`event ${ev.name}`),
  });
  return log;
}

const steps = (state: AnimationState, n: number, dt = 1 / 60) => {
  for (let i = 0; i < n; i++) state.update(dt);
};

describe('animation state', () => {
  it('finishes the current loop and completes once when looping is switched off', () => {
    const state = new AnimationState(SkeletonData.fromJSON(file({ spin })));
    const e = state.setAnimation(0, 'spin', true);
    steps(state, 150); // 2.5 loops
    const log = record(state);
    e.loop = false;
    close(e.animationTime, 0.5, 0.02); // no jump to the last frame
    steps(state, 120);
    expect(log).toEqual(['complete spin']);
    expect(e.isComplete).toBe(true);
    close(e.animationTime, 1);
    // Setting trackTime seeks (a viewer scrubbing the timeline), as in spine.
    e.trackTime = 0.25;
    close(e.animationTime, 0.25);
    expect(e.isComplete).toBe(false);
    e.trackTime = 1;
    close(e.animationTime, 1);
    expect(e.isComplete).toBe(true);
  });

  it('fires an event keyed at the end of a looping animation on every loop', () => {
    const state = new AnimationState(SkeletonData.fromJSON(file({ beat: { ...spin, events: [{ time: 1, name: 'drum' }] } })));
    const log = record(state);
    state.setAnimation(0, 'beat', true);
    steps(state, 30, 0.1); // 3 loops
    expect(log.filter((l) => l === 'event drum')).toHaveLength(3);
    expect(log.indexOf('event drum')).toBeLessThan(log.indexOf('complete beat'));
  });

  it('fires the events of an animation that has no length', () => {
    const state = new AnimationState(SkeletonData.fromJSON(file({ cue: { events: [{ time: 0, name: 'sound' }] } })));
    const log = record(state);
    state.setAnimation(0, 'cue', false);
    steps(state, 3);
    expect(log).toEqual(['start cue', 'event sound', 'complete cue']);
  });

  it('shows the last stepped and attachment keys at the end, whatever the float rounding', () => {
    const data = SkeletonData.fromJSON(
      file({
        land: {
          slots: {
            s2: { alpha: [{ time: 0, value: 1, curve: 'stepped' }, { time: 0.3, value: 0 }] },
            s1: { attachment: [{ time: 0, name: 'one' }, { time: 1.1, name: 'two' }] },
          },
          bones: { a: { rotate: [{ time: 0, value: 0, curve: 'stepped' }, { time: 0.6, value: 90 }] } },
        },
      }),
    );
    const sk = new Skeleton(data);
    const state = new AnimationState(data);
    state.setAnimation(0, 'land', false);
    state.update(5);
    state.apply(sk);
    expect(sk.slotColor(1)[3]).toBe(0);
    expect(sk.attachments[0]).toBe(data.findAttachment(0, 'two'));
    close(sk.channels[data.boneChannel(data.findBone('a'), 0)], 90);
  });

  it('plays animations queued after an empty one, and after the current loop', () => {
    const state = new AnimationState(SkeletonData.fromJSON(file({ spin, land: spin })));
    state.defaultMix = 0;
    state.setEmptyAnimation(0, 0);
    state.addAnimation(0, 'land', false, 1);
    steps(state, 30);
    expect(state.getCurrent(0)?.animation.name).toBe('<empty>');
    steps(state, 40);
    expect(state.getCurrent(0)?.animation.name).toBe('land');

    state.setAnimation(0, 'spin', true);
    state.update(5.3);
    state.addAnimation(0, 'land', false);
    state.update(0.5);
    expect(state.getCurrent(0)?.animation.name).toBe('spin'); // keeps looping until 6.0
    state.update(0.3);
    expect(state.getCurrent(0)?.animation.name).toBe('land');
    close(state.getCurrent(0)!.trackTime, 0.1);
  });

  it('lets listeners change the track: no recursion, one end per entry', () => {
    const state = new AnimationState(SkeletonData.fromJSON(file({ spin, land: spin, idle: spin, win: spin })));
    state.defaultMix = 0;
    const land = state.setAnimation(0, 'land', false);
    land.listener = { end: () => state.setAnimation(0, 'idle', true) };
    const log = record(state);
    state.setAnimation(0, 'win', true);
    expect(state.getCurrent(0)?.animation.name).toBe('idle');
    expect(log).toEqual(['interrupt land', 'end land', 'start win', 'interrupt win', 'end win', 'start idle']);

    // A complete listener switching animations while a queued entry takes over.
    state.setAnimation(0, 'land', false);
    state.addAnimation(0, 'idle', true);
    let switched = false;
    state.addListener({ complete: (e) => e.animation.name === 'land' && !switched && ((switched = true), state.setAnimation(0, 'win', true)) });
    log.length = 0;
    state.update(1.1);
    expect(state.getCurrent(0)?.animation.name).toBe('win');
    expect(log.filter((l) => l === 'end land')).toHaveLength(1);
    expect(log.filter((l) => l === 'end idle')).toHaveLength(1);

    // clearTracks from a complete listener while mixing ends each entry once.
    const s2 = new AnimationState(SkeletonData.fromJSON(file({ land: spin, idle: spin })));
    s2.defaultMix = 0.5;
    s2.setAnimation(0, 'land', false);
    s2.update(0.8);
    s2.setAnimation(0, 'idle', true);
    s2.addListener({ complete: () => s2.clearTracks() });
    const log2 = record(s2);
    s2.update(0.3);
    expect(log2.filter((l) => l.startsWith('end')).sort()).toEqual(['end idle', 'end land']);
    expect(s2.getCurrent(0)).toBeNull();
  });

  it('calls every listener even when one removes itself', () => {
    const state = new AnimationState(SkeletonData.fromJSON(file({ spin })));
    const calls: string[] = [];
    const first = { complete: () => (calls.push('first'), state.removeListener(first)) };
    state.addListener(first);
    state.addListener({ complete: () => calls.push('second') });
    state.setAnimation(0, 'spin', false);
    state.update(2);
    expect(calls).toEqual(['first', 'second']);
  });

  it('crossfades in real time, also into a paused entry; negative speeds count as 0', () => {
    const data = SkeletonData.fromJSON(file({ spin, hold: { bones: { a: { rotate: [{ time: 0, value: 40 }] } } } }));
    const sk = new Skeleton(data);
    const state = new AnimationState(data);
    state.defaultMix = 0.5;
    state.setAnimation(0, 'spin', true);
    state.update(0.5);
    const hold: TrackEntry = state.setAnimation(0, 'hold', false);
    hold.timeScale = 0;
    state.update(0.6);
    expect(hold.mixingFrom).toBeNull();
    state.apply(sk);
    close(sk.channels[data.boneChannel(data.findBone('a'), 0)], 40);

    const e = state.setAnimation(0, 'spin', true);
    state.update(0.6);
    e.timeScale = -1;
    state.update(1);
    expect(state.getCurrent(0)).toBe(e);
    close(e.trackTime, 0.6);
  });

  it('spreads a vertex whose weights are all 0 over its bones instead of collapsing it', () => {
    const f = armFile();
    const strip = f.attachments.strip.strip as { weights: number[][] };
    strip.weights[2] = [0, 0, 1, 0];
    const sk = new Skeleton(SkeletonData.fromJSON(f));
    const out = new Float32Array(12);
    sk.computeSlotVertices(0, out);
    close(out[4], 100); // vertex 2 stays at (100, -5)
    close(out[5], -5);
  });

  it('solves IK the same way every time, rejects mix keys outside 0..1 and handles a mirrored parent', () => {
    const f = armFile();
    f.ik![0].mix = 0.5;
    f.bones.find((b) => b.name === 'target')!.y = 60;
    const sk = new Skeleton(SkeletonData.fromJSON(f));
    const tips = [0, 1, 2].map(() => {
      sk.updateWorldTransform();
      return sk.boneWorldTip(2);
    });
    expect(tips[1]).toEqual(tips[0]);
    expect(tips[2]).toEqual(tips[0]);

    const bad = armFile();
    bad.animations.reach = { ik: { arm_ik: { mix: [{ time: 0, value: 1.5 }] } } };
    expect(validate(bad).errors.map((e) => e.path)).toContain('animations.reach.ik.arm_ik.mix[0].value');

    const mirrored = armFile();
    mirrored.ik![0].mix = 1;
    const upper = mirrored.bones.find((b) => b.name === 'upper')!;
    upper.scaleX = -1;
    const target = mirrored.bones.find((b) => b.name === 'target')!;
    target.x = -60;
    target.y = 40;
    const m = new Skeleton(SkeletonData.fromJSON(mirrored));
    m.updateWorldTransform();
    const [x, y] = m.boneWorldTip(2);
    close(x, -60, 1e-2);
    close(y, 40, 1e-2);
  });

  it('frames a skeleton whose slots all start transparent', () => {
    const f = file({ spin });
    f.slots.forEach((s) => (s.color = 'ffffff00'));
    const b = SkeletonData.fromJSON(f).bounds;
    expect(b.width).toBeGreaterThan(0);
    expect(b.height).toBeGreaterThan(0);
  });

  it('plays no events of an animation that is fading out, unless asked (eventThreshold)', () => {
    const data = SkeletonData.fromJSON(file({ land: { ...spin, events: [{ time: 0.55, name: 'thud' }] }, idle: spin }));
    const state = new AnimationState(data);
    state.defaultMix = 0.2;
    const log = record(state);
    const land = state.setAnimation(0, 'land', false);
    state.update(0.5);
    state.setAnimation(0, 'idle', true); // just before the thud
    state.update(0.3);
    expect(log).not.toContain('event thud');

    const again = state.setAnimation(0, 'land', false);
    expect(again).not.toBe(land);
    state.update(0.5);
    again.eventThreshold = 1;
    state.setAnimation(0, 'idle', true);
    state.update(0.3);
    expect(log.filter((l) => l === 'event thud')).toHaveLength(1);
    expect(validate(file({ late: { duration: 1, events: [{ time: 1.5, name: 'x' }] } })).warnings.map((w) => w.path)).toContain('animations.late.events[0]');
  });

  it('counts changes for renderers', () => {
    const state = new AnimationState(SkeletonData.fromJSON(file({ spin })));
    const v0 = state.version;
    state.setAnimation(0, 'spin', true);
    const v1 = state.version;
    expect(v1).toBeGreaterThan(v0);
    state.update(0.1);
    expect(state.version).toBeGreaterThan(v1);
  });
});
