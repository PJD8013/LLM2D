/**
 * Validates one or more .l2d.json files and checks that every referenced image exists.
 *
 *   pnpm validate samples/bolt/bolt.l2d.json [more files...]
 *   pnpm validate            # all samples
 *
 * Exit code 1 if any file has errors. Use --json for machine-readable output.
 */
import { access, readFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SkeletonData, validate, type ValidationIssue } from '../packages/core/src/index.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const asJson = args.includes('--json');
const files = args.filter((a) => a !== '--json');
if (!files.length) files.push('samples/bolt/bolt.l2d.json', 'samples/gem/gem.l2d.json');

const report: { file: string; ok: boolean; errors: ValidationIssue[]; warnings: ValidationIssue[] }[] = [];
for (const file of files) {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  let json: unknown;
  try {
    json = JSON.parse(await readFile(file, 'utf8'));
  } catch (e) {
    errors.push({ path: '', message: `Cannot read JSON: ${(e as Error).message}` });
  }
  if (json !== undefined) {
    const r = validate(json);
    errors.push(...r.errors);
    warnings.push(...r.warnings);
    if (r.ok) {
      const data = SkeletonData.fromJSON(json);
      for (const [name, img] of Object.entries(data.images)) {
        try {
          await access(join(dirname(file), img.path));
        } catch {
          errors.push({ path: `images.${name}.path`, message: `File not found: ${img.path}` });
        }
      }
    }
  }
  report.push({ file: relative(root, join(process.cwd(), file)) || file, ok: errors.length === 0, errors, warnings });
}

if (asJson) console.log(JSON.stringify(report, null, 2));
else
  for (const r of report) {
    console.log(`${r.ok ? 'OK     ' : 'INVALID'} ${r.file}`);
    for (const e of r.errors) console.log(`  error   ${e.path || '(root)'}: ${e.message}`);
    for (const w of r.warnings) console.log(`  warning ${w.path || '(root)'}: ${w.message}`);
  }
if (report.some((r) => !r.ok)) process.exitCode = 1;
