import { Skeleton, type L2DAnimation, type L2DVec2Key, type SkeletonData } from '@llm2d/core';
import { r3, scaleKeys, shift, sine, swayKeys, valueKeys } from './keys.ts';

export type ParamType = 'bone' | 'bones' | 'slot' | 'slots' | 'attachment' | 'number' | 'numbers' | 'boolean';

export interface PresetParam {
  name: string;
  type: ParamType;
  description: string;
  /** Default value; `undefined` + required means the caller must give it. */
  default?: unknown;
  required?: boolean;
  /** For "attachment" params: the slot param whose attachments are allowed. */
  slotParam?: string;
}

export interface Preset {
  name: string;
  category: 'symbol' | 'character' | 'general';
  description: string;
  /** Whether the result is meant to loop seamlessly. */
  loops: boolean;
  params: PresetParam[];
  build(ctx: PresetContext, p: Record<string, any>): L2DAnimation;
}

export interface PresetContext {
  data: SkeletonData;
  /** Setup world angle of a bone, in degrees. */
  worldAngle(bone: string): number;
  /** Bone that carries the biggest visible normal-blend art: a good default for symbols. */
  mainBone(): string;
}

const START: PresetParam = {
  name: 'start',
  type: 'number',
  default: 0,
  description: 'Seconds to delay the motion inside the animation (to place it after other motion).',
};

/** +1 or -1: the rotation direction that lifts a hanging limb outward (away from the body centre). */
function outward(ctx: PresetContext, bone: string): number {
  return ctx.worldAngle(bone) <= 90 ? -1 : 1;
}

const ty = (list: [number, number, string?][]): L2DVec2Key[] =>
  list.map(([time, y, curve]) => ({ time: r3(time), y: r3(y), ...(curve ? { curve } : {}) }));

