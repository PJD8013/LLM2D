import { initializeCanvas, readPsd as agReadPsd, writePsdBuffer, type BlendMode, type Layer as PsdLayer } from 'ag-psd';
import { composite, type Layer, type RGBAImage } from './image.ts';

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

/** Reads a PSD into flat layers (raster pixels only; text, effects and masks are not applied). */
export function readPsd(buffer: Uint8Array): LayeredArt {
  const psd = agReadPsd(buffer, { useImageData: true, skipCompositeImageData: true, skipThumbnail: true });
  const layers: Layer[] = [];
  const warnings: string[] = [];
  const walk = (children: PsdLayer[], prefix: string, hiddenParent: boolean) => {
    for (const l of children) {
      const name = prefix + (l.name ?? 'layer');
      const hidden = hiddenParent || !!l.hidden;
      if (l.children) {
        walk(l.children, `${name}/`, hidden);
        continue;
      }
      if (!l.imageData || l.right === undefined || l.left === undefined) continue;
      if (l.clipping) warnings.push(`${name}: clipping masks are ignored`);
      if (l.mask) warnings.push(`${name}: layer masks are ignored; apply them before export`);
      if (l.effects) warnings.push(`${name}: layer effects are ignored; rasterise them before export`);
      const blend = BLENDS[l.blendMode ?? 'normal'];
      if (!blend) warnings.push(`${name}: blend mode "${l.blendMode}" is not supported, using normal`);
      const src = l.imageData;
      const image: RGBAImage = { width: src.width, height: src.height, data: new Uint8Array(src.data.buffer, src.data.byteOffset, src.data.length) };
      layers.push({ name, x: l.left, y: l.top ?? 0, image, hidden, opacity: l.opacity ?? 1, blend: blend ?? 'normal' });
    }
  };
  walk(psd.children ?? [], '', false);
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
