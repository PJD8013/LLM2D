import { parseColor, type RGBA } from './color.ts';
import { resolveCurve, type EaseFn } from './curves.ts';
import type { BlendMode, L2DAnimation, L2DFile, L2DImage, L2DMeshAttachment, L2DRegionAttachment } from './format.ts';
import { compose, invert, mat, multiply, type Mat2D } from './math.ts';
import { validate } from './validate.ts';

/** Number of animatable channels per bone: rotation, x, y, scaleX, scaleY. */
export const BONE_CHANNELS = 5;
export const CH_ROT = 0;
export const CH_X = 1;
export const CH_Y = 2;
export const CH_SX = 3;
export const CH_SY = 4;
/** Number of animatable channels per slot: r, g, b, a. */
export const SLOT_CHANNELS = 4;

export interface BoneData {
  index: number;
  name: string;
  parent: number;
  x: number;
  y: number;
  rotation: number;
  scaleX: number;
  scaleY: number;
  length: number;
}

export interface SlotData {
  index: number;
  name: string;
  bone: number;
  /** Index into `SkeletonData.attachments[slot]`, or -1. */
  attachment: number;
  color: RGBA;
  blend: BlendMode;
}

/** Every attachment is compiled to a mesh. Regions become 4-vertex quads. */
export interface MeshData {
  name: string;
  slot: number;
  image: string;
  kind: 'region' | 'mesh';
  vertexCount: number;
  /** Skeleton-space positions at setup pose. */
  vertices: Float32Array;
  uvs: Float32Array;
  triangles: Uint32Array;
  hull: number;
  /**
   * Influences in CSR form: vertex v uses entries influenceStart[v]..influenceStart[v+1]-1
   * of influenceBone (skeleton bone index) and influenceWeight.
   */
  influenceStart: Uint32Array;
  influenceBone: Int32Array;
  influenceWeight: Float32Array;
  /** Set when the whole mesh follows one bone (fast path). */
  rigidBone: number;
}

export interface IkData {
  index: number;
  name: string;
  bones: number[];
  target: number;
  bendPositive: boolean;
  mix: number;
}

export type TimelineOp = 'add' | 'mul' | 'set';

export interface CurveTimeline {
  kind: 'curve';
  /** Channel indices written by this timeline (1 for scalars, 2 for vec2, 4 for colors). */
  channels: number[];
  op: TimelineOp;
  times: Float32Array;
  /** keyCount * channels.length values. */
  values: Float32Array;
  curves: EaseFn[];
}

export interface AttachmentTimeline {
  kind: 'attachment';
  slot: number;
  times: Float32Array;
  /** Attachment index per key, -1 = hidden. */
  values: Int16Array;
}

export type Timeline = CurveTimeline | AttachmentTimeline;

export interface EventData {
  time: number;
  name: string;
  payload: Record<string, unknown>;
}

export class AnimationData {
  readonly name: string;
  readonly duration: number;
  readonly timelines: Timeline[];
  /** Continuous channels this animation keys. */
  readonly channels: Int32Array;
  /** Slots whose attachment this animation keys. */
  readonly attachmentSlots: Int32Array;
  readonly events: EventData[];

  constructor(name: string, duration: number, timelines: Timeline[], events: EventData[]) {
    this.name = name;
    this.duration = duration;
    this.timelines = timelines;
    this.events = events;
    const ch = new Set<number>();
    const slots: number[] = [];
    for (const t of timelines) {
      if (t.kind === 'curve') t.channels.forEach((c) => ch.add(c));
      else slots.push(t.slot);
    }
    this.channels = Int32Array.from([...ch].sort((a, b) => a - b));
    this.attachmentSlots = Int32Array.from(slots);
  }

  /**
   * Writes the sampled target value of every keyed channel into `out`, and the keyed
   * attachments into `attachmentsOut`. Untouched channels keep their current value.
   */
  sample(time: number, setup: Float32Array, out: Float32Array, attachmentsOut: Int16Array): void {
    for (const tl of this.timelines) {
      const times = tl.times;
      const n = times.length;
      // Last key at or before `time` (keys are sorted).
      let i = 0;
      if (time >= times[n - 1]) i = n - 1;
      else if (time > times[0]) {
        let lo = 0;
        let hi = n - 1;
        while (hi - lo > 1) {
          const mid = (lo + hi) >> 1;
          if (times[mid] <= time) lo = mid;
          else hi = mid;
        }
        i = lo;
      }
      if (tl.kind === 'attachment') {
        attachmentsOut[tl.slot] = time < times[0] ? tl.values[0] : tl.values[i];
        continue;
      }
      const w = tl.channels.length;
      let t = 0;
      let j = i;
      if (i < n - 1 && time > times[i]) {
        j = i + 1;
        t = tl.curves[i]((time - times[i]) / (times[j] - times[i] || 1));
      }
      for (let c = 0; c < w; c++) {
        const a = tl.values[i * w + c];
        const v = j === i ? a : a + (tl.values[j * w + c] - a) * t;
        const ch = tl.channels[c];
        out[ch] = tl.op === 'add' ? setup[ch] + v : tl.op === 'mul' ? setup[ch] * v : v;
      }
    }
  }
}

