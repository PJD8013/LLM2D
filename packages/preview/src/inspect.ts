import { composite, encodePng, type LayeredArt, type RigSpec } from '@llm2d/rig';
import { getBrowser } from './browser.ts';

export interface InspectOptions {
  /** Longest side of the output image in pixels (art is scaled down to fit). Default 1400. */
  maxSize?: number;
  /** Draw the spec's bones, chain starts and origin. */
  spec?: RigSpec;
}

const PALETTE = ['#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#008080', '#9a6324', '#800000'];

/**
 * Flattened art with a labelled pixel grid and layer boxes (and optionally the rig spec's
 * bones), so joint positions can be read straight off the picture. Labels are in art pixels
 * even when the image is scaled down.
 */
export async function inspectImage(art: LayeredArt, options: InspectOptions = {}): Promise<Buffer> {
  const { width: w, height: h } = art;
  const k = Math.min(1, (options.maxSize ?? 1400) / Math.max(w, h));
  const W = Math.round(w * k);
  const H = Math.round(h * k);
  // Grid step in art pixels: major lines at least ~70 screen pixels apart.
  const step = [10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000].find((s) => s * k >= 70) ?? 5000;
  const minor = step / 2;
  const png = encodePng(composite(art.layers, w, h)).toString('base64');
  const X = (x: number) => (x * k).toFixed(1);
  const parts: string[] = [];
  for (let x = 0; x <= w; x += minor)
    parts.push(`<line x1="${X(x)}" y1="0" x2="${X(x)}" y2="${H}" stroke="${x % step ? '#0002' : '#0005'}"/>`);
  for (let y = 0; y <= h; y += minor)
    parts.push(`<line x1="0" y1="${X(y)}" x2="${W}" y2="${X(y)}" stroke="${y % step ? '#0002' : '#0005'}"/>`);
  for (let x = step; x < w; x += step) parts.push(label(x * k + 3, 14, String(x), '#333'));
  for (let y = step; y < h; y += step) parts.push(label(3, y * k - 3, String(y), '#333'));
  art.layers.forEach((l, i) => {
    if (l.hidden) return;
    const c = PALETTE[i % PALETTE.length];
    parts.push(
      `<rect x="${X(l.x)}" y="${X(l.y)}" width="${X(l.image.width)}" height="${X(l.image.height)}" fill="none" stroke="${c}" stroke-dasharray="6 4" stroke-width="2"/>`,
    );
    parts.push(label(l.x * k + 4, l.y * k + 16, l.name, c));
  });
  const spec = options.spec;
  if (spec) {
    for (const b of spec.bones ?? []) {
      const t = b.to ?? b.from;
      parts.push(`<line x1="${X(b.from[0])}" y1="${X(b.from[1])}" x2="${X(t[0])}" y2="${X(t[1])}" stroke="#ff2d78" stroke-width="4" stroke-linecap="round"/>`);
      parts.push(`<circle cx="${X(b.from[0])}" cy="${X(b.from[1])}" r="6" fill="#ffd400" stroke="#000" stroke-width="1.5"/>`);
      parts.push(label(b.from[0] * k + 8, b.from[1] * k - 5, b.name, '#b0004a'));
    }
    for (const c of spec.chains ?? []) {
      parts.push(`<circle cx="${X(c.start[0])}" cy="${X(c.start[1])}" r="8" fill="none" stroke="#00b3ff" stroke-width="3"/>`);
      parts.push(label(c.start[0] * k + 10, c.start[1] * k + 4, `${c.prefix} chain`, '#006a99'));
      if (c.end) parts.push(`<circle cx="${X(c.end[0])}" cy="${X(c.end[1])}" r="5" fill="#00b3ff"/>`);
    }
    if (spec.origin) {
      const [ox, oy] = spec.origin.map((v) => v * k);
      parts.push(`<path d="M ${ox - 12} ${oy} H ${ox + 12} M ${ox} ${oy - 12} V ${oy + 12}" stroke="#000" stroke-width="3"/>`);
      parts.push(label(ox + 8, oy - 8, 'origin', '#000'));
    }
  }
  const html = `<html><body style="margin:0;background:#fff">
    <div style="position:relative;width:${W}px;height:${H}px">
      <img src="data:image/png;base64,${png}" style="position:absolute;left:0;top:0;width:${W}px;height:${H}px"/>
      <svg width="${W}" height="${H}" style="position:absolute;left:0;top:0;font:600 14px system-ui,sans-serif">${parts.join('')}</svg>
    </div></body></html>`;
  const page = await (await getBrowser()).newPage({ viewport: { width: W, height: H } });
  try {
    await page.setContent(html);
    return await page.screenshot({ clip: { x: 0, y: 0, width: W, height: H } });
  } finally {
    await page.close();
  }
}

function label(x: number, y: number, text: string, color: string): string {
  const safe = text.replace(/[<&>]/g, (c) => ({ '<': '&lt;', '&': '&amp;', '>': '&gt;' })[c]!);
  return `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" fill="${color}" stroke="#fff" stroke-width="4" paint-order="stroke">${safe}</text>`;
}
