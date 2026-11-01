import { isHexColor } from './color.ts';
import { resolveCurve } from './curves.ts';
import { FORMAT_ID, FORMAT_VERSION, type L2DFile } from './format.ts';

export interface ValidationIssue {
  /** Location in the file, e.g. `animations.idle.bones.head.rotate[2].time`. */
  path: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

const BLENDS = new Set(['normal', 'add', 'multiply', 'screen']);
const MAX_INFLUENCES = 4;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

/**
 * Checks an LLM2D file for structural and semantic problems. Messages are written to be
 * actionable by a person or an LLM fixing the file.
 */
export function validate(input: unknown): ValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const err = (path: string, message: string) => errors.push({ path, message });
  const warn = (path: string, message: string) => warnings.push({ path, message });
  const done = (): ValidationResult => ({ ok: errors.length === 0, errors, warnings });

  if (!isObj(input)) {
    err('', 'File must be a JSON object');
    return done();
  }
  const f = input as Partial<L2DFile> & Obj;
  if (f.format !== FORMAT_ID) err('format', `Must be "${FORMAT_ID}"`);
  if (f.version !== FORMAT_VERSION) err('version', `Unsupported version "${String(f.version)}", expected "${FORMAT_VERSION}"`);
  if (!isStr(f.name)) err('name', 'Must be a non-empty string');

  // Images
  const images = new Set<string>();
  if (!isObj(f.images)) err('images', 'Must be an object of { name: { path, width, height } }');
  else
    for (const [name, img] of Object.entries(f.images)) {
      const p = `images.${name}`;
      images.add(name);
      if (!isObj(img)) {
        err(p, 'Must be an object');
        continue;
      }
      if (!isStr(img.path)) err(`${p}.path`, 'Must be a relative file path');
      if (!isNum(img.width) || img.width <= 0) err(`${p}.width`, 'Must be a positive number');
      if (img.frame !== undefined) {
        const fr = img.frame as Obj;
        if (!isObj(fr) || ![fr.x, fr.y, fr.width, fr.height].every(isNum) || (fr.x as number) < 0 || (fr.y as number) < 0 || (fr.width as number) <= 0 || (fr.height as number) <= 0)
          err(`${p}.frame`, 'Must be { x, y, width, height } in PNG pixels with a positive size');
      }
      if (!isNum(img.height) || img.height <= 0) err(`${p}.height`, 'Must be a positive number');
    }

  // Bones
  const boneIndex = new Map<string, number>();
  const boneParent: number[] = [];
  if (!Array.isArray(f.bones) || f.bones.length === 0) err('bones', 'Must be a non-empty array; the first bone is the root');
  else
    f.bones.forEach((b, i) => {
      const p = `bones[${i}]`;
      if (!isObj(b) || !isStr(b.name)) {
        err(p, 'Bone must be an object with a "name"');
        boneParent.push(-1);
        return;
      }
      if (boneIndex.has(b.name)) err(`${p}.name`, `Duplicate bone name "${b.name}"`);
      let parent = -1;
      if (i === 0) {
        if (b.parent !== undefined) err(`${p}.parent`, 'The first bone is the root and must not have a parent');
      } else if (!isStr(b.parent)) {
        err(`${p}.parent`, `Bone "${b.name}" needs a parent (only the first bone may be the root)`);
      } else if (!boneIndex.has(b.parent)) {
        err(`${p}.parent`, `Parent "${b.parent}" must be defined before "${b.name}"`);
      } else parent = boneIndex.get(b.parent)!;
      boneIndex.set(b.name, i);
      boneParent.push(parent);
      for (const k of ['x', 'y', 'rotation', 'scaleX', 'scaleY', 'length'] as const)
        if (b[k] !== undefined && !isNum(b[k])) err(`${p}.${k}`, 'Must be a finite number');
      if (b.length !== undefined && isNum(b.length) && b.length < 0) err(`${p}.length`, 'Must be >= 0');
    });

  const isDescendant = (bone: number, ancestor: number) => {
    for (let b = bone; b !== -1; b = boneParent[b]) if (b === ancestor) return true;
    return false;
  };

