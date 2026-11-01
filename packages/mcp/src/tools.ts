import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { CURVE_NAMES, Skeleton, SkeletonData, bendTest, validate, type L2DAnimation, type L2DFile } from '@llm2d/core';
import { applyPreset, describePresets, findPreset, mergeAnimations } from '@llm2d/motion';
import { Previewer, inspectImage } from '@llm2d/preview';
import { Project, type ProjectSpec } from './project.ts';

type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
type Result = { content: Content[]; isError?: boolean };

const text = (t: string): Content => ({ type: 'text', text: t });
const image = (png: Uint8Array): Content => ({ type: 'image', data: Buffer.from(png).toString('base64'), mimeType: 'image/png' });

export const INSTRUCTIONS = `LLM2D rigs and animates 2D art for slot games (characters, symbols, titles) and previews it with the real PixiJS runtime the game uses.

Workflow
1. create_project(dir, art = a layered PSD). Look at the inspect image: layer boxes over the art and a pixel grid labelled in art pixels.
2. set_rig_spec: place bones by joint in art pixels ("from" = pivot, "to" = tip). Use "chains" for tails, hair, scarves, ears (only the root point is needed; bones follow the middle of the shape). In "parts", give each layer the bones that move it: one bone = rigid, several = a bending mesh with automatic weights. The reply overlays your bones on the art; check every pivot sits on the joint before building.
3. build_rig: read the bend test. Fix errors (move joints, add a bone, lower "spacing" or raise "softness" for that part) before animating.
4. describe_skeleton: bone names, setup angles, slots and attachments.
5. Animate: apply_preset for standard motions (see list_presets), set_animation for custom keys. Build one animation from several presets with mode "merge" and "start".
6. After every change, look at the frames (the edit tools return a preview; render_animation for more detail) and fix what looks wrong: limbs hidden behind other layers, feet sliding or detaching, overshoot, loops that jump.
7. validate_project, then export_project into the game's assets.

Conventions
- y points down. Angles in degrees; positive = clockwise on screen.
- Bone keys are relative to the setup pose: rotate and translate are added, scale multiplies. Slot color/alpha keys are absolute.
- A key's "curve" shapes the motion to the next key: "linear", "stepped", easings.net names such as "easeOutBack", or [x1, y1, x2, y2].
- Loops must end where they start. Symbols usually need "idle", "land" and "win"; characters "idle" plus actions.
- IK legs: when the hip moves up, move the foot target bones up with the same timing, or the legs come apart.`;

const pt = z.tuple([z.number(), z.number()]);

