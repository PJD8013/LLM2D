import { createImage, decodePng, encodePng, type RGBAImage, type Segmentation, type SplitResult } from '@llm2d/rig';
import { getBrowser } from './browser.ts';
import { gridSvg, overlay } from './inspect.ts';

/** Area-average downscale by factor k (<= 1). */
export function downscale(img: RGBAImage, k: number): RGBAImage {
  if (k >= 1) return img;
  const W = Math.max(1, Math.round(img.width * k));
  const H = Math.max(1, Math.round(img.height * k));
  const out = createImage(W, H);
  const acc = new Float64Array(W * H * 5);
  for (let y = 0; y < img.height; y++) {
    const Y = Math.min(H - 1, Math.floor(y * k));
    for (let x = 0; x < img.width; x++) {
      const X = Math.min(W - 1, Math.floor(x * k));
      const s = (y * img.width + x) * 4;
      const a = img.data[s + 3];
      const d = (Y * W + X) * 5;
      acc[d] += img.data[s] * a;
      acc[d + 1] += img.data[s + 1] * a;
      acc[d + 2] += img.data[s + 2] * a;
      acc[d + 3] += a;
      acc[d + 4]++;
    }
  }
  for (let i = 0; i < W * H; i++) {
    const a = acc[i * 5 + 3];
    if (!a) continue;
    out.data[i * 4] = Math.round(acc[i * 5] / a);
    out.data[i * 4 + 1] = Math.round(acc[i * 5 + 1] / a);
    out.data[i * 4 + 2] = Math.round(acc[i * 5 + 2] / a);
    out.data[i * 4 + 3] = Math.round(a / acc[i * 5 + 4]);
  }
  return out;
}

