/**
 * "Kit", a fox host character drawn as layered art the way an artist would hand it over:
 * whole limbs on single layers (they must bend through a mesh), hidden overlap under the
 * body, and alternate expressions on hidden layers. Original art.
 *
 * Every layer is drawn on the full 600x800 canvas; make-psd.ts rasterises them at 2x and
 * writes source/kit.psd.
 */

export const CANVAS = { width: 600, height: 800 };

const OUT = '#3B2418';
const FUR = '#F28C38';
const FUR_D = '#D9692A';
const CREAM = '#FFF1DC';
const JACKET = '#2B7A78';
const JACKET_D = '#1F5F5D';
const GOLD = '#F4C542';
const PANTS = '#3D4B6B';
const SHOE = '#5A3A28';
const SCARF = '#D63A4A';
const SCARF_D = '#A82535';
const PAW = '#7A3E1D';
const SW = `stroke="${OUT}" stroke-width="5" stroke-linejoin="round" stroke-linecap="round"`;

type P = [number, number];

/** Catmull-Rom spline through control points, sampled densely. */
function spline(points: P[], step = 2): P[] {
  const out: P[] = [];
  const pts = [points[0], ...points, points[points.length - 1]];
  for (let i = 1; i < pts.length - 2; i++) {
    const [p0, p1, p2, p3] = [pts[i - 1], pts[i], pts[i + 1], pts[i + 2]];
    const n = Math.max(2, Math.ceil(Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) / step));
    for (let k = 0; k < n; k++) {
      const t = k / n;
      const t2 = t * t;
      const t3 = t2 * t;
      const f = (a: number, b: number, c: number, d: number) =>
        0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      out.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])]);
    }
  }
  out.push(points[points.length - 1]);
  return out;
}

/**
 * Outline of a tube along a smooth centerline. `widths` are [t, width] stops along the
 * length (t in 0..1). Ends are rounded.
 */
function tube(points: P[], widths: [number, number][]): string {
  const c = spline(points);
  const len: number[] = [0];
  for (let i = 1; i < c.length; i++) len.push(len[i - 1] + Math.hypot(c[i][0] - c[i - 1][0], c[i][1] - c[i - 1][1]));
  const total = len[len.length - 1];
  const widthAt = (t: number) => {
    for (let i = 1; i < widths.length; i++)
      if (t <= widths[i][0]) {
        const [t0, w0] = widths[i - 1];
        const [t1, w1] = widths[i];
        const u = (t - t0) / (t1 - t0 || 1);
        return w0 + (w1 - w0) * (0.5 - Math.cos(u * Math.PI) / 2);
      }
    return widths[widths.length - 1][1];
  };
  const left: P[] = [];
  const right: P[] = [];
  c.forEach((p, i) => {
    const a = c[Math.max(0, i - 1)];
    const b = c[Math.min(c.length - 1, i + 1)];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const l = Math.hypot(dx, dy) || 1;
    const w = widthAt(len[i] / total) / 2;
    left.push([p[0] - (dy / l) * w, p[1] + (dx / l) * w]);
    right.push([p[0] + (dy / l) * w, p[1] - (dx / l) * w]);
  });
  const fmt = (p: P) => `${p[0].toFixed(1)} ${p[1].toFixed(1)}`;
  const wEnd = widthAt(1) / 2;
  const wStart = widthAt(0) / 2;
  return (
    `M ${fmt(left[0])} ` +
    left.slice(1).map((p) => `L ${fmt(p)}`).join(' ') +
    ` A ${wEnd.toFixed(1)} ${wEnd.toFixed(1)} 0 0 0 ${fmt(right[right.length - 1])} ` +
    right.slice(0, -1).reverse().map((p) => `L ${fmt(p)}`).join(' ') +
    ` A ${wStart.toFixed(1)} ${wStart.toFixed(1)} 0 0 0 ${fmt(left[0])} Z`
  );
}

const flip = (svg: string) => `<g transform="translate(${CANVAS.width} 0) scale(-1 1)">${svg}</g>`;

// ---- Parts ----

const tailPath = tube(
  [
    [350, 592],
    [418, 566],
    [478, 492],
    [500, 410],
    [480, 334],
  ],
  [
    [0, 44],
    [0.35, 118],
    [0.7, 104],
    [1, 12],
  ],
);
const tail = `<defs><clipPath id="tail"><path d="${tailPath}"/></clipPath></defs>
  <path d="${tailPath}" fill="${FUR}"/>
  <g clip-path="url(#tail)">
    <path d="M 420 420 Q 470 448 540 420 L 560 300 L 400 300 Z" fill="${CREAM}"/>
    <path d="M 380 560 Q 430 520 452 470 M 404 586 Q 470 540 494 470 M 440 500 Q 470 470 480 430" fill="none" stroke="${FUR_D}" stroke-width="5" stroke-linecap="round"/>
  </g>
  <path d="${tailPath}" fill="none" ${SW}/>`;

