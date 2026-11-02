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

/** The old file-safe name (ASCII only); still accepted as a key in rig specs. */
const legacyName = (s: string) => s.replace(/[^A-Za-z0-9_-]+/g, '_');
/** A slot / image name for a layer: its own name with spaces, slashes and the like as "_" (letters of any script kept). */
const idOf = (s: string) => s.replace(/[^\p{L}\p{N}_-]+/gu, '_').replace(/^_+|_+$/g, '') || 'layer';

const isPt = (p: unknown): p is Pt => Array.isArray(p) && p.length === 2 && p.every((v) => typeof v === 'number' && Number.isFinite(v));

/** Checks the parts of a spec that would otherwise fail deep inside the build (or never finish). */
function checkSpec(spec: RigSpec) {
  const bad = (msg: string): never => {
    throw new Error(`rig.json: ${msg}`);
  };
  if (!isPt(spec.origin)) bad('"origin" must be [x, y] in art pixels');
  if (spec.scale !== undefined && !(spec.scale > 0)) bad('"scale" must be above 0 (skeleton units per art pixel, e.g. 0.5 for @2x art)');
  if (!Array.isArray(spec.bones)) bad('"bones" must be a list');
  for (const b of spec.bones) {
    if (!b || typeof b.name !== 'string') bad('every bone needs a "name"');
    if (!isPt(b.from)) bad(`bone "${b.name}": "from" must be [x, y] in art pixels`);
    if (b.to !== undefined && !isPt(b.to)) bad(`bone "${b.name}": "to" must be [x, y] in art pixels`);
  }
  for (const c of spec.chains ?? []) {
    if (!isPt(c.start)) bad(`chain "${c.prefix}": "start" must be [x, y] in art pixels`);
    if (!(Number.isInteger(c.count) && c.count >= 1)) bad(`chain "${c.prefix}": "count" must be a whole number of bones (1 or more)`);
  }
  const mesh = (m: { spacing?: number; softness?: number; smooth?: number } | undefined, where: string) => {
    if (!m) return;
    if (m.spacing !== undefined && !(m.spacing >= 2)) bad(`${where}.spacing must be at least 2 (art pixels between mesh points)`);
    if (m.softness !== undefined && !(m.softness > 0)) bad(`${where}.softness must be above 0 (art pixels a joint blends over)`);
    if (m.smooth !== undefined && !(Number.isInteger(m.smooth) && m.smooth >= 0)) bad(`${where}.smooth must be a whole number, 0 or more`);
  };
  mesh(spec.mesh, 'mesh');
  for (const [name, part] of Object.entries(spec.parts ?? {})) mesh(part, `parts.${name}`);
}

interface LayerEntry {
  /** Name in the art (group path joined with "/"). */
  name: string;
  /** Slot / image name. */
  id: string;
  layer: Layer;
}

