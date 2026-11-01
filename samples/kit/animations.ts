/**
 * Kit's animations, written against the bone names produced by rig.json. Passed to the rig
 * build with `--animations samples/kit/animations.ts`.
 */
import type { L2DAnimation, L2DValueKey } from '../../packages/core/src/index.ts';

const sine = 'easeInOutSine';

/**
 * Seamless looping sway v(t) = amp * sin(2π (t - lag) / period) over one period, as keys at
 * the extremes. Increasing `lag` along a chain makes motion travel down it (tails, ears).
 */
function sway(amp: number, period: number, lag = 0): L2DValueKey[] {
  const v = (t: number) => amp * Math.sin((2 * Math.PI * (t - lag)) / period);
  const extremes = [lag + period / 4, lag + (3 * period) / 4]
    .map((t) => ((t % period) + period) % period)
    .filter((t) => t > 1e-6 && t < period - 1e-6)
    .sort((a, b) => a - b);
  const r = (x: number) => Math.round(x * 1000) / 1000;
  return [
    { time: 0, value: r(v(0)), curve: 'easeOutSine' },
    ...extremes.map((t, i) => ({ time: r(t), value: r(v(t)), curve: i === extremes.length - 1 ? 'easeInSine' : sine })),
    { time: period, value: r(v(period)) },
  ];
}

/** A chain swaying with the motion travelling from root to tip. */
function chainSway(prefix: string, count: number, amp: number, growth: number, period: number, lagStep: number) {
  return Object.fromEntries(
    Array.from({ length: count }, (_, i) => [`${prefix}${i + 1}`, { rotate: sway(amp + growth * i, period, lagStep * i) }]),
  );
}

const idle: L2DAnimation = {
  bones: {
    hip: { translate: [{ time: 0, y: 0, curve: sine }, { time: 1.2, y: 4, curve: sine }, { time: 2.4, y: 0 }] },
    torso: { rotate: sway(-1.2, 2.4) },
    head: { rotate: sway(2.5, 2.4, 0.2) },
    upper_arm_l: { rotate: sway(2, 2.4, 0.3) },
    upper_arm_r: { rotate: sway(-2, 2.4, 0.3) },
    ...chainSway('tail', 4, 3, 2, 2.4, 0.18),
    ...chainSway('scarf', 2, 3, 2, 2.4, 0.35),
    ear_l2: { rotate: [{ time: 0, value: 0 }, { time: 1.6, value: 0, curve: 'easeOutQuad' }, { time: 1.7, value: -14, curve: 'easeOutBack' }, { time: 1.95, value: 0 }] },
  },
};

const blink: L2DAnimation = {
  duration: 0.2,
  slots: { eyes: { attachment: [{ time: 0, name: 'eyes_closed' }, { time: 0.12, name: 'eyes' }] } },
};

const talk: L2DAnimation = {
  bones: {
    head: { rotate: [{ time: 0, value: 0, curve: sine }, { time: 0.15, value: 2, curve: sine }, { time: 0.3, value: 0, curve: sine }, { time: 0.45, value: -1.5, curve: sine }, { time: 0.6, value: 0 }] },
    neck: { scale: [{ time: 0, x: 1, curve: sine }, { time: 0.15, x: 1.04, curve: sine }, { time: 0.3, x: 1, curve: sine }, { time: 0.45, x: 1.03, curve: sine }, { time: 0.6, x: 1 }] },
  },
  slots: {
    mouth: {
      attachment: [
        { time: 0, name: 'mouth_open' },
        { time: 0.12, name: 'mouth' },
        { time: 0.24, name: 'mouth_open' },
        { time: 0.42, name: 'mouth' },
      ],
    },
  },
};

const wave: L2DAnimation = {
  bones: {
    // The arm layer sits behind the head, so the wave stays out to the side where it is visible.
    upper_arm_r: {
      rotate: [
        { time: 0, value: 0, curve: 'easeOutBack' },
        { time: 0.4, value: -105 },
        { time: 1.9, value: -105, curve: 'easeInOutQuad' },
        { time: 2.4, value: 0 },
      ],
    },
    forearm_r: {
      rotate: [
        { time: 0, value: 0, curve: sine },
        { time: 0.4, value: -15, curve: sine },
        { time: 0.65, value: -38, curve: sine },
        { time: 0.9, value: 8, curve: sine },
        { time: 1.15, value: -38, curve: sine },
        { time: 1.4, value: 8, curve: sine },
        { time: 1.65, value: -38, curve: sine },
        { time: 1.9, value: -15, curve: sine },
        { time: 2.4, value: 0 },
      ],
    },
    hand_r: { rotate: [{ time: 0.4, value: 0, curve: sine }, { time: 0.65, value: -20, curve: sine }, { time: 0.9, value: 15, curve: sine }, { time: 1.15, value: -20, curve: sine }, { time: 1.4, value: 15, curve: sine }, { time: 1.65, value: -20, curve: sine }, { time: 1.9, value: 0 }] },
    torso: { rotate: [{ time: 0, value: 0, curve: sine }, { time: 0.4, value: -3 }, { time: 1.9, value: -3, curve: sine }, { time: 2.4, value: 0 }] },
    head: { rotate: [{ time: 0, value: 0, curve: sine }, { time: 0.45, value: 7, curve: sine }, { time: 1.2, value: 4, curve: sine }, { time: 1.9, value: 7, curve: sine }, { time: 2.4, value: 0 }] },
    ear_r2: { rotate: [{ time: 0.3, value: 0, curve: 'easeOutQuad' }, { time: 0.45, value: 16, curve: 'easeOutBack' }, { time: 0.8, value: 0 }] },
    ...chainSway('tail', 4, 6, 4, 0.8, 0.07),
  },
  slots: {
    mouth: { attachment: [{ time: 0.2, name: 'mouth_open' }, { time: 2.1, name: 'mouth' }] },
  },
  events: [{ time: 0.4, name: 'wave' }],
};

