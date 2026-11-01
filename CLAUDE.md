# LLM2D

AI-driven 2D skeletal animation for Stake Engine slot games (PixiJS 8 + Svelte 5).
The user communicates in Korean; write user-facing docs and replies in Korean.

## Layout

- `packages/core` — format types, validator, compiled `SkeletonData`, `Skeleton` (world transforms,
  IK, skinning), `AnimationState` (tracks, mixing, queue, events). No DOM, runs in Node.
- `packages/pixi` — `Llm2dActor` (PixiJS 8 `Mesh` per slot, CPU skinning) and `loadLlm2d`.
- `apps/viewer` — Vite viewer; also exposes `window.__llm2d` (`seek`, `contactSheet`, ...) for headless use.
- `samples/<name>/build.ts` — generates original SVG art + rig + animations; `pnpm samples` writes
  PNGs (@2x) and `<name>.l2d.json`. Edit build.ts, never the generated JSON/PNGs by hand.
- `scripts/` — `build-samples.ts`, `render.ts` (contact sheets via Playwright), `validate.ts`.
- `docs/format.md` — format spec (Korean). Keep it in sync with `packages/core/src/format.ts`.

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
