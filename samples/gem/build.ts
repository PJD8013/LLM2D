/**
 * "Gem", a high-pay slot symbol with the three states a reel symbol usually needs:
 * idle (subtle loop), land (reel stop) and win (payline celebration).
 * All art is original vector art drawn below.
 */
import type { L2DAnimation, L2DFile } from '../../packages/core/src/index.ts';
import type { ArtPart } from '../_lib.ts';

// Gem silhouette in a 180x180 box: table on top, girdle at y=60, culet at the bottom.
const T = [55, 20, 90, 20, 125, 20]; // table points
const G = [15, 60, 52, 60, 90, 60, 128, 60, 165, 60]; // girdle points
const CULET = [90, 163];
const pt = (a: number[], i: number) => `${a[i * 2]},${a[i * 2 + 1]}`;
const poly = (pts: string[], fill: string) => `<polygon points="${pts.join(' ')}" fill="${fill}"/>`;
const outline = `${pt(T, 0)} ${pt(T, 2)} ${pt(G, 4)} ${CULET.join(',')} ${pt(G, 0)}`;

export const art: Record<string, ArtPart> = {
  glow: {
    w: 300,
    h: 300,
    svg: `<defs><radialGradient id="g"><stop offset="0" stop-color="#FF7AB0"/><stop offset="0.3" stop-color="#FF4D8D" stop-opacity="0.75"/>
      <stop offset="1" stop-color="#FF4D8D" stop-opacity="0"/></radialGradient></defs><circle cx="150" cy="150" r="150" fill="url(#g)"/>`,
  },
  gem: {
    w: 180,
    h: 180,
    svg: `<g stroke-linejoin="round">
      ${poly([pt(T, 0), pt(G, 0), pt(G, 1)], '#FF6FA0')}
      ${poly([pt(T, 0), pt(G, 1), pt(T, 1)], '#FF9DC0')}
      ${poly([pt(T, 1), pt(G, 1), pt(G, 3)], '#FFC4DA')}
      ${poly([pt(T, 1), pt(G, 3), pt(T, 2)], '#FF8DB6')}
      ${poly([pt(T, 2), pt(G, 3), pt(G, 4)], '#E2457E')}
      ${poly([pt(G, 0), pt(G, 1), CULET.join(',')], '#D8326C')}
      ${poly([pt(G, 1), pt(G, 2), CULET.join(',')], '#F0558A')}
      ${poly([pt(G, 2), pt(G, 3), CULET.join(',')], '#C2185B')}
      ${poly([pt(G, 3), pt(G, 4), CULET.join(',')], '#8E0E42')}
      <path d="M${pt(T, 0)} L${pt(G, 1)} L${pt(T, 1)} L${pt(G, 3)} L${pt(T, 2)} M${pt(G, 0)} H165 M${pt(G, 1)} L${CULET.join(',')} L${pt(G, 3)} M${pt(G, 2)} L${CULET.join(',')}"
        fill="none" stroke="#fff" stroke-opacity="0.45" stroke-width="2"/>
      <polygon points="${outline}" fill="none" stroke="#3B0B22" stroke-width="5"/>
      <polygon points="66,28 84,28 62,52" fill="#fff" opacity="0.85"/>
      <polygon points="88,28 94,28 84,40" fill="#fff" opacity="0.6"/></g>`,
  },
  gem_flash: {
    w: 180,
    h: 180,
    svg: `<polygon points="${outline}" fill="#fff" stroke="#fff" stroke-width="3" stroke-linejoin="round"/>`,
  },
  sparkle: {
    w: 64,
    h: 64,
    svg: `<defs><radialGradient id="c"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient></defs>
      <circle cx="32" cy="32" r="14" fill="url(#c)"/>
      <path d="M32 0 Q35 29 64 32 Q35 35 32 64 Q29 35 0 32 Q29 29 32 0 Z" fill="#fff"/>`,
  },
};

const sine = 'easeInOutSine';

const idle: L2DAnimation = {
  duration: 2.4,
  bones: {
    gem: { translate: [{ time: 0, y: 0, curve: sine }, { time: 1.2, y: -3, curve: sine }, { time: 2.4, y: 0 }] },
    sparkle: {
      rotate: [{ time: 1.5, value: 0 }, { time: 2.1, value: 90 }],
      scale: [{ time: 1.5, x: 0.2, y: 0.2, curve: 'easeOutBack' }, { time: 1.75, x: 1, y: 1, curve: 'easeInQuad' }, { time: 2.1, x: 0.2, y: 0.2 }],
    },
  },
  slots: {
    sparkle: { alpha: [{ time: 1.5, value: 0, curve: 'easeOutQuad' }, { time: 1.7, value: 1, curve: 'easeInQuad' }, { time: 2.1, value: 0 }] },
  },
};

