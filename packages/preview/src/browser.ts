import { chromium, type Browser } from 'playwright';

let shared: Promise<Browser> | null = null;

/** One headless Chromium per process, started on first use. WebGL runs on SwiftShader. */
export function getBrowser(): Promise<Browser> {
  shared ??= chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] }).then(
    (b) => {
      b.on('disconnected', () => (shared = null));
      return b;
    },
    (e) => {
      // Let the next call try again instead of failing forever.
      shared = null;
      throw e;
    },
  );
  return shared;
}

export async function closeBrowser(): Promise<void> {
  if (!shared) return;
  const b = await shared;
  shared = null;
  await b.close();
}
