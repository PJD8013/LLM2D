import {
  validate,
  type BlendMode,
  type L2DAnimation,
  type L2DAttachment,
  type L2DFile,
  type L2DIkConstraint,
  type L2DImage,
  type L2DSlot,
} from '@llm2d/core';
import { bonesFromWorld, round, type WorldBone } from './bones.ts';
import { chainJoints } from './chain.ts';
import { components, traceBoundary } from './contour.ts';
import { distToSegment, simplifyClosed, type Pt } from './geometry.ts';
import { alphaMask, encodePng, trimLayer, type Layer } from './image.ts';
import { buildMesh, thickness } from './mesh.ts';
import type { LayeredArt } from './psd.ts';
import { computeWeights, type BoneSegment } from './weights.ts';

/**
 * Rig specification: the part a person or an LLM decides by looking at the art. All
 * coordinates are art pixels (the PSD canvas), so joints can be read straight off the picture.
 */
export interface RigSpec {
  name: string;
  /** Skeleton units per art pixel. Use 0.5 for @2x art. Default 1. */
  scale?: number;
  /** Art pixel that becomes the skeleton origin (characters: between the feet; symbols: centre). */
  origin: Pt;
  /** Bones placed by joint: `from` is the joint, `to` gives direction and length. Parent defaults to "root". */
  bones: { name: string; parent?: string; from: Pt; to?: Pt }[];
  /** Bone chains placed automatically along the middle of a layer (tails, hair, scarves, ears). */
  chains?: RigChain[];
  /** Per-layer settings, keyed by layer name. Unlisted layers are assigned automatically. */
  parts?: Record<string, RigPart>;
  ik?: L2DIkConstraint[];
  /** Defaults for every mesh. */
  mesh?: { spacing?: number; tolerance?: number; margin?: number; softness?: number; smooth?: number };
  meta?: Record<string, unknown>;
}

export interface RigChain {
  layer: string;
  /** Bones are named prefix1, prefix2, ... */
  prefix: string;
  count: number;
  parent: string;
  /** Where the chain is rooted (art pixels). */
  start: Pt;
  /** Optional tip, to pick a branch or set the exact end. */
  end?: Pt;
}

export interface RigPart {
  /** Rigid: follow one bone. */
  bone?: string;
  /** Deform with several bones (makes a weighted mesh). */
  bones?: string[];
  /** Put this layer in another layer's slot as an alternate attachment (e.g. eyes_closed -> eyes). */
  slot?: string;
  /** Force a mesh (true) or a plain quad (false). Default: mesh when there are several bones. */
  mesh?: boolean;
  /** Vertex spacing in art pixels. */
  spacing?: number;
  /** Joint blend distance in art pixels (smaller = crisper joints). Default 0.75 x spacing. */
  softness?: number;
  /** Weight smoothing passes. Default 2. */
  smooth?: number;
  blend?: BlendMode;
  /**
   * Opacity at setup pose, 0..1. Default: the layer's opacity, or 0 for a layer hidden in the
   * art (hidden layers listed in parts become effects that animations fade in).
   */
  alpha?: number;
  /** Leave the layer out. */
  skip?: boolean;
  /**
   * Draw this layer only inside the outline of another layer (a shine sweeping across a coin,
   * clipped to the coin). Makes a clipping slot just below this one that follows that layer's bone.
   */
  clip?: string;
}

export interface PartReport {
  layer: string;
  slot: string;
  attachment: string;
  kind: 'region' | 'mesh';
  bones: string[];
  auto: boolean;
  vertices: number;
  triangles: number;
  hidden: boolean;
}

export interface RigResult {
  file: L2DFile;
  /** PNG per image name, to be written next to the file under `images/`. */
  images: Record<string, Buffer>;
  report: { parts: PartReport[]; chains: Record<string, Pt[]>; warnings: string[] };
}

const safeName = (s: string) => s.replace(/[^A-Za-z0-9_-]+/g, '_');