/**
 * Immutable, compiled skeleton data. Build one per file and share it between instances.
 */
export class SkeletonData {
  readonly name: string;
  readonly images: Record<string, L2DImage>;
  readonly bones: BoneData[];
  readonly slots: SlotData[];
  /** attachments[slotIndex] = list of compiled attachments for that slot. */
  readonly attachments: MeshData[][];
  readonly ik: IkData[];
  readonly animations: Map<string, AnimationData>;
  readonly channelCount: number;
  readonly slotChannelBase: number;
  readonly ikChannelBase: number;
  /** Setup values of every channel. */
  readonly setupChannels: Float32Array;
  /** 1 for rotation channels (blended along the shortest arc when mixing). */
  readonly angleChannels: Uint8Array;
  readonly setupAttachments: Int16Array;
  /** Bone world matrices at setup pose (before IK). */
  readonly setupWorld: Mat2D[];
  readonly inverseBind: Mat2D[];
  readonly bounds: { x: number; y: number; width: number; height: number };
  readonly source: L2DFile;

  private readonly boneByName = new Map<string, number>();
  private readonly slotByName = new Map<string, number>();
  private readonly ikByName = new Map<string, number>();
  private readonly attachmentByName: Map<string, number>[] = [];

  /** Validates and compiles a parsed `.l2d.json`. Throws with all errors if invalid. */
  static fromJSON(json: unknown): SkeletonData {
    const result = validate(json);
    if (!result.ok) {
      const lines = result.errors.slice(0, 20).map((e) => `  ${e.path || '(root)'}: ${e.message}`);
      const more = result.errors.length > 20 ? `\n  ...and ${result.errors.length - 20} more` : '';
      throw new Error(`Invalid LLM2D file:\n${lines.join('\n')}${more}`);
    }
    return new SkeletonData(json as L2DFile);
  }

  /** Use `SkeletonData.fromJSON` unless the file was already validated. */
  constructor(file: L2DFile) {
    this.source = file;
    this.name = file.name;
    this.images = file.images;

    this.bones = file.bones.map((b, index) => {
      const parent = b.parent === undefined ? -1 : this.boneByName.get(b.parent)!;
      this.boneByName.set(b.name, index);
      return {
        index,
        name: b.name,
        parent,
        x: b.x ?? 0,
        y: b.y ?? 0,
        rotation: b.rotation ?? 0,
        scaleX: b.scaleX ?? 1,
        scaleY: b.scaleY ?? 1,
        length: b.length ?? 0,
      };
    });

    // Setup world transforms and inverse bind matrices.
    this.setupWorld = [];
    this.inverseBind = [];
    const local = mat();
    for (const b of this.bones) {
      compose(local, b.x, b.y, b.rotation, b.scaleX, b.scaleY);
      const w = mat();
      if (b.parent < 0) w.set(local);
      else multiply(w, this.setupWorld[b.parent], local);
      this.setupWorld.push(w);
      this.inverseBind.push(invert(mat(), w));
    }

    // Slots and attachments.
    this.slots = [];
    this.attachments = [];
    file.slots.forEach((s, index) => {
      this.slotByName.set(s.name, index);
      const byName = new Map<string, number>();
      const list: MeshData[] = [];
      const bone = this.boneByName.get(s.bone)!;
      for (const [name, a] of Object.entries(file.attachments[s.name] ?? {})) {
        byName.set(name, list.length);
        list.push(
          a.type === 'region'
            ? this.compileRegion(name, index, bone, a)
            : this.compileMesh(name, index, bone, a),
        );
      }
      this.attachmentByName.push(byName);
      this.attachments.push(list);
      this.slots.push({
        index,
        name: s.name,
        bone,
        attachment: s.attachment == null ? -1 : byName.get(s.attachment)!,
        color: parseColor(s.color ?? 'ffffffff'),
        blend: s.blend ?? 'normal',
      });
    });

    this.ik = (file.ik ?? []).map((c, index) => {
      this.ikByName.set(c.name, index);
      return {
        index,
        name: c.name,
        bones: c.bones.map((b) => this.boneByName.get(b)!),
        target: this.boneByName.get(c.target)!,
        bendPositive: c.bendPositive ?? true,
        mix: c.mix ?? 1,
      };
    });

    // Channel layout.
    this.slotChannelBase = this.bones.length * BONE_CHANNELS;
    this.ikChannelBase = this.slotChannelBase + this.slots.length * SLOT_CHANNELS;
    this.channelCount = this.ikChannelBase + this.ik.length;
    this.setupChannels = new Float32Array(this.channelCount);
    this.angleChannels = new Uint8Array(this.channelCount);
    for (const b of this.bones) {
      const o = b.index * BONE_CHANNELS;
      this.setupChannels.set([b.rotation, b.x, b.y, b.scaleX, b.scaleY], o);
      this.angleChannels[o + CH_ROT] = 1;
    }
    for (const s of this.slots) {
      this.setupChannels.set([s.color.r, s.color.g, s.color.b, s.color.a], this.slotChannelBase + s.index * SLOT_CHANNELS);
    }
    for (const c of this.ik) this.setupChannels[this.ikChannelBase + c.index] = c.mix;
    this.setupAttachments = Int16Array.from(this.slots.map((s) => s.attachment));

    this.animations = new Map();
    for (const [name, a] of Object.entries(file.animations)) this.animations.set(name, this.compileAnimation(name, a));

    this.bounds = file.bounds ?? this.computeSetupBounds();
  }

