import { BONE_CHANNELS, CH_ROT, CH_SX, CH_SY, CH_X, CH_Y, SLOT_CHANNELS, type SkeletonData } from './data.ts';
import { DEG, clamp, compose, invert, lerpAngle, mat, multiply, type Mat2D } from './math.ts';

/**
 * A posable instance of SkeletonData. Holds the current pose as a flat channel array
 * (written by animations) and derives bone world transforms and deformed vertices from it.
 */
export class Skeleton {
  readonly data: SkeletonData;
  /** Current value of every animatable channel (see SkeletonData channel layout). */
  readonly channels: Float32Array;
  /** Current attachment index per slot, -1 = hidden. */
  readonly attachments: Int16Array;
  /** Bone world matrices in skeleton space. Valid after updateWorldTransform(). */
  readonly world: Mat2D[];

  private readonly local = mat();
  private readonly tmp = mat();
  private readonly skin: Float64Array;
  /** Channels as animated, kept while IK rotates bones for the world transforms only. */
  private readonly beforeIk: Float32Array;

  constructor(data: SkeletonData) {
    this.data = data;
    this.channels = new Float32Array(data.channelCount);
    this.attachments = new Int16Array(data.slots.length);
    this.world = data.bones.map(() => mat());
    this.skin = new Float64Array(data.bones.length * 6);
    this.beforeIk = new Float32Array(data.channelCount);
    this.setToSetupPose();
    this.updateWorldTransform();
  }

  setToSetupPose(): void {
    this.channels.set(this.data.setupChannels);
    this.attachments.set(this.data.setupAttachments);
  }

  /**
   * Recomputes bone world transforms, then solves IK constraints in order. IK changes the world
   * transforms only; `channels` keep the animated values, so calling this again gives the same pose.
   */
  updateWorldTransform(): void {
    this.updateBones(0);
    let saved = false;
    for (const ik of this.data.ik) {
      const mix = clamp(this.channels[this.data.ikChannelBase + ik.index], 0, 1);
      if (!(mix > 0)) continue;
      if (!saved) {
        this.beforeIk.set(this.channels);
        saved = true;
      }
      if (ik.bones.length === 1) this.solveAim(ik.bones[0], ik.target, mix);
      else this.solveLimb(ik.bones[0], ik.bones[1], ik.target, ik.bendPositive, mix);
      this.updateBones(ik.bones[0]);
    }
    if (saved) this.channels.set(this.beforeIk);
    // Skinning matrices: world * inverseBind.
    for (let i = 0; i < this.world.length; i++) {
      multiply(this.tmp, this.world[i], this.data.inverseBind[i]);
      this.skin.set(this.tmp, i * 6);
    }
  }

  private updateBones(from: number): void {
    const bones = this.data.bones;
    const ch = this.channels;
    for (let i = from; i < bones.length; i++) {
      const o = i * BONE_CHANNELS;
      compose(this.local, ch[o + CH_X], ch[o + CH_Y], ch[o + CH_ROT], ch[o + CH_SX], ch[o + CH_SY]);
      const p = bones[i].parent;
      if (p < 0) this.world[i].set(this.local);
      else multiply(this.world[i], this.world[p], this.local);
    }
  }

  /** Target position expressed in the local space of `bone`'s parent. */
  private targetInParent(bone: number, target: number): [number, number] {
    const tw = this.world[target];
    const p = this.data.bones[bone].parent;
    if (p < 0) return [tw[4], tw[5]];
    const inv = invert(this.tmp, this.world[p]);
    return [inv[0] * tw[4] + inv[2] * tw[5] + inv[4], inv[1] * tw[4] + inv[3] * tw[5] + inv[5]];
  }

  private solveAim(bone: number, target: number, mix: number): void {
    const o = bone * BONE_CHANNELS;
    const ch = this.channels;
    const [tx, ty] = this.targetInParent(bone, target);
    const dx = tx - ch[o + CH_X];
    const dy = ty - ch[o + CH_Y];
    if (dx * dx + dy * dy < 1e-12) return;
    let desired = Math.atan2(dy, dx) / DEG;
    if (ch[o + CH_SX] < 0) desired += 180;
    ch[o + CH_ROT] = lerpAngle(ch[o + CH_ROT], desired, mix);
  }

