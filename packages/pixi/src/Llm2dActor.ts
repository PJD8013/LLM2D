import { Container, Graphics, Matrix, Mesh, MeshGeometry, Texture, Ticker, type ContainerOptions, type DestroyOptions } from 'pixi.js';
import { AnimationState, Skeleton, type SkeletonData } from '@llm2d/core';

export interface DebugOptions {
  bones?: boolean;
  meshes?: boolean;
  ik?: boolean;
}

export interface Llm2dActorOptions extends ContainerOptions {
  data: SkeletonData;
  /** Texture per image name in `data.images`. */
  textures: Record<string, Texture>;
  /**
   * Advance with Ticker.shared automatically. Default true. The pose is then applied right
   * before each render, so animations set this frame already show (no setup-pose frame).
   */
  autoUpdate?: boolean;
}

interface BoneFollower {
  bone: number;
  object: Container;
}

const BLENDS = { normal: 'normal', add: 'add', multiply: 'multiply', screen: 'screen' } as const;

/**
 * Renders an LLM2D skeleton with PixiJS 8 meshes. API intentionally mirrors spine-pixi-v8:
 *   const actor = new Llm2dActor({ data, textures });
 *   actor.state.setAnimation(0, 'idle', true);
 */
export class Llm2dActor extends Container {
  readonly skeleton: Skeleton;
  readonly state: AnimationState;
  readonly data: SkeletonData;

  private readonly meshes: Mesh[] = [];
  /** geometries[slot][attachment] */
  private readonly geometries: MeshGeometry[][] = [];
  /** Stand-in geometries of slots without attachments. */
  private readonly placeholders: MeshGeometry[] = [];
  /** state.version when the pose was last applied. */
  private posedVersion = -1;
  private readonly textures: Record<string, Texture>;
  private readonly shownAttachment: Int16Array;
  private readonly followers: BoneFollower[] = [];
  private readonly followerLayer = new Container({ label: 'followers' });
  private debugGraphics: Graphics | null = null;
  private debugOptions: DebugOptions = {};
  private _autoUpdate = false;
  private readonly tmpMatrix = new Matrix();

  constructor(options: Llm2dActorOptions) {
    const { data, textures, autoUpdate = true, ...containerOptions } = options;
    super(containerOptions);
    this.data = data;
    this.textures = textures;
    this.skeleton = new Skeleton(data);
    this.state = new AnimationState(data);
    this.shownAttachment = new Int16Array(data.slots.length).fill(-2);

    for (const slot of data.slots) {
      const geoms = data.attachments[slot.index].map(
        (a) =>
          new MeshGeometry({
            positions: new Float32Array(a.vertices),
            uvs: new Float32Array(a.uvs),
            indices: new Uint32Array(a.triangles),
          }),
      );
      this.geometries.push(geoms);
      const first = data.attachments[slot.index][0];
      let geometry = geoms[0];
      if (!geometry) {
        geometry = new MeshGeometry({ positions: new Float32Array(6), uvs: new Float32Array(6), indices: new Uint32Array([0, 1, 2]) });
        this.placeholders.push(geometry);
      }
      const mesh = new Mesh({
        geometry,
        texture: first ? this.textureFor(first.image) : Texture.EMPTY,
        label: slot.name,
      });
      mesh.blendMode = BLENDS[slot.blend];
      this.meshes.push(mesh);
      this.addChild(mesh);
    }
    this.addChild(this.followerLayer);
    this.autoUpdate = autoUpdate;
    this.update(0);
    this.onRender = () => {
      if (this._autoUpdate && this.posedVersion !== this.state.version) this.pose();
    };
  }

  private textureFor(image: string): Texture {
    const t = this.textures[image];
    if (!t) throw new Error(`Llm2dActor: no texture for image "${image}"`);
    return t;
  }

  get autoUpdate(): boolean {
    return this._autoUpdate;
  }

  set autoUpdate(value: boolean) {
    if (value === this._autoUpdate) return;
    this._autoUpdate = value;
    if (value) Ticker.shared.add(this.onTick, this);
    else Ticker.shared.remove(this.onTick, this);
  }

  private onTick(ticker: Ticker): void {
    // Only the clock moves here; the pose is applied before the next render (onRender).
    this.state.update(ticker.deltaMS / 1000);
  }

  /** Advances animations by `dt` seconds and refreshes the meshes. */
  update(dt: number): void {
    this.state.update(dt);
    this.pose();
  }

  private pose(): void {
    this.state.apply(this.skeleton);
    this.posedVersion = this.state.version;
    this.refresh();
  }

  /** Re-renders the current skeleton pose (call after changing the skeleton by hand). */
  refresh(): void {
    const sk = this.skeleton;
    sk.updateWorldTransform();
    for (let s = 0; s < this.meshes.length; s++) {
      const mesh = this.meshes[s];
      const a = sk.attachments[s];
      if (a < 0) {
        mesh.visible = false;
        continue;
      }
      const geometry = this.geometries[s][a];
      if (this.shownAttachment[s] !== a) {
        this.shownAttachment[s] = a;
        mesh.geometry = geometry;
        mesh.texture = this.textureFor(this.data.attachments[s][a].image);
      }
      sk.computeSlotVertices(s, geometry.positions);
      geometry.getBuffer('aPosition').update();
      const [r, g, b, alpha] = sk.slotColor(s);
      mesh.tint = ((r * 255) << 16) | ((g * 255) << 8) | (b * 255);
      mesh.alpha = alpha;
      mesh.visible = alpha > 0;
    }
    for (const f of this.followers) {
      const w = sk.world[f.bone];
      this.tmpMatrix.set(w[0], w[1], w[2], w[3], w[4], w[5]);
      f.object.setFromMatrix(this.tmpMatrix);
    }
    if (this.debugGraphics) this.drawDebug();
  }

