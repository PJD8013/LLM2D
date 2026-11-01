import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AnimationState, Skeleton, SkeletonData, validate } from '../src/index.ts';

const root = join(import.meta.dirname, '../../..');
const load = (name: string) => JSON.parse(readFileSync(join(root, 'samples', name, `${name}.l2d.json`), 'utf8'));

describe.each(['bolt', 'gem', 'kit'])('sample %s', (name) => {
  it('validates without errors or warnings', () => {
    const r = validate(load(name));
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it('plays every animation without producing NaN vertices', () => {
    const data = SkeletonData.fromJSON(load(name));
    const sk = new Skeleton(data);
    const state = new AnimationState(data);
    const out = new Float32Array(4096);
    for (const anim of data.animations.values()) {
      state.setAnimation(0, anim.name, true);
      for (let t = 0; t < anim.duration + 0.5; t += 1 / 30) {
        state.update(1 / 30);
        state.apply(sk);
        sk.updateWorldTransform();
        for (let s = 0; s < data.slots.length; s++) {
          const n = sk.computeSlotVertices(s, out);
          for (let i = 0; i < n * 2; i++) expect(Number.isFinite(out[i])).toBe(true);
        }
      }
    }
  });
});

describe('bolt rig', () => {
  it('keeps feet on the IK targets through the cheer jump', () => {
    const data = SkeletonData.fromJSON(load('bolt'));
    const sk = new Skeleton(data);
    const state = new AnimationState(data);
    state.setAnimation(0, 'cheer', false);
    for (let i = 0; i < 48; i++) {
      state.update(1 / 30);
      state.apply(sk);
      sk.updateWorldTransform();
      for (const side of ['l', 'r']) {
        const [ax, ay] = sk.boneWorldTip(data.findBone(`shin_${side}`));
        const [tx, ty] = sk.boneWorldPosition(data.findBone(`foot_${side}_ik`));
        expect(Math.hypot(ax - tx, ay - ty)).toBeLessThan(0.5);
      }
    }
  });
});
