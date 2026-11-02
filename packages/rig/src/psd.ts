import { initializeCanvas, readPsd as agReadPsd, writePsdBuffer, type BlendMode, type Layer as PsdLayer, type LayerMaskData, type PixelData } from 'ag-psd';
import { composite, trimLayer, type Layer, type RGBAImage } from './image.ts';

// Node has no canvas: work with raw pixel data only.
initializeCanvas(
  () => {
    throw new Error('ag-psd tried to create a canvas; only raw image data is supported');
  },
  (width, height) => ({ width, height, data: new Uint8ClampedArray(width * height * 4), colorSpace: 'srgb' }) as ImageData,
);

export interface LayeredArt {
  width: number;
  height: number;
  /** Bottom to top. Group names are joined with "/". */
  layers: Layer[];
  warnings: string[];
}

const BLENDS: Partial<Record<BlendMode, Layer['blend']>> = {
  normal: 'normal',
  'pass through': 'normal',
  'linear dodge': 'add',
  multiply: 'multiply',
  screen: 'screen',
};

/**
 * 8-bit RGBA from ag-psd pixel data, which is 16-bit (Uint16Array) or 32-bit float (linear,
 * Float32Array) for deeper documents.
 */
export function to8Bit(src: PixelData): RGBAImage {
  const { width, height, data } = src;
  if (data instanceof Uint8Array || data instanceof Uint8ClampedArray)
    return { width, height, data: new Uint8Array(data.buffer, data.byteOffset, data.length) };
  const out = new Uint8Array(width * height * 4);
  if (data instanceof Uint16Array) for (let i = 0; i < out.length; i++) out[i] = Math.round(data[i] / 257);
  else
    for (let i = 0; i < out.length; i++) {
      const v = Math.min(1, Math.max(0, data[i]));
      // 32-bit documents are linear; colours go back to sRGB-like gamma, alpha stays linear.
      out[i] = Math.round((i % 4 === 3 ? v : Math.pow(v, 1 / 2.2)) * 255);
    }
  return { width, height, data: out };
}

/** Grey level (0..255) of a layer mask at document pixel (x, y). */
function maskAt(mask: LayerMaskData, grey: RGBAImage | null, x: number, y: number): number {
  const left = mask.left ?? 0;
  const top = mask.top ?? 0;
  if (!grey || x < left || y < top || x >= left + grey.width || y >= top + grey.height) return mask.defaultColor ?? 0;
  return grey.data[((y - top) * grey.width + (x - left)) * 4];
}

/** Multiplies a layer's alpha by its raster mask (an enabled mask with pixels or a default colour). */
function applyMask(layer: Layer, mask: LayerMaskData): void {
  if (mask.disabled) return;
  const grey = mask.imageData ? to8Bit(mask.imageData) : null;
  const { width, height, data } = layer.image;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4 + 3;
      if (data[i]) data[i] = Math.round((data[i] * maskAt(mask, grey, layer.x + x, layer.y + y)) / 255);
    }
}

const blendChannel: Record<Layer['blend'], (b: number, t: number) => number> = {
  normal: (_b, t) => t,
  add: (b, t) => Math.min(255, b + t),
  multiply: (b, t) => (b * t) / 255,
  screen: (b, t) => 255 - ((255 - b) * (255 - t)) / 255,
};

/**
 * Paints a clipped layer (shading, highlights drawn "clipped" onto the layer below) into its base:
 * only where the base has pixels, with the clipped layer's blend mode and opacity. The base's
 * shape (alpha) does not change, so the part moves as one piece when rigged.
 */
export function mergeClipped(base: Layer, clip: Layer): void {
  const b = base.image;
  const c = clip.image;
  const blend = blendChannel[clip.blend];
  for (let y = 0; y < b.height; y++) {
    const cy = base.y + y - clip.y;
    if (cy < 0 || cy >= c.height) continue;
    for (let x = 0; x < b.width; x++) {
      const cx = base.x + x - clip.x;
      if (cx < 0 || cx >= c.width) continue;
      const bi = (y * b.width + x) * 4;
      const ci = (cy * c.width + cx) * 4;
      const a = (c.data[ci + 3] / 255) * clip.opacity;
      if (a <= 0 || !b.data[bi + 3]) continue;
      for (let k = 0; k < 3; k++) {
        const v = b.data[bi + k];
        b.data[bi + k] = Math.round(v + (blend(v, c.data[ci + k]) - v) * a);
      }
    }
  }
}

