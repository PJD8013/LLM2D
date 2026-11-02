import { BONE_CHANNELS, CH_ROT, CH_X, CH_Y, type SkeletonData } from './data.ts';
import { Skeleton } from './skeleton.ts';

export interface BendIssue {
  severity: 'error' | 'warning';
  /** What was moved: a bone name, or an IK constraint name for target moves. */
  control: string;
  /** Human-readable pose, e.g. "+45°" or "crouch 20%". */
  pose: string;
  slot: string;
  attachment: string;
  /** Triangles whose winding flipped (the art folds over itself). */
  flipped: number;
  /** Smallest / largest triangle area relative to setup pose. */
  minArea: number;
  maxArea: number;
  message: string;
}

export interface BendReport {
  ok: boolean;
  /** Controls exercised and the poses tried. */
  tested: { control: string; poses: string[] }[];
  issues: BendIssue[];
  /** Short human-readable summary. */
  summary: string;
}

export interface BendTestOptions {
  /** Joint angles that must bend cleanly, both directions. Default [45]. */
  angles?: number[];
  /** Extreme joint angles, reported as warnings only. Default [90]. */
  stress?: number[];
  /** IK crouch (target moved toward the chain root, as a fraction of reach). Default [0.2] and stress [0.4]. */
  crouch?: number[];
  crouchStress?: number[];
  /** IK swing (target rotated around the chain root, degrees). Default [20] and stress [40]. */
  swing?: number[];
  swingStress?: number[];
  /** Only test these bones / IK constraints. */
  only?: string[];
  /** Area ratio below which a triangle counts as collapsed. Default 0.15. */
  minArea?: number;
  /** Area ratio above which a triangle counts as overstretched. Default 4. */
  maxArea?: number;
}

/** One test pose: a control moved away from setup. `apply` expects a skeleton at setup pose. */
export interface BendPose {
  control: string;
  pose: string;
  /** Folds here are errors (false: stress pose, warnings only). */
  hard: boolean;
  /** Weighted meshes that bend in this pose, as [slot, attachment index]. */
  meshes: [number, number][];
  apply(skeleton: Skeleton): void;
}

/**
 * The poses the bend test uses (also used by the viewer to draw bend sheets):
 * - each bone that bends a mesh at its joint is rotated (IK chains excluded),
 * - each two-bone IK chain is bent by moving its target (crouch) and swung around its root.
 */