const specSchema = z.object({
  name: z.string().regex(/^[A-Za-z0-9_-]+$/).describe('Skeleton name; also the output file name.'),
  art: z.string().optional().describe('Path to the PSD, relative to the project folder (create_project sets it).'),
  scale: z.number().positive().optional().describe('Skeleton units per art pixel. 0.5 for @2x art.'),
  origin: pt.describe('Art pixel that becomes the skeleton origin (characters: between the feet on the ground; symbols: centre).'),
  bones: z
    .array(
      z.object({
        name: z.string(),
        parent: z.string().optional().describe('Defaults to "root". Must be defined earlier (or be a chain bone).'),
        from: pt.describe('Joint / pivot in art pixels.'),
        to: pt.optional().describe('Tip in art pixels: sets the direction and length. Omit for IK targets and pure pivots.'),
      }),
    )
    .describe('Bones in parent-before-child order. "root" exists automatically at the origin.'),
  chains: z
    .array(
      z.object({
        layer: z.string().describe('Layer the chain runs through.'),
        prefix: z.string().describe('Bones are named prefix1..prefixN.'),
        count: z.number().int().min(1).max(12),
        parent: z.string(),
        start: pt.describe('Root of the chain in art pixels (e.g. where the tail meets the body).'),
        end: pt.optional().describe('Optional tip, to choose a branch or set the exact end.'),
      }),
    )
    .optional()
    .describe('Bone chains placed automatically along the middle of a layer.'),
  parts: z
    .record(
      z.string(),
      z.object({
        bone: z.string().optional().describe('Rigid: follow this bone.'),
        bones: z.array(z.string()).optional().describe('Bend with these bones (weighted mesh).'),
        slot: z.string().optional().describe("Put this layer in another layer's slot as alternate art (e.g. eyes_closed -> eyes)."),
        mesh: z.boolean().optional().describe('Force a mesh (true) or a plain quad (false).'),
        spacing: z.number().positive().optional().describe('Mesh vertex spacing in art pixels (smaller = smoother bends).'),
        softness: z.number().positive().optional().describe('How far joints blend, in art pixels (bigger = softer).'),
        smooth: z.number().int().min(0).max(10).optional(),
        blend: z.enum(['normal', 'add', 'multiply', 'screen']).optional(),
        alpha: z.number().min(0).max(1).optional().describe('Opacity at setup pose. Use 0 for glows/flashes/sparkles that animations fade in.'),
        skip: z.boolean().optional().describe('Leave the layer out.'),
      }),
    )
    .optional()
    .describe('Per-layer settings keyed by layer name. Unlisted layers follow the bone(s) running through them, else the nearest bone.'),
  ik: z
    .array(
      z.object({
        name: z.string(),
        bones: z.array(z.string()).min(1).max(2).describe('[upper, lower] for a limb, or one bone to aim.'),
        target: z.string().describe('Target bone, usually a child of root (e.g. foot_l_ik).'),
        bendPositive: z.boolean().optional().describe('true: the lower bone bends clockwise relative to the upper.'),
        mix: z.number().min(0).max(1).optional(),
      }),
    )
    .optional(),
  mesh: z
    .object({ spacing: z.number().optional(), tolerance: z.number().optional(), margin: z.number().optional(), softness: z.number().optional(), smooth: z.number().optional() })
    .optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
});

const animationSchema = z
  .object({
    duration: z.number().min(0).optional().describe('Defaults to the last key time.'),
    bones: z
      .record(z.string(), z.record(z.string(), z.array(z.record(z.string(), z.unknown()))))
      .optional()
      .describe('{ bone: { rotate: [{time, value, curve?}], translate: [{time, x?, y?, curve?}], scale: [{time, x?, y?, curve?}] } }'),
    slots: z
      .record(z.string(), z.record(z.string(), z.array(z.record(z.string(), z.unknown()))))
      .optional()
      .describe('{ slot: { color: [{time, value: "RRGGBBAA"}], alpha: [{time, value}], attachment: [{time, name|null}] } }'),
    ik: z.record(z.string(), z.record(z.string(), z.array(z.record(z.string(), z.unknown())))).optional().describe('{ ikName: { mix: [{time, value}] } }'),
    events: z.array(z.object({ time: z.number(), name: z.string() }).catchall(z.unknown())).optional(),
  })
  .describe('LLM2D animation. Times in seconds; bone values relative to setup.');

const dirArg = z.string().describe('Project folder (absolute, or relative to the server working directory).');
const bg = z.enum(['dark', 'light', 'checker']).optional().describe('Background. Default dark.');