/**
 * Reads a PSD into flat layers. Layer masks are applied, layers clipped to the layer below
 * (clipping masks) are painted into it, and group visibility, opacity and masks carry over to the
 * layers inside. Layer effects, adjustment layers and vector masks are not rendered (warned).
 */
export function readPsd(buffer: Uint8Array): LayeredArt {
  let psd;
  try {
    psd = agReadPsd(buffer, { useImageData: true, skipCompositeImageData: true, skipThumbnail: true });
  } catch (e) {
    const message = (e as Error).message;
    if (/Color mode not supported/.test(message)) throw new Error(`${message}. Save the PSD in RGB colour mode (Photoshop: Image > Mode > RGB Color).`);
    throw e;
  }
  const layers: Layer[] = [];
  const warnings: string[] = [];
  /** Group masks that apply to the layers being read (outermost first). */
  const groupMasks: LayerMaskData[] = [];

  const walk = (children: PsdLayer[], prefix: string, hiddenParent: boolean, opacityParent: number) => {
    // The base a clipped layer paints into: the last unclipped layer of this group ('gone' when
    // its mask left nothing, 'group' when it is a group, which clipping onto is not supported).
    let base: Layer | 'gone' | 'group' | null = null;
    for (const l of children) {
      const name = prefix + (l.name ?? 'layer');
      const hidden = hiddenParent || !!l.hidden;
      const opacity = opacityParent * (l.opacity ?? 1) * (l.fillOpacity ?? 1);
      if (l.children) {
        if (l.clipping) warnings.push(`${name}: a clipped group is read as a normal group`);
        const mask = l.mask && !l.mask.disabled ? l.mask : null;
        if (mask) groupMasks.push(mask);
        walk(l.children, `${name}/`, hidden, opacity);
        if (mask) groupMasks.pop();
        base = 'group';
        continue;
      }
      if (l.adjustment) {
        warnings.push(`${name}: adjustment layers are not applied; merge them into the art before export`);
        continue;
      }
      if (!l.imageData || l.right === undefined || l.left === undefined) continue;
      if (l.effects) warnings.push(`${name}: layer effects are ignored; rasterise them before export`);
      if (l.vectorMask && !l.mask?.imageData) warnings.push(`${name}: vector masks are ignored; rasterise them before export`);
      const blend = BLENDS[l.blendMode ?? 'normal'];
      if (!blend) warnings.push(`${name}: blend mode "${l.blendMode}" is not supported, using normal`);
      const layer: Layer = { name, x: l.left, y: l.top ?? 0, image: to8Bit(l.imageData), hidden, opacity, blend: blend ?? 'normal' };
      // Copy before masking: the pixels may share ag-psd's buffer.
      if (l.mask || groupMasks.length) layer.image = { ...layer.image, data: layer.image.data.slice() };
      if (l.mask) applyMask(layer, l.mask);
      for (const m of groupMasks) applyMask(layer, m);
      if (l.clipping && base !== null) {
        if (base === 'gone') continue; // its base shows nothing, so neither does it
        if (base === 'group') warnings.push(`${name}: clipped to a group; read as a normal layer`);
        else {
          if (!hidden) mergeClipped(base, layer);
          continue;
        }
      }
      const trimmed = l.mask || groupMasks.length ? trimLayer(layer) : layer;
      if (!trimmed) {
        warnings.push(`${name}: nothing left visible after its mask; skipped`);
        base = 'gone';
        continue;
      }
      layers.push(trimmed);
      base = trimmed;
    }
  };
  walk(psd.children ?? [], '', false, 1);
  return { width: psd.width, height: psd.height, layers, warnings };
}

/** Writes flat layers as a PSD (used to produce test art). */
export function writePsd(art: { width: number; height: number; layers: Layer[] }): Buffer {
  const toPixels = (img: RGBAImage) => ({
    width: img.width,
    height: img.height,
    data: new Uint8ClampedArray(img.data.buffer, img.data.byteOffset, img.data.length),
  });
  const blendBack: Record<Layer['blend'], BlendMode> = { normal: 'normal', add: 'linear dodge', multiply: 'multiply', screen: 'screen' };
  return writePsdBuffer(
    {
      width: art.width,
      height: art.height,
      imageData: toPixels(composite(art.layers, art.width, art.height)),
      children: art.layers.map((l) => ({
        name: l.name,
        left: l.x,
        top: l.y,
        right: l.x + l.image.width,
        bottom: l.y + l.image.height,
        hidden: l.hidden,
        opacity: l.opacity,
        blendMode: blendBack[l.blend],
        imageData: toPixels(l.image),
      })),
    },
    { generateThumbnail: false },
  );
}
