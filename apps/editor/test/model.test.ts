import { describe, expect, it } from 'vitest';
import { AnimationState, Skeleton, SkeletonData, validate, type L2DAnimation, type L2DFile } from '@llm2d/core';
import {
  History,
  boneKeyFromPose,
  copyKeys,
  deleteKeys,
  getKey,
  keysOf,
  lengthOf,
  moveKeys,
  pasteKeys,
  setCurve,
  setKey,
  slotKeyFromPose,
  snap,
  timelineRows,
  tracksWithKeys,
  type KeyRef,
  type Track,
} from '../src/lib/model.ts';

const file = (): L2DFile => ({
  format: 'llm2d',
  version: '0.1',
  name: 't',
  images: { box: { path: 'box.png', width: 10, height: 10 } },
  bones: [{ name: 'root' }, { name: 'arm', parent: 'root', x: 5, rotation: 30, length: 20 }, { name: 'target', parent: 'root', x: 40 }],
  slots: [{ name: 'hand', bone: 'arm', attachment: 'box' }],
  attachments: { hand: { box: { type: 'region', image: 'box', x: 20, y: 0 }, fist: { type: 'region', image: 'box', x: 20, y: 0, scaleX: 0.5 } } },
  ik: [{ name: 'aim', bones: ['arm'], target: 'target', mix: 0 }],
  animations: {},
});

const rot: Track = { group: 'bones', target: 'arm', channel: 'rotate' };
const ref = (t: Track, time: number) => ({ ...t, time }) as KeyRef;

