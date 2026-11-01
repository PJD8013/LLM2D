import type { L2DBone } from '@llm2d/core';

export interface WorldBone {
  name: string;
  parent?: string;
  /** Setup position in skeleton space. */
  x: number;
  y: number;
  /** World angle in degrees (0 = right, 90 = down, -90 = up). */
  angle?: number;
  length?: number;
}

export const round = (v: number, d = 3) => {
  const r = Math.round(v * 10 ** d) / 10 ** d;
  return Object.is(r, -0) ? 0 : r;
};

/**
 * Converts bones placed in world space (setup pose, unscaled) to the file's parent-local
 * bones. This is how rigs are authored: joints are picked on the picture.
 */
export function bonesFromWorld(list: WorldBone[]): L2DBone[] {
  const byName = new Map<string, WorldBone>();
  return list.map((b) => {
    const angle = b.angle ?? 0;
    const out: L2DBone = { name: b.name };
    if (b.parent) {
      const p = byName.get(b.parent);
      if (!p) throw new Error(`Bone "${b.name}": parent "${b.parent}" must be defined before it`);
      const pa = ((p.angle ?? 0) * Math.PI) / 180;
      const dx = b.x - p.x;
      const dy = b.y - p.y;
      out.parent = b.parent;
      out.x = round(Math.cos(-pa) * dx - Math.sin(-pa) * dy);
      out.y = round(Math.sin(-pa) * dx + Math.cos(-pa) * dy);
      out.rotation = round(angle - (p.angle ?? 0));
    } else {
      out.x = round(b.x);
      out.y = round(b.y);
      out.rotation = round(angle);
    }
    if (b.length) out.length = round(b.length);
    byName.set(b.name, b);
    return out;
  });
}