export function bendPoses(data: SkeletonData, options: BendTestOptions = {}): BendPose[] {
  const angles = options.angles ?? [45];
  const stress = options.stress ?? [90];
  const crouch = options.crouch ?? [0.2];
  const crouchStress = options.crouchStress ?? [0.4];
  const swing = options.swing ?? [20];
  const swingStress = options.swingStress ?? [40];
  const only = options.only ? new Set(options.only) : null;
  const poses: BendPose[] = [];

  const meshes = data.attachments.flatMap((list, slot) =>
    list
      .map((mesh, index) => ({ slot, index, bones: new Set(mesh.influenceBone), weighted: mesh.rigidBone < 0 && mesh.kind !== 'clipping' }))
      .filter((m) => m.weighted),
  );
  const subtree = data.bones.map((b) => {
    const set = new Set<number>([b.index]);
    for (const c of data.bones) if (c.index > b.index && set.has(c.parent)) set.add(c.index);
    return set;
  });
  // Chains driven by IK at setup are bent by moving their targets; FK chains are rotated.
  const activeIk = data.ik.filter((c) => c.mix > 0);
  const ikBones = new Set(activeIk.flatMap((c) => c.bones));
  /** Meshes that bend when the given set of bones moves relative to the rest. */
  const bending = (moved: Set<number>): [number, number][] =>
    meshes
      .filter(({ bones }) => [...bones].some((b) => moved.has(b)) && [...bones].some((b) => !moved.has(b)))
      .map(({ slot, index }) => [slot, index]);

  for (const b of data.bones) {
    if (ikBones.has(b.index) || (only && !only.has(b.name))) continue;
    const list = bending(subtree[b.index]);
    if (!list.length) continue;
    const add = (deg: number, hard: boolean) =>
      poses.push({
        control: b.name,
        pose: `${deg > 0 ? '+' : ''}${deg}°`,
        hard,
        meshes: list,
        apply: (sk) => {
          sk.channels[b.index * BONE_CHANNELS + CH_ROT] += deg;
        },
      });
    for (const a of angles) for (const s of [-1, 1]) add(a * s, true);
    for (const a of stress) for (const s of [-1, 1]) add(a * s, false);
  }

  const sk = new Skeleton(data);
  const world = data.bones.map((b) => sk.boneWorldPosition(b.index));
  for (const c of activeIk) {
    if (c.bones.length !== 2 || (only && !only.has(c.name))) continue;
    const [p, ch] = c.bones;
    // IK re-solves the chain's rotations, so every mesh the chain or target touches can bend.
    const moved = new Set<number>([...subtree[p], ...subtree[c.target]]);
    const list = meshes.filter(({ bones }) => [...bones].some((x) => moved.has(x))).map(({ slot, index }): [number, number] => [slot, index]);
    const [px, py] = world[p];
    const [tx, ty] = world[c.target];
    const [cx, cy] = world[ch];
    const reach = Math.hypot(cx - px, cy - py) + data.bones[ch].length;
    const parent = data.bones[c.target].parent;
    // World offset -> target bone's parent space (setup pose).
    const toLocal = (dx: number, dy: number): [number, number] => {
      if (parent < 0) return [dx, dy];
      const m = sk.world[parent];
      const det = m[0] * m[3] - m[1] * m[2] || 1;
      return [(m[3] * dx - m[2] * dy) / det, (-m[1] * dx + m[0] * dy) / det];
    };
    const add = (pose: string, hard: boolean, wx: number, wy: number) => {
      const [lx, ly] = toLocal(wx - tx, wy - ty);
      poses.push({
        control: c.name,
        pose,
        hard,
        meshes: list,
        apply: (s) => {
          s.channels[c.target * BONE_CHANNELS + CH_X] += lx;
          s.channels[c.target * BONE_CHANNELS + CH_Y] += ly;
        },
      });
    };
    const len = Math.hypot(px - tx, py - ty) || 1;
    const crouchAt = (f: number, hard: boolean) =>
      add(`crouch ${Math.round(f * 100)}%`, hard, tx + ((px - tx) / len) * f * reach, ty + ((py - ty) / len) * f * reach);
    const swingAt = (deg: number, hard: boolean) => {
      const r = (deg * Math.PI) / 180;
      const vx = tx - px;
      const vy = ty - py;
      add(`swing ${deg > 0 ? '+' : ''}${deg}°`, hard, px + vx * Math.cos(r) - vy * Math.sin(r), py + vx * Math.sin(r) + vy * Math.cos(r));
    };
    for (const f of crouch) crouchAt(f, true);
    for (const f of crouchStress) crouchAt(f, false);
    for (const a of swing) for (const s of [-1, 1]) swingAt(a * s, true);
    for (const a of swingStress) for (const s of [-1, 1]) swingAt(a * s, false);
  }
  return poses;
}

/**
 * Exercises a rig the way animation will and checks every weighted mesh for folds (flipped
 * triangles), collapse and overstretch:
 * - each bone that bends a mesh at its joint is rotated (IK chains excluded),
 * - each two-bone IK chain is bent by moving its target (crouch) and swung around its root.
 * IK chains are also checked for reaching their targets at setup.
 */