  /**
   * Makes a Pixi object follow a bone (position, rotation and scale), drawn above the
   * skeleton. Useful for particles, win frames or text.
   */
  attachToBone(boneName: string, object: Container): Container {
    const bone = this.data.findBone(boneName);
    if (bone < 0) throw new Error(`Llm2dActor: unknown bone "${boneName}"`);
    this.followers.push({ bone, object });
    this.followerLayer.addChild(object);
    this.refresh();
    return object;
  }

  detachFromBone(object: Container): void {
    const i = this.followers.findIndex((f) => f.object === object);
    if (i >= 0) this.followers.splice(i, 1);
    this.followerLayer.removeChild(object);
  }

  /** Bone position in this container's local space. */
  getBonePosition(boneName: string): { x: number; y: number } {
    const bone = this.data.findBone(boneName);
    if (bone < 0) throw new Error(`Llm2dActor: unknown bone "${boneName}"`);
    const [x, y] = this.skeleton.boneWorldPosition(bone);
    return { x, y };
  }

  get debug(): DebugOptions {
    return this.debugOptions;
  }

  /** Draw bones, mesh wireframes and IK targets on top of the skeleton. */
  set debug(options: DebugOptions | boolean) {
    this.debugOptions = options === true ? { bones: true, meshes: true, ik: true } : options || {};
    const on = this.debugOptions.bones || this.debugOptions.meshes || this.debugOptions.ik;
    if (on && !this.debugGraphics) {
      this.debugGraphics = new Graphics({ label: 'debug' });
      this.addChild(this.debugGraphics);
    } else if (!on && this.debugGraphics) {
      this.debugGraphics.destroy();
      this.debugGraphics = null;
    }
    if (this.debugGraphics) this.drawDebug();
  }

  private drawDebug(): void {
    const g = this.debugGraphics!;
    const sk = this.skeleton;
    const scale = 1 / Math.max(1e-6, Math.abs(this.worldTransform.a) || 1);
    g.clear();
    if (this.debugOptions.meshes) {
      const tmp = new Float32Array(2048);
      for (let s = 0; s < this.meshes.length; s++) {
        const a = sk.attachments[s];
        if (a < 0) continue;
        const mesh = this.data.attachments[s][a];
        const v = mesh.vertexCount * 2 > tmp.length ? new Float32Array(mesh.vertexCount * 2) : tmp;
        sk.computeSlotVertices(s, v);
        const t = mesh.triangles;
        for (let i = 0; i < t.length; i += 3) {
          g.moveTo(v[t[i] * 2], v[t[i] * 2 + 1])
            .lineTo(v[t[i + 1] * 2], v[t[i + 1] * 2 + 1])
            .lineTo(v[t[i + 2] * 2], v[t[i + 2] * 2 + 1])
            .closePath();
        }
        g.stroke({ width: 1 * scale, color: mesh.kind === 'mesh' ? 0x00e5ff : 0xffffff, alpha: mesh.kind === 'mesh' ? 0.7 : 0.25 });
      }
    }
    if (this.debugOptions.bones) {
      for (const b of this.data.bones) {
        const [x, y] = sk.boneWorldPosition(b.index);
        if (b.length > 0) {
          const [tx, ty] = sk.boneWorldTip(b.index);
          g.moveTo(x, y).lineTo(tx, ty).stroke({ width: 3 * scale, color: 0xff3d7f, alpha: 0.9 });
        }
        g.circle(x, y, 4 * scale).fill({ color: 0xffd400 });
      }
    }
    if (this.debugOptions.ik) {
      for (const c of this.data.ik) {
        const [x, y] = sk.boneWorldPosition(c.target);
        const r = 9 * scale;
        g.moveTo(x - r, y).lineTo(x + r, y).moveTo(x, y - r).lineTo(x, y + r).stroke({ width: 2 * scale, color: 0x7cff4f });
        g.circle(x, y, r * 0.7).stroke({ width: 2 * scale, color: 0x7cff4f });
      }
    }
  }

  /**
   * Frees the meshes and their GPU buffers. Textures are shared with other actors of the same
   * asset, so they are never destroyed here (unload the asset for that). With `children: true`,
   * objects attached to bones are destroyed too.
   */
  override destroy(options?: DestroyOptions): void {
    this.autoUpdate = false;
    // Pixi's typing does not admit clearing it, but its setter does.
    (this as { onRender: unknown }).onRender = null;
    const children = typeof options === 'boolean' ? options : !!options?.children;
    for (const mesh of this.meshes) mesh.destroy();
    this.meshes.length = 0;
    for (const list of this.geometries) for (const geom of list) geom.destroy(true);
    for (const geom of this.placeholders) geom.destroy(true);
    this.debugGraphics?.destroy();
    this.debugGraphics = null;
    this.followers.length = 0;
    this.followerLayer.destroy({ children });
    super.destroy({ children: false });
  }
}