  // Slots
  const slotIndex = new Map<string, number>();
  const slotAttachments = new Map<string, Set<string>>();
  if (!Array.isArray(f.slots)) err('slots', 'Must be an array (draw order, back to front)');
  else
    f.slots.forEach((s, i) => {
      const p = `slots[${i}]`;
      if (!isObj(s) || !isStr(s.name)) {
        err(p, 'Slot must be an object with a "name"');
        return;
      }
      if (slotIndex.has(s.name)) err(`${p}.name`, `Duplicate slot name "${s.name}"`);
      slotIndex.set(s.name, i);
      if (!isStr(s.bone) || !boneIndex.has(s.bone)) err(`${p}.bone`, `Unknown bone "${String(s.bone)}"`);
      if (s.color !== undefined && !isHexColor(s.color)) err(`${p}.color`, 'Must be RRGGBB or RRGGBBAA hex');
      if (s.blend !== undefined && !BLENDS.has(s.blend as string))
        err(`${p}.blend`, `Must be one of ${[...BLENDS].join(', ')}`);
    });

  // Attachments
  if (!isObj(f.attachments)) err('attachments', 'Must be an object: { slotName: { attachmentName: {...} } }');
  else
    for (const [slotName, group] of Object.entries(f.attachments)) {
      const sp = `attachments.${slotName}`;
      if (!slotIndex.has(slotName)) err(sp, `Unknown slot "${slotName}"`);
      if (!isObj(group)) {
        err(sp, 'Must be an object of attachments');
        continue;
      }
      const names = new Set<string>();
      slotAttachments.set(slotName, names);
      for (const [name, a] of Object.entries(group)) {
        names.add(name);
        const p = `${sp}.${name}`;
        if (!isObj(a)) {
          err(p, 'Must be an object');
          continue;
        }
        if (!isStr(a.image) || !images.has(a.image)) err(`${p}.image`, `Unknown image "${String(a.image)}"`);
        if (a.type === 'region') {
          for (const k of ['x', 'y'] as const) if (!isNum(a[k])) err(`${p}.${k}`, 'Must be a finite number');
          for (const k of ['rotation', 'scaleX', 'scaleY', 'width', 'height'] as const)
            if (a[k] !== undefined && !isNum(a[k])) err(`${p}.${k}`, 'Must be a finite number');
        } else if (a.type === 'mesh') {
          validateMesh(a, p, boneIndex, err, warn);
        } else err(`${p}.type`, 'Must be "region" or "mesh"');
      }
    }

  if (Array.isArray(f.slots))
    f.slots.forEach((s, i) => {
      if (!isObj(s) || s.attachment === undefined || s.attachment === null) return;
      if (!slotAttachments.get(s.name as string)?.has(s.attachment as string))
        err(`slots[${i}].attachment`, `No attachment "${String(s.attachment)}" under attachments.${String(s.name)}`);
    });

  // IK
  const ikNames = new Set<string>();
  if (f.ik !== undefined) {
    if (!Array.isArray(f.ik)) err('ik', 'Must be an array');
    else
      f.ik.forEach((c, i) => {
        const p = `ik[${i}]`;
        if (!isObj(c) || !isStr(c.name)) {
          err(p, 'IK constraint must be an object with a "name"');
          return;
        }
        if (ikNames.has(c.name)) err(`${p}.name`, `Duplicate IK name "${c.name}"`);
        ikNames.add(c.name);
        const bones = Array.isArray(c.bones) ? (c.bones as unknown[]) : [];
        if (bones.length < 1 || bones.length > 2) {
          err(`${p}.bones`, 'Must list 1 bone (aim) or 2 bones [parent, child]');
          return;
        }
        const idx = bones.map((b) => (isStr(b) ? boneIndex.get(b) : undefined));
        idx.forEach((v, j) => v === undefined && err(`${p}.bones[${j}]`, `Unknown bone "${String(bones[j])}"`));
        if (idx.length === 2 && idx[0] !== undefined && idx[1] !== undefined && boneParent[idx[1]] !== idx[0])
          err(`${p}.bones`, `"${String(bones[1])}" must be a direct child of "${String(bones[0])}"`);
        const t = isStr(c.target) ? boneIndex.get(c.target) : undefined;
        if (t === undefined) err(`${p}.target`, `Unknown bone "${String(c.target)}"`);
        else if (idx[0] !== undefined && isDescendant(t, idx[0]))
          err(`${p}.target`, `Target "${String(c.target)}" must not be inside the chain it drives; parent it to the root`);
        if (c.mix !== undefined && (!isNum(c.mix) || c.mix < 0 || c.mix > 1)) err(`${p}.mix`, 'Must be between 0 and 1');
      });
  }

