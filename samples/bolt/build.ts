/**
 * "Bolt", a small host robot for slot games. Demonstrates bones, two-bone IK legs, a
 * weighted mesh (the bendy antenna), attachment swaps (face), additive glow and events.
 * All art is original vector art drawn below.
 */
import type { L2DAnimation, L2DFile } from '../../packages/core/src/index.ts';
import { bonesFromWorld, segmentWeights, stripMesh, type ArtPart } from '../_lib.ts';

const OUT = '#22253A';
const SW = 'stroke="#22253A" stroke-width="4" stroke-linejoin="round" stroke-linecap="round"';
const JOINT = '#4A5068';
const ORANGE = '#FF8A3D';
const ORANGE_D = '#E0661C';
const CYAN = '#5CF2FF';
const SCREEN = '#18203A';

const metal = (id: string, horizontal = true) =>
  `<linearGradient id="${id}" x1="0" y1="0" x2="${horizontal ? 1 : 0}" y2="${horizontal ? 0 : 1}">
    <stop offset="0" stop-color="#C3CCDB"/><stop offset="0.3" stop-color="#EEF2F7"/>
    <stop offset="0.65" stop-color="#FAFBFD"/><stop offset="1" stop-color="#BCC6D6"/></linearGradient>`;

const glow = `<filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
  <feGaussianBlur stdDeviation="3.5" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>`;