export function createServer() {
  const server = new McpServer({ name: 'llm2d', version: '0.1.0' }, { instructions: INSTRUCTIONS });
  const previewer = new Previewer();
  // One browser page renders everything; serialise preview work.
  let queue: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => {});
    return run;
  };

  const tool = <Shape extends z.ZodRawShape>(
    name: string,
    config: { title: string; description: string; input: Shape; readOnly?: boolean; destructive?: boolean },
    fn: (args: z.infer<z.ZodObject<Shape>>) => Promise<Content[]>,
  ) =>
    server.registerTool(
      name,
      {
        title: config.title,
        description: config.description,
        inputSchema: config.input,
        annotations: { readOnlyHint: !!config.readOnly, destructiveHint: !!config.destructive, openWorldHint: false },
      },
      (async (args: any): Promise<Result> => {
        try {
          return { content: await fn(args) };
        } catch (e) {
          return { content: [text(`Error: ${(e as Error).message}`)], isError: true };
        }
      }) as any,
    );

  /** Renders a short preview of an animation from the project's current skeleton. */
  const preview = (project: Project, animation: string, frames = 8): Promise<Content[]> =>
    exclusive(async () => {
      await previewer.loadFile(await project.requireSkeletonPath());
      return [image(await previewer.contactSheet(animation, { frames, cell: 180, columns: 4 }))];
    });

  const layerTable = (art: { width: number; height: number; layers: { name: string; x: number; y: number; image: { width: number; height: number }; hidden: boolean }[] }) =>
    `Art ${art.width}x${art.height} px, ${art.layers.length} layers (bottom to top):\n` +
    art.layers.map((l) => `  ${l.name}  x=${l.x} y=${l.y} ${l.image.width}x${l.image.height}${l.hidden ? '  (hidden: alternate art via parts.slot, or an effect that starts invisible if listed in parts)' : ''}`).join('\n');

  // ---------------- Project & rig ----------------

  tool(
    'create_project',
    {
      title: 'Create project from layered art',
      description:
        'Starts an LLM2D project from a layered PSD: copies the art into <dir>/source, writes a starter rig.json (origin and scale guessed) and returns the layer list with an inspect image (layer boxes and a pixel grid in art pixels) for placing joints.',
      input: {
        dir: dirArg,
        art: z.string().describe('Path to the layered PSD.'),
        kind: z.enum(['character', 'symbol']).default('character').describe('Sets the origin: feet for characters, centre for symbols.'),
        name: z.string().optional().describe('Skeleton name. Default: folder name.'),
        scale: z.number().positive().optional().describe('Skeleton units per art pixel. Default 0.5 for art over 1200 px, else 1.'),
        overwrite: z.boolean().default(false).describe('Replace an existing rig.json.'),
        image: z.boolean().default(true).describe('Return the inspect image.'),
      },
    },
    async (a) => {
      const { project, art, spec } = await Project.create(a.dir, a.art, { kind: a.kind, name: a.name, scale: a.scale, overwrite: a.overwrite });
      const out: Content[] = [
        text(
          `Project ${project.dir}\nrig.json: name "${spec.name}", scale ${spec.scale}, origin [${spec.origin}] (${a.kind}).\n${layerTable(art)}\n\nNext: set_rig_spec with bones (pixel coordinates from the grid), chains and parts.`,
        ),
      ];
      if (a.image) out.push(image(await exclusive(() => inspectImage(art, { spec }))));
      return out;
    },
  );

  tool(
    'inspect_art',
    {
      title: 'Inspect art',
      description: "Layer list and an image of the art with layer boxes, a pixel grid in art pixels and (by default) the current rig spec's bones drawn on top.",
      input: { dir: dirArg, show_rig: z.boolean().default(true) },
      readOnly: true,
    },
    async (a) => {
      const project = new Project(a.dir);
      const art = await project.readArt();
      const spec = a.show_rig ? await project.readSpec() : null;
      const png = await exclusive(() => inspectImage(art, { spec: spec ?? undefined }));
      return [text(layerTable(art)), image(png)];
    },
  );

  tool(
    'get_rig_spec',
    { title: 'Get rig spec', description: "Returns the project's rig.json (bones, chains, parts, IK) to edit and send back with set_rig_spec.", input: { dir: dirArg }, readOnly: true },
    async (a) => [text(JSON.stringify(await new Project(a.dir).requireSpec(), null, 2))],
  );

  tool(
    'set_rig_spec',
    {
      title: 'Set rig spec',
      description:
        'Replaces rig.json (send the whole spec). Checks names against the art and returns the art with your bones drawn on it so you can verify each pivot before build_rig. All coordinates are art pixels.',
      input: { dir: dirArg, spec: specSchema, image: z.boolean().default(true).describe('Return the art with the bones drawn on it.') },
    },
    async (a) => {
      const project = new Project(a.dir);
      const old = await project.readSpec();
      const spec: ProjectSpec = { ...a.spec, art: a.spec.art ?? old?.art } as ProjectSpec;
      if (!spec.art) throw new Error('spec.art is missing; give the PSD path relative to the project folder.');
      await project.writeSpec(spec);
      const art = await project.readArt();
      const layers = new Set(art.layers.map((l) => l.name));
      const names = new Set(['root', ...spec.bones.map((b) => b.name)]);
      for (const c of spec.chains ?? []) for (let i = 1; i <= c.count; i++) names.add(`${c.prefix}${i}`);
      const problems: string[] = [];
      for (const b of spec.bones) if (b.parent && !names.has(b.parent)) problems.push(`bone ${b.name}: unknown parent "${b.parent}"`);
      for (const c of spec.chains ?? []) if (!layers.has(c.layer)) problems.push(`chain ${c.prefix}: no layer "${c.layer}"`);
      for (const [layer, part] of Object.entries(spec.parts ?? {})) {
        if (!layers.has(layer)) problems.push(`parts.${layer}: no such layer`);
        for (const b of [...(part.bones ?? []), ...(part.bone ? [part.bone] : [])]) if (!names.has(b)) problems.push(`parts.${layer}: unknown bone "${b}"`);
      }
      for (const c of spec.ik ?? []) for (const b of [...c.bones, c.target]) if (!names.has(b)) problems.push(`ik ${c.name}: unknown bone "${b}"`);
      const unassigned = art.layers.filter((l) => !spec.parts?.[l.name]).map((l) => l.name);
      const out: Content[] = [
        text(
          `Saved ${project.specPath}: ${spec.bones.length} bones, ${spec.chains?.length ?? 0} chains, ${Object.keys(spec.parts ?? {}).length} parts.\n` +
            (problems.length ? `Problems:\n  ${problems.join('\n  ')}\n` : 'No naming problems found.\n') +
            (unassigned.length ? `Layers without parts (assigned automatically at build): ${unassigned.join(', ')}\n` : '') +
            'Check the image: every yellow pivot should sit on its joint. Then build_rig.',
        ),
      ];
      if (a.image) out.push(image(await exclusive(() => inspectImage(art, { spec }))));
      return out;
    },
  );

  tool(
    'build_rig',
    {
      title: 'Build rig',
      description:
        'Builds the skeleton from the art and rig.json: meshes, chain bones and weights are automatic; animations.json is included. Writes <name>.l2d.json + images/ and runs the bend test (each joint bent ±45°, IK chains crouched and swung), returning its report and an image of the test poses.',
      input: { dir: dirArg, bend_sheet: z.boolean().default(true).describe('Include the bend test image.') },
    },
    async (a) => {
      const project = new Project(a.dir);
      const { result, bend, path } = await project.build();
      const parts = result.report.parts
        .map((p) => `  ${p.layer}: ${p.kind}${p.kind === 'mesh' ? ` ${p.vertices}v` : ''} -> ${p.bones.join(', ')}${p.auto ? ' (auto)' : ''}${p.slot !== p.layer ? ` [slot ${p.slot}]` : ''}`)
        .join('\n');
      const chains = Object.entries(result.report.chains)
        .map(([k, j]) => `  chain ${k}: ${j.map(([x, y]) => `(${Math.round(x)}, ${Math.round(y)})`).join(' -> ')}`)
        .join('\n');
      const out: Content[] = [
        text(
          `Built ${path}: ${result.file.bones.length} bones, ${result.file.slots.length} slots, ${Object.keys(result.file.animations).length} animations.\n${parts}\n${chains}\n` +
            (result.report.warnings.length ? `Warnings:\n  ${result.report.warnings.join('\n  ')}\n` : '') +
            `${bend.summary}\n${bend.issues.map((i) => `  ${i.severity}: ${i.message}`).join('\n')}`,
        ),
      ];
      const hasMeshes = result.file.slots.some((s) => Object.values(result.file.attachments[s.name] ?? {}).some((x) => x.type === 'mesh'));
      if (a.bend_sheet && hasMeshes)
        out.push(
          ...(await exclusive(async () => {
            await previewer.loadFile(path, String(Date.now()));
            return [image(await previewer.bendSheet({ cell: 170 }))];
          })),
        );
      return out;
    },
  );

  tool(
    'bend_test',
    {
      title: 'Bend test',
      description: 'Re-runs the bend test on the built skeleton. stress adds extreme poses (±90°, deep crouch) as warnings.',
      input: { dir: dirArg, stress: z.boolean().default(false), image: z.boolean().default(true) },
      readOnly: true,
    },
    async (a) => {
      const project = new Project(a.dir);
      const file = await project.readSkeleton();
      const bend = bendTest(SkeletonData.fromJSON(file), a.stress ? {} : { stress: [], crouchStress: [], swingStress: [] });
      const out: Content[] = [text(`${bend.summary}\n${bend.issues.map((i) => `  ${i.severity}: ${i.message}`).join('\n')}`)];
      if (a.image)
        out.push(
          ...(await exclusive(async () => {
            await previewer.loadFile(await project.requireSkeletonPath());
            return [image(await previewer.bendSheet({ cell: 170, stress: a.stress }))];
          })),
        );
      return out;
    },
  );

  tool(
    'describe_skeleton',
    {
      title: 'Describe skeleton',
      description:
        'Bones (parent, setup position and world angle, length), slots with their attachments, IK constraints and animations of the built skeleton. Use the names from here in presets and keys.',
      input: { dir: dirArg },
      readOnly: true,
    },
    async (a) => {
      const project = new Project(a.dir);
      const file = await project.readSkeleton();
      const spec = await project.readSpec();
      const data = SkeletonData.fromJSON(file);
      const sk = new Skeleton(data);
      const toArt = (x: number, y: number) =>
        spec ? ` art(${Math.round(spec.origin[0] + x / (spec.scale ?? 1))}, ${Math.round(spec.origin[1] + y / (spec.scale ?? 1))})` : '';
      const lines = [`Skeleton "${file.name}". Units: skeleton units (y down). Bounds ${JSON.stringify(data.bounds)}.`, 'Bones (name <- parent: setup position, world angle, length):'];
      for (const b of data.bones) {
        const [x, y] = sk.boneWorldPosition(b.index);
        const parent = b.parent >= 0 ? data.bones[b.parent].name : '-';
        lines.push(`  ${b.name} <- ${parent}: (${x.toFixed(1)}, ${y.toFixed(1)})${toArt(x, y)}, ${sk.boneWorldRotation(b.index).toFixed(1)}°, len ${b.length}`);
      }
      lines.push('Slots (draw order, back to front):');
      for (const s of data.slots) {
        const atts = data.attachments[s.index].map((m) => `${m.name}${m.kind === 'mesh' ? ' (mesh)' : ''}`);
        lines.push(`  ${s.name} on ${data.bones[s.bone].name}: ${atts.join(', ')}; shows ${s.attachment >= 0 ? data.attachments[s.index][s.attachment].name : 'nothing'}${s.blend !== 'normal' ? `; blend ${s.blend}` : ''}`);
      }
      if (data.ik.length) {
        lines.push('IK:');
        for (const c of data.ik) lines.push(`  ${c.name}: ${c.bones.map((b) => data.bones[b].name).join(' -> ')} target ${data.bones[c.target].name}, bendPositive ${c.bendPositive}, mix ${c.mix}`);
      }
      lines.push('Animations:');
      for (const anim of data.animations.values()) lines.push(`  ${anim.name}: ${anim.duration.toFixed(2)}s, ${anim.timelines.length} timelines, events ${anim.events.map((e) => `${e.name}@${e.time}`).join(' ') || '-'}`);
      if (!data.animations.size) lines.push('  (none)');
      return [text(lines.join('\n'))];
    },
  );

  // ---------------- Animation ----------------

  tool(
    'list_presets',
    {
      title: 'List motion presets',
      description: 'Catalogue of motion presets (slot symbol states, character motions, general effects) and their parameters.',
      input: {},
      readOnly: true,
    },
    async () => [text(`${describePresets()}\n\nCurves you can use in keys: ${CURVE_NAMES.join(', ')}, or [x1, y1, x2, y2].`)],
  );

  tool(
    'apply_preset',
    {
      title: 'Apply motion preset',
      description:
        'Generates keys from a preset into an animation. mode "merge" (default) replaces only the timelines the preset writes and keeps the rest, so several presets build one animation; "replace" starts the animation fresh. Use the "start" param to place motion later in time. Returns a preview.',
      input: {
        dir: dirArg,
        animation: z.string().describe('Animation to write (created if missing).'),
        preset: z.string().describe('Preset name from list_presets.'),
        params: z.record(z.string(), z.unknown()).default({}).describe('Preset parameters.'),
        mode: z.enum(['merge', 'replace']).default('merge'),
        preview: z.boolean().default(true),
      },
    },
    async (a) => {
      const project = new Project(a.dir);
      const data = SkeletonData.fromJSON(await project.readSkeleton());
      const keys = applyPreset(data, a.preset, a.params);
      const animations = await project.readAnimations();
      const before = animations[a.animation];
      animations[a.animation] = a.mode === 'merge' && before ? mergeAnimations(before, keys) : keys;
      const result = await project.writeAnimations(animations);
      if (!result.ok) throw new Error(`Result is invalid:\n${result.errors.map((e) => `  ${e.path}: ${e.message}`).join('\n')}`);
      const preset = findPreset(a.preset);
      const out: Content[] = [
        text(
          `${a.mode === 'merge' && before ? 'Merged' : 'Wrote'} preset ${a.preset} into "${a.animation}"` +
            ` (bones: ${Object.keys(keys.bones ?? {}).join(', ') || '-'}; slots: ${Object.keys(keys.slots ?? {}).join(', ') || '-'}).` +
            `${preset.loops ? ' Designed to loop.' : ''}`,
        ),
      ];
      if (a.preview) out.push(...(await preview(project, a.animation)));
      return out;
    },
  );

  tool(
    'set_animation',
    {
      title: 'Set animation',
      description:
        'Creates or replaces one animation with your own keys (full JSON). Errors name the exact key to fix. Returns a preview.',
      input: { dir: dirArg, name: z.string(), animation: animationSchema, preview: z.boolean().default(true) },
    },
    async (a) => {
      const project = new Project(a.dir);
      const animations = await project.readAnimations();
      animations[a.name] = a.animation as L2DAnimation;
      const result = await project.writeAnimations(animations);
      if (!result.ok) throw new Error(`Not saved. Fix these:\n${result.errors.map((e) => `  ${e.path}: ${e.message}`).join('\n')}`);
      const warn = result.warnings.filter((w) => w.path.startsWith(`animations.${a.name}`));
      const out: Content[] = [text(`Saved "${a.name}".${warn.length ? ` Warnings: ${warn.map((w) => `${w.path}: ${w.message}`).join('; ')}` : ''}`)];
      if (a.preview) out.push(...(await preview(project, a.name)));
      return out;
    },
  );

  tool(
    'get_animation',
    { title: 'Get animation', description: 'Returns one animation as JSON, to edit and send back with set_animation.', input: { dir: dirArg, name: z.string() }, readOnly: true },
    async (a) => {
      const animations = await new Project(a.dir).readAnimations();
      const anim = animations[a.name];
      if (!anim) throw new Error(`No animation "${a.name}". Animations: ${Object.keys(animations).join(', ') || '(none)'}`);
      return [text(JSON.stringify(anim, null, 2))];
    },
  );

  tool(
    'delete_animation',
    { title: 'Delete animation', description: 'Removes one animation from animations.json and the built skeleton.', input: { dir: dirArg, name: z.string() }, destructive: true },
    async (a) => {
      const project = new Project(a.dir);
      const animations = await project.readAnimations();
      if (!animations[a.name]) throw new Error(`No animation "${a.name}".`);
      delete animations[a.name];
      await project.writeAnimations(animations);
      return [text(`Deleted "${a.name}". Remaining: ${Object.keys(animations).join(', ') || '(none)'}`)];
    },
  );

  // ---------------- Preview ----------------

  tool(
    'render_animation',
    {
      title: 'Render animation',
      description: 'Contact sheet: frames evenly spread over an animation (first and last included), rendered with the game runtime. debug draws bones, meshes and IK targets.',
      input: {
        dir: dirArg,
        name: z.string(),
        frames: z.number().int().min(1).max(24).default(8),
        cell: z.number().int().min(96).max(512).default(220),
        debug: z.boolean().default(false),
        background: bg,
      },
      readOnly: true,
    },
    async (a) => {
      const project = new Project(a.dir);
      return exclusive(async () => {
        const file = await previewer.loadFile(await project.requireSkeletonPath());
        const anim = file.animations[a.name];
        if (!anim) throw new Error(`No animation "${a.name}". Animations: ${Object.keys(file.animations).join(', ') || '(none)'}`);
        const data = SkeletonData.fromJSON(file).animations.get(a.name)!;
        const png = await previewer.contactSheet(a.name, { frames: a.frames, cell: a.cell, debug: a.debug, background: a.background });
        return [
          text(`"${a.name}": ${data.duration.toFixed(2)}s; events: ${data.events.map((e) => `${e.name}@${e.time}s`).join(', ') || 'none'}.`),
          image(png),
        ];
      });
    },
  );

  tool(
    'render_frame',
    {
      title: 'Render frame',
      description: 'One larger frame of an animation at a time, or the setup pose when no animation is given.',
      input: {
        dir: dirArg,
        name: z.string().optional().describe('Animation; omit for the setup pose.'),
        time: z.number().min(0).default(0),
        size: z.number().int().min(128).max(1024).default(512),
        debug: z.boolean().default(false),
        background: bg,
      },
      readOnly: true,
    },
    async (a) => {
      const project = new Project(a.dir);
      return exclusive(async () => {
        await previewer.loadFile(await project.requireSkeletonPath());
        return [image(await previewer.frame(a.name ?? null, a.time, { size: a.size, debug: a.debug, background: a.background }))];
      });
    },
  );

  tool(
    'validate_project',
    {
      title: 'Validate project',
      description: 'Validates the skeleton file and its images, and summarises the bend test.',
      input: { dir: dirArg },
      readOnly: true,
    },
    async (a) => {
      const project = new Project(a.dir);
      const file: L2DFile = await project.readSkeleton();
      const result = validate(file);
      const lines = [result.ok ? 'Skeleton is valid.' : 'Skeleton has errors:'];
      for (const e of result.errors) lines.push(`  error ${e.path}: ${e.message}`);
      for (const w of result.warnings) lines.push(`  warning ${w.path}: ${w.message}`);
      const dir = (await project.requireSkeletonPath()).replace(/[^/\\]+$/, '');
      for (const [name, img] of Object.entries(file.images))
        if (!(await project.exists(dir + img.path))) lines.push(`  error images.${name}: missing file ${img.path}`);
      if (result.ok) lines.push(bendTest(SkeletonData.fromJSON(file), { stress: [], crouchStress: [], swingStress: [] }).summary);
      lines.push(`Animations: ${Object.keys(file.animations).join(', ') || '(none)'}`);
      return [text(lines.join('\n'))];
    },
  );

  tool(
    'export_project',
    {
      title: 'Export to game',
      description: "Copies the skeleton and its images to <dest>/<name>/ (for example a Stake game's static assets folder).",
      input: { dir: dirArg, dest: z.string().describe('Destination folder.') },
    },
    async (a) => {
      const files = await new Project(a.dir).export(a.dest);
      return [text(`Exported ${files.length} files:\n${files.map((f) => `  ${f}`).join('\n')}`)];
    },
  );

  return { server, previewer };
}