/** Builds an LLM2D skeleton from layered art and a rig spec. Throws with clear messages on bad input. */
export function buildRig(art: LayeredArt, spec: RigSpec, animations: Record<string, L2DAnimation> = {}): RigResult {
  checkSpec(spec);
  const s = spec.scale ?? 1;
  const [ox, oy] = spec.origin;
  const toSk = (x: number, y: number): Pt => [round((x - ox) * s), round((y - oy) * s)];
  const warnings: string[] = [...art.warnings];
  const meshDefaults = spec.mesh ?? {};
  const margin = meshDefaults.margin ?? 3;

  // Layers by their names in the art. Specs may also use the id or the older ASCII-only name.
  const entries: LayerEntry[] = [];
  const byName = new Map<string, LayerEntry>();
  const empty = new Set<string>();
  const ids = new Set<string>();
  for (const l of art.layers) {
    if (entries.some((e) => e.name === l.name)) throw new Error(`Two layers are named "${l.name}"; rename one in the art`);
    let id = idOf(l.name);
    for (let n = 2; ids.has(id); n++) id = `${idOf(l.name)}_${n}`;
    const t = trimLayer({ ...l, name: id }, margin + 2);
    if (!t) {
      warnings.push(`${l.name}: empty layer skipped`);
      empty.add(l.name);
      continue;
    }
    ids.add(id);
    const entry = { name: l.name, id, layer: t };
    entries.push(entry);
  }
  for (const e of entries) byName.set(e.name, e);
  for (const e of entries) if (!byName.has(e.id)) byName.set(e.id, e);
  for (const e of entries) if (!byName.has(legacyName(e.name))) byName.set(legacyName(e.name), e);
  const layerList = () => entries.map((e) => `"${e.name}"`).join(', ');
  const findLayer = (name: string, where: string): LayerEntry => {
    const e = byName.get(name);
    if (e) return e;
    if (empty.has(name)) throw new Error(`${where}: layer "${name}" is empty`);
    throw new Error(`${where}: no layer named "${name}". Layers: ${layerList()}`);
  };
  const partOf = (e: LayerEntry): RigPart | undefined => spec.parts?.[e.name] ?? spec.parts?.[e.id] ?? spec.parts?.[legacyName(e.name)];
  for (const key of Object.keys(spec.parts ?? {}))
    if (!byName.has(key) && !empty.has(key)) warnings.push(`parts."${key}": no layer with that name, ignored. Layers: ${layerList()}`);

  // Bones in world (skeleton) space.
  const world: WorldBone[] = [{ name: 'root', x: 0, y: 0 }];
  const segment = new Map<string, { a: Pt; b: Pt }>(); // in art pixels
  segment.set('root', { a: spec.origin, b: spec.origin });
  const addBone = (name: string, parent: string, from: Pt, to: Pt | undefined) => {
    if (segment.has(name)) throw new Error(`Bone "${name}" is defined twice`);
    if (!segment.has(parent)) throw new Error(`Bone "${name}": parent "${parent}" is not defined`);
    const [x, y] = toSk(from[0], from[1]);
    const b: WorldBone = { name, parent, x, y };
    if (to) {
      b.angle = round((Math.atan2(to[1] - from[1], to[0] - from[0]) * 180) / Math.PI);
      b.length = round(Math.hypot(to[0] - from[0], to[1] - from[1]) * s);
    }
    world.push(b);
    segment.set(name, { a: from, b: to ?? from });
  };
  // Bones whose parent is a chain bone wait until the chains are placed.
  const chainBones = new Set((spec.chains ?? []).flatMap((c) => Array.from({ length: c.count }, (_, i) => `${c.prefix}${i + 1}`)));
  let waiting = spec.bones.filter((b) => {
    if (b.parent && !segment.has(b.parent) && chainBones.has(b.parent)) return true;
    addBone(b.name, b.parent ?? 'root', b.from, b.to);
    return false;
  });

  const chains: Record<string, Pt[]> = {};
  for (const c of spec.chains ?? []) {
    const { layer, name } = findLayer(c.layer, `Chain "${c.prefix}"`);
    const local = (p: Pt): Pt => [p[0] - layer.x, p[1] - layer.y];
    let joints: Pt[];
    try {
      joints = chainJoints(layer.image, c.count, local(c.start), c.end && local(c.end)).map(([x, y]) => [round(x + layer.x, 1), round(y + layer.y, 1)] as Pt);
    } catch (e) {
      throw new Error(`Chain "${c.prefix}" (start [${c.start.join(', ')}]) on layer "${name}": ${(e as Error).message}`);
    }
    chains[c.prefix] = joints;
    // Few bones on a curled shape cut across it; the weights then pull on the wrong side.
    const opaque = alphaMask(layer.image);
    const off: string[] = [];
    for (let i = 0; i < c.count; i++) {
      const [a, b] = [joints[i], joints[i + 1]];
      let out = 0;
      for (let k = 0; k <= 20; k++) {
        const x = Math.round(a[0] + ((b[0] - a[0]) * k) / 20 - layer.x);
        const y = Math.round(a[1] + ((b[1] - a[1]) * k) / 20 - layer.y);
        if (x < 0 || y < 0 || x >= layer.image.width || y >= layer.image.height || !opaque[y * layer.image.width + x]) out++;
      }
      if (out > 8) off.push(`${c.prefix}${i + 1} ${Math.round((out / 21) * 100)}%`);
    }
    if (off.length) warnings.push(`chain "${c.prefix}": bones run outside the art (${off.join(', ')}); raise its count`);
    for (let i = 0; i < c.count; i++)
      addBone(`${c.prefix}${i + 1}`, i === 0 ? c.parent : `${c.prefix}${i}`, joints[i], joints[i + 1]);
  }
  while (waiting.length) {
    const before = waiting.length;
    waiting = waiting.filter((b) => {
      if (!segment.has(b.parent!)) return true;
      addBone(b.name, b.parent!, b.from, b.to);
      return false;
    });
    if (waiting.length === before) addBone(waiting[0].name, waiting[0].parent!, waiting[0].from, waiting[0].to); // throws: parent unknown
  }

  // Which slot each layer goes in. A layer that is alternate art (parts.slot, or hidden and
  // named "<slot layer>_...") goes in its base layer's slot, which keeps the base layer's place
  // in the draw order.
  const slotFor = new Map<LayerEntry, LayerEntry | null>(); // null: skipped
  for (const e of entries) {
    const part = partOf(e) ?? {};
    if (part.skip) {
      slotFor.set(e, null);
      continue;
    }
    if (part.slot) {
      slotFor.set(e, findLayer(part.slot, `Layer "${e.name}": parts.slot`));
      continue;
    }
    const hiddenEffect = e.layer.hidden && !!partOf(e);
    if (e.layer.hidden && !hiddenEffect) {
      // The longest matching name wins ("eye_l_closed" goes to "eye_l", not "eye").
      const base = entries
        .filter((b) => b !== e && !b.layer.hidden && e.id.startsWith(`${b.id}_`))
        .sort((a, b) => b.id.length - a.id.length)[0];
      if (!base) {
        warnings.push(
          `${e.name}: hidden layer skipped (list it in parts to use it as an effect that starts invisible, or give it a "slot" to use it as alternate art)`,
        );
        slotFor.set(e, null);
        continue;
      }
      slotFor.set(e, base);
      continue;
    }
    slotFor.set(e, e);
  }
  for (const [e, base] of slotFor) {
    if (!base || base === e) continue;
    if (slotFor.get(base) !== base) throw new Error(`Layer "${e.name}": its slot "${base.name}" is itself alternate art or skipped; point it at a layer that has its own slot`);
  }

  // Slots and attachments: base layers in art order (bottom first), then alternate art.
  const images: Record<string, L2DImage> = {};
  const pngs: Record<string, Buffer> = {};
  const slots: L2DSlot[] = [];
  const attachments: Record<string, Record<string, L2DAttachment>> = {};
  const parts: PartReport[] = [];
  const slotBones = new Map<string, string[]>();

  const order = [...entries.filter((e) => slotFor.get(e) === e), ...entries.filter((e) => slotFor.get(e) && slotFor.get(e) !== e)];
  for (const e of order) {
    const layer = e.layer;
    const base = slotFor.get(e)!;
    const part: RigPart = partOf(e) ?? {};
    const slotName = base.id;
    const isBase = base === e;
    const hiddenEffect = isBase && layer.hidden && !!partOf(e);
    let auto = !partOf(e);

    let boneNames = part.bones ?? (part.bone ? [part.bone] : undefined);
    if (!boneNames && !isBase) boneNames = slotBones.get(slotName);
    if (!boneNames) boneNames = autoBones(layer, segment);
    else auto = auto && !part.bones && !part.bone;
    for (const b of boneNames) if (!segment.has(b)) throw new Error(`Layer "${e.name}": unknown bone "${b}"`);
    if (isBase) slotBones.set(slotName, boneNames);

    const useMesh = part.mesh ?? boneNames.length > 1;
    const imgName = e.id;
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
      const spacingPx = part.spacing ?? meshDefaults.spacing ?? Math.min(64, Math.max(16, thickness(layer.image) / 3));
      for (const b of boneNames) {
        const { a, b: t } = segment.get(b)!;
        const len = Math.hypot(t[0] - a[0], t[1] - a[1]);
        const n = Math.max(1, Math.ceil(len / (spacingPx * 0.6)));
        for (let k = 0; k <= n; k++) extra.push([a[0] + ((t[0] - a[0]) * k) / n - layer.x, a[1] + ((t[1] - a[1]) * k) / n - layer.y]);
      }
      let mesh: ReturnType<typeof buildMesh>;
      try {
        mesh = buildMesh(layer.image, { spacing: spacingPx, tolerance: meshDefaults.tolerance, margin }, extra);
      } catch (err) {
        throw new Error(`Layer "${e.name}": ${(err as Error).message}`);
      }
      for (const wmsg of mesh.warnings) warnings.push(`${e.name}: ${wmsg}`);
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
        // A bone only reaches art it can "see" through the shape: no pulling across gaps.
        const opaque = alphaMask(layer.image);
        const { width: W, height: H } = layer.image;
        const inside = (sx: number, sy: number) => {
          const x = Math.floor(sx / s + ox - layer.x);
          const y = Math.floor(sy / s + oy - layer.y);
          return x >= 0 && y >= 0 && x < W && y < H && opaque[y * W + x] === 1;
        };
        attachment.weights = computeWeights(skPts, mesh.triangles, segs, mesh.spacing * s, {
          softness: softness === undefined ? undefined : softness * s,
          smooth: part.smooth ?? meshDefaults.smooth,
          inside,
          edge: (margin + 1.5) * s,
        });
      } else attachment.bones = boneNames;
      vertexCount = mesh.points.length;
      triCount = mesh.triangles.length / 3;
    }

    if (isBase) {
      const slot: L2DSlot = { name: slotName, bone: boneNames[0], attachment: layer.hidden && !hiddenEffect ? null : imgName };
      const blend = part.blend ?? layer.blend;
      if (blend !== 'normal') slot.blend = blend;
      const alpha = Math.min(1, Math.max(0, part.alpha ?? (hiddenEffect ? 0 : layer.opacity)));
      if (alpha < 1) slot.color = `ffffff${Math.round(alpha * 255).toString(16).padStart(2, '0')}`;
      slots.push(slot);
    } else {
      const slot = slots.find((sl) => sl.name === slotName)!;
      if (slot.attachment == null && !layer.hidden) slot.attachment = imgName;
    }
    (attachments[slotName] ??= {})[imgName] = attachment;
    parts.push({
      layer: e.name,
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

  // Clipping: a slot just below each clipped part, holding the clip layer's outline. It follows
  // the clip layer: its bone, or, for a bending mesh, the bones and weights of the nearest vertex.
  for (const e of entries) {
    const part = partOf(e);
    if (!part?.clip || part.skip) continue;
    const own = parts.find((p) => p.layer === e.name);
    if (!own) continue;
    const clipEntry = findLayer(part.clip, `Layer "${e.name}": parts.clip`);
    const clipPart = parts.find((p) => p.layer === clipEntry.name);
    if (!clipPart) throw new Error(`Layer "${e.name}": clip layer "${part.clip}" is not rigged (skipped or alternate art)`);
    const slotIndex = slots.findIndex((sl) => sl.name === own.slot);
    const clipSlot = `${own.slot}_clip`;
    if (slots.some((sl) => sl.name === clipSlot)) continue; // alternate art of the same slot
    const clipLayer = clipEntry.layer;
    const { width: w, height: h } = clipLayer.image;
    const { labels, list } = components(alphaMask(clipLayer.image, 127), w, h);
    if (!list.length) throw new Error(`Layer "${e.name}": clip layer "${part.clip}" is empty`);
    const outline = simplifyClosed(traceBoundary(labels, w, h, list[0]), 1);
    const vertices = outline.flatMap(([x, y]) => toSk(x + clipLayer.x, y + clipLayer.y));
    const clip: L2DAttachment = { type: 'clipping', vertices, end: own.slot };
    const source = attachments[clipPart.slot]?.[clipPart.attachment];
    if (source?.type === 'mesh' && source.weights && source.bones) {
      clip.bones = source.bones;
      clip.weights = [];
      for (let i = 0; i < vertices.length; i += 2) {
        let best = 0;
        let bd = Infinity;
        for (let j = 0; j < source.vertices.length; j += 2) {
          const d = (source.vertices[j] - vertices[i]) ** 2 + (source.vertices[j + 1] - vertices[i + 1]) ** 2;
          if (d < bd) {
            bd = d;
            best = j / 2;
          }
        }
        clip.weights.push([...source.weights[best]]);
      }
    }
    slots.splice(slotIndex, 0, { name: clipSlot, bone: clipPart.bones[0], attachment: clipSlot });
    attachments[clipSlot] = { [clipSlot]: clip };
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