export function bendTest(data: SkeletonData, options: BendTestOptions = {}): BendReport {
  const minAreaLimit = options.minArea ?? 0.15;
  const maxAreaLimit = options.maxArea ?? 4;
  const sk = new Skeleton(data);
  const issues: BendIssue[] = [];
  const setupAreas = data.attachments.map((list) => list.map((mesh) => triangleAreas(mesh.vertices, mesh.triangles)));
  const buf = new Float32Array(Math.max(8, ...data.attachments.flat().map((m) => m.vertexCount * 2)));
  const poses = bendPoses(data, options);
  const tested = new Map<string, string[]>();

  for (const p of poses) {
    tested.set(p.control, [...(tested.get(p.control) ?? []), p.pose]);
    sk.setToSetupPose();
    p.apply(sk);
    sk.updateWorldTransform();
    for (const [slot, index] of p.meshes) {
      const mesh = data.attachments[slot][index];
      sk.attachments[slot] = index;
      sk.computeSlotVertices(slot, buf);
      const now = triangleAreas(buf, mesh.triangles);
      const base = setupAreas[slot][index];
      let flipped = 0;
      let minA = Infinity;
      let maxA = 0;
      for (let t = 0; t < base.length; t++) {
        if (Math.abs(base[t]) < 1e-3) continue;
        const r = now[t] / base[t];
        if (r <= 0) flipped++;
        minA = Math.min(minA, r);
        maxA = Math.max(maxA, r);
      }
      const problems: string[] = [];
      if (flipped) problems.push(`${flipped} triangle(s) fold over`);
      if (minA > 0 && minA < minAreaLimit) problems.push(`triangles shrink to ${(minA * 100).toFixed(0)}%`);
      if (maxA > maxAreaLimit) problems.push(`triangles stretch to ${(maxA * 100).toFixed(0)}%`);
      if (problems.length)
        issues.push({
          severity: p.hard && flipped ? 'error' : 'warning',
          control: p.control,
          pose: p.pose,
          slot: data.slots[slot].name,
          attachment: mesh.name,
          flipped,
          minArea: minA,
          maxArea: maxA,
          message: `${p.control} ${p.pose}: ${mesh.name} ${problems.join(', ')}`,
        });
    }
  }

  // IK reach at setup.
  sk.setToSetupPose();
  sk.updateWorldTransform();
  for (const c of data.ik) {
    if (c.bones.length !== 2) continue;
    const [p, ch] = c.bones;
    const [px, py] = sk.boneWorldPosition(p);
    const [cx, cy] = sk.boneWorldPosition(ch);
    const [tx, ty] = sk.boneWorldPosition(c.target);
    const reach = Math.hypot(cx - px, cy - py) + data.bones[ch].length;
    const d = Math.hypot(tx - px, ty - py);
    if (data.bones[ch].length <= 0)
      issues.push(ikIssue('error', c.name, `IK ${c.name}: child bone has no length, so it cannot reach the target`));
    else if (d > reach + 0.5)
      issues.push(ikIssue('warning', c.name, `IK ${c.name}: target is ${(d - reach).toFixed(1)} units out of reach at setup`));
  }

  const errors = issues.filter((i) => i.severity === 'error').length;
  const warnings = issues.length - errors;
  const meshCount = data.attachments.flat().filter((m) => m.rigidBone < 0 && m.kind !== 'clipping').length;
  const summary =
    `bend test: ${tested.size} control(s), ${meshCount} weighted mesh(es); ` +
    (issues.length ? `${errors} error(s), ${warnings} warning(s)` : 'clean');
  return { ok: errors === 0, tested: [...tested].map(([control, list]) => ({ control, poses: list })), issues, summary };
}

function ikIssue(severity: 'error' | 'warning', name: string, message: string): BendIssue {
  return { severity, control: name, pose: 'setup', slot: '', attachment: '', flipped: 0, minArea: 1, maxArea: 1, message };
}

function triangleAreas(v: Float32Array, tri: Uint32Array): Float64Array {
  const out = new Float64Array(tri.length / 3);
  for (let i = 0; i < tri.length; i += 3) {
    const a = tri[i] * 2;
    const b = tri[i + 1] * 2;
    const c = tri[i + 2] * 2;
    out[i / 3] = ((v[b] - v[a]) * (v[c + 1] - v[a + 1]) - (v[c] - v[a]) * (v[b + 1] - v[a + 1])) / 2;
  }
  return out;
}