export const art: Record<string, ArtPart> = {
  shadow: {
    w: 170,
    h: 30,
    svg: `<defs><radialGradient id="s"><stop offset="0.55" stop-color="#000"/><stop offset="1" stop-color="#000" stop-opacity="0"/></radialGradient></defs>
      <ellipse cx="85" cy="15" rx="84" ry="14" fill="url(#s)"/>`,
  },
  antenna_stalk: {
    w: 14,
    h: 96,
    svg: `<rect x="3" y="0" width="8" height="96" rx="4" fill="${JOINT}" stroke="${OUT}" stroke-width="2.5"/>
      <rect x="5" y="2" width="2" height="92" rx="1" fill="#7C84A0"/>`,
  },
  antenna_ball: {
    w: 40,
    h: 40,
    svg: `<defs><radialGradient id="ab" cx="0.38" cy="0.35" r="0.7"><stop offset="0" stop-color="#FFD1A8"/>
      <stop offset="0.45" stop-color="${ORANGE}"/><stop offset="1" stop-color="${ORANGE_D}"/></radialGradient></defs>
      <circle cx="20" cy="20" r="15" fill="url(#ab)" ${SW}/>
      <ellipse cx="15" cy="14" rx="5" ry="3.5" fill="#fff" opacity="0.85" transform="rotate(-30 15 14)"/>`,
  },
  neck: {
    w: 50,
    h: 36,
    svg: `<rect x="5" y="3" width="40" height="30" rx="6" fill="${JOINT}" ${SW}/>
      <path d="M9 13 H41 M9 23 H41" stroke="#2E3346" stroke-width="3"/>`,
  },
  thigh: {
    w: 36,
    h: 82,
    svg: `<defs>${metal('m')}</defs>
      <rect x="6" y="10" width="24" height="68" rx="11" fill="url(#m)" ${SW}/>
      <circle cx="18" cy="13" r="12" fill="${JOINT}" ${SW}/>`,
  },
  shin: {
    w: 42,
    h: 80,
    svg: `<defs>${metal('m')}</defs>
      <path d="M8 14 H34 L37 70 Q37 76 31 76 H11 Q5 76 5 70 Z" fill="url(#m)" ${SW}/>
      <circle cx="21" cy="12" r="11" fill="${ORANGE}" ${SW}/>
      <circle cx="21" cy="12" r="4" fill="${ORANGE_D}"/>`,
  },
  foot: {
    w: 80,
    h: 38,
    svg: `<path d="M8 30 Q6 6 40 5 Q74 6 72 30 Z" fill="${ORANGE}" ${SW}/>
      <path d="M22 13 Q40 8 58 13" stroke="#FFC79E" stroke-width="4" fill="none" stroke-linecap="round"/>
      <rect x="4" y="27" width="72" height="9" rx="4.5" fill="${JOINT}" ${SW}/>`,
  },
  pelvis: {
    w: 124,
    h: 48,
    svg: `<defs>${metal('m')}</defs>
      <path d="M10 6 H114 Q120 6 118 14 L108 38 Q105 44 98 44 H26 Q19 44 16 38 L6 14 Q4 6 10 6 Z" fill="url(#m)" ${SW}/>
      <rect x="44" y="14" width="36" height="16" rx="6" fill="${JOINT}" ${SW}/>`,
  },
  upper_arm: {
    w: 36,
    h: 82,
    svg: `<defs>${metal('m')}</defs>
      <rect x="7" y="12" width="22" height="66" rx="11" fill="url(#m)" ${SW}/>
      <circle cx="18" cy="12" r="13" fill="${JOINT}" ${SW}/>`,
  },
  forearm: {
    w: 38,
    h: 78,
    svg: `<defs>${metal('m')}</defs>
      <path d="M9 12 H29 L32 64 H6 Z" fill="url(#m)" ${SW}/>
      <rect x="4" y="58" width="30" height="16" rx="6" fill="${ORANGE}" ${SW}/>
      <circle cx="19" cy="10" r="10" fill="${ORANGE}" ${SW}/>
      <circle cx="19" cy="10" r="3.5" fill="${ORANGE_D}"/>`,
  },
  hand: {
    w: 54,
    h: 50,
    svg: `<defs>${metal('m')}</defs>
      <path d="M14 8 H40 Q48 8 48 18 V32 Q48 46 34 46 H20 Q6 46 6 32 V18 Q6 8 14 8 Z" fill="url(#m)" ${SW}/>
      <path d="M44 22 Q54 22 52 32 Q50 40 42 37" fill="#E6EBF2" ${SW}/>
      <path d="M17 30 V40 M27 30 V41 M37 30 V40" stroke="#9AA4B8" stroke-width="3" stroke-linecap="round"/>`,
  },
  torso: {
    w: 180,
    h: 168,
    svg: `<defs>${metal('m')}</defs>
      <path d="M24 6 H156 Q174 6 172 26 L164 142 Q162 162 142 162 H38 Q18 162 16 142 L8 26 Q6 6 24 6 Z" fill="url(#m)" ${SW}/>
      <path d="M26 16 H70" stroke="#fff" stroke-width="6" stroke-linecap="round" opacity="0.9"/>
      <rect x="42" y="104" width="96" height="44" rx="14" fill="${ORANGE}" ${SW}/>
      <path d="M62 116 V136 M80 116 V136 M98 116 V136 M116 116 V136" stroke="${ORANGE_D}" stroke-width="5" stroke-linecap="round"/>
      <circle cx="90" cy="64" r="27" fill="${SCREEN}" ${SW}/>
      <circle cx="90" cy="64" r="15" fill="${CYAN}"/>
      <circle cx="84" cy="58" r="5" fill="#fff" opacity="0.9"/>
      <circle cx="26" cy="38" r="4" fill="#9AA4B8"/><circle cx="154" cy="38" r="4" fill="#9AA4B8"/>`,
  },
  chest_light: {
    w: 80,
    h: 80,
    svg: `<defs><radialGradient id="g"><stop offset="0" stop-color="${CYAN}"/><stop offset="0.35" stop-color="${CYAN}" stop-opacity="0.8"/>
      <stop offset="1" stop-color="${CYAN}" stop-opacity="0"/></radialGradient></defs>
      <circle cx="40" cy="40" r="40" fill="url(#g)"/>`,
  },
  head: {
    w: 224,
    h: 156,
    svg: `<defs>${metal('m')}<linearGradient id="v" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#232D4D"/><stop offset="1" stop-color="${SCREEN}"/></linearGradient></defs>
      <circle cx="16" cy="82" r="14" fill="${ORANGE}" ${SW}/><circle cx="208" cy="82" r="14" fill="${ORANGE}" ${SW}/>
      <rect x="96" y="2" width="32" height="14" rx="5" fill="${ORANGE}" ${SW}/>
      <rect x="14" y="10" width="196" height="140" rx="42" fill="url(#m)" ${SW}/>
      <path d="M44 22 Q70 16 96 18" stroke="#fff" stroke-width="7" stroke-linecap="round" fill="none" opacity="0.95"/>
      <rect x="38" y="34" width="148" height="96" rx="30" fill="url(#v)" ${SW}/>
      <path d="M56 44 L82 44 L58 74 Z" fill="#fff" opacity="0.07"/>`,
  },
  face_idle: {
    w: 140,
    h: 80,
    svg: `<defs>${glow}</defs><g filter="url(#glow)" fill="${CYAN}" stroke="${CYAN}">
      <rect x="35" y="14" width="22" height="34" rx="11" stroke="none"/>
      <rect x="83" y="14" width="22" height="34" rx="11" stroke="none"/>
      <path d="M56 60 Q70 70 84 60" fill="none" stroke-width="5" stroke-linecap="round"/></g>`,
  },
  face_blink: {
    w: 140,
    h: 80,
    svg: `<defs>${glow}</defs><g filter="url(#glow)" fill="none" stroke="${CYAN}" stroke-linecap="round">
      <path d="M34 36 H58 M82 36 H106" stroke-width="6"/>
      <path d="M56 60 Q70 70 84 60" stroke-width="5"/></g>`,
  },
  face_happy: {
    w: 140,
    h: 80,
    svg: `<defs>${glow}</defs><g filter="url(#glow)" stroke="${CYAN}" stroke-linecap="round" stroke-linejoin="round">
      <path d="M33 40 Q46 14 59 40 M81 40 Q94 14 107 40" fill="none" stroke-width="7"/>
      <path d="M52 54 Q70 78 88 54 Z" fill="${CYAN}" stroke-width="4"/></g>`,
  },
};