export const PRESETS: Preset[] = [
  // ---------------- Slot symbols ----------------
  {
    name: 'symbol_idle',
    category: 'symbol',
    loops: true,
    description: 'Gentle floating and breathing for a symbol resting on the reel.',
    params: [
      { name: 'bone', type: 'bone', description: 'Bone to move. Default: the bone of the main art.' },
      { name: 'float', type: 'number', default: 3, description: 'Up/down travel in skeleton units.' },
      { name: 'pulse', type: 'number', default: 0.02, description: 'Scale breathing amount (0.02 = ±2%).' },
      { name: 'period', type: 'number', default: 2.4, description: 'Seconds per loop.' },
      START,
    ],
    build: (ctx, p) => ({
      bones: {
        [p.bone]: {
          translate: swayKeys(p.float, p.period, 0).map((k) => ({ time: k.time, y: k.value, curve: k.curve })),
          // Half a period behind the float, starting (and ending) at rest size.
          ...(p.pulse ? { scale: swayKeys(p.pulse, p.period, p.period / 2).map((k) => ({ time: k.time, x: r3(1 + k.value), y: r3(1 + k.value), curve: k.curve })) } : {}),
        },
      },
    }),
  },
  {
    name: 'symbol_land',
    category: 'symbol',
    loops: false,
    description: 'Reel stop: drops in, squashes on impact and settles with an elastic bounce. Fires event "land".',
    params: [
      { name: 'bone', type: 'bone', description: 'Bone to move. Default: the bone of the main art.' },
      { name: 'drop', type: 'number', default: 40, description: 'Fall distance in skeleton units.' },
      { name: 'squash', type: 'number', default: 0.2, description: 'Squash on impact (0.2 = 20% wider and flatter).' },
      { name: 'duration', type: 'number', default: 0.5, description: 'Seconds.' },
      { name: 'flash', type: 'slot', description: 'Optional additive slot (e.g. a white silhouette) to flash on impact.' },
      START,
    ],
    build: (ctx, p) => {
      const hit = r3(p.duration * 0.24);
      const anim: L2DAnimation = {
        bones: {
          [p.bone]: {
            translate: ty([[0, -p.drop, 'easeInQuad'], [hit, 0]]),
            scale: [
              { time: 0, x: r3(1 - p.squash * 0.4), y: r3(1 + p.squash * 0.5), curve: 'easeInQuad' },
              { time: hit, x: r3(1 + p.squash), y: r3(1 - p.squash), curve: 'easeOutElastic' },
              { time: r3(p.duration), x: 1, y: 1 },
            ],
          },
        },
        events: [{ time: hit, name: 'land' }],
      };
      if (p.flash)
        anim.slots = { [p.flash]: { alpha: valueKeys([[Math.max(0, hit - 0.02), 0, 'easeOutQuad'], [hit + 0.02, 0.35, 'easeOutQuad'], [Math.min(p.duration, hit + p.duration * 0.5), 0]]) } };
      return anim;
    },
  },
  {
    name: 'symbol_win',
    category: 'symbol',
    loops: true,
    description: 'Payline win: punchy scale pulses with a wobble, optional glow, flash and sparkle. Ends at rest so it loops.',
    params: [
      { name: 'bone', type: 'bone', description: 'Bone to move. Default: the bone of the main art.' },
      { name: 'scale', type: 'number', default: 1.2, description: 'Peak scale of the first pulse.' },
      { name: 'wobble', type: 'number', default: 7, description: 'Rotation wobble in degrees.' },
      { name: 'duration', type: 'number', default: 1.2, description: 'Seconds per loop.' },
      { name: 'glow', type: 'slot', description: 'Optional glow slot (additive) to fade in and out.' },
      { name: 'glowBone', type: 'bone', description: 'Optional bone of the glow, to pulse its size.' },
      { name: 'flash', type: 'slot', description: 'Optional additive silhouette slot to flash on the first beat.' },
      { name: 'sparkle', type: 'slot', description: 'Optional sparkle slot to pop.' },
      { name: 'sparkleBone', type: 'bone', description: 'Bone of the sparkle (spins and scales it).' },
      START,
    ],
    build: (ctx, p) => {
      const d = p.duration;
      const s = p.scale;
      const anim: L2DAnimation = {
        bones: {
          [p.bone]: {
            scale: scaleKeys([[0, 1, 'easeOutBack'], [d * 0.21, s, sine], [d * 0.5, 1 + (s - 1) * 0.1, 'easeOutBack'], [d * 0.71, 1 + (s - 1) * 0.6, sine], [d, 1]]),
            rotate: valueKeys([[0, 0, sine], [d * 0.17, -p.wobble, sine], [d * 0.38, p.wobble * 0.85, sine], [d * 0.58, -p.wobble * 0.4, sine], [d * 0.79, p.wobble * 0.3, sine], [d, 0]]),
          },
        },
        slots: {},
      };
      if (p.glow) anim.slots![p.glow] = { alpha: valueKeys([[0, 0, 'easeOutQuad'], [d * 0.25, 0.95, sine], [d * 0.62, 0.45, sine], [d, 0]]) };
      if (p.glowBone) anim.bones![p.glowBone] = { scale: scaleKeys([[0, 0.7, 'easeOutQuad'], [d * 0.25, 1.1, sine], [d * 0.62, 0.9, sine], [d, 0.7]]) };
      if (p.flash) anim.slots![p.flash] = { alpha: valueKeys([[0, 0, 'easeOutQuad'], [d * 0.17, 0.28, 'easeInQuad'], [d * 0.42, 0]]) };
      if (p.sparkle) anim.slots![p.sparkle] = { alpha: valueKeys([[d * 0.12, 0, 'easeOutQuad'], [d * 0.3, 1, 'easeInQuad'], [d * 0.62, 0]]) };
      if (p.sparkleBone)
        anim.bones![p.sparkleBone] = {
          rotate: valueKeys([[d * 0.12, 0], [d * 0.62, 180]]),
          scale: scaleKeys([[d * 0.12, 0, 'easeOutBack'], [d * 0.33, 0.9, 'easeInQuad'], [d * 0.62, 0]]),
        };
      if (!Object.keys(anim.slots!).length) delete anim.slots;
      return anim;
    },
  },
  {
    name: 'shine_sweep',
    category: 'symbol',
    loops: true,
    description:
      'A light streak sweeps across the symbol, then rests out of sight until the loop starts again. Clip the shine layer to the symbol (rig.json parts.<shine>.clip) so only the part over the symbol shows.',
    params: [
      { name: 'bone', type: 'bone', required: true, description: 'Bone of the shine layer; it is moved across.' },
      { name: 'distance', type: 'number', description: 'Travel to each side of the setup position, in skeleton units. Default: from just outside the symbol on one side to just outside on the other.' },
      { name: 'angle', type: 'number', default: 0, description: 'Direction of travel in degrees (0 = left to right, 90 = top to bottom).' },
      { name: 'sweep', type: 'number', default: 0.6, description: 'Seconds the streak takes to cross.' },
      { name: 'duration', type: 'number', default: 1.6, description: 'Seconds per loop (the time after the sweep is a pause).' },
      START,
    ],
    build: (ctx, p) => {
      const a = (p.angle * Math.PI) / 180;
      const ux = Math.cos(a);
      const uy = Math.sin(a);
      let from = -(p.distance ?? 0);
      let to = p.distance ?? 0;
      if (p.distance === undefined) {
        // Along the direction: the shine's own extent and the symbol's (setup pose).
        const data = ctx.data;
        const bone = data.findBone(p.bone);
        let sMin = Infinity;
        let sMax = -Infinity;
        for (const slot of data.slots) {
          if (slot.bone !== bone || slot.attachment < 0) continue;
          const v = data.attachments[slot.index][slot.attachment].vertices;
          for (let i = 0; i < v.length; i += 2) {
            const t = v[i] * ux + v[i + 1] * uy;
            sMin = Math.min(sMin, t);
            sMax = Math.max(sMax, t);
          }
        }
        const b = data.bounds;
        const corners = [b.x * ux + b.y * uy, (b.x + b.width) * ux + b.y * uy, b.x * ux + (b.y + b.height) * uy, (b.x + b.width) * ux + (b.y + b.height) * uy];
        if (sMin === Infinity) [sMin, sMax] = [0, 0];
        from = Math.min(...corners) - sMax;
        to = Math.max(...corners) - sMin;
      }
      const across = r3(Math.min(p.sweep, p.duration));
      const at = (t: number) => ({ x: r3(ux * t), y: r3(uy * t) });
      return {
        duration: r3(p.duration),
        bones: {
          [p.bone]: {
            translate: [
              { time: 0, ...at(from), curve: 'easeInOutSine' },
              // Waits on the far side (clipped away), then jumps back unseen for the next loop.
              { time: across, ...at(to), curve: 'stepped' },
              { time: r3(p.duration), ...at(from) },
            ],
          },
        },
      };
    },
  },
  {
    name: 'anticipation',
    category: 'symbol',
    loops: true,
    description: 'Tension before a big reveal (e.g. a scatter waiting for the last reel): swells and trembles.',
    params: [
      { name: 'bone', type: 'bone', description: 'Bone to move. Default: the bone of the main art.' },
      { name: 'scale', type: 'number', default: 1.08, description: 'Held scale.' },
      { name: 'shake', type: 'number', default: 3, description: 'Tremble in degrees.' },
      { name: 'rate', type: 'number', default: 14, description: 'Trembles per second.' },
      { name: 'duration', type: 'number', default: 1, description: 'Seconds per loop.' },
      START,
    ],
    build: (ctx, p) => {
      const n = Math.max(2, Math.round(p.duration * p.rate));
      const rotate = Array.from({ length: n + 1 }, (_, i) => ({
        time: r3((p.duration * i) / n),
        value: i === 0 || i === n ? 0 : r3((i % 2 ? 1 : -1) * p.shake),
        curve: sine,
      }));
      rotate[n] = { time: r3(p.duration), value: 0 } as (typeof rotate)[number];
      return {
        bones: {
          [p.bone]: {
            rotate,
            scale: scaleKeys([[0, 1, 'easeOutQuad'], [p.duration * 0.3, p.scale, sine], [p.duration * 0.7, p.scale * 1.01, sine], [p.duration, 1]]),
          },
        },
      };
    },
  },
  {
    name: 'big_win_title',
    category: 'symbol',
    loops: false,
    description: 'Title slam for BIG WIN / MEGA WIN banners: crashes in from large, settles with an overshoot, then pulses. Fires event "slam".',
    params: [
      { name: 'bone', type: 'bone', description: 'Bone to move. Default: the bone of the main art.' },
      { name: 'slots', type: 'slots', default: [], description: 'Slots to fade in at the start.' },
      { name: 'from', type: 'number', default: 3, description: 'Starting scale.' },
      { name: 'tilt', type: 'number', default: -10, description: 'Starting tilt in degrees.' },
      { name: 'duration', type: 'number', default: 1.6, description: 'Seconds.' },
      START,
    ],
    build: (ctx, p) => {
      const d = p.duration;
      const hit = r3(d * 0.22);
      const anim: L2DAnimation = {
        bones: {
          [p.bone]: {
            scale: scaleKeys([[0, p.from, 'easeOutBack'], [hit, 1, sine], [d * 0.5, 1.08, sine], [d * 0.75, 1, sine], [d, 1.04]]),
            rotate: valueKeys([[0, p.tilt, 'easeOutBack'], [hit, 0]]),
          },
        },
        events: [{ time: hit, name: 'slam' }],
      };
      if (p.slots.length) anim.slots = Object.fromEntries(p.slots.map((s: string) => [s, { alpha: valueKeys([[0, 0, 'easeOutQuad'], [hit * 0.7, 1]]) }]));
      return anim;
    },
  },
  {
    name: 'pop_in',
    category: 'general',
    loops: false,
    description: 'Appear: scales up from nothing with an overshoot, fading the given slots in.',
    params: [
      { name: 'bone', type: 'bone', description: 'Bone to scale. Default: the bone of the main art.' },
      { name: 'slots', type: 'slots', default: [], description: 'Slots to fade in.' },
      { name: 'duration', type: 'number', default: 0.35, description: 'Seconds.' },
      START,
    ],
    build: (ctx, p) => ({
      bones: { [p.bone]: { scale: scaleKeys([[0, 0, 'easeOutBack'], [p.duration, 1]]) } },
      ...(p.slots.length ? { slots: Object.fromEntries(p.slots.map((s: string) => [s, { alpha: valueKeys([[0, 0, 'easeOutQuad'], [p.duration * 0.6, 1]]) }])) } : {}),
    }),
  },
  {
    name: 'pop_out',
    category: 'general',
    loops: false,
    description: 'Disappear: a small anticipation, then shrinks to nothing, fading the given slots out.',
    params: [
      { name: 'bone', type: 'bone', description: 'Bone to scale. Default: the bone of the main art.' },
      { name: 'slots', type: 'slots', default: [], description: 'Slots to fade out.' },
      { name: 'duration', type: 'number', default: 0.3, description: 'Seconds.' },
      START,
    ],
    build: (ctx, p) => ({
      bones: { [p.bone]: { scale: scaleKeys([[0, 1, sine], [p.duration * 0.3, 1.1, 'easeInBack'], [p.duration, 0]]) } },
      ...(p.slots.length ? { slots: Object.fromEntries(p.slots.map((s: string) => [s, { alpha: valueKeys([[p.duration * 0.4, 1, 'easeInQuad'], [p.duration, 0]]) }])) } : {}),
    }),
  },
  {
    name: 'spin',
    category: 'general',
    loops: false,
    description: 'Full turns around the bone (coins, wheels, bonus symbols).',
    params: [
      { name: 'bone', type: 'bone', description: 'Bone to spin. Default: the bone of the main art.' },
      { name: 'turns', type: 'number', default: 1, description: 'Number of turns; negative spins counter-clockwise.' },
      { name: 'duration', type: 'number', default: 1, description: 'Seconds.' },
      START,
    ],
    build: (ctx, p) => ({ bones: { [p.bone]: { rotate: valueKeys([[0, 0, 'easeInOutCubic'], [p.duration, 360 * p.turns]]) } } }),
  },
  {
    name: 'fade',
    category: 'general',
    loops: false,
    description: 'Fades slots between two alpha values.',
    params: [
      { name: 'slots', type: 'slots', required: true, description: 'Slots to fade.' },
      { name: 'from', type: 'number', default: 0, description: 'Start alpha 0..1.' },
      { name: 'to', type: 'number', default: 1, description: 'End alpha 0..1.' },
      { name: 'duration', type: 'number', default: 0.4, description: 'Seconds.' },
      START,
    ],
    build: (ctx, p) => ({
      slots: Object.fromEntries(p.slots.map((s: string) => [s, { alpha: valueKeys([[0, p.from, sine], [p.duration, p.to]]) }])),
    }),
  },
  {
    name: 'shake',
    category: 'general',
    loops: false,
    description: 'Decaying side-to-side shake (impacts, heavy landings, screen shake on a root bone).',
    params: [
      { name: 'bone', type: 'bone', description: 'Bone to shake. Default: the bone of the main art.' },
      { name: 'amount', type: 'number', default: 6, description: 'Offset in skeleton units.' },
      { name: 'duration', type: 'number', default: 0.5, description: 'Seconds.' },
      { name: 'rate', type: 'number', default: 20, description: 'Shakes per second.' },
      START,
    ],
    build: (ctx, p) => {
      const n = Math.max(2, Math.round(p.duration * p.rate));
      const translate = Array.from({ length: n + 1 }, (_, i) => {
        const decay = 1 - i / n;
        return { time: r3((p.duration * i) / n), x: i === n ? 0 : r3((i % 2 ? 1 : -1) * p.amount * decay), curve: sine };
      });
      return { bones: { [p.bone]: { translate } } };
    },
  },

  // ---------------- Characters ----------------
  {
    name: 'sway',
    category: 'character',
    loops: true,
    description:
      'Secondary motion for chains (tails, ears, hair, scarves, antennae): a sway that travels from the first bone to the last. Loops seamlessly.',
    params: [
      { name: 'bones', type: 'bones', required: true, description: 'Chain bones from root to tip, e.g. ["tail1","tail2","tail3"].' },
      { name: 'amplitude', type: 'number', default: 4, description: 'Degrees at the first bone.' },
      { name: 'growth', type: 'number', default: 2, description: 'Extra degrees per bone toward the tip.' },
      { name: 'period', type: 'number', default: 2.4, description: 'Seconds per loop (use the idle length). Shorter = livelier.' },
      { name: 'lag', type: 'number', default: 0.15, description: 'Delay per bone in seconds; makes the motion travel.' },
      START,
    ],
    build: (ctx, p) => ({
      bones: Object.fromEntries(p.bones.map((b: string, i: number) => [b, { rotate: swayKeys(p.amplitude + p.growth * i, p.period, p.lag * i) }])),
    }),
  },
  {
    name: 'breathe',
    category: 'character',
    loops: true,
    description: 'Idle breathing: the bone bobs down and up (with IK legs this bends the knees slightly).',
    params: [
      { name: 'bone', type: 'bone', required: true, description: 'Usually the hip (whole upper body) or torso.' },
      { name: 'amount', type: 'number', default: 4, description: 'Bob distance in skeleton units (down is positive).' },
      { name: 'period', type: 'number', default: 2.4, description: 'Seconds per loop.' },
      START,
    ],
    build: (ctx, p) => ({ bones: { [p.bone]: { translate: ty([[0, 0, sine], [p.period / 2, p.amount, sine], [p.period, 0]]) } } }),
  },
  {
    name: 'blink',
    category: 'character',
    loops: false,
    description: 'Swaps a slot to closed-eyes art and back. Put it on track 1 over an idle, or bake it into an idle with "times".',
    params: [
      { name: 'slot', type: 'slot', required: true, description: 'Eyes slot.' },
      { name: 'closed', type: 'attachment', slotParam: 'slot', required: true, description: 'Closed-eyes attachment.' },
      { name: 'open', type: 'attachment', slotParam: 'slot', description: "Open-eyes attachment. Default: the slot's setup attachment." },
      { name: 'times', type: 'numbers', default: [0], description: 'When to blink (seconds).' },
      { name: 'length', type: 'number', default: 0.12, description: 'How long the eyes stay shut.' },
      START,
    ],
    build: (ctx, p) => {
      const times = [...(p.times as number[])].sort((a, b) => a - b);
      const keys = times.flatMap((t) => [
        { time: r3(t), name: p.closed },
        { time: r3(t + p.length), name: p.open },
      ]);
      // Eyes open until the first blink (the first key is held before it).
      if (times[0] > 0) keys.unshift({ time: 0, name: p.open });
      return {
        ...(times.length === 1 && times[0] === 0 ? { duration: r3(p.length + 0.08) } : {}),
        slots: { [p.slot]: { attachment: keys } },
      };
    },
  },
  {
    name: 'talk',
    category: 'character',
    loops: true,
    description: 'Mouth flaps for speech, with a small head nod.',
    params: [
      { name: 'slot', type: 'slot', required: true, description: 'Mouth slot.' },
      { name: 'open', type: 'attachment', slotParam: 'slot', required: true, description: 'Open-mouth attachment.' },
      { name: 'closed', type: 'attachment', slotParam: 'slot', description: "Closed-mouth attachment. Default: the slot's setup attachment." },
      { name: 'head', type: 'bone', description: 'Optional head bone to nod.' },
      { name: 'syllables', type: 'number', default: 3, description: 'Mouth openings per loop.' },
      { name: 'duration', type: 'number', default: 0.6, description: 'Seconds per loop.' },
      START,
    ],
    build: (ctx, p) => {
      const n = Math.max(1, Math.round(p.syllables));
      const step = p.duration / n;
      const anim: L2DAnimation = {
        duration: r3(p.duration),
        slots: {
          [p.slot]: {
            attachment: Array.from({ length: n }, (_, i) => [
              { time: r3(i * step), name: p.open },
              { time: r3(i * step + step * (i % 2 ? 0.45 : 0.6)), name: p.closed },
            ]).flat(),
          },
        },
      };
      if (p.head)
        anim.bones = {
          [p.head]: {
            rotate: [
              ...Array.from({ length: n }, (_, i) => ({ time: r3(i * step), value: 0, curve: sine })),
              ...Array.from({ length: n }, (_, i) => ({ time: r3(i * step + step / 2), value: i % 2 ? -1.5 : 2, curve: sine })),
              { time: r3(p.duration), value: 0 },
            ].sort((a, b) => a.time - b.time),
          },
        };
      return anim;
    },
  },
  {
    name: 'nod',
    category: 'character',
    loops: false,
    description: 'Head nods (yes) by rotating a bone back and forth.',
    params: [
      { name: 'bone', type: 'bone', required: true, description: 'Head bone.' },
      { name: 'angle', type: 'number', default: 6, description: 'Degrees.' },
      { name: 'count', type: 'number', default: 2, description: 'Number of nods.' },
      { name: 'duration', type: 'number', default: 0.8, description: 'Seconds.' },
      START,
    ],
    build: (ctx, p) => {
      const n = Math.max(1, Math.round(p.count));
      const keys: [number, number, string?][] = [[0, 0, sine]];
      for (let i = 0; i < n; i++) keys.push([((i + 0.5) / n) * p.duration, p.angle, sine], [((i + 1) / n) * p.duration, 0, sine]);
      return { bones: { [p.bone]: { rotate: valueKeys(keys) } } };
    },
  },
  {
    name: 'wave',
    category: 'character',
    loops: false,
    description: 'Raises an arm outward and waves the forearm, then lowers it. The raise direction is worked out from the arm.',
    params: [
      { name: 'upper', type: 'bone', required: true, description: 'Upper arm bone.' },
      { name: 'forearm', type: 'bone', required: true, description: 'Forearm bone.' },
      { name: 'hand', type: 'bone', description: 'Optional hand bone to flick.' },
      { name: 'raise', type: 'number', default: 110, description: 'How far the upper arm lifts, in degrees.' },
      { name: 'swing', type: 'number', default: 40, description: 'Forearm wave range in degrees.' },
      { name: 'waves', type: 'number', default: 3, description: 'Number of waves.' },
      { name: 'duration', type: 'number', default: 2.4, description: 'Seconds.' },
      START,
    ],
    build: (ctx, p) => {
      const s = outward(ctx, p.upper);
      const d = p.duration;
      const up = d * 0.17;
      const down = d * 0.79;
      const n = Math.max(1, Math.round(p.waves));
      const base = s * p.swing * 0.4;
      const amp = p.swing * 0.6;
      const fore: [number, number, string?][] = [[0, 0, sine], [up, base, sine]];
      for (let i = 0; i < n; i++) {
        const t0 = up + ((down - up) * i) / n;
        const t1 = up + ((down - up) * (i + 0.5)) / n;
        if (i > 0) fore.push([t0, base - amp * s, sine]);
        fore.push([t1, base + amp * s, sine]);
      }
      fore.push([down, base, sine], [d, 0]);
      const anim: L2DAnimation = {
        bones: {
          [p.upper]: { rotate: valueKeys([[0, 0, 'easeOutBack'], [up, s * p.raise], [down, s * p.raise, 'easeInOutQuad'], [d, 0]]) },
          [p.forearm]: { rotate: valueKeys(fore) },
        },
        events: [{ time: r3(up), name: 'wave' }],
      };
      if (p.hand) {
        const hand: [number, number, string?][] = [[up, 0, sine]];
        for (let i = 0; i < n; i++) hand.push([up + ((down - up) * (i + 0.5)) / n, s * 18, sine], [up + ((down - up) * (i + 1)) / n, -s * 12, sine]);
        hand[hand.length - 1] = [down, 0];
        anim.bones![p.hand] = { rotate: valueKeys(hand) };
      }
      return anim;
    },
  },
  {
    name: 'jump',
    category: 'character',
    loops: true,
    description:
      'Jump for joy: crouch, leap (IK feet rise with the hip so legs stay attached), optional arms up, land and absorb. Fires events "jump" and "land".',
    params: [
      { name: 'hip', type: 'bone', required: true, description: 'Hip / pelvis bone (parent of the legs).' },
      { name: 'feet', type: 'bones', default: [], description: 'IK target bones of the feet. Required for IK legs.' },
      { name: 'arms', type: 'bones', default: [], description: 'Upper arm bones to throw up.' },
      { name: 'height', type: 'number', default: 60, description: 'Jump height in skeleton units.' },
      { name: 'crouch', type: 'number', default: 16, description: 'Crouch depth before and after.' },
      { name: 'tuck', type: 'number', default: 10, description: 'Extra foot lift at the top (bends the knees).' },
      { name: 'raise', type: 'number', default: 125, description: 'Arm lift in degrees.' },
      { name: 'duration', type: 'number', default: 1.6, description: 'Seconds.' },
      START,
    ],
    build: (ctx, p) => {
      const d = p.duration;
      const t = (f: number) => d * f;
      const anim: L2DAnimation = {
        bones: {
          [p.hip]: {
            translate: ty([[0, 0, 'easeOutQuad'], [t(0.16), p.crouch, 'easeOutQuad'], [t(0.375), -p.height, 'easeInQuad'], [t(0.575), 0, 'easeOutQuad'], [t(0.66), p.crouch * 0.6, sine], [d, 0]]),
          },
        },
        events: [
          { time: r3(t(0.19)), name: 'jump' },
          { time: r3(t(0.575)), name: 'land' },
        ],
      };
      // Feet use the same curve as the hip on the way up and down so IK legs stay in reach.
      for (const f of p.feet)
        anim.bones![f] = { translate: ty([[0, 0], [t(0.16), 0, 'easeOutQuad'], [t(0.375), -(p.height + p.tuck + p.crouch * 0.3), 'easeInQuad'], [t(0.575), 0]]) };
      for (const a of p.arms) {
        const s = outward(ctx, a);
        anim.bones![a] = {
          rotate: valueKeys([[0, 0, 'easeOutQuad'], [t(0.16), -s * 10, 'easeOutBack'], [t(0.34), s * p.raise], [t(0.625), s * p.raise, sine], [t(0.84), s * 8, sine], [d, 0]]),
        };
      }
      return anim;
    },
  },
];