const earPts: P[] = [
  [240, 216],
  [226, 160],
  [206, 100],
];
const earPath = tube(earPts, [
  [0, 76],
  [0.55, 48],
  [1, 6],
]);
const innerEar = tube(
  [
    [236, 206],
    [225, 160],
    [212, 120],
  ],
  [
    [0, 40],
    [1, 4],
  ],
);
const earL = `<defs><clipPath id="ear"><path d="${earPath}"/></clipPath></defs>
  <path d="${earPath}" fill="${FUR}"/>
  <path d="${innerEar}" fill="${CREAM}"/>
  <g clip-path="url(#ear)"><path d="M 150 140 L 260 118 L 260 60 L 150 60 Z" fill="${OUT}"/></g>
  <path d="${earPath}" fill="none" ${SW}/>`;

const armPts: P[] = [
  [236, 392],
  [214, 466],
  [198, 532],
];
const sleeve = tube(armPts, [
  [0, 46],
  [0.5, 38],
  [1, 34],
]);
const paw = (cx: number, cy: number) =>
  `<path d="M ${cx - 20} ${cy - 4} Q ${cx - 22} ${cy - 24} ${cx} ${cy - 24} Q ${cx + 22} ${cy - 22} ${cx + 20} ${cy - 2} ` +
  `Q ${cx + 18} ${cy + 20} ${cx - 2} ${cy + 20} Q ${cx - 20} ${cy + 18} ${cx - 20} ${cy - 4} Z" fill="${PAW}" ${SW}/>
  <path d="M ${cx - 10} ${cy + 8} L ${cx - 10} ${cy + 17} M ${cx} ${cy + 9} L ${cx} ${cy + 19} M ${cx + 10} ${cy + 8} L ${cx + 9} ${cy + 17}" stroke="#B9774D" stroke-width="3" stroke-linecap="round"/>`;
const armL = `<defs><clipPath id="sleeve"><path d="${sleeve}"/></clipPath></defs>
  <path d="${sleeve}" fill="${JACKET}"/>
  <g clip-path="url(#sleeve)">
    <path d="M 160 502 L 240 512 L 240 528 L 160 518 Z" fill="${GOLD}"/>
    <path d="M 224 406 Q 212 436 208 462" fill="none" stroke="${JACKET_D}" stroke-width="5" stroke-linecap="round"/>
  </g>
  <path d="${sleeve}" fill="none" ${SW}/>
  ${paw(194, 552)}`;

const legPts: P[] = [
  [262, 556],
  [262, 650],
  [262, 738],
];
const pants = tube(legPts, [
  [0, 54],
  [0.5, 46],
  [1, 42],
]);
const legL = `<path d="${pants}" fill="${PANTS}" ${SW}/>
  <path d="M 252 600 Q 250 650 254 700" fill="none" stroke="#2C3752" stroke-width="5" stroke-linecap="round"/>
  <path d="M 218 770 Q 210 744 236 736 L 278 733 Q 300 735 300 754 Q 300 772 282 772 L 230 772 Q 220 772 218 770 Z" fill="${SHOE}" ${SW}/>
  <path d="M 230 744 Q 244 738 262 739" fill="none" stroke="#8A6248" stroke-width="4" stroke-linecap="round"/>`;

const bodyPath =
  'M 300 350 C 346 350 368 370 372 408 C 378 468 386 540 374 578 C 364 606 332 612 300 612 C 268 612 236 606 226 578 C 214 540 222 468 228 408 C 232 370 254 350 300 350 Z';
const body = `<defs><clipPath id="body"><path d="${bodyPath}"/></clipPath></defs>
  <path d="${bodyPath}" fill="${JACKET}"/>
  <g clip-path="url(#body)">
    <path d="M 272 340 L 328 340 L 316 620 L 284 620 Z" fill="${CREAM}"/>
    <path d="M 272 340 L 284 620 M 328 340 L 316 620" stroke="${JACKET_D}" stroke-width="6"/>
    <path d="M 226 586 Q 300 600 374 586" fill="none" stroke="${JACKET_D}" stroke-width="6"/>
    <path d="M 238 520 L 262 520" stroke="${JACKET_D}" stroke-width="5" stroke-linecap="round"/>
  </g>
  <path d="${bodyPath}" fill="none" ${SW}/>
  <circle cx="276" cy="448" r="7" fill="${GOLD}" ${SW.replace('5', '3')}/>
  <circle cx="279" cy="512" r="7" fill="${GOLD}" ${SW.replace('5', '3')}/>`;

