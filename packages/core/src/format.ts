/**
 * LLM2D file format (`*.l2d.json`), version 0.1.
 *
 * Conventions (see docs/format.md for the full spec):
 * - Coordinates are in skeleton units, x to the right, y DOWN (same as PixiJS).
 * - Angles are in degrees. Positive rotation is clockwise on screen.
 * - Bone transforms are local to the parent bone.
 * - Attachment geometry (region placement, mesh vertices) is given in skeleton
 *   space at the setup pose, exactly where the art sits on the canvas. It is
 *   bound to bones automatically, so layered art can be placed as drawn.
 * - Animation values for bones are relative to the setup pose:
 *   rotate/translate are added, scale is multiplied.
 */

export const FORMAT_ID = 'llm2d';
export const FORMAT_VERSION = '0.1';

export interface L2DFile {
  format: typeof FORMAT_ID;
  version: string;
  name: string;
  /** Optional free-form metadata (author, source art, generator, notes). */
  meta?: Record<string, unknown>;
  /** Reference size of the art in skeleton units; used for fitting and previews. */
  bounds?: { x: number; y: number; width: number; height: number };
  images: Record<string, L2DImage>;
  /** Ordered list; every parent must appear before its children. The first bone is the root. */
  bones: L2DBone[];
  /** Draw order, back to front. */
  slots: L2DSlot[];
  /** attachments[slotName][attachmentName] */
  attachments: Record<string, Record<string, L2DAttachment>>;
  ik?: L2DIkConstraint[];
  animations: Record<string, L2DAnimation>;
}

export interface L2DImage {
  /** Path of the PNG, relative to the .l2d.json file. Several images may share one atlas page. */
  path: string;
  /** Logical size in skeleton units. The PNG itself may be any resolution (e.g. @2x). */
  width: number;
  height: number;
  /** Rectangle of the PNG holding this image, in PNG pixels (texture atlases). Omit for a whole PNG. */
  frame?: { x: number; y: number; width: number; height: number };
}

export interface L2DBone {
  name: string;
  parent?: string;
  x?: number;
  y?: number;
  /** Degrees, clockwise positive. */
  rotation?: number;
  scaleX?: number;
  scaleY?: number;
  /** Length along the bone's local +x axis. Used by IK, debug drawing and tools. */
  length?: number;
}

export type BlendMode = 'normal' | 'add' | 'multiply' | 'screen';

export interface L2DSlot {
  name: string;
  bone: string;
  /** Attachment shown at setup pose, or null/omitted for none. */
  attachment?: string | null;
  /** RRGGBB or RRGGBBAA hex tint. Default "ffffffff". */
  color?: string;
  blend?: BlendMode;
}

export type L2DAttachment = L2DRegionAttachment | L2DMeshAttachment | L2DClippingAttachment;

export interface L2DRegionAttachment {
  type: 'region';
  image: string;
  /** Center of the image in skeleton space at setup pose. */
  x: number;
  y: number;
  rotation?: number;
  scaleX?: number;
  scaleY?: number;
  /** Defaults to the image's logical size. */
  width?: number;
  height?: number;
}

export interface L2DMeshAttachment {
  type: 'mesh';
  image: string;
  /** Flat [x0, y0, x1, y1, ...] in skeleton space at setup pose. */
  vertices: number[];
  /** Flat [u0, v0, ...] in 0..1 of the image. Same length as vertices. */
  uvs: number[];
  /** Flat triangle vertex indices. */
  triangles: number[];
  /**
   * Number of vertices (from the start of the list) on the outline, of every piece when the
   * art has several. Informational.
   */
  hull?: number;
  /**
   * Bones that deform this mesh. If omitted, the whole mesh follows the slot's bone.
   */
  bones?: string[];
  /**
   * Per-vertex influences as flat pairs [boneIndex, weight, boneIndex, weight, ...],
   * where boneIndex indexes into `bones`. Weights of a vertex should sum to 1.
   */
  weights?: number[][];
}

/**
 * A clipping polygon: the slots after this one in draw order, up to and including `end`, are
 * drawn only inside it (e.g. a shine sweeping across a symbol, clipped to the symbol's shape).
 * Draws nothing itself. Follows the slot's bone, or `bones`/`weights` like a mesh. Clipping
 * ranges may not overlap.
 */
export interface L2DClippingAttachment {
  type: 'clipping';
  /** Polygon in skeleton space at setup pose: flat [x0, y0, x1, y1, ...], at least 3 points. */
  vertices: number[];
  /** Last slot clipped (inclusive). Default: the last slot. */
  end?: string;
  /** Bones that move the polygon (default: the slot's bone). */
  bones?: string[];
  /** Per-vertex influences like a mesh's: flat pairs [boneIndex, weight, ...]. */
  weights?: number[][];
}

export interface L2DIkConstraint {
  name: string;
  /** One bone (aim) or two bones [parent, child] (limb). */
  bones: string[];
  target: string;
  /** Two-bone only: true bends the joint so the child turns clockwise relative to the parent. */
  bendPositive?: boolean;
  /** 0..1, default 1. */
  mix?: number;
}

/**
 * Curve from this key to the next one:
 * "linear" (default), "stepped", a named easing such as "easeOutBack", or a
 * cubic bezier [x1, y1, x2, y2] like CSS cubic-bezier().
 */
export type L2DCurve = string | [number, number, number, number];

export interface L2DKeyBase {
  time: number;
  curve?: L2DCurve;
}
export interface L2DValueKey extends L2DKeyBase {
  value: number;
}
export interface L2DVec2Key extends L2DKeyBase {
  x?: number;
  y?: number;
}
export interface L2DColorKey extends L2DKeyBase {
  value: string;
}
export interface L2DAttachmentKey {
  time: number;
  name: string | null;
}

export interface L2DBoneTimelines {
  /** Degrees added to setup rotation. */
  rotate?: L2DValueKey[];
  /** Offset added to setup position (missing x/y = 0). */
  translate?: L2DVec2Key[];
  /** Multiplier of setup scale (missing x/y = 1). */
  scale?: L2DVec2Key[];
}

export interface L2DSlotTimelines {
  /** Absolute RRGGBB[AA] tint. */
  color?: L2DColorKey[];
  /** Absolute alpha 0..1 (applied after color). */
  alpha?: L2DValueKey[];
  attachment?: L2DAttachmentKey[];
}

export interface L2DIkTimelines {
  mix?: L2DValueKey[];
}

export interface L2DEventKey {
  time: number;
  name: string;
  [payload: string]: unknown;
}

export interface L2DAnimation {
  /** Defaults to the last key time. */
  duration?: number;
  bones?: Record<string, L2DBoneTimelines>;
  slots?: Record<string, L2DSlotTimelines>;
  ik?: Record<string, L2DIkTimelines>;
  events?: L2DEventKey[];
}