/** Builds an LLM2D skeleton from layered art and a rig spec. Throws with clear messages on bad input. */
export function buildRig(art: LayeredArt, spec: RigSpec, animations: Record<string, L2DAnimation> = {}): RigResult {
  const s = spec.scale ?? 1;
  const [ox, oy] = spec.origin;
  const toSk = (x: number, y: number): Pt => [round((x - ox) * s), round((y - oy) * s)];
  const warnings: string[] = [...art.warnings];
  const meshDefaults = spec.mesh ?? {};
  const margin = meshDefaults.margin ?? 3;

  // Trim and pad layers.
  const layers = new Map<string, Layer>();
  for (const l of art.layers) {
    const name = safeName(l.name);
    if (layers.has(name)) throw new Error(`Two layers are named "${name}"; rename one in the art`);
    const t = trimLayer({ ...l, name }, margin + 2);
    if (!t) {
      warnings.push(`${name}: empty layer skipped`);
      continue;
    }
    layers.set(name, t);
  }

  // Bones in world (skeleton) space.
  const world: WorldBone[] = [{ name: 'root', x: 0, y: 0 }];
  const segment = new Map<string, { a: Pt; b: Pt }>(); // in art pixels
  segment.set('root', { a: spec.origin, b: spec.origin });
  const addBone = (name: string, parent: string, from: Pt, to: Pt | undefined) => {
    if (segment.has(name)) throw new Error(`Bone "${name}" is defined twice`);
    if (!segment.has(parent)) throw new Error(`Bone "${name}": parent "${parent}" is not defined (yet)`);
    const [x, y] = toSk(from[0], from[1]);
    const b: WorldBone = { name, parent, x, y };
    if (to) {
      b.angle = round((Math.atan2(to[1] - from[1], to[0] - from[0]) * 180) / Math.PI);
      b.length = round(Math.hypot(to[0] - from[0], to[1] - from[1]) * s);
    }
    world.push(b);
    segment.set(name, { a: from, b: to ?? from });
  };
  for (const b of spec.bones) addBone(b.name, b.parent ?? 'root', b.from, b.to);

  const chains: Record<string, Pt[]> = {};
  for (const c of spec.chains ?? []) {
    const layer = layers.get(safeName(c.layer));
    if (!layer) throw new Error(`Chain "${c.prefix}": no layer named "${c.layer}"`);
    const local = (p: Pt): Pt => [p[0] - layer.x, p[1] - layer.y];
    const joints = chainJoints(layer.image, c.count, local(c.start), c.end && local(c.end)).map(
      ([x, y]) => [round(x + layer.x, 1), round(y + layer.y, 1)] as Pt,
    );
    chains[c.prefix] = joints;
    for (let i = 0; i < c.count; i++)
      addBone(`${c.prefix}${i + 1}`, i === 0 ? c.parent : `${c.prefix}${i}`, joints[i], joints[i + 1]);
  }

  // Slots and attachments, bottom layer first.
  const images: Record<string, L2DImage> = {};
  const pngs: Record<string, Buffer> = {};
  const slots: L2DSlot[] = [];
  const attachments: Record<string, Record<string, L2DAttachment>> = {};
  const parts: PartReport[] = [];

  for (const layer of layers.values()) {
    const part: RigPart = spec.parts?.[layer.name] ?? {};
    if (part.skip) continue;

    let slotName = part.slot ? safeName(part.slot) : layer.name;
    let auto = !spec.parts?.[layer.name];
    // A hidden layer listed in parts without a slot is an effect layer: its own slot, invisible at setup.
    const hiddenEffect = layer.hidden && !part.slot && !!spec.parts?.[layer.name];
    if (layer.hidden && !part.slot && !hiddenEffect) {
      // Alternate art: "eyes_closed" goes into slot "eyes" if that exists.
      const base = slots.find((sl) => layer.name.startsWith(`${sl.name}_`));
      if (!base) {
        warnings.push(
          `${layer.name}: hidden layer skipped (list it in parts to use it as an effect that starts invisible, or give it a "slot" to use it as alternate art)`,
        );
        continue;
      }
      slotName = base.name;
    }
    const existing = slots.find((sl) => sl.name === slotName);

    let boneNames = part.bones ?? (part.bone ? [part.bone] : undefined);
    if (!boneNames && existing) boneNames = [existing.bone];
    if (!boneNames) boneNames = autoBones(layer, segment);
    else auto = auto && !part.bones && !part.bone;
    for (const b of boneNames) if (!segment.has(b)) throw new Error(`Layer "${layer.name}": unknown bone "${b}"`);

    const useMesh = part.mesh ?? boneNames.length > 1;
    const imgName = layer.name;
    images[imgName] = { path: `images/${imgName}.png`, width: round(layer.image.width * s), height: round(layer.image.height * s) };
    pngs[imgName] = encodePng(layer.image);

    let attachment: L2DAttachment;
    let vertexCount = 4;
    let triCount = 2;
    if (!useMesh) {
      const [x, y] = toSk(layer.x + layer.image.width / 2, layer.y + layer.image.height / 2);
      attachment = { type: 'region', image: imgName, x, y };
    } else {
      // Sample points along the bones (inside the art) help the mesh bend cleanly.
      const extra: Pt[] = [];
      const spacingPx =
        part.spacing ?? meshDefaults.spacing ?? Math.min(64, Math.max(16, thickness(layer.image) / 3));
      for (const b of boneNames) {
        const { a, b: t } = segment.get(b)!;
        const len = Math.hypot(t[0] - a[0], t[1] - a[1]);
        const n = Math.max(1, Math.ceil(len / (spacingPx * 0.6)));
        for (let k = 0; k <= n; k++)
          extra.push([a[0] + ((t[0] - a[0]) * k) / n - layer.x, a[1] + ((t[1] - a[1]) * k) / n - layer.y]);
      }
      const mesh = buildMesh(layer.image, { spacing: spacingPx, tolerance: meshDefaults.tolerance, margin }, extra);
      for (const wmsg of mesh.warnings) warnings.push(`${layer.name}: ${wmsg}`);
      const vertices: number[] = [];
      const uvs: number[] = [];
      const skPts: Pt[] = mesh.points.map(([px, py]) => {
        const p = toSk(px + layer.x, py + layer.y);
        vertices.push(p[0], p[1]);
        uvs.push(round(px / layer.image.width, 5), round(py / layer.image.height, 5));
        return p;
      });
      attachment = { type: 'mesh', image: imgName, vertices, uvs, triangles: mesh.triangles, hull: mesh.hull };
      if (boneNames.length > 1) {
        const segs: BoneSegment[] = boneNames.map((b) => {
          const { a, b: t } = segment.get(b)!;
          const [x1, y1] = toSk(a[0], a[1]);
          const [x2, y2] = toSk(t[0], t[1]);
          return { x1, y1, x2, y2 };
        });
        attachment.bones = boneNames;
        const softness = part.softness ?? meshDefaults.softness;
        attachment.weights = computeWeights(skPts, mesh.triangles, segs, mesh.spacing * s, {
          softness: softness === undefined ? undefined : softness * s,
          smooth: part.smooth ?? meshDefaults.smooth,
        });
      } else attachment.bones = boneNames;
      vertexCount = mesh.points.length;
      triCount = mesh.triangles.length / 3;
    }

    if (!existing) {
      const slot: L2DSlot = { name: slotName, bone: boneNames[0], attachment: layer.hidden && !hiddenEffect ? null : imgName };
      const blend = part.blend ?? layer.blend;
      if (blend !== 'normal') slot.blend = blend;
      const alpha = Math.min(1, Math.max(0, part.alpha ?? (hiddenEffect ? 0 : layer.opacity)));
      if (alpha < 1) slot.color = `ffffff${Math.round(alpha * 255).toString(16).padStart(2, '0')}`;
      slots.push(slot);
    } else if (existing.attachment == null && !layer.hidden) existing.attachment = imgName;
    (attachments[slotName] ??= {})[imgName] = attachment;
    parts.push({
      layer: layer.name,
      slot: slotName,
      attachment: imgName,
      kind: attachment.type,
      bones: boneNames,
      auto,
      vertices: vertexCount,
      triangles: triCount,
      hidden: layer.hidden,
    });
  }

  // Clipping: a slot just below each clipped part, holding the clip layer's outline.
  for (const [layerName, part] of Object.entries(spec.parts ?? {})) {
    if (!part.clip || part.skip) continue;
    const own = parts.find((p) => p.layer === safeName(layerName));
    if (!own) throw new Error(`Layer "${layerName}": "clip" is set, but the layer is not in the art`);
    const clipLayer = layers.get(safeName(part.clip));
    const clipPart = parts.find((p) => p.layer === safeName(part.clip!));
    if (!clipLayer || !clipPart) throw new Error(`Layer "${layerName}": clip layer "${part.clip}" is not in the art`);
    const slotIndex = slots.findIndex((sl) => sl.name === own.slot);
    const clipSlot = `${own.slot}_clip`;
    if (slots.some((sl) => sl.name === clipSlot)) continue; // alternate art of the same slot
    const { width: w, height: h } = clipLayer.image;
    const { labels, list } = components(alphaMask(clipLayer.image, 127), w, h);
    if (!list.length) throw new Error(`Layer "${layerName}": clip layer "${part.clip}" is empty`);
    const outline = simplifyClosed(traceBoundary(labels, w, h, list[0]), 1);
    const vertices = outline.flatMap(([x, y]) => toSk(x + clipLayer.x, y + clipLayer.y));
    slots.splice(slotIndex, 0, { name: clipSlot, bone: clipPart.bones[0], attachment: clipSlot });
    attachments[clipSlot] = { [clipSlot]: { type: 'clipping', vertices, end: own.slot } };
  }

  const file: L2DFile = {
    format: 'llm2d',
    version: '0.1',
    name: spec.name,
    meta: { ...spec.meta, generator: '@llm2d/rig', scale: s, origin: spec.origin },
    images,
    bones: bonesFromWorld(world),
    slots,
    attachments,
    ...(spec.ik?.length ? { ik: spec.ik } : {}),
    animations,
  };
  const result = validate(file);
  if (!result.ok)
    throw new Error(`Generated skeleton is invalid:\n${result.errors.map((e) => `  ${e.path}: ${e.message}`).join('\n')}`);
  for (const w of result.warnings) if (!w.path.startsWith('animations')) warnings.push(`${w.path}: ${w.message}`);
  return { file, images: pngs, report: { parts, chains, warnings } };
}