  // Animations
  if (!isObj(f.animations)) err('animations', 'Must be an object of { name: animation }');
  else
    for (const [animName, anim] of Object.entries(f.animations)) {
      const ap = `animations.${animName}`;
      if (!isObj(anim)) {
        err(ap, 'Must be an object');
        continue;
      }
      if (anim.duration !== undefined && (!isNum(anim.duration) || anim.duration < 0))
        err(`${ap}.duration`, 'Must be a number >= 0');
      let keyCount = 0;
      if (anim.bones !== undefined) {
        if (!isObj(anim.bones)) err(`${ap}.bones`, 'Must be an object keyed by bone name');
        else
          for (const [bone, tl] of Object.entries(anim.bones)) {
            const bp = `${ap}.bones.${bone}`;
            if (!boneIndex.has(bone)) err(bp, `Unknown bone "${bone}"`);
            if (!isObj(tl)) {
              err(bp, 'Must be an object with rotate/translate/scale');
              continue;
            }
            for (const k of Object.keys(tl))
              if (!['rotate', 'translate', 'scale'].includes(k)) err(`${bp}.${k}`, 'Unknown bone timeline; use rotate, translate or scale');
            keyCount += checkKeys(tl.rotate, `${bp}.rotate`, ['value'], [], err);
            keyCount += checkKeys(tl.translate, `${bp}.translate`, [], ['x', 'y'], err);
            keyCount += checkKeys(tl.scale, `${bp}.scale`, [], ['x', 'y'], err);
          }
      }
      if (anim.slots !== undefined) {
        if (!isObj(anim.slots)) err(`${ap}.slots`, 'Must be an object keyed by slot name');
        else
          for (const [slot, tl] of Object.entries(anim.slots)) {
            const sp = `${ap}.slots.${slot}`;
            if (!slotIndex.has(slot)) err(sp, `Unknown slot "${slot}"`);
            if (!isObj(tl)) {
              err(sp, 'Must be an object with color/alpha/attachment');
              continue;
            }
            for (const k of Object.keys(tl))
              if (!['color', 'alpha', 'attachment'].includes(k)) err(`${sp}.${k}`, 'Unknown slot timeline; use color, alpha or attachment');
            keyCount += checkKeys(tl.alpha, `${sp}.alpha`, ['value'], [], err);
            if (tl.color !== undefined) {
              keyCount += checkKeys(tl.color, `${sp}.color`, [], [], err);
              if (Array.isArray(tl.color))
                tl.color.forEach((k, j) => {
                  if (isObj(k) && !isHexColor(k.value)) err(`${sp}.color[${j}].value`, 'Must be RRGGBB or RRGGBBAA hex');
                });
            }
            if (tl.attachment !== undefined) {
              keyCount += checkKeys(tl.attachment, `${sp}.attachment`, [], [], err, false);
              if (Array.isArray(tl.attachment))
                tl.attachment.forEach((k, j) => {
                  if (!isObj(k)) return;
                  if (k.name !== null && !slotAttachments.get(slot)?.has(k.name as string))
                    err(`${sp}.attachment[${j}].name`, `No attachment "${String(k.name)}" under attachments.${slot} (use null to hide)`);
                });
            }
          }
      }
      if (anim.ik !== undefined) {
        if (!isObj(anim.ik)) err(`${ap}.ik`, 'Must be an object keyed by IK constraint name');
        else
          for (const [ik, tl] of Object.entries(anim.ik)) {
            const ip = `${ap}.ik.${ik}`;
            if (!ikNames.has(ik)) err(ip, `Unknown IK constraint "${ik}"`);
            if (!isObj(tl)) err(ip, 'Must be an object with mix');
            else keyCount += checkKeys(tl.mix, `${ip}.mix`, ['value'], [], err);
          }
      }
      if (anim.events !== undefined) {
        if (!Array.isArray(anim.events)) err(`${ap}.events`, 'Must be an array of { time, name }');
        else
          anim.events.forEach((e, j) => {
            if (!isObj(e) || !isNum(e.time) || e.time < 0 || !isStr(e.name))
              err(`${ap}.events[${j}]`, 'Event needs a time >= 0 and a name');
          });
      }
      if (keyCount === 0 && !(Array.isArray(anim.events) && anim.events.length))
        warn(ap, 'Animation has no keys');
    }

  return done();
}