// ---- Rig (world/canvas coordinates at setup pose; y down, origin between the feet) ----
const SHOULDER_X = 96;
const HIP_X = 36;

const bones = bonesFromWorld([
  { name: 'root', x: 0, y: 0 },
  { name: 'hip', parent: 'root', x: 0, y: -170, angle: -90, length: 20 },
  { name: 'torso', parent: 'hip', x: 0, y: -188, angle: -90, length: 150 },
  { name: 'neck', parent: 'torso', x: 0, y: -336, angle: -90, length: 22 },
  { name: 'head', parent: 'neck', x: 0, y: -356, angle: -90, length: 148 },
  { name: 'antenna1', parent: 'head', x: 0, y: -500, angle: -90, length: 32 },
  { name: 'antenna2', parent: 'antenna1', x: 0, y: -532, angle: -90, length: 32 },
  { name: 'antenna3', parent: 'antenna2', x: 0, y: -564, angle: -90, length: 28 },
  ...(['l', 'r'] as const).flatMap((side) => {
    const sx = side === 'l' ? -SHOULDER_X : SHOULDER_X;
    return [
      { name: `upper_arm_${side}`, parent: 'torso', x: sx, y: -318, angle: 90, length: 70 },
      { name: `forearm_${side}`, parent: `upper_arm_${side}`, x: sx, y: -248, angle: 90, length: 62 },
      { name: `hand_${side}`, parent: `forearm_${side}`, x: sx, y: -186, angle: 90, length: 26 },
    ];
  }),
  ...(['l', 'r'] as const).flatMap((side) => {
    const hx = side === 'l' ? -HIP_X : HIP_X;
    return [
      { name: `thigh_${side}`, parent: 'hip', x: hx, y: -160, angle: 90, length: 68 },
      { name: `shin_${side}`, parent: `thigh_${side}`, x: hx, y: -92, angle: 90, length: 64 },
      // IK target (and foot holder) lives under the root so feet stay planted.
      { name: `foot_${side}_ik`, parent: 'root', x: hx, y: -28 },
    ];
  }),
]);

const img = (name: string) => ({ path: `images/${name}.png`, width: art[name].w, height: art[name].h });
const region = (image: string, x: number, y: number, mirror = false) =>
  ({ type: 'region', image, x, y, ...(mirror ? { scaleX: -1 } : {}) }) as const;

const antenna = stripMesh('antenna_stalk', 0, -544, 14, 96, 8);
const antennaMesh = {
  ...antenna,
  bones: ['antenna1', 'antenna2', 'antenna3'],
  weights: segmentWeights(antenna.vertices, [
    { x1: 0, y1: -500, x2: 0, y2: -532 },
    { x1: 0, y1: -532, x2: 0, y2: -564 },
    { x1: 0, y1: -564, x2: 0, y2: -592 },
  ]),
};

const sides = ['l', 'r'] as const;
const sideX = (side: 'l' | 'r', x: number) => (side === 'l' ? -x : x);

// ---- Animations ----
const sine = 'easeInOutSine';