// Jump for joy. The legs are straight at setup, so the feet rise with the hip's timing (and
// a bit more at the apex to tuck the knees); otherwise the IK chain could not reach them.
const footJump = [
  { time: 0, y: 0 },
  { time: 0.25, y: 0, curve: 'easeOutQuad' },
  { time: 0.6, y: -70, curve: 'easeInQuad' },
  { time: 0.92, y: 0 },
];
const flop = (sign: number, delay = 0) => [
  { time: 0, value: 0, curve: sine },
  { time: 0.25 + delay, value: sign * 10, curve: 'easeOutQuad' },
  { time: 0.6 + delay, value: sign * -16, curve: 'easeInQuad' },
  { time: 0.95 + delay, value: sign * 24, curve: 'easeOutBack' },
  { time: 1.3 + delay, value: 0 },
];
const cheer: L2DAnimation = {
  bones: {
    hip: {
      translate: [
        { time: 0, y: 0, curve: 'easeOutQuad' },
        { time: 0.25, y: 16, curve: 'easeOutQuad' },
        { time: 0.6, y: -60, curve: 'easeInQuad' },
        { time: 0.92, y: 0, curve: 'easeOutQuad' },
        { time: 1.06, y: 10, curve: sine },
        { time: 1.6, y: 0 },
      ],
    },
    foot_l_ik: { translate: footJump },
    foot_r_ik: { translate: footJump },
    torso: {
      scale: [
        { time: 0, x: 1, y: 1, curve: sine },
        { time: 0.25, x: 0.94, y: 1.04, curve: 'easeOutQuad' },
        { time: 0.45, x: 1.05, y: 0.97, curve: sine },
        { time: 0.92, x: 1, y: 1, curve: 'easeOutQuad' },
        { time: 1.05, x: 0.95, y: 1.03, curve: sine },
        { time: 1.35, x: 1, y: 1 },
      ],
    },
    upper_arm_l: {
      rotate: [
        { time: 0, value: 0, curve: 'easeOutQuad' },
        { time: 0.25, value: -10, curve: 'easeOutBack' },
        { time: 0.55, value: 128 },
        { time: 1.0, value: 128, curve: sine },
        { time: 1.35, value: 8, curve: sine },
        { time: 1.6, value: 0 },
      ],
    },
    upper_arm_r: {
      rotate: [
        { time: 0, value: 0, curve: 'easeOutQuad' },
        { time: 0.25, value: 10, curve: 'easeOutBack' },
        { time: 0.55, value: -128 },
        { time: 1.0, value: -128, curve: sine },
        { time: 1.35, value: -8, curve: sine },
        { time: 1.6, value: 0 },
      ],
    },
    forearm_l: { rotate: [{ time: 0, value: 0, curve: sine }, { time: 0.55, value: 20, curve: sine }, { time: 0.8, value: -10, curve: sine }, { time: 1.0, value: 20, curve: sine }, { time: 1.6, value: 0 }] },
    forearm_r: { rotate: [{ time: 0, value: 0, curve: sine }, { time: 0.55, value: -20, curve: sine }, { time: 0.8, value: 10, curve: sine }, { time: 1.0, value: -20, curve: sine }, { time: 1.6, value: 0 }] },
    head: { rotate: [{ time: 0, value: 0, curve: sine }, { time: 0.25, value: 3, curve: sine }, { time: 0.6, value: -3, curve: sine }, { time: 1.05, value: 2, curve: sine }, { time: 1.6, value: 0 }] },
    ear_l1: { rotate: flop(-0.5) },
    ear_l2: { rotate: flop(-1, 0.05) },
    ear_r1: { rotate: flop(0.5) },
    ear_r2: { rotate: flop(1, 0.05) },
    tail1: { rotate: flop(0.4) },
    tail2: { rotate: flop(0.6, 0.04) },
    tail3: { rotate: flop(0.8, 0.08) },
    tail4: { rotate: flop(1, 0.12) },
    scarf1: { rotate: flop(-0.8, 0.03) },
    scarf2: { rotate: flop(-1, 0.08) },
  },
  slots: {
    eyes: { attachment: [{ time: 0, name: 'eyes_closed' }, { time: 1.4, name: 'eyes' }] },
    mouth: { attachment: [{ time: 0, name: 'mouth_open' }, { time: 1.4, name: 'mouth' }] },
  },
  events: [
    { time: 0.3, name: 'jump' },
    { time: 0.92, name: 'land' },
  ],
};

export const animations: Record<string, L2DAnimation> = { idle, blink, talk, wave, cheer };