export function findPreset(name: string): Preset {
  const p = PRESETS.find((x) => x.name === name);
  if (!p) throw new Error(`Unknown preset "${name}". Available: ${PRESETS.map((x) => x.name).join(', ')}`);
  return p;
}

export function presetContext(data: SkeletonData): PresetContext {
  const sk = new Skeleton(data);
  return {
    data,
    worldAngle(bone) {
      const i = data.findBone(bone);
      if (i < 0) throw new Error(`Unknown bone "${bone}"`);
      return sk.boneWorldRotation(i);
    },
    mainBone() {
      // Visible art (box area of what each slot shows at setup) per bone, summed over subtrees;
      // then the deepest bone that still carries most of it: the coin of a coin symbol, the hip
      // of a character, never an invisible glow or a tail.
      const sub = new Float64Array(data.bones.length);
      for (const s of data.slots) {
        if (s.attachment < 0 || s.color.a <= 0) continue;
        const m = data.attachments[s.index][s.attachment];
        if (m.kind === 'clipping') continue;
        const v = m.vertices;
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        for (let i = 0; i < v.length; i += 2) {
          minX = Math.min(minX, v[i]);
          maxX = Math.max(maxX, v[i]);
          minY = Math.min(minY, v[i + 1]);
          maxY = Math.max(maxY, v[i + 1]);
        }
        sub[s.bone] += (maxX - minX) * (maxY - minY);
      }
      for (let i = data.bones.length - 1; i > 0; i--) if (data.bones[i].parent >= 0) sub[data.bones[i].parent] += sub[i];
      let bone = 0;
      for (;;) {
        const children = data.bones.filter((b) => b.parent === bone);
        const best = children.sort((a, b) => sub[b.index] - sub[a.index])[0];
        if (!best || sub[best.index] < sub[bone] * 0.9) break;
        bone = best.index;
      }
      return data.bones[bone].name;
    },
  };
}