/** Bones whose segment runs through the layer's art; falls back to the nearest bone. */
function autoBones(layer: Layer, segments: Map<string, { a: Pt; b: Pt }>): string[] {
  const { width: w, height: h } = layer.image;
  const mask = alphaMask(layer.image);
  const hits: string[] = [];
  for (const [name, { a, b }] of segments) {
    if (name === 'root') continue;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 1) continue;
    const n = Math.max(4, Math.ceil(len / 8));
    let inside = 0;
    for (let k = 0; k <= n; k++) {
      const x = Math.round(a[0] + ((b[0] - a[0]) * k) / n - layer.x);
      const y = Math.round(a[1] + ((b[1] - a[1]) * k) / n - layer.y);
      if (x >= 0 && y >= 0 && x < w && y < h && mask[y * w + x]) inside++;
    }
    if (inside / (n + 1) >= 0.5) hits.push(name);
  }
  if (hits.length) return hits;
  const cx = layer.x + w / 2;
  const cy = layer.y + h / 2;
  let best = 'root';
  let bd = Infinity;
  for (const [name, { a, b }] of segments) {
    const d = distToSegment(cx, cy, a[0], a[1], b[0], b[1]).d;
    if (d < bd) {
      bd = d;
      best = name;
    }
  }
  return [best];
}
