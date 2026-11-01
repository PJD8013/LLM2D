/** RGBA color with channels in 0..1. */
export interface RGBA {
  r: number;
  g: number;
  b: number;
  a: number;
}

const HEX = /^#?([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

export function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && HEX.test(value);
}

/** Parse "rrggbb" or "rrggbbaa" (optional leading #). */
export function parseColor(hex: string): RGBA {
  const m = HEX.exec(hex);
  if (!m) throw new Error(`Invalid color "${hex}", expected RRGGBB or RRGGBBAA`);
  const s = m[1];
  const n = (i: number) => parseInt(s.slice(i, i + 2), 16) / 255;
  return { r: n(0), g: n(2), b: n(4), a: s.length === 8 ? n(6) : 1 };
}

export function toHex({ r, g, b, a }: RGBA): string {
  const h = (v: number) =>
    Math.round(Math.min(1, Math.max(0, v)) * 255)
      .toString(16)
      .padStart(2, '0');
  return h(r) + h(g) + h(b) + h(a);
}