  /**
   * Analytic two-bone IK in the parent bone's parent space. The parent bone may be scaled or
   * mirrored; the child's origin may sit anywhere in the parent's space.
   */
  private solveLimb(parent: number, child: number, target: number, bendPositive: boolean, mix: number): void {
    const ch = this.channels;
    const po = parent * BONE_CHANNELS;
    const co = child * BONE_CHANNELS;
    const px = ch[po + CH_X];
    const py = ch[po + CH_Y];
    const sp = ch[po + CH_SX];
    // Parent -> child origin, in the parent's unrotated frame.
    const vx = ch[co + CH_X] * sp;
    const vy = ch[co + CH_Y] * ch[po + CH_SY];
    const l1 = Math.hypot(vx, vy);
    const l2 = Math.abs(this.data.bones[child].length * ch[co + CH_SX] * sp);
    if (l1 < 1e-6 || l2 < 1e-6) {
      this.solveAim(parent, target, mix);
      return;
    }
    const delta = Math.atan2(vy, vx);
    const [tx, ty] = this.targetInParent(parent, target);
    const dx = tx - px;
    const dy = ty - py;
    const d = clamp(Math.hypot(dx, dy), Math.abs(l1 - l2) + 1e-6, l1 + l2 - 1e-6);
    const base = Math.atan2(dy, dx);
    const a1 = Math.acos(clamp((l1 * l1 + d * d - l2 * l2) / (2 * l1 * d), -1, 1));
    const theta = bendPositive ? base - a1 : base + a1; // direction parent -> child origin
    const ex = px + l1 * Math.cos(theta);
    const ey = py + l1 * Math.sin(theta);
    const parentRot = (theta - delta) / DEG;
    let childWorld = Math.atan2(ty - ey, tx - ex);
    if (Math.hypot(tx - ex, ty - ey) < 1e-6) childWorld = theta;
    // The child's x axis seen from the parent's parent is R(parentRot) * S(sx, sy) * R(childRot) * x,
    // so undo the parent's (possibly mirrored or uneven) scale on the wanted direction.
    const want = childWorld - parentRot * DEG;
    let childRot = Math.atan2(Math.sin(want) / (ch[po + CH_SY] || 1), Math.cos(want) / (sp || 1)) / DEG;
    if (ch[co + CH_SX] < 0) childRot += 180;
    ch[po + CH_ROT] = lerpAngle(ch[po + CH_ROT], parentRot, mix);
    ch[co + CH_ROT] = lerpAngle(ch[co + CH_ROT], childRot, mix);
  }

  /**
   * Writes the deformed skeleton-space vertices of the slot's current attachment into `out`
   * ([x, y, ...]). Returns the vertex count, or 0 if the slot shows nothing.
   */
  computeSlotVertices(slot: number, out: Float32Array): number {
    const a = this.attachments[slot];
    if (a < 0) return 0;
    const mesh = this.data.attachments[slot][a];
    const v = mesh.vertices;
    const n = mesh.vertexCount;
    const s = this.skin;
    if (mesh.rigidBone >= 0) {
      const o = mesh.rigidBone * 6;
      for (let i = 0; i < n * 2; i += 2) {
        out[i] = s[o] * v[i] + s[o + 2] * v[i + 1] + s[o + 4];
        out[i + 1] = s[o + 1] * v[i] + s[o + 3] * v[i + 1] + s[o + 5];
      }
      return n;
    }
    const start = mesh.influenceStart;
    for (let i = 0; i < n; i++) {
      const x = v[i * 2];
      const y = v[i * 2 + 1];
      let ox = 0;
      let oy = 0;
      for (let k = start[i]; k < start[i + 1]; k++) {
        const o = mesh.influenceBone[k] * 6;
        const w = mesh.influenceWeight[k];
        ox += (s[o] * x + s[o + 2] * y + s[o + 4]) * w;
        oy += (s[o + 1] * x + s[o + 3] * y + s[o + 5]) * w;
      }
      out[i * 2] = ox;
      out[i * 2 + 1] = oy;
    }
    return n;
  }

  /** Current slot tint as [r, g, b, a] in 0..1. */
  slotColor(slot: number): [number, number, number, number] {
    const o = this.data.slotChannelBase + slot * SLOT_CHANNELS;
    const c = this.channels;
    return [clamp(c[o], 0, 1), clamp(c[o + 1], 0, 1), clamp(c[o + 2], 0, 1), clamp(c[o + 3], 0, 1)];
  }

  /** World position of a bone's origin, in skeleton space. */
  boneWorldPosition(bone: number): [number, number] {
    const w = this.world[bone];
    return [w[4], w[5]];
  }

  /** World position of a bone's tip (origin + length along its x axis). */
  boneWorldTip(bone: number): [number, number] {
    const w = this.world[bone];
    const l = this.data.bones[bone].length;
    return [w[0] * l + w[4], w[1] * l + w[5]];
  }

  /** World rotation of a bone in degrees. */
  boneWorldRotation(bone: number): number {
    const w = this.world[bone];
    return Math.atan2(w[1], w[0]) / DEG;
  }

  /** Convenience: set a bone channel by name (e.g. for procedural look-at). */
  setBoneLocal(name: string, values: Partial<{ x: number; y: number; rotation: number; scaleX: number; scaleY: number }>): void {
    const b = this.data.findBone(name);
    if (b < 0) throw new Error(`Unknown bone "${name}"`);
    const o = b * BONE_CHANNELS;
    if (values.rotation !== undefined) this.channels[o + CH_ROT] = values.rotation;
    if (values.x !== undefined) this.channels[o + CH_X] = values.x;
    if (values.y !== undefined) this.channels[o + CH_Y] = values.y;
    if (values.scaleX !== undefined) this.channels[o + CH_SX] = values.scaleX;
    if (values.scaleY !== undefined) this.channels[o + CH_SY] = values.scaleY;
  }
}