describe('editing model', () => {
  it('adds, replaces and sorts keys, keeping the curve of a replaced key', () => {
    const a: L2DAnimation = {};
    setKey(a, rot, { time: 1, value: 10 });
    setKey(a, rot, { time: 0, value: 0, curve: 'easeOutBack' });
    setKey(a, rot, { time: 0, value: 5 });
    expect(keysOf(a, rot)).toEqual([
      { time: 0, value: 5, curve: 'easeOutBack' },
      { time: 1, value: 10 },
    ]);
    expect(lengthOf(a)).toBe(1);
    expect(validate({ ...file(), animations: { a } }).ok).toBe(true);
  });

  it('moves keys in time, overwriting keys at the destination, and clamps at zero', () => {
    const a: L2DAnimation = {};
    for (const [t, v] of [[0, 0], [0.5, 1], [1, 2]]) setKey(a, rot, { time: t, value: v });
    const moved = moveKeys(a, [ref(rot, 0.5)], 0.5);
    expect(moved).toEqual([ref(rot, 1)]);
    expect(keysOf(a, rot).map((k) => [k.time, k.value])).toEqual([[0, 0], [1, 1]]);
    const back = moveKeys(a, [ref(rot, 1)], -5);
    expect(back[0].time).toBe(0);
    expect(keysOf(a, rot)).toHaveLength(1);
  });

  it('deletes keys and prunes empty timelines', () => {
    const a: L2DAnimation = {};
    setKey(a, rot, { time: 0, value: 1 });
    setKey(a, { group: 'slots', target: 'hand', channel: 'alpha' }, { time: 0.2, value: 0.5 });
    deleteKeys(a, [ref(rot, 0)]);
    expect(a.bones).toBeUndefined();
    expect(tracksWithKeys(a)).toEqual([{ group: 'slots', target: 'hand', channel: 'alpha' }]);
  });

  it('sets curves (linear removes the field) and ignores attachment keys', () => {
    const a: L2DAnimation = {};
    setKey(a, rot, { time: 0, value: 0 });
    setCurve(a, [ref(rot, 0)], [0.2, 0, 0.8, 1]);
    expect(getKey(a, ref(rot, 0))!.curve).toEqual([0.2, 0, 0.8, 1]);
    setCurve(a, [ref(rot, 0)], 'linear');
    expect(getKey(a, ref(rot, 0))!.curve).toBeUndefined();
    const att: Track = { group: 'slots', target: 'hand', channel: 'attachment' };
    setKey(a, att, { time: 0, name: 'fist' });
    setCurve(a, [ref(att, 0)], 'easeInQuad');
    expect(getKey(a, ref(att, 0))!.curve).toBeUndefined();
  });

  it('keeps events that share a time', () => {
    const a: L2DAnimation = {};
    const ev: Track = { group: 'events', target: '', channel: 'events' };
    setKey(a, ev, { time: 0.5, name: 'land' });
    setKey(a, ev, { time: 0.5, name: 'sfx', sound: 'thud' });
    expect(a.events).toHaveLength(2);
    moveKeys(a, [ref(ev, 0.5)], 0.25);
    expect(a.events!.map((e) => e.time)).toEqual([0.75, 0.75]);
  });

  it('moves events that share a time once, and pastes keys whole (curve included)', () => {
    const a: L2DAnimation = {};
    const ev: Track = { group: 'events', target: '', channel: 'events' };
    setKey(a, ev, { time: 0.5, name: 'land' });
    setKey(a, ev, { time: 0.5, name: 'sfx' });
    const moved = moveKeys(a, [ref(ev, 0.5), ref(ev, 0.5)], 0.25);
    expect(moved).toEqual([ref(ev, 0.75)]);
    expect(copyKeys(a, [...moved, ...moved])!.items).toHaveLength(2);
    setKey(a, rot, { time: 1, value: 1, curve: 'easeOutBack' });
    pasteKeys(a, { items: [{ track: rot, key: { time: 0, value: 5 } }] }, 1);
    expect(getKey(a, ref(rot, 1))).toEqual({ time: 1, value: 5 });
  });

  it('copies and pastes keys relative to the earliest one', () => {
    const a: L2DAnimation = {};
    setKey(a, rot, { time: 0.2, value: 1, curve: 'easeInSine' });
    setKey(a, rot, { time: 0.4, value: 2 });
    const clip = copyKeys(a, [ref(rot, 0.2), ref(rot, 0.4)])!;
    const pasted = pasteKeys(a, clip, 1);
    expect(pasted.map((p) => p.time)).toEqual([1, 1.2]);
    expect(getKey(a, ref(rot, 1))).toEqual({ time: 1, value: 1, curve: 'easeInSine' });
  });

  it('snaps to frames', () => {
    expect(snap(0.51, 30)).toBe(0.5);
    expect(snap(0.52, 30)).toBe(0.5333);
    expect(snap(-1, 30)).toBe(0);
  });

  it('turns the current pose into keys relative to setup', () => {
    const data = SkeletonData.fromJSON(file());
    const sk = new Skeleton(data);
    sk.setBoneLocal('arm', { rotation: 75, x: 8, scaleX: 2 });
    expect(boneKeyFromPose(data, sk, 'arm', 'rotate', 0.5)).toEqual({ time: 0.5, value: 45 });
    expect(boneKeyFromPose(data, sk, 'arm', 'translate', 0.5)).toEqual({ time: 0.5, x: 3, y: 0 });
    expect(boneKeyFromPose(data, sk, 'arm', 'scale', 0.5)).toEqual({ time: 0.5, x: 2, y: 1 });
    sk.attachments[0] = data.findAttachment(0, 'fist');
    expect(slotKeyFromPose(data, sk, 'hand', 'attachment', 0)).toEqual({ time: 0, name: 'fist' });
    expect(slotKeyFromPose(data, sk, 'hand', 'color', 0)).toEqual({ time: 0, value: 'ffffffff' });

    // A key written from the pose plays back as that pose.
    const anim: L2DAnimation = {};
    setKey(anim, rot, boneKeyFromPose(data, sk, 'arm', 'rotate', 0));
    data.setAnimation('edit', anim);
    const fresh = new Skeleton(data);
    const state = new AnimationState(data);
    state.setAnimation(0, 'edit', false);
    state.apply(fresh);
    expect(fresh.channels[data.boneChannel(data.findBone('arm'), 0)]).toBeCloseTo(75);
  });

  it('lists timeline rows: events, keyed or selected bones, expanded channels, slots, IK', () => {
    const data = SkeletonData.fromJSON(file());
    const a: L2DAnimation = {};
    setKey(a, rot, { time: 0, value: 1 });
    const rows = timelineRows(a, data, { expanded: new Set(['bone/arm']), showAll: false, selectedBone: 'target' });
    expect(rows.map((r) => r.id)).toEqual(['events', 'bone/arm', 'bone/arm/rotate', 'bone/arm/translate', 'bone/arm/scale', 'bone/target']);
    expect(rows[1].tracks).toEqual([rot]);
    const all = timelineRows(a, data, { expanded: new Set(), showAll: true });
    expect(all.map((r) => r.id)).toEqual(['events', 'bone/root', 'bone/arm', 'bone/target', 'slot/hand', 'ik/aim']);
  });

  it('undoes and redoes snapshots', () => {
    const h = new History();
    h.push('a');
    h.push('b');
    expect(h.undo('c')).toBe('b');
    expect(h.undo('b')).toBe('a');
    expect(h.undo('a')).toBeNull();
    expect(h.redo('a')).toBe('b');
    h.push('x');
    expect(h.canRedo).toBe(false);
    h.push('y');
    h.dropLast();
    expect(h.undo('z')).toBe('x');
  });
});
