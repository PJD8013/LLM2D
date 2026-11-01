/**
 * "Coin", a gold coin symbol drawn as layered art (original): glow, coin body, star emblem,
 * a shine streak and a hidden white flash. Rigged and animated through the MCP tools.
 *
 *   node samples/coin/art.ts   # writes source/coin.psd and source/coin-preview.png
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { svgLayersToPsd, type SvgLayer } from '../_psd.ts';

const C = 160; // canvas centre (320x320 logical)
const R = 108; // coin radius
const OUT = '#5A3300';

const star = (cx: number, cy: number, r: number, inner: number) => {
  const pts: string[] = [];
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const rr = i % 2 ? inner : r;
    pts.push(`${(cx + Math.cos(a) * rr).toFixed(1)},${(cy + Math.sin(a) * rr).toFixed(1)}`);
  }
  return pts.join(' ');
};

const layers: SvgLayer[] = [
  {
    name: 'glow',
    blend: 'add',
    svg: `<defs><radialGradient id="g"><stop offset="0" stop-color="#FFD866"/><stop offset="0.45" stop-color="#FFB627" stop-opacity="0.7"/>
      <stop offset="1" stop-color="#FF9F1C" stop-opacity="0"/></radialGradient></defs><circle cx="${C}" cy="${C}" r="156" fill="url(#g)"/>`,
  },
  {
    name: 'coin',
    svg: `<defs>
      <linearGradient id="rim" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#FFE38A"/><stop offset="0.5" stop-color="#F5B730"/><stop offset="1" stop-color="#C77D0A"/></linearGradient>
      <radialGradient id="face" cx="0.4" cy="0.35" r="0.75"><stop offset="0" stop-color="#FFE9A0"/><stop offset="0.6" stop-color="#F7C443"/><stop offset="1" stop-color="#DE9616"/></radialGradient></defs>
      <circle cx="${C}" cy="${C}" r="${R}" fill="url(#rim)" stroke="${OUT}" stroke-width="6"/>
      <circle cx="${C}" cy="${C}" r="${R - 18}" fill="url(#face)" stroke="#B9740A" stroke-width="4"/>
      <circle cx="${C}" cy="${C}" r="${R - 9}" fill="none" stroke="#FFF2B8" stroke-width="2" stroke-dasharray="3 7" opacity="0.8"/>`,
  },
  {
    name: 'star',
    svg: `<polygon points="${star(C, C + 2, 56, 24)}" fill="#FFF3C4" stroke="#B9740A" stroke-width="5" stroke-linejoin="round"/>
      <polygon points="${star(C, C + 2, 40, 17)}" fill="#FFD95A"/>`,
  },
  {
    name: 'shine',
    svg: `<path d="M ${C - 70} ${C - 40} Q ${C - 40} ${C - 92} ${C + 10} ${C - 98} Q ${C - 30} ${C - 70} ${C - 54} ${C - 24} Z" fill="#fff" opacity="0.75"/>`,
  },
  {
    name: 'flash',
    hidden: true,
    blend: 'add',
    svg: `<circle cx="${C}" cy="${C}" r="${R + 2}" fill="#fff"/>`,
  },
];

const dir = join(dirname(fileURLToPath(import.meta.url)), 'source');
await svgLayersToPsd(layers, { width: 320, height: 320 }, join(dir, 'coin.psd'), join(dir, 'coin-preview.png'));
console.log('wrote samples/coin/source/coin.psd');