const land: L2DAnimation = {
  bones: {
    gem: {
      translate: [{ time: 0, y: -36, curve: 'easeInQuad' }, { time: 0.12, y: 0 }],
      scale: [
        { time: 0, x: 0.92, y: 1.1, curve: 'easeInQuad' },
        { time: 0.12, x: 1.2, y: 0.8, curve: 'easeOutElastic' },
        { time: 0.5, x: 1, y: 1 },
      ],
    },
  },
  slots: {
    gem_flash: { alpha: [{ time: 0.1, value: 0, curve: 'easeOutQuad' }, { time: 0.13, value: 0.35, curve: 'easeOutQuad' }, { time: 0.35, value: 0 }] },
  },
  events: [{ time: 0.12, name: 'land' }],
};

const win: L2DAnimation = {
  bones: {
    gem: {
      scale: [
        { time: 0, x: 1, y: 1, curve: 'easeOutBack' },
        { time: 0.25, x: 1.2, y: 1.2, curve: sine },
        { time: 0.6, x: 1.02, y: 1.02, curve: 'easeOutBack' },
        { time: 0.85, x: 1.12, y: 1.12, curve: sine },
        { time: 1.2, x: 1, y: 1 },
      ],
      rotate: [
        { time: 0, value: 0, curve: sine },
        { time: 0.2, value: -7, curve: sine },
        { time: 0.45, value: 6, curve: sine },
        { time: 0.7, value: -3, curve: sine },
        { time: 0.95, value: 2, curve: sine },
        { time: 1.2, value: 0 },
      ],
    },
    glow: {
      scale: [{ time: 0, x: 0.7, y: 0.7, curve: 'easeOutQuad' }, { time: 0.3, x: 1.1, y: 1.1, curve: sine }, { time: 0.75, x: 0.9, y: 0.9, curve: sine }, { time: 1.2, x: 0.7, y: 0.7 }],
    },
    sparkle: {
      rotate: [{ time: 0.15, value: 0 }, { time: 0.75, value: 180 }],
      scale: [{ time: 0.15, x: 0, y: 0, curve: 'easeOutBack' }, { time: 0.4, x: 0.9, y: 0.9, curve: 'easeInQuad' }, { time: 0.75, x: 0, y: 0 }],
    },
  },
  slots: {
    glow: { alpha: [{ time: 0, value: 0, curve: 'easeOutQuad' }, { time: 0.3, value: 0.95, curve: sine }, { time: 0.75, value: 0.45, curve: sine }, { time: 1.2, value: 0 }] },
    gem_flash: { alpha: [{ time: 0, value: 0, curve: 'easeOutQuad' }, { time: 0.2, value: 0.28, curve: 'easeInQuad' }, { time: 0.5, value: 0 }] },
    sparkle: { alpha: [{ time: 0.15, value: 0, curve: 'easeOutQuad' }, { time: 0.35, value: 1, curve: 'easeInQuad' }, { time: 0.75, value: 0 }] },
  },
};

export const file: L2DFile = {
  format: 'llm2d',
  version: '0.1',
  name: 'gem',
  meta: { description: 'Sample high-pay slot symbol for LLM2D. Original art generated from samples/gem/build.ts.' },
  bounds: { x: -100, y: -100, width: 200, height: 200 },
  images: Object.fromEntries(Object.entries(art).map(([k, a]) => [k, { path: `images/${k}.png`, width: a.w, height: a.h }])),
  bones: [
    { name: 'root' },
    { name: 'gem', parent: 'root' },
    { name: 'glow', parent: 'gem' },
    { name: 'sparkle', parent: 'gem', x: 40, y: -58 },
  ],
  slots: [
    { name: 'glow', bone: 'glow', attachment: 'glow', color: 'ffffff00', blend: 'add' },
    { name: 'gem', bone: 'gem', attachment: 'gem' },
    { name: 'gem_flash', bone: 'gem', attachment: 'gem_flash', color: 'ffffff00', blend: 'add' },
    { name: 'sparkle', bone: 'sparkle', attachment: 'sparkle', color: 'ffffff00', blend: 'add' },
  ],
  attachments: {
    glow: { glow: { type: 'region', image: 'glow', x: 0, y: 0 } },
    gem: { gem: { type: 'region', image: 'gem', x: 0, y: 2 } },
    gem_flash: { gem_flash: { type: 'region', image: 'gem_flash', x: 0, y: 2 } },
    sparkle: { sparkle: { type: 'region', image: 'sparkle', x: 40, y: -58 } },
  },
  animations: { idle, land, win },
};