/** Distinct, readable colours for region ids. */
export function regionColor(id: number): [number, number, number] {
  const hue = (id * 137.508) % 360;
  const f = (n: number) => {
    const k = (n + hue / 30) % 12;
    return Math.round(255 * (0.55 - 0.4 * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return [f(0), f(8), f(4)];
}

export interface RegionsImageOptions {
  /** Longest side of the output in pixels. Default 1400. */
  maxSize?: number;
  /** How strongly regions are tinted (0..1). Default 0.55. */
  tint?: number;
}

/**
 * The picture with every region tinted and numbered (outlines stay dark), over a pixel grid in
 * art pixels. This is what Claude reads to group regions into parts.
 */
export async function regionsImage(img: RGBAImage, seg: Segmentation, options: RegionsImageOptions = {}): Promise<Buffer> {
  const { width: w, height: h } = img;
  const k = Math.min(1, (options.maxSize ?? 1400) / Math.max(w, h));
  const t = options.tint ?? 0.55;
  const tinted = createImage(w, h);
  for (let i = 0; i < w * h; i++) {
    const p = i * 4;
    const a = img.data[p + 3];
    if (!a) continue;
    const l = seg.labels[i];
    let r = img.data[p];
    let g = img.data[p + 1];
    let b = img.data[p + 2];
    if (l > 0) {
      const c = regionColor(l);
      r = r * (1 - t) + c[0] * t;
      g = g * (1 - t) + c[1] * t;
      b = b * (1 - t) + c[2] * t;
    }
    // Composite over white so the picture reads the same in any viewer.
    const af = a / 255;
    tinted.data[p] = Math.round(r * af + 255 * (1 - af));
    tinted.data[p + 1] = Math.round(g * af + 255 * (1 - af));
    tinted.data[p + 2] = Math.round(b * af + 255 * (1 - af));
    tinted.data[p + 3] = 255;
  }
  for (let i = 0; i < w * h; i++)
    if (!img.data[i * 4 + 3]) {
      tinted.data[i * 4] = tinted.data[i * 4 + 1] = tinted.data[i * 4 + 2] = 255;
      tinted.data[i * 4 + 3] = 255;
    }
  const small = downscale(tinted, k);
  const svg = gridSvg(w, h, k);
  for (const r of seg.regions) {
    const fs = r.area * k * k > 400 ? 15 : 11;
    svg.push(
      `<text x="${(r.point[0] * k).toFixed(1)}" y="${(r.point[1] * k + fs * 0.35).toFixed(1)}" font-size="${fs}" text-anchor="middle" fill="#000" stroke="#fff" stroke-width="3.5" paint-order="stroke">${r.id}</text>`,
    );
  }
  return overlay(encodePng(small).toString('base64'), small.width, small.height, svg);
}

export interface SplitSheetOptions {
  /** Cell size in pixels. Default 220. */
  cell?: number;
  columns?: number;
}

/**
 * Every layer of a split on a checkerboard, back to front, with rebuilt (previously hidden)
 * pixels tinted magenta, plus the restacked result.
 */
export async function splitSheet(result: SplitResult, options: SplitSheetOptions = {}): Promise<Buffer> {
  const cell = options.cell ?? 220;
  const { width: w } = result.art;
  const cells: { title: string; sub: string; png: string; width: number; height: number }[] = [];
  result.art.layers.forEach((layer) => {
    const index = result.report.parts.findIndex((p) => p.name === layer.name);
    const fill = result.fills[index];
    const rep = result.report.parts[index];
    const src = layer.image;
    const view = createImage(src.width, src.height);
    for (let y = 0; y < src.height; y++)
      for (let x = 0; x < src.width; x++) {
        const s = (y * src.width + x) * 4;
        const a = src.data[s + 3] / 255;
        const check = ((x >> 3) + (y >> 3)) & 1 ? 214 : 245;
        let r = src.data[s] * a + check * (1 - a);
        let g = src.data[s + 1] * a + check * (1 - a);
        let b = src.data[s + 2] * a + check * (1 - a);
        if (fill[(y + layer.y) * w + x + layer.x]) {
          r = r * 0.55 + 255 * 0.45;
          g = g * 0.55;
          b = b * 0.55 + 200 * 0.45;
        }
        view.data[s] = Math.round(r);
        view.data[s + 1] = Math.round(g);
        view.data[s + 2] = Math.round(b);
        view.data[s + 3] = 255;
      }
    const k = Math.min(1, (cell - 16) / Math.max(src.width, src.height));
    const small = downscale(view, k);
    cells.push({
      title: layer.name,
      sub: `${rep.pixels} px${rep.filled ? ` +${rep.filled} rebuilt` : ''}`,
      png: encodePng(small).toString('base64'),
      width: small.width,
      height: small.height,
    });
  });
  const columns = options.columns ?? Math.min(6, cells.length);
  const html = `<html><body style="margin:0;background:#2a2a2e;font:600 13px system-ui,sans-serif;color:#eee">
    <div style="display:grid;grid-template-columns:repeat(${columns}, ${cell}px);gap:6px;padding:6px">
    ${cells
      .map(
        (c, i) => `<div style="background:#3a3a40;height:${cell + 34}px;display:flex;flex-direction:column;align-items:center">
        <div style="padding:4px 0 0">${i + 1}. ${c.title}</div><div style="font-weight:400;font-size:11px;color:#bbb">${c.sub}</div>
        <div style="flex:1;display:flex;align-items:center"><img src="data:image/png;base64,${c.png}" width="${c.width}" height="${c.height}"/></div></div>`,
      )
      .join('')}
    </div></body></html>`;
  const rows = Math.ceil(cells.length / columns);
  const W = columns * (cell + 6) + 6;
  const H = rows * (cell + 40) + 6;
  const page = await (await getBrowser()).newPage({ viewport: { width: W, height: H } });
  try {
    await page.setContent(html);
    return await page.screenshot({ clip: { x: 0, y: 0, width: W, height: H } });
  } finally {
    await page.close();
  }
}



/**
 * Decodes a picture file to RGBA: PNG directly, other formats (JPEG, WebP, GIF, AVIF) through
 * the headless browser.
 */
export async function decodeImage(bytes: Uint8Array, fileName: string): Promise<RGBAImage> {
  if (/\.png$/i.test(fileName)) return decodePng(bytes);
  const ext = (/\.([a-z0-9]+)$/i.exec(fileName)?.[1] ?? '').toLowerCase();
  const mime = { jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif', bmp: 'image/bmp' }[ext];
  if (!mime) throw new Error(`Unsupported picture type ".${ext}" (use PNG, JPEG or WebP).`);
  const page = await (await getBrowser()).newPage();
  try {
    const out = await page.evaluate(
      async ({ b64, mime }) => {
        const blob = await (await fetch(`data:${mime};base64,${b64}`)).blob();
        const bmp = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
        const canvas = new OffscreenCanvas(bmp.width, bmp.height);
        const ctx = canvas.getContext('2d')!;
        ctx.drawImage(bmp, 0, 0);
        const data = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
        let bin = '';
        for (let i = 0; i < data.length; i += 0x8000) bin += String.fromCharCode(...data.subarray(i, i + 0x8000));
        return { width: bmp.width, height: bmp.height, b64: btoa(bin) };
      },
      { b64: Buffer.from(bytes).toString('base64'), mime },
    );
    return { width: out.width, height: out.height, data: new Uint8Array(Buffer.from(out.b64, 'base64')) };
  } finally {
    await page.close();
  }
}
