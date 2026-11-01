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
- `apps/viewer` — Vite viewer; also exposes `window.__llm2d` (`seek`, `contactSheet`, ...) for headless use.
- `samples/bolt|gem/build.ts` — generate original SVG art + rig + animations in code.
- `samples/kit` — auto-rigged sample: `art.ts` + `make-psd.ts` produce `source/kit.psd`; `rig.json`
  (joints in PSD pixels) and `animations.ts` are the inputs to `pnpm rig build`.
- `pnpm samples` regenerates every sample's PNGs and `<name>.l2d.json`. Edit the sources, never the
  generated JSON/PNGs by hand.
- `scripts/` — `build-samples.ts`, `rig.ts` (inspect/build), `render.ts` (contact sheets and
  `--bend` sheets via Playwright), `validate.ts`.
- `docs/format.md` (format spec) and `docs/rigging.md` (rigging guide), both Korean. Keep
  format.md in sync with `packages/core/src/format.ts`.

## Conventions

- No build step: TypeScript runs directly (Node type stripping, Vite, Vitest). Import with explicit
  `.ts` extensions, use `import type` for types, and avoid enums, namespaces and constructor
  parameter properties (`erasableSyntaxOnly`).
- Coordinates: y down, degrees, positive rotation clockwise. Attachment geometry is in skeleton
  space at setup pose; bone animation values are relative to setup (rotate/translate add, scale multiplies).
- Keep the runtime API shaped like spine-ts (`state.setAnimation(track, name, loop)`, `TrackEntry.listener`).
- Stake web SDK pins pixi.js 8.8.1 and svelte 5.20.5; stay compatible with those.

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