  findBone(name: string): number {
    return this.boneByName.get(name) ?? -1;
  }
  findSlot(name: string): number {
    return this.slotByName.get(name) ?? -1;
  }
  findIk(name: string): number {
    return this.ikByName.get(name) ?? -1;
  }
  findAttachment(slot: number, name: string): number {
    return this.attachmentByName[slot]?.get(name) ?? -1;
  }
  boneChannel(bone: number, channel: number): number {
    return bone * BONE_CHANNELS + channel;
  }
  slotChannel(slot: number, channel: number): number {
    return this.slotChannelBase + slot * SLOT_CHANNELS + channel;
  }

  private compileRegion(name: string, slot: number, bone: number, a: L2DRegionAttachment): MeshData {
    const img = this.images[a.image];
    const hw = ((a.width ?? img.width) * (a.scaleX ?? 1)) / 2;
    const hh = ((a.height ?? img.height) * (a.scaleY ?? 1)) / 2;
    const m = compose(mat(), a.x, a.y, a.rotation ?? 0, 1, 1);
    const corners = [-hw, -hh, hw, -hh, hw, hh, -hw, hh];
    const vertices = new Float32Array(8);
    for (let i = 0; i < 8; i += 2) {
      vertices[i] = m[0] * corners[i] + m[2] * corners[i + 1] + m[4];
      vertices[i + 1] = m[1] * corners[i] + m[3] * corners[i + 1] + m[5];
    }
    return {
      name,
      slot,
      image: a.image,
      kind: 'region',
      vertexCount: 4,
      vertices,
      uvs: Float32Array.from([0, 0, 1, 0, 1, 1, 0, 1]),
      triangles: Uint32Array.from([0, 1, 2, 0, 2, 3]),
      hull: 4,
      influenceStart: Uint32Array.from([0, 1, 2, 3, 4]),
      influenceBone: Int32Array.from([bone, bone, bone, bone]),
      influenceWeight: Float32Array.from([1, 1, 1, 1]),
      rigidBone: bone,
    };
  }