const idle: L2DAnimation = {
  bones: {
    hip: { translate: [{ time: 0, y: 0, curve: sine }, { time: 1, y: 6, curve: sine }, { time: 2, y: 0 }] },
    torso: {
      rotate: [{ time: 0, value: 0, curve: sine }, { time: 0.5, value: 1.5, curve: sine }, { time: 1.5, value: -1.5, curve: sine }, { time: 2, value: 0 }],
    },
    head: {
      rotate: [{ time: 0, value: 0, curve: sine }, { time: 0.65, value: -3, curve: sine }, { time: 1.65, value: 3, curve: sine }, { time: 2, value: 0 }],
    },
    antenna1: {
      rotate: [{ time: 0, value: 0, curve: sine }, { time: 0.7, value: -5, curve: sine }, { time: 1.7, value: 5, curve: sine }, { time: 2, value: 0 }],
    },
    antenna2: {
      rotate: [{ time: 0, value: 2, curve: sine }, { time: 0.8, value: -7, curve: sine }, { time: 1.8, value: 7, curve: sine }, { time: 2, value: 2 }],
    },
    antenna3: {
      rotate: [{ time: 0, value: 4, curve: sine }, { time: 0.9, value: -9, curve: sine }, { time: 1.9, value: 9, curve: sine }, { time: 2, value: 4 }],
    },
    upper_arm_l: { rotate: [{ time: 0, value: 0, curve: sine }, { time: 1, value: 4, curve: sine }, { time: 2, value: 0 }] },
    upper_arm_r: { rotate: [{ time: 0, value: 0, curve: sine }, { time: 1, value: -4, curve: sine }, { time: 2, value: 0 }] },
    forearm_l: { rotate: [{ time: 0, value: 0, curve: sine }, { time: 1.1, value: 5, curve: sine }, { time: 2, value: 0 }] },
    forearm_r: { rotate: [{ time: 0, value: 0, curve: sine }, { time: 1.1, value: -5, curve: sine }, { time: 2, value: 0 }] },
  },
  slots: {
    chest_light: { alpha: [{ time: 0, value: 0.35, curve: sine }, { time: 1, value: 0.7, curve: sine }, { time: 2, value: 0.35 }] },
  },
};

const blink: L2DAnimation = {
  slots: {
    face: {
      attachment: [
        { time: 0, name: 'face_blink' },
        { time: 0.12, name: 'face_idle' },
      ],
    },
  },
  duration: 0.2,
};

const wave: L2DAnimation = {
  bones: {
    upper_arm_r: {
      rotate: [
        { time: 0, value: 0, curve: 'easeOutBack' },
        { time: 0.4, value: -140 },
        { time: 1.9, value: -140, curve: 'easeInOutQuad' },
        { time: 2.4, value: 0 },
      ],
    },
    forearm_r: {
      rotate: [
        { time: 0, value: 0, curve: sine },
        { time: 0.4, value: -10, curve: sine },
        { time: 0.65, value: -40, curve: sine },
        { time: 0.9, value: 15, curve: sine },
        { time: 1.15, value: -40, curve: sine },
        { time: 1.4, value: 15, curve: sine },
        { time: 1.65, value: -40, curve: sine },
        { time: 1.9, value: -10, curve: sine },
        { time: 2.4, value: 0 },
      ],
    },
    hand_r: {
      rotate: [{ time: 0.4, value: 0, curve: sine }, { time: 0.65, value: -15, curve: sine }, { time: 0.9, value: 10, curve: sine }, { time: 1.15, value: -15, curve: sine }, { time: 1.4, value: 10, curve: sine }, { time: 1.65, value: -15, curve: sine }, { time: 1.9, value: 0 }],
    },
    torso: { rotate: [{ time: 0, value: 0, curve: sine }, { time: 0.4, value: -3 }, { time: 1.9, value: -3, curve: sine }, { time: 2.4, value: 0 }] },
    head: {
      rotate: [{ time: 0, value: 0, curve: sine }, { time: 0.45, value: 6, curve: sine }, { time: 1.2, value: 3, curve: sine }, { time: 1.9, value: 6, curve: sine }, { time: 2.4, value: 0 }],
    },
    upper_arm_l: { rotate: [{ time: 0, value: 0, curve: sine }, { time: 0.4, value: 6 }, { time: 1.9, value: 6, curve: sine }, { time: 2.4, value: 0 }] },
    antenna2: { rotate: [{ time: 0, value: 0, curve: sine }, { time: 0.5, value: 10, curve: sine }, { time: 1.2, value: -6, curve: sine }, { time: 1.9, value: 8, curve: sine }, { time: 2.4, value: 0 }] },
    antenna3: { rotate: [{ time: 0, value: 0, curve: sine }, { time: 0.6, value: 14, curve: sine }, { time: 1.3, value: -8, curve: sine }, { time: 2.0, value: 10, curve: sine }, { time: 2.4, value: 0 }] },
  },
  slots: {
    face: { attachment: [{ time: 0, name: 'face_happy' }, { time: 2.2, name: 'face_idle' }] },
  },
  events: [{ time: 0.2, name: 'wave_start' }],
};

