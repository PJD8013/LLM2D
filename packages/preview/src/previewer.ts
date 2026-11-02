import { readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from 'playwright';
import type { ViteDevServer } from 'vite';
import type { L2DFile } from '@llm2d/core';
import { getBrowser } from './browser.ts';

const VIEWER = resolve(dirname(fileURLToPath(import.meta.url)), '../../../apps/viewer');

export interface SheetOptions {
  frames?: number;
  /** Cell size in pixels. */
  cell?: number;
  columns?: number;
  debug?: boolean;
  background?: 'dark' | 'light' | 'checker';
}

/**
 * Renders skeletons with the real PixiJS runtime in a headless browser. The viewer app is
 * served by an in-process Vite server; both start on first use and are reused.
 */
export class Previewer {
  private server: ViteDevServer | null = null;
  private page: Page | null = null;
  private starting: Promise<Page> | null = null;
  private loadedKey = '';

  /** The viewer page, started on first use and again after the page or the browser went away. */
  private async ensure(): Promise<Page> {
    if (this.page && !this.page.isClosed()) return this.page;
    if (this.page) this.forget(this.page);
    this.starting ??= this.start().catch((e) => {
      this.starting = null;
      throw e;
    });
    return this.starting;
  }

  /** Drops a dead page so the next call opens a new one (and loads the skeleton again). */
  private forget(page: Page) {
    if (this.page !== page) return;
    this.page = null;
    this.starting = null;
    this.loadedKey = '';
  }

  private async start(): Promise<Page> {
    if (!this.server) {
      const { createServer } = await import('vite');
      const server = await createServer({
        root: VIEWER,
        configFile: join(VIEWER, 'vite.config.ts'),
        server: { port: 0, host: '127.0.0.1' },
        logLevel: 'error',
        clearScreen: false,
      });
      await server.listen();
      this.server = server;
    }
    const address = this.server.httpServer!.address();
    const port = typeof address === 'object' && address ? address.port : 5173;
    const page = await (await getBrowser()).newPage({ viewport: { width: 640, height: 640 } });
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('close', () => this.forget(page));
    page.on('crash', () => {
      this.forget(page);
      page.close().catch(() => {});
    });
    try {
      await page.goto(`http://127.0.0.1:${port}/?headless=1&bg=dark`);
      await page.waitForSelector('body[data-ready="true"]', { timeout: 60000 });
    } catch (e) {
      await page.close().catch(() => {});
      throw new Error(`Viewer failed to start: ${errors.join('; ') || (e as Error).message}`);
    }
    this.page = page;
    return page;
  }

  /** Loads a skeleton from memory. `pages` maps each image path in the file to its PNG bytes. */
  async load(file: L2DFile, pages: Record<string, Uint8Array>): Promise<void> {
    const page = await this.ensure();
    const urls = Object.fromEntries(
      Object.entries(pages).map(([k, v]) => [k, `data:image/png;base64,${Buffer.from(v).toString('base64')}`]),
    );
    await page.evaluate(([json, imgs, label]) => (window as any).__llm2d.loadData(json, imgs, label), [file, urls, file.name] as const);
    this.loadedKey = '';
  }

  /**
   * Loads a `.l2d.json` and its images from disk. Skips the reload if the same file content
   * is already loaded (`key` can be used to force a reload when images changed).
   */
  async loadFile(path: string, key?: string): Promise<L2DFile> {
    const text = await readFile(path, 'utf8');
    const file = JSON.parse(text) as L2DFile;
    // Images can change while the JSON does not (new art, same rig): their dates count too.
    const stamps = await Promise.all(
      [...new Set(Object.values(file.images ?? {}).map((i) => i.path))].map(async (p) => `${p}@${await stat(join(dirname(path), p)).then((s) => s.mtimeMs, () => 0)}`),
    );
    const cacheKey = `${path}\u0000${key ?? ''}\u0000${text}\u0000${stamps.join('|')}`;
    if (cacheKey === this.loadedKey && this.page) return file;
    const pages: Record<string, Uint8Array> = {};
    for (const img of Object.values(file.images ?? {})) pages[img.path] ??= await readFile(join(dirname(path), img.path));
    await this.load(file, pages);
    this.loadedKey = cacheKey;
    return file;
  }

  private async setup(page: Page, size: number, options: { debug?: boolean; background?: string }) {
    await page.setViewportSize({ width: size, height: size });
    await page.evaluate(
      async ([debug, bg]) => {
        // Let layout catch up with the new viewport before resizing the canvas.
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        const api = (window as any).__llm2d;
        api.resize();
        api.debug(debug);
        api.setBackground(bg);
      },
      [!!options.debug, options.background ?? 'dark'] as const,
    );
  }

  private static decode(dataUrl: string): Buffer {
    return Buffer.from(dataUrl.split(',')[1], 'base64');
  }

  /** Grid of frames evenly spread over an animation (first and last frame included). */
  async contactSheet(animation: string, options: SheetOptions = {}): Promise<Buffer> {
    const page = await this.ensure();
    const cell = options.cell ?? 220;
    await this.setup(page, Math.max(320, cell * 2), options);
    const url: string = await page.evaluate(
      ([a, f, c, col]) => (window as any).__llm2d.contactSheet(a, f, c, col),
      [animation, options.frames ?? 8, cell, options.columns ?? 4] as const,
    );
    return Previewer.decode(url);
  }

  /** The bend test poses, one row per control, zoomed on the meshes that bend. */
  async bendSheet(options: { cell?: number; stress?: boolean; debug?: boolean; background?: 'dark' | 'light' | 'checker' } = {}): Promise<Buffer> {
    const page = await this.ensure();
    const cell = options.cell ?? 200;
    await this.setup(page, Math.max(320, cell * 2), options);
    const url: string = await page.evaluate(([c, s]) => (window as any).__llm2d.bendSheet(c, s), [cell, !!options.stress] as const);
    return Previewer.decode(url);
  }

  /** A single frame; `animation` null renders the setup pose. */
  async frame(animation: string | null, time = 0, options: { size?: number; debug?: boolean; background?: 'dark' | 'light' | 'checker' } = {}): Promise<Buffer> {
    const page = await this.ensure();
    await this.setup(page, options.size ?? 512, options);
    const url: string = await page.evaluate(([a, t]) => (window as any).__llm2d.frame(a, t), [animation, time] as const);
    return Previewer.decode(url);
  }

  async close(): Promise<void> {
    const page = this.page ?? (await this.starting?.catch(() => null));
    this.page = null;
    this.starting = null;
    this.loadedKey = '';
    await page?.close().catch(() => {});
    await this.server?.close();
    this.server = null;
  }
}