  private compileMesh(name: string, slot: number, slotBone: number, a: L2DMeshAttachment): MeshData {
    const n = a.vertices.length / 2;
    const start = new Uint32Array(n + 1);
    const bones: number[] = [];
    const weights: number[] = [];
    let rigidBone = -1;
    if (!a.weights) {
      rigidBone = a.bones?.length ? this.boneByName.get(a.bones[0])! : slotBone;
      for (let v = 0; v < n; v++) {
        start[v] = v;
        bones.push(rigidBone);
        weights.push(1);
      }
      start[n] = n;
    } else {
      const local = a.bones!.map((b) => this.boneByName.get(b)!);
      for (let v = 0; v < n; v++) {
        start[v] = bones.length;
        const w = a.weights[v];
        let sum = 0;
        for (let k = 1; k < w.length; k += 2) sum += w[k];
        for (let k = 0; k < w.length; k += 2) {
          if (w[k + 1] <= 0) continue;
          bones.push(local[w[k]]);
          weights.push(sum > 0 ? w[k + 1] / sum : 1 / (w.length / 2));
        }
      }
      start[n] = bones.length;
    }
    return {
      name,
      slot,
      image: a.image,
      kind: 'mesh',
      vertexCount: n,
      vertices: Float32Array.from(a.vertices),
      uvs: Float32Array.from(a.uvs),
      triangles: Uint32Array.from(a.triangles),
      hull: a.hull ?? n,
      influenceStart: start,
      influenceBone: Int32Array.from(bones),
      influenceWeight: Float32Array.from(weights),
      rigidBone,
    };
  }

  private compileAnimation(name: string, a: L2DAnimation): AnimationData {
    const timelines: Timeline[] = [];
    let maxTime = 0;
    const curveTimeline = (
      channels: number[],
      op: TimelineOp,
      keys: { time: number; curve?: unknown }[],
      read: (k: any) => number[],
    ) => {
      const w = channels.length;
      const values = new Float32Array(keys.length * w);
      keys.forEach((k, i) => values.set(read(k), i * w));
      maxTime = Math.max(maxTime, keys[keys.length - 1].time);
      timelines.push({
        kind: 'curve',
        channels,
        op,
        times: Float32Array.from(keys.map((k) => k.time)),
        values,
        curves: keys.map((k) => resolveCurve(k.curve)!),
      });
    };

    for (const [boneName, tl] of Object.entries(a.bones ?? {})) {
      const b = this.boneByName.get(boneName)!;
      const o = b * BONE_CHANNELS;
      if (tl.rotate) curveTimeline([o + CH_ROT], 'add', tl.rotate, (k) => [k.value]);
      if (tl.translate) curveTimeline([o + CH_X, o + CH_Y], 'add', tl.translate, (k) => [k.x ?? 0, k.y ?? 0]);
      if (tl.scale) curveTimeline([o + CH_SX, o + CH_SY], 'mul', tl.scale, (k) => [k.x ?? 1, k.y ?? 1]);
    }
    for (const [slotName, tl] of Object.entries(a.slots ?? {})) {
      const s = this.slotByName.get(slotName)!;
      const o = this.slotChannelBase + s * SLOT_CHANNELS;
      if (tl.color)
        curveTimeline([o, o + 1, o + 2, o + 3], 'set', tl.color, (k) => {
          const c = parseColor(k.value);
          return [c.r, c.g, c.b, c.a];
        });
      if (tl.alpha) curveTimeline([o + 3], 'set', tl.alpha, (k) => [k.value]);
      if (tl.attachment) {
        maxTime = Math.max(maxTime, tl.attachment[tl.attachment.length - 1].time);
        timelines.push({
          kind: 'attachment',
          slot: s,
          times: Float32Array.from(tl.attachment.map((k) => k.time)),
          values: Int16Array.from(tl.attachment.map((k) => (k.name === null ? -1 : this.findAttachment(s, k.name)))),
        });
      }
    }
    for (const [ikName, tl] of Object.entries(a.ik ?? {})) {
      const c = this.ikByName.get(ikName)!;
      if (tl.mix) curveTimeline([this.ikChannelBase + c], 'set', tl.mix, (k) => [k.value]);
    }
    const events = (a.events ?? [])
      .map(({ time, name, ...payload }) => ({ time, name, payload }))
      .sort((x, y) => x.time - y.time);
    for (const e of events) maxTime = Math.max(maxTime, e.time);
    return new AnimationData(name, a.duration ?? maxTime, timelines, events);
  }

  private computeSetupBounds() {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    this.slots.forEach((s) => {
      // Effects that start invisible (glows, flashes) should not inflate the framing.
      if (s.attachment < 0 || s.color.a <= 0) return;
      const v = this.attachments[s.index][s.attachment].vertices;
      for (let i = 0; i < v.length; i += 2) {
        minX = Math.min(minX, v[i]);
        maxX = Math.max(maxX, v[i]);
        minY = Math.min(minY, v[i + 1]);
        maxY = Math.max(maxY, v[i + 1]);
      }
    });
    if (minX === Infinity) return { x: 0, y: 0, width: 0, height: 0 };
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  }
}