function validateMesh(
  a: Obj,
  p: string,
  boneIndex: Map<string, number>,
  err: (p: string, m: string) => void,
  warn: (p: string, m: string) => void,
) {
  const nums = (v: unknown): v is number[] => Array.isArray(v) && v.every(isNum);
  if (!nums(a.vertices) || a.vertices.length < 6 || a.vertices.length % 2) {
    err(`${p}.vertices`, 'Must be a flat [x, y, ...] array with at least 3 vertices');
    return;
  }
  const n = a.vertices.length / 2;
  if (!nums(a.uvs) || a.uvs.length !== a.vertices.length) err(`${p}.uvs`, `Must have ${a.vertices.length} numbers (one u,v per vertex)`);
  if (!nums(a.triangles) || a.triangles.length < 3 || a.triangles.length % 3)
    err(`${p}.triangles`, 'Must be a flat list of vertex indices, 3 per triangle');
  else if (a.triangles.some((t) => !Number.isInteger(t) || t < 0 || t >= n))
    err(`${p}.triangles`, `Indices must be integers in 0..${n - 1}`);
  if (a.hull !== undefined && (!Number.isInteger(a.hull) || (a.hull as number) < 3 || (a.hull as number) > n))
    err(`${p}.hull`, `Must be an integer between 3 and ${n}`);

  const bones = a.bones;
  if (bones !== undefined) {
    if (!Array.isArray(bones) || bones.length === 0) err(`${p}.bones`, 'Must be a non-empty list of bone names');
    else bones.forEach((b, i) => (!isStr(b) || !boneIndex.has(b)) && err(`${p}.bones[${i}]`, `Unknown bone "${String(b)}"`));
  }
  if (a.weights !== undefined) {
    if (!Array.isArray(bones)) {
      err(`${p}.weights`, 'Weights need a "bones" list to index into');
      return;
    }
    if (!Array.isArray(a.weights) || a.weights.length !== n) {
      err(`${p}.weights`, `Must have one entry per vertex (${n})`);
      return;
    }
    a.weights.forEach((w, i) => {
      const wp = `${p}.weights[${i}]`;
      if (!nums(w) || w.length < 2 || w.length % 2) {
        err(wp, 'Must be flat pairs [boneIndex, weight, ...]');
        return;
      }
      let sum = 0;
      for (let k = 0; k < w.length; k += 2) {
        if (!Number.isInteger(w[k]) || w[k] < 0 || w[k] >= bones.length) err(wp, `Bone index ${w[k]} is outside "bones"`);
        if (w[k + 1] < 0) err(wp, 'Weights must be >= 0');
        sum += w[k + 1];
      }
      if (Math.abs(sum - 1) > 0.01) warn(wp, `Weights sum to ${sum.toFixed(3)}; they will be normalised to 1`);
      if (w.length / 2 > MAX_INFLUENCES) warn(wp, `More than ${MAX_INFLUENCES} bones influence this vertex`);
    });
  } else if (Array.isArray(bones) && bones.length > 1) {
    err(`${p}.weights`, 'A mesh with several bones needs per-vertex weights');
  }
}

/**
 * Validates a key list. `required` fields must be finite numbers; `optional` fields may be
 * omitted. Returns the number of keys (0 if invalid or missing).
 */
function checkKeys(
  keys: unknown,
  p: string,
  required: string[],
  optional: string[],
  err: (p: string, m: string) => void,
  curves = true,
): number {
  if (keys === undefined) return 0;
  if (!Array.isArray(keys) || keys.length === 0) {
    err(p, 'Must be a non-empty array of keys');
    return 0;
  }
  let last = -Infinity;
  keys.forEach((k, i) => {
    const kp = `${p}[${i}]`;
    if (!isObj(k)) {
      err(kp, 'Key must be an object');
      return;
    }
    if (!isNum(k.time) || k.time < 0) err(`${kp}.time`, 'Must be a number >= 0 (seconds)');
    else {
      if (k.time < last) err(`${kp}.time`, `Keys must be sorted by time (${k.time} comes after ${last})`);
      last = k.time;
    }
    for (const r of required) if (!isNum(k[r])) err(`${kp}.${r}`, 'Must be a finite number');
    for (const o of optional) if (k[o] !== undefined && !isNum(k[o])) err(`${kp}.${o}`, 'Must be a finite number');
    if (curves && k.curve !== undefined && resolveCurve(k.curve) === null)
      err(`${kp}.curve`, 'Unknown curve; use "linear", "stepped", an easing like "easeOutBack", or [x1, y1, x2, y2]');
  });
  return keys.length;
}
