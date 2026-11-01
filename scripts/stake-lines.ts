/**
 * Puts the LLM2D coin (samples/coin) into the Stake web-sdk `lines` sample game as its H1 symbol,
 * and captures it running in that game's Storybook. See examples/stake-lines/README.md.
 *
 *   pnpm stake:lines apply ../web-sdk
 *   pnpm stake:lines capture --out out/stake-lines     (Storybook must be running)
 *
 * apply: packs @llm2d/core|pixi|svelte into <web-sdk>/vendor, exports the coin to
 *   apps/lines/static/assets/llm2d (half-size atlas), applies examples/stake-lines/lines.patch
 *   and runs pnpm install. Safe to run again: an applied patch is skipped.
 * capture: screenshots Components/<Symbol>/symbols, then plays MODE_BASE/book/random with a
 *   fixed book (default 25: H1 wins on line 9) and screenshots it until the action resolves.
 *   Exits non-zero if the coin skeleton is not loaded or the page throws.
 *   Options: --url (default http://localhost:6001), --out, --book, --every <ms>, --shots <n>
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { chromium, type Page } from 'playwright';
import { exportSkeleton } from '../packages/export/src/index.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const patch = join(root, 'examples/stake-lines/lines.patch');

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    url: { type: 'string', default: 'http://localhost:6001' },
    out: { type: 'string', default: 'out/stake-lines' },
    book: { type: 'string', default: '25' },
    every: { type: 'string', default: '400' },
    shots: { type: 'string', default: '40' },
  },
});

const [command, target] = positionals;
if (command === 'apply' && target) await apply(resolve(target));
else if (command === 'capture') await capture();
else {
  console.error('Usage: pnpm stake:lines apply <web-sdk dir> | capture [--url] [--out] [--book] [--every] [--shots]');
  process.exit(1);
}

function git(cwd: string, args: string[]): boolean {
  try {
    execFileSync('git', args, { cwd, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

async function apply(web: string) {
  if (!existsSync(join(web, 'apps/lines/src/game/constants.ts'))) {
    throw new Error(`${web} does not look like the Stake web-sdk (apps/lines/src/game/constants.ts is missing)`);
  }
  const applied = git(web, ['apply', '--reverse', '--check', patch]);
  if (!applied && !git(web, ['apply', '--check', patch])) {
    throw new Error(`lines.patch does not apply to ${web}. It was made against StakeEngine/web-sdk 1843d60; see examples/stake-lines/README.md.`);
  }

  console.log('1/4 Packing @llm2d/core, @llm2d/pixi, @llm2d/svelte');
  execFileSync('node', ['scripts/pack-lib.ts'], { cwd: root, stdio: 'inherit' });
  const vendor = join(web, 'vendor');
  mkdirSync(vendor, { recursive: true });
  for (const f of readdirSync(join(root, 'out/packages')).filter((f) => f.endsWith('.tgz'))) {
    copyFileSync(join(root, 'out/packages', f), join(vendor, f));
  }

  console.log('2/4 Exporting the coin to apps/lines/static/assets/llm2d');
  const result = await exportSkeleton(join(root, 'samples/coin/coin.l2d.json'), join(web, 'apps/lines/static/assets/llm2d'), { scale: 0.5 });
  for (const f of result.files) console.log(`  ${f.path} (${Math.round(f.bytes / 1024)} KB)`);

  console.log(applied ? '3/4 lines.patch is already applied' : '3/4 Applying lines.patch');
  if (!applied) execFileSync('git', ['apply', patch], { cwd: web, stdio: 'inherit' });

  console.log('4/4 pnpm install');
  execFileSync('pnpm', ['install'], { cwd: web, stdio: 'inherit' });

  console.log(`\nDone. Run the game's Storybook:\n  cd ${web}\n  pnpm run storybook --filter=lines\nthen open http://localhost:6001 (Components/<Symbol>/symbols, MODE_BASE/book/random).`);
}

async function capture() {
  const out = resolve(values.out);
  mkdirSync(out, { recursive: true });
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const problems: string[] = [];
  let coinLoaded = false;

  const open = async (story: string): Promise<Page> => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    page.on('pageerror', (e) => problems.push(`${story}: ${e.message}`));
    page.on('response', (r) => {
      if (/coin\.l2d\.json$/.test(r.url())) coinLoaded ||= r.ok();
    });
    await page.goto(`${values.url}/iframe.html?id=${story}&viewMode=story`, { waitUntil: 'load', timeout: 240_000 });
    await page.waitForSelector('canvas', { timeout: 240_000 });
    return page;
  };

  // Every symbol in every state; H1 is the LLM2D coin.
  const symbols = await open('components-symbol--symbols');
  await symbols.waitForTimeout(4000);
  await symbols.screenshot({ path: join(out, 'symbols.png') });
  await symbols.close();
  console.log(`${join(out, 'symbols.png')}`);

  // A full base-game round with a fixed book.
  const game = await open('mode-base-book--random');
  await game.getByText('Click action to start').waitFor({ timeout: 240_000 });
  await game.waitForTimeout(2000);
  await game.screenshot({ path: join(out, 'game-00.png') });
  // The story picks randomInteger({ min: 0, max: books.length - 1 }) = floor(Math.random() * 10000).
  await game.evaluate((index) => {
    const original = Math.random;
    Math.random = () => {
      Math.random = original;
      return (index + 0.5) / 10000;
    };
  }, Number(values.book));
  await game.getByRole('button', { name: 'Action' }).click();
  const resolved = () => game.evaluate(() => /Action is resolved/.test(document.querySelector('.message')?.textContent ?? ''));
  let shot = 1;
  for (; shot <= Number(values.shots) && !(await resolved()); shot++) {
    const started = Date.now();
    await game.screenshot({ path: join(out, `game-${String(shot).padStart(2, '0')}.png`) });
    const wait = Number(values.every) - (Date.now() - started);
    if (wait > 0) await game.waitForTimeout(wait);
  }
  console.log(`${join(out, 'game-*.png')} (${shot} frames, ${(await resolved()) ? 'round finished' : 'stopped before the round finished'})`);
  await browser.close();

  if (!coinLoaded) problems.push('coin.l2d.json was not loaded (is lines.patch applied and Storybook restarted?)');
  if (problems.length) {
    console.error(`\nProblems:\n${problems.map((p) => `  ${p}`).join('\n')}`);
    process.exit(1);
  }
}