const scarfEnd = tube(
  [
    [334, 380],
    [344, 420],
    [352, 466],
  ],
  [
    [0, 30],
    [1, 36],
  ],
);
const band = tube(
  [
    [236, 360],
    [300, 382],
    [364, 360],
  ],
  [
    [0, 26],
    [0.5, 30],
    [1, 26],
  ],
);
const scarf = `<defs><clipPath id="end"><path d="${scarfEnd}"/></clipPath></defs>
  <path d="${scarfEnd}" fill="${SCARF}"/>
  <g clip-path="url(#end)"><path d="M 300 422 L 400 410 L 400 424 L 300 436 Z M 300 446 L 400 434 L 400 448 L 300 460 Z" fill="${SCARF_D}"/></g>
  <path d="${scarfEnd}" fill="none" ${SW}/>
  <path d="${band}" fill="${SCARF}" ${SW}/>
  <circle cx="334" cy="378" r="16" fill="${SCARF_D}" ${SW}/>`;

const headPath =
  'M 300 168 C 358 168 396 200 402 246 C 404 262 412 276 424 290 C 404 296 392 304 382 316 C 362 340 332 352 300 352 ' +
  'C 268 352 238 340 218 316 C 208 304 196 296 176 290 C 188 276 196 262 198 246 C 204 200 242 168 300 168 Z';
const head = `<defs><clipPath id="head"><path d="${headPath}"/></clipPath></defs>
  <path d="${headPath}" fill="${FUR}"/>
  <g clip-path="url(#head)">
    <path d="M 170 290 C 200 286 240 266 272 278 C 286 284 314 284 328 278 C 360 266 400 286 430 290 L 430 360 L 170 360 Z" fill="${CREAM}"/>
    <path d="M 284 176 Q 300 200 316 176" fill="none" stroke="${FUR_D}" stroke-width="6" stroke-linecap="round"/>
    <ellipse cx="236" cy="296" rx="16" ry="9" fill="#FF8FA0" opacity="0.45"/>
    <ellipse cx="364" cy="296" rx="16" ry="9" fill="#FF8FA0" opacity="0.45"/>
  </g>
  <path d="${headPath}" fill="none" ${SW}/>
  <ellipse cx="300" cy="296" rx="15" ry="10" fill="${OUT}"/>
  <ellipse cx="296" cy="292" rx="5" ry="3" fill="#fff" opacity="0.8"/>`;

const eye = (cx: number) => `<ellipse cx="${cx}" cy="250" rx="12" ry="16" fill="${OUT}"/>
  <circle cx="${cx + 4}" cy="243" r="4.5" fill="#fff"/><circle cx="${cx - 3}" cy="256" r="2" fill="#fff"/>`;
const eyes = eye(262) + eye(338);
const eyesClosed = `<path d="M 248 250 Q 262 262 276 250 M 324 250 Q 338 262 352 250" fill="none" stroke="${OUT}" stroke-width="5" stroke-linecap="round"/>`;
const mouth = `<path d="M 300 306 V 314 M 286 313 Q 293 321 300 314 Q 307 321 314 313" fill="none" stroke="${OUT}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>`;
const mouthOpen = `<defs><clipPath id="m"><path d="M 284 312 Q 300 344 316 312 Z"/></clipPath></defs>
  <path d="M 284 312 Q 300 344 316 312 Z" fill="#7A1E2A"/>
  <g clip-path="url(#m)"><ellipse cx="300" cy="332" rx="11" ry="8" fill="#F07A8A"/></g>
  <path d="M 284 312 Q 300 344 316 312 Z" fill="none" stroke="${OUT}" stroke-width="4" stroke-linejoin="round"/>
  <path d="M 300 306 V 312" stroke="${OUT}" stroke-width="4" stroke-linecap="round"/>`;

/** Bottom to top, like a PSD layer panel read from the bottom. */
export const layers: { name: string; svg: string; hidden?: boolean }[] = [
  { name: 'tail', svg: tail },
  { name: 'ear_l', svg: earL },
  { name: 'ear_r', svg: flip(earL.replace('id="ear"', 'id="ear2"').replace('url(#ear)', 'url(#ear2)')) },
  { name: 'arm_l', svg: armL },
  { name: 'arm_r', svg: flip(armL.replace('id="sleeve"', 'id="sleeve2"').replace('url(#sleeve)', 'url(#sleeve2)')) },
  { name: 'leg_l', svg: legL },
  { name: 'leg_r', svg: flip(legL) },
  { name: 'body', svg: body },
  { name: 'scarf', svg: scarf },
  { name: 'head', svg: head },
  { name: 'eyes', svg: eyes },
  { name: 'eyes_closed', svg: eyesClosed, hidden: true },
  { name: 'mouth', svg: mouth },
  { name: 'mouth_open', svg: mouthOpen, hidden: true },
];
