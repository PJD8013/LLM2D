/**
 * Kit's animations for the fox split from one flat picture. A flat picture has no hidden
 * "eyes closed" / "mouth open" art, so attachment swaps are dropped and blinking squashes the
 * eyes on their own bone instead. Passed to the rig build with --animations.
 */
import type { L2DAnimation } from '../../packages/core/src/index.ts';
import { animations as kit } from '../kit/animations.ts';

/** A copy of an animation without slot attachment keys (art the flat picture does not have). */
function withoutSwaps(anim: L2DAnimation): L2DAnimation {
  const slots = Object.fromEntries(
    Object.entries(anim.slots ?? {})
      .map(([slot, timelines]) => [slot, Object.fromEntries(Object.entries(timelines).filter(([kind]) => kind !== 'attachment'))])
      .filter(([, timelines]) => Object.keys(timelines).length),
  );
  const { slots: _drop, ...rest } = anim;
  return Object.keys(slots).length ? { ...rest, slots } : rest;
}

/** Eyes squash shut and open again around the eye line. */
const squash = (start: number) => [
  { time: start, y: 1, curve: 'easeInQuad' },
  { time: start + 0.06, y: 0.12, curve: 'linear' },
  { time: start + 0.12, y: 0.12, curve: 'easeOutQuad' },
  { time: start + 0.2, y: 1 },
];

const blink: L2DAnimation = { duration: 0.2, bones: { eyes: { scale: squash(0) } } };

const cheer = withoutSwaps(kit.cheer);
cheer.bones = { ...cheer.bones, eyes: { scale: [{ time: 0, y: 0.12 }, { time: 1.4, y: 0.12, curve: 'easeOutQuad' }, { time: 1.55, y: 1 }] } };

export const animations: Record<string, L2DAnimation> = {
  idle: kit.idle,
  blink,
  wave: withoutSwaps(kit.wave),
  cheer,
};