// Jump for joy: crouch, jump with arms up, land and absorb.
// The legs are straight at setup, so the feet must rise with the same timing and curve as
// the hip (and a bit more at the apex to tuck the knees) or the IK chain cannot reach them.
const footJump = [
  { time: 0, y: 0 },
  { time: 0.25, y: 0, curve: 'easeOutQuad' },
  { time: 0.6, y: -82, curve: 'easeInQuad' },
  { time: 0.92, y: 0 },
];
const cheer: L2DAnimation = {
  bones: {
    hip: {
      translate: [
        { time: 0, y: 0, curve: 'easeOutQuad' },
        { time: 0.25, y: 22, curve: 'easeOutQuad' },
        { time: 0.6, y: -70, curve: 'easeInQuad' },
        { time: 0.92, y: 0, curve: 'easeOutQuad' },
        { time: 1.08, y: 14, curve: sine },
        { time: 1.6, y: 0 },
      ],
    },
    foot_l_ik: { translate: footJump },
    foot_r_ik: { translate: footJump },
    torso: {
      scale: [
        { time: 0, x: 1, y: 1, curve: sine },
        { time: 0.25, x: 0.92, y: 1.05, curve: 'easeOutQuad' },
        { time: 0.45, x: 1.06, y: 0.97, curve: sine },
        { time: 0.92, x: 1, y: 1, curve: 'easeOutQuad' },
        { time: 1.05, x: 0.94, y: 1.04, curve: sine },
        { time: 1.35, x: 1, y: 1 },
      ],
    },
    head: { rotate: [{ time: 0, value: 0, curve: sine }, { time: 0.25, value: 4, curve: sine }, { time: 0.6, value: -4, curve: sine }, { time: 1.05, value: 3, curve: sine }, { time: 1.6, value: 0 }] },
    ...Object.fromEntries(
      sides.flatMap((side) => {
        const s = side === 'l' ? 1 : -1;
        return [
          [
            `upper_arm_${side}`,
            {
              rotate: [
                { time: 0, value: 0, curve: 'easeOutQuad' },
                { time: 0.25, value: s * -15, curve: 'easeOutBack' },
                { time: 0.55, value: s * 145 },
                { time: 1.0, value: s * 145, curve: sine },
                { time: 1.3, value: s * 10, curve: sine },
                { time: 1.6, value: 0 },
              ],
            },
          ],
          [
            `forearm_${side}`,
            {
              rotate: [
                { time: 0, value: 0, curve: sine },
                { time: 0.25, value: s * -20, curve: sine },
                { time: 0.55, value: s * 25, curve: sine },
                { time: 0.75, value: s * -10, curve: sine },
                { time: 1.0, value: s * 20, curve: sine },
                { time: 1.6, value: 0 },
              ],
            },
          ],
        ];
      }),
    ),
    antenna1: { rotate: [{ time: 0, value: 0, curve: sine }, { time: 0.3, value: 6, curve: sine }, { time: 0.62, value: -8, curve: sine }, { time: 0.98, value: 8, curve: sine }, { time: 1.25, value: -4, curve: sine }, { time: 1.6, value: 0 }] },
    antenna2: { rotate: [{ time: 0, value: 0, curve: sine }, { time: 0.35, value: 10, curve: sine }, { time: 0.67, value: -14, curve: sine }, { time: 1.03, value: 12, curve: sine }, { time: 1.3, value: -6, curve: sine }, { time: 1.6, value: 0 }] },
    antenna3: { rotate: [{ time: 0, value: 0, curve: sine }, { time: 0.4, value: 14, curve: sine }, { time: 0.72, value: -18, curve: sine }, { time: 1.08, value: 16, curve: sine }, { time: 1.35, value: -8, curve: sine }, { time: 1.6, value: 0 }] },
    shadow: { scale: [{ time: 0, x: 1, y: 1, curve: 'easeOutQuad' }, { time: 0.3, x: 1.05, y: 1, curve: 'easeOutQuad' }, { time: 0.6, x: 0.6, y: 0.6, curve: 'easeInQuad' }, { time: 0.92, x: 1, y: 1 }] },
  },
  slots: {
    face: { attachment: [{ time: 0, name: 'face_happy' }] },
    chest_light: {
      alpha: [{ time: 0, value: 0.4, curve: 'easeOutQuad' }, { time: 0.6, value: 1, curve: sine }, { time: 0.95, value: 0.5, curve: sine }, { time: 1.6, value: 0.4 }],
    },
    shadow: { alpha: [{ time: 0, value: 0.28, curve: 'easeOutQuad' }, { time: 0.6, value: 0.1, curve: 'easeInQuad' }, { time: 0.92, value: 0.28 }] },
  },
  events: [
    { time: 0.32, name: 'jump' },
    { time: 0.92, name: 'land' },
  ],
};

