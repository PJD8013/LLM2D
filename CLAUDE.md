# LLM2D

AI-driven 2D skeletal animation for Stake Engine slot games (PixiJS 8 + Svelte 5).
The user communicates in Korean; write user-facing docs and replies in Korean.

## Layout

- `packages/core` — format types, validator, compiled `SkeletonData`, `Skeleton` (world transforms,
  IK, skinning), `AnimationState` (tracks, mixing, queue, events; listeners run after the state change,
  like spine's event queue). No DOM, runs in Node.
- `packages/pixi` — `Llm2dActor` (PixiJS 8 `Mesh` per slot, CPU skinning; clipping ranges as containers with a
  Graphics mask) and `loadLlm2d`.
- `packages/rig` — Node-only auto-rigging: `readPsd`, contour + constrained Delaunay `buildMesh`,
  medial-axis `chainJoints`, geodesic `computeWeights`, `buildRig(art, spec)`. `bendTest`/`bendPoses`
  live in core so the viewer can use them. Flat pictures: `segment.ts` (`removeBackground`, `segmentArt`:
  median + Felzenszwalb graph segmentation, outline strokes as label -1, neck splitting, broad soft areas
  such as glows as regions) and `split.ts` (`splitArt`: parts back to front from region ids/points/polygons/
  strokes, outlines with caps and fringe to the front part unless it has no outline of its own, hidden areas
  rebuilt by disk closing + overlap + fully covered holes; restacked layers must equal the input,
  `report.difference`).
- `packages/motion` — motion presets (`applyPreset`, `describePresets`, `mergeAnimations`); pure TS.
- `packages/preview` — Node-only renders via Playwright + the viewer: `inspectImage`, `Previewer`
  (`loadFile`, `contactSheet`, `bendSheet`, `frame`); `regionsImage`, `splitSheet`, `decodeImage`
  (JPEG/WebP via the browser) for flat pictures.
- `packages/export` — game export: MaxRects atlas packing with edge extrusion, `resample`, `exportSkeleton`.
- `packages/svelte` — pixi-svelte components (`Llm2dProvider`, `Llm2dTrack`, `Llm2dBone`). Checked with
  svelte-check (root tsc excludes it). Imports inside it use `.js` extensions because svelte-package does
  not rewrite `.ts`.
- `packages/mcp` — stdio MCP server (`src/server.ts`, tools in `src/tools.ts`, project folders in
  `src/project.ts`). Registered for Claude Code in `.mcp.json`. Server `INSTRUCTIONS` describe the workflow.
- `apps/editor` — Svelte 5 timeline editor (`pnpm editor [dir]`, 127.0.0.1:5174, `--host` to expose). `server.ts`
  is a Vite plugin API (`/api/projects`, `/api/project`, PUT `/api/project/animations` via the MCP `Project`,
  `/files/<encoded id>/...`, `llm2d:changed` HMR event on outside edits; checks Host and Origin itself because
  plugin middlewares run before Vite's host check). `src/lib/model.ts` (pure key ops, rows, history; unit-tested),
  `editor.svelte.ts` (state, undo, save; edits recompile one animation with `SkeletonData.setAnimation`),
  `stage.ts` (Pixi view, bone picking, rotate/move/scale drags). `test/editor.e2e.test.ts` drives it in Chromium.
- `apps/viewer` — Vite viewer; also exposes `window.__llm2d` (`loadData`, `seek`, `frame`, `contactSheet`,
  `bendSheet`, ...) for headless use.
- `samples/bolt|gem/build.ts` — generate original SVG art + rig + animations in code.
- `samples/coin` — symbol rigged and animated through the MCP tools: `art.ts` (PSD), `rig.json`, `animations.json`.
- `apps/reel-demo` — Svelte 5 + pixi-svelte 2.1 demo of the Stake integration; `pnpm assets` exports samples
  with atlases into `public/assets` (gitignored).
- `examples/stake-lines` — `lines.patch` against StakeEngine/web-sdk 1843d60 that swaps the `lines` game's H1 symbol
  for the coin; `pnpm stake:lines apply <web-sdk>` vendors the tgz, exports the coin and applies it,
  `pnpm stake:lines capture` screenshots the running Storybook (port 6001). Regenerate the patch with `git diff` in
  web-sdk after changing it there (use `git add -N` for new files).
- `samples/kit-flat` — Kit merged into one JPEG (`make.ts`), split back with `split.json` (points, not ids)
  into `source/kit-flat.psd` (gitignored, made by `pnpm samples kit-flat`), rigged with `rig.json`.
  `packages/rig/test/split.test.ts` compares the split with Kit's real layers (IoU).
- `samples/kit` — auto-rigged sample: `art.ts` + `make-psd.ts` produce `source/kit.psd`; `rig.json`
  (joints in PSD pixels) and `animations.ts` are the inputs to `pnpm rig build`.
- `pnpm samples` regenerates every sample's PNGs and `<name>.l2d.json`. Edit the sources, never the
  generated JSON/PNGs by hand.
- `scripts/` — `build-samples.ts`, `rig.ts` (inspect/build), `render.ts` (contact sheets and
  `--bend` sheets), `validate.ts`, `mcp-call.ts` (call MCP tools over stdio; images go to out/mcp), `stake-lines.ts`,
  `split.ts` (`regions` / `build` for flat pictures).
- `docs/format.md` (format spec), `docs/rigging.md` (rigging guide), `docs/split.md` (flat picture
  split), `docs/editor.md` (timeline editor), `docs/mcp.md` (Claude/MCP guide), `docs/stake.md` (Stake
  integration), all Korean. Keep format.md in sync with `packages/core/src/format.ts`.

## Conventions

- No build step: TypeScript runs directly (Node type stripping, Vite, Vitest). Import with explicit
  `.ts` extensions, use `import type` for types, and avoid enums, namespaces and constructor
  parameter properties (`erasableSyntaxOnly`).
- Coordinates: y down, degrees, positive rotation clockwise. Attachment geometry is in skeleton
  space at setup pose; bone animation values are relative to setup (rotate/translate add, scale multiplies).
- Keep the runtime API shaped like spine-ts (`state.setAnimation(track, name, loop)`, `TrackEntry.listener`).
- Stake web SDK pins pixi.js 8.8.1, svelte 5.20.5, vite 6.2, spine-pixi-v8 4.2.74; stay compatible
  (root `pnpm.overrides` pins spine and vite).
- Runtime packages (core, pixi, svelte) ship `dist/` via `pnpm pack:lib` (`publishConfig` points exports at dist);
  inside the workspace they resolve to source.

## Verify changes

```bash
pnpm test && pnpm typecheck && pnpm validate
```

For anything visual, render and look at the result:

```bash
pnpm render --file bolt/bolt.l2d.json --anim cheer --frames 8 --debug
```

For rig changes, the build prints the bend test; also look at the bend sheet:

```bash
pnpm render --file kit/kit.l2d.json --bend
```

For split changes, look at the region map and the layer sheet (magenta = rebuilt):

```bash
pnpm split regions samples/kit-flat/source/kit-flat.jpg && pnpm samples kit-flat
```

For editor changes, run it and use it (the e2e test also drives it in Chromium):

```bash
pnpm editor out/projects/<name>
```

For MCP changes, call the tools end to end and look at the returned images:

```bash
pnpm mcp:call create_project '{"dir":"out/projects/ruby","art":"samples/gem/source/gem.psd","kind":"symbol","overwrite":true}'
```
