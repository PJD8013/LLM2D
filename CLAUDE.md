# LLM2D

AI-driven 2D skeletal animation for Stake Engine slot games (PixiJS 8 + Svelte 5).
The user communicates in Korean; write user-facing docs and replies in Korean.

## Layout

- `packages/core` — format types, validator, compiled `SkeletonData`, `Skeleton` (world transforms,
  IK, skinning), `AnimationState` (tracks, mixing, queue, events). No DOM, runs in Node.
- `packages/pixi` — `Llm2dActor` (PixiJS 8 `Mesh` per slot, CPU skinning) and `loadLlm2d`.
- `packages/rig` — Node-only auto-rigging: `readPsd`, contour + constrained Delaunay `buildMesh`,
  medial-axis `chainJoints`, geodesic `computeWeights`, `buildRig(art, spec)`. `bendTest`/`bendPoses`
  live in core so the viewer can use them.
- `packages/motion` — motion presets (`applyPreset`, `describePresets`, `mergeAnimations`); pure TS.
- `packages/preview` — Node-only renders via Playwright + the viewer: `inspectImage`, `Previewer`
  (`loadFile`, `contactSheet`, `bendSheet`, `frame`).
- `packages/export` — game export: MaxRects atlas packing with edge extrusion, `resample`, `exportSkeleton`.
- `packages/svelte` — pixi-svelte components (`Llm2dProvider`, `Llm2dTrack`, `Llm2dBone`). Checked with
  svelte-check (root tsc excludes it). Imports inside it use `.js` extensions because svelte-package does
  not rewrite `.ts`.
- `packages/mcp` — stdio MCP server (`src/server.ts`, tools in `src/tools.ts`, project folders in
  `src/project.ts`). Registered for Claude Code in `.mcp.json`. Server `INSTRUCTIONS` describe the workflow.
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
- `samples/kit` — auto-rigged sample: `art.ts` + `make-psd.ts` produce `source/kit.psd`; `rig.json`
  (joints in PSD pixels) and `animations.ts` are the inputs to `pnpm rig build`.
- `pnpm samples` regenerates every sample's PNGs and `<name>.l2d.json`. Edit the sources, never the
  generated JSON/PNGs by hand.
- `scripts/` — `build-samples.ts`, `rig.ts` (inspect/build), `render.ts` (contact sheets and
  `--bend` sheets), `validate.ts`, `mcp-call.ts` (call MCP tools over stdio; images go to out/mcp), `stake-lines.ts`.
- `docs/format.md` (format spec), `docs/rigging.md` (rigging guide), `docs/mcp.md` (Claude/MCP
  guide), `docs/stake.md` (Stake integration), all Korean. Keep format.md in sync with `packages/core/src/format.ts`.

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

For MCP changes, call the tools end to end and look at the returned images:

```bash
pnpm mcp:call create_project '{"dir":"out/projects/ruby","art":"samples/gem/source/gem.psd","kind":"symbol","overwrite":true}'
```