export const file: L2DFile = {
  format: 'llm2d',
  version: '0.1',
  name: 'bolt',
  meta: { description: 'Sample host robot for LLM2D. Original art generated from samples/bolt/build.ts.' },
  images: Object.fromEntries(Object.keys(art).map((k) => [k, img(k)])),
  bones: [...bones, { name: 'shadow', parent: 'root', x: 0, y: -2 }],
  slots: [
    { name: 'shadow', bone: 'shadow', attachment: 'shadow', color: '00000047' },
    { name: 'antenna_stalk', bone: 'antenna1', attachment: 'antenna_stalk' },
    { name: 'antenna_ball', bone: 'antenna3', attachment: 'antenna_ball' },
    { name: 'neck', bone: 'neck', attachment: 'neck' },
    ...sides.flatMap((s) => [
      { name: `thigh_${s}`, bone: `thigh_${s}`, attachment: 'thigh' },
      { name: `shin_${s}`, bone: `shin_${s}`, attachment: 'shin' },
      { name: `foot_${s}`, bone: `foot_${s}_ik`, attachment: 'foot' },
    ]),
    { name: 'pelvis', bone: 'hip', attachment: 'pelvis' },
    ...sides.flatMap((s) => [
      { name: `upper_arm_${s}`, bone: `upper_arm_${s}`, attachment: 'upper_arm' },
      { name: `forearm_${s}`, bone: `forearm_${s}`, attachment: 'forearm' },
      { name: `hand_${s}`, bone: `hand_${s}`, attachment: 'hand' },
    ]),
    { name: 'torso', bone: 'torso', attachment: 'torso' },
    { name: 'chest_light', bone: 'torso', attachment: 'chest_light', color: 'ffffff59', blend: 'add' },
    { name: 'head', bone: 'head', attachment: 'head' },
    { name: 'face', bone: 'head', attachment: 'face_idle' },
  ],
  attachments: {
    shadow: { shadow: region('shadow', 0, -2) },
    antenna_stalk: { antenna_stalk: antennaMesh },
    antenna_ball: { antenna_ball: region('antenna_ball', 0, -596) },
    neck: { neck: region('neck', 0, -346) },
    ...Object.fromEntries(
      sides.flatMap((s) => [
        [`thigh_${s}`, { thigh: region('thigh', sideX(s, HIP_X), -132, s === 'r') }],
        [`shin_${s}`, { shin: region('shin', sideX(s, HIP_X), -64, s === 'r') }],
        [`foot_${s}`, { foot: region('foot', sideX(s, HIP_X), -18, s === 'r') }],
        [`upper_arm_${s}`, { upper_arm: region('upper_arm', sideX(s, SHOULDER_X), -289, s === 'r') }],
        [`forearm_${s}`, { forearm: region('forearm', sideX(s, SHOULDER_X), -219, s === 'r') }],
        // The thumb is drawn on the right of the image (inward for the left hand); mirror the right.
        [`hand_${s}`, { hand: region('hand', sideX(s, SHOULDER_X), -173, s === 'r') }],
      ]),
    ),
    pelvis: { pelvis: region('pelvis', 0, -166) },
    torso: { torso: region('torso', 0, -264) },
    chest_light: { chest_light: region('chest_light', 0, -284) },
    head: { head: region('head', 0, -432) },
    face: {
      face_idle: region('face_idle', 0, -428),
      face_blink: region('face_blink', 0, -428),
      face_happy: region('face_happy', 0, -428),
    },
  },
  ik: [
    { name: 'leg_l', bones: ['thigh_l', 'shin_l'], target: 'foot_l_ik', bendPositive: false },
    { name: 'leg_r', bones: ['thigh_r', 'shin_r'], target: 'foot_r_ik', bendPositive: true },
  ],
  animations: { idle, blink, wave, cheer },
};