/**
 * Builds the keys for a preset on a skeleton. Checks parameter names, types and that bones,
 * slots and attachments exist, with messages that list what is available.
 */
export function applyPreset(data: SkeletonData, name: string, params: Record<string, unknown> = {}): L2DAnimation {
  const preset = findPreset(name);
  const ctx = presetContext(data);
  const known = new Set(preset.params.map((p) => p.name));
  const unknown = Object.keys(params).filter((k) => !known.has(k));
  if (unknown.length)
    throw new Error(`Preset "${name}" has no parameter ${unknown.map((u) => `"${u}"`).join(', ')}. Parameters: ${[...known].join(', ')}`);
  const bones = data.bones.map((b) => b.name);
  const slots = data.slots.map((s) => s.name);
  const p: Record<string, any> = {};
  for (const def of preset.params) {
    let v = params[def.name];
    if (v === undefined) {
      if (def.default !== undefined) v = structuredClone(def.default);
      else if (def.name === 'bone' && !def.required) v = ctx.mainBone();
      else if (def.required) throw new Error(`Preset "${name}" needs "${def.name}": ${def.description}`);
      else continue;
    }
    const fail = (msg: string) => {
      throw new Error(`Preset "${name}", parameter "${def.name}": ${msg}`);
    };
    switch (def.type) {
      case 'number':
        if (typeof v !== 'number' || !Number.isFinite(v)) fail('must be a number');
        break;
      case 'numbers':
        if (typeof v === 'number') v = [v];
        if (!Array.isArray(v) || !v.every((x) => typeof x === 'number')) fail('must be a list of numbers');
        break;
      case 'boolean':
        if (typeof v !== 'boolean') fail('must be true or false');
        break;
      case 'bone':
        if (typeof v !== 'string' || !bones.includes(v)) fail(`unknown bone "${String(v)}". Bones: ${bones.join(', ')}`);
        break;
      case 'bones':
        if (typeof v === 'string') v = [v];
        if (!Array.isArray(v)) fail('must be a list of bone names');
        for (const b of v as unknown[]) if (typeof b !== 'string' || !bones.includes(b)) fail(`unknown bone "${String(b)}". Bones: ${bones.join(', ')}`);
        break;
      case 'slot':
        if (typeof v !== 'string' || !slots.includes(v)) fail(`unknown slot "${String(v)}". Slots: ${slots.join(', ')}`);
        break;
      case 'slots':
        if (typeof v === 'string') v = [v];
        if (!Array.isArray(v)) fail('must be a list of slot names');
        for (const s of v as unknown[]) if (typeof s !== 'string' || !slots.includes(s)) fail(`unknown slot "${String(s)}". Slots: ${slots.join(', ')}`);
        break;
      case 'attachment': {
        const slot = p[def.slotParam!] as string;
        const si = data.findSlot(slot);
        const names = data.attachments[si].map((a) => a.name);
        if (typeof v !== 'string' || !names.includes(v)) fail(`slot "${slot}" has no attachment "${String(v)}". Attachments: ${names.join(', ')}`);
        break;
      }
    }
    p[def.name] = v;
  }
  // Attachment defaults: the slot's setup attachment.
  for (const def of preset.params)
    if (def.type === 'attachment' && p[def.name] === undefined) {
      const si = data.findSlot(p[def.slotParam!]);
      const a = data.slots[si].attachment;
      if (a < 0) throw new Error(`Preset "${name}" needs "${def.name}" because slot "${p[def.slotParam!]}" shows nothing at setup`);
      p[def.name] = data.attachments[si][a].name;
    }
  const anim = shift(preset.build(ctx, p), p.start ?? 0);
  // Attachment keys pushed later by "start" would hold their first key before it: show the
  // slot's setup attachment until then.
  for (const [slot, tl] of Object.entries(anim.slots ?? {})) {
    const keys = tl.attachment;
    if (!keys?.length || keys[0].time <= 0) continue;
    const si = data.findSlot(slot);
    const a = data.slots[si].attachment;
    keys.unshift({ time: 0, name: a < 0 ? null : data.attachments[si][a].name });
  }
  return anim;
}

/** Human/LLM-readable catalogue of presets and their parameters. */
export function describePresets(): string {
  return PRESETS.map((p) => {
    const params = p.params
      .map((x) => `    - ${x.name} (${x.type}${x.required ? ', required' : x.default !== undefined ? `, default ${JSON.stringify(x.default)}` : ''}): ${x.description}`)
      .join('\n');
    return `${p.name} [${p.category}${p.loops ? ', loops' : ''}]: ${p.description}\n${params}`;
  }).join('\n\n');
}
