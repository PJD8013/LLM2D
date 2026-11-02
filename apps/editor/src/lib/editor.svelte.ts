/**
 * Editor state: the open project, the animation being edited, playhead, selection, undo and
 * saving. The animation JSON lives in `data.source.animations` (the SkeletonData being shown);
 * every edit recompiles that one animation and re-poses the stage.
 */
import { SkeletonData, type L2DAnimation, type L2DCurve, type L2DFile } from '@llm2d/core';
import { loadImageTextures, type LoadedLlm2d } from '@llm2d/pixi';
import * as M from './model.ts';
import type { Stage } from './stage.ts';

export interface ProjectInfo {
  id: string;
  name: string;
  skeleton: string;
  editable: boolean;
  note?: string;
}

export type Tool = 'rotate' | 'translate' | 'scale';
export type Status = { kind: 'info' | 'ok' | 'error'; text: string } | null;

export class Editor {
  projects = $state<ProjectInfo[]>([]);
  info = $state<ProjectInfo | null>(null);
  animNames = $state<string[]>([]);
  animName = $state('');
  time = $state(0);
  playing = $state(false);
  loop = $state(true);
  speed = $state(1);
  fps = $state(30);
  tool = $state<Tool>('rotate');
  selectedBone = $state<string | null>(null);
  selectedSlot = $state<string | null>(null);
  selectedKeys = $state<M.KeyRef[]>([]);
  expanded = $state<string[]>([]);
  showAll = $state(false);
  onion = $state(false);
  dirty = $state(false);
  saving = $state(false);
  externalChange = $state(false);
  status = $state<Status>(null);
  /** Bumped on every change to the animation JSON (timeline redraws). */
  rev = $state(0);
  /** Bumped whenever the pose shown changes (inspector values). */
  poseRev = $state(0);
  canUndo = $state(false);
  canRedo = $state(false);
  loading = $state(false);

  /** Reassigned on load (reactive); edits inside it bump `rev` instead. */
  data = $state.raw<SkeletonData | null>(null);
  loaded = $state.raw<LoadedLlm2d | null>(null);
  stage: Stage | null = null;
  private history = new M.History();
  private clipboard: M.Clip | null = null;
  private saved = '';
  /** Snapshot taken at the start of a drag; each drag step replays from it. */
  private dragBase: string | null = null;

  // ---------------- Loading ----------------

  async init(): Promise<void> {
    this.projects = await (await fetch('/api/projects')).json();
    const want = new URLSearchParams(location.search).get('project');
    const first = this.projects.find((p) => p.id === want) ?? this.projects.find((p) => p.editable) ?? this.projects[0];
    if (first) await this.open(first.id);
    import.meta.hot?.on('llm2d:changed', (e: { id: string }) => this.onExternalChange(e.id));
  }

  /** Opens a project (or reloads the open one, keeping animation, time and selection). */
  async open(id: string, keep = false): Promise<void> {
    this.loading = true;
    try {
      const res = await fetch(`/api/project?id=${encodeURIComponent(id)}`);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? res.statusText);
      const file = body.file as L2DFile;
      const data = SkeletonData.fromJSON(file);
      const textures = await loadImageTextures(data.images, new URL(`/files/${encodeURIComponent(id)}/`, location.href).href);
      this.data = data;
      this.loaded = { data, textures };
      this.info = body.info;
      this.stage?.setSkeleton(this.loaded);
      this.history.clear();
      this.saved = this.snapshot();
      this.dirty = false;
      this.externalChange = false;
      this.refreshNames();
      if (!keep || !this.animNames.includes(this.animName)) {
        this.animName = this.animNames.includes('idle') ? 'idle' : (this.animNames[0] ?? '');
        this.time = 0;
        this.selectedKeys = [];
        this.selectedBone = null;
        this.selectedSlot = null;
      }
      if (!this.animName) this.newAnimation('idle', false);
      const url = new URL(location.href);
      url.searchParams.set('project', id);
      history.replaceState(null, '', url);
      this.updateUndo();
      this.rev++;
      this.pose();
      this.say(keep ? 'info' : null, keep ? '파일이 밖에서 바뀌어 다시 불러왔습니다.' : '');
    } catch (e) {
      this.say('error', `불러오기 실패: ${(e as Error).message}`);
    } finally {
      this.loading = false;
    }
  }

  private onExternalChange(id: string) {
    if (id !== this.info?.id || this.saving) return;
    if (!this.dirty) void this.open(id, true);
    else this.externalChange = true;
  }

  // ---------------- Basics ----------------

  get anim(): L2DAnimation {
    return this.data!.source.animations[this.animName];
  }

  get duration(): number {
    void this.rev;
    return this.data && this.animName && this.data.source.animations[this.animName] ? M.lengthOf(this.anim) : 0;
  }

  say(kind: 'info' | 'ok' | 'error' | null, text: string) {
    this.status = kind && text ? { kind, text } : null;
  }

  private refreshNames() {
    this.animNames = Object.keys(this.data?.source.animations ?? {}).sort();
  }

  private snapshot(): string {
    return JSON.stringify(this.data?.source.animations ?? {});
  }

  private updateUndo() {
    this.canUndo = this.history.canUndo;
    this.canRedo = this.history.canRedo;
    this.dirty = this.snapshot() !== this.saved;
  }

  /** Shows the pose at the playhead (and onion skins). */
  pose() {
    if (!this.data || !this.animName) return;
    this.stage?.poseAt(this.animName, this.time);
    this.poseRev++;
  }

  seek(time: number, snapToFrame = true) {
    this.time = Math.max(0, snapToFrame ? M.snap(time, this.fps) : time);
    this.pose();
  }

  step(frames: number) {
    this.playing = false;
    this.seek(M.snap(this.time, this.fps) + frames / this.fps);
  }

  /** Advances playback (called every frame by the stage). */
  tick(dt: number) {
    if (!this.playing || !this.data) return;
    const d = this.duration;
    let t = this.time + dt * this.speed;
    if (d <= 0) t = 0;
    else if (t > d) {
      if (this.loop) t %= d;
      else {
        t = d;
        this.playing = false;
      }
    }
    this.time = t;
    this.pose();
  }

  selectAnimation(name: string) {
    if (!this.data?.source.animations[name]) return;
    this.animName = name;
    this.selectedKeys = [];
    this.time = Math.min(this.time, this.duration);
    this.rev++;
    this.pose();
  }

  selectBone(name: string | null) {
    this.selectedBone = name;
    if (name) this.selectedSlot = null;
  }

  selectSlot(name: string | null) {
    this.selectedSlot = name;
    if (name) this.selectedBone = null;
  }

  // ---------------- Editing ----------------

  /** Applies a change to the current animation as one undo step. */
  edit(fn: (anim: L2DAnimation) => void, record = true) {
    if (!this.data || !this.animName) return;
    if (record) this.history.push(this.snapshot());
    fn(this.anim);
    this.commit();
  }

  private commit() {
    M.prune(this.anim);
    this.data!.setAnimation(this.animName, this.anim);
    this.updateUndo();
    this.rev++;
    this.pose();
  }

  /** Starts a drag: one undo step for everything until endDrag. */
  beginDrag() {
    this.dragBase = this.snapshot();
    this.history.push(this.dragBase);
  }

  /** Re-applies a drag step from the state at the start of the drag. */
  dragStep(fn: (anim: L2DAnimation) => void) {
    if (!this.dragBase || !this.data) return;
    const base = JSON.parse(this.dragBase) as Record<string, L2DAnimation>;
    this.data.source.animations[this.animName] = base[this.animName] ?? {};
    fn(this.anim);
    this.commit();
  }

  endDrag() {
    if (this.dragBase === this.snapshot()) this.history.undo(this.dragBase); // nothing changed
    this.dragBase = null;
    this.updateUndo();
  }

  /** Key time at the playhead, snapped to a frame. */
  keyTime(): number {
    return M.snap(this.time, this.fps);
  }

  /** Writes a key for a bone channel at the playhead from the values given (others kept). */
  keyBone(bone: string, channel: M.BoneChannel, values: Partial<{ value: number; x: number; y: number }>, record = true) {
    const time = this.keyTime();
    const track: M.Track = { group: 'bones', target: bone, channel };
    const apply = (anim: L2DAnimation) => {
      const existing = M.getKey(anim, { ...track, time });
      const fromPose = M.boneKeyFromPose(this.data!, this.stage!.skeleton!, bone, channel, time);
      M.setKey(anim, track, { ...fromPose, ...(existing ?? {}), ...values, time });
    };
    if (record === false) this.dragStep(apply);
    else this.edit(apply);
  }

  /** Keys the selected bone's channels (all three, or one) with the pose shown. */
  keySelected(channels: M.BoneChannel[] = ['rotate', 'translate', 'scale']) {
    const bone = this.selectedBone;
    if (!bone || !this.stage?.skeleton) return this.say('info', '먼저 뼈를 선택하세요.');
    const time = this.keyTime();
    const keys = channels.map((ch) => M.boneKeyFromPose(this.data!, this.stage!.skeleton!, bone, ch, time));
    this.edit((anim) => keys.forEach((k, i) => M.setKey(anim, { group: 'bones', target: bone, channel: channels[i] }, k)));
    this.say('ok', `${bone}: ${channels.map(M.channelLabel).join(', ')} 키를 ${time.toFixed(2)}초에 넣었습니다.`);
  }

  /** Writes a slot key at the playhead. */
  keySlot(slot: string, channel: M.SlotChannel, key: Record<string, unknown>) {
    const time = this.keyTime();
    this.edit((anim) => M.setKey(anim, { group: 'slots', target: slot, channel }, { ...key, time }));
  }

  /** Adds a key at a time using the value the animation has there (double-click on a track). */
  addKeyAt(track: M.Track, time: number) {
    if (!this.stage?.skeleton) return;
    this.seek(time);
    const t = this.keyTime();
    if (track.group === 'events') return this.addEvent('event');
    const sk = this.stage.skeleton;
    const key =
      track.group === 'bones'
        ? M.boneKeyFromPose(this.data!, sk, track.target, track.channel, t)
        : track.group === 'slots'
          ? M.slotKeyFromPose(this.data!, sk, track.target, track.channel, t)
          : { time: t, value: sk.channels[this.data!.ikChannelBase + this.data!.findIk(track.target)] };
    this.edit((anim) => M.setKey(anim, track, key));
    this.selectedKeys = [{ ...track, time: t } as M.KeyRef];
  }

  deleteSelectedKeys() {
    if (!this.selectedKeys.length) return;
    const refs = this.selectedKeys;
    this.edit((anim) => M.deleteKeys(anim, refs));
    this.say('ok', `키 ${refs.length}개를 지웠습니다.`);
    this.selectedKeys = [];
  }

  /** During a key drag: moves the keys selected at drag start by dt from where they started. */
  dragKeys(start: M.KeyRef[], dt: number) {
    let moved: M.KeyRef[] = [];
    this.dragStep((anim) => (moved = M.moveKeys(anim, start, dt)));
    this.selectedKeys = moved;
  }

  setCurve(curve: L2DCurve | undefined) {
    const refs = this.selectedKeys;
    this.edit((anim) => M.setCurve(anim, refs, curve));
  }

  setKeyTime(time: number) {
    const ref = this.selectedKeys[0];
    if (!ref) return;
    let moved: M.KeyRef[] = [];
    this.edit((anim) => (moved = M.moveKeys(anim, [ref], M.snap(time, 1000) - ref.time)));
    this.selectedKeys = moved;
  }

  /** Changes fields of the (single) selected key, e.g. { value: 30 } or { x: 4 }. */
  setKeyFields(fields: Record<string, unknown>) {
    const ref = this.selectedKeys[0];
    if (!ref) return;
    this.edit((anim) => {
      const k = M.getKey(anim, ref);
      if (k) Object.assign(k, fields);
    });
  }

  copy() {
    const clip = M.copyKeys(this.anim, this.selectedKeys);
    if (!clip) return this.say('info', '복사할 키를 먼저 선택하세요.');
    this.clipboard = clip;
    this.say('ok', `키 ${clip.items.length}개를 복사했습니다.`);
  }

  paste() {
    const clip = this.clipboard;
    if (!clip) return;
    const at = this.keyTime();
    let pasted: M.KeyRef[] = [];
    this.edit((anim) => (pasted = M.pasteKeys(anim, clip, at)));
    this.selectedKeys = pasted;
    this.say('ok', `키 ${pasted.length}개를 ${at.toFixed(2)}초에 붙였습니다.`);
  }

  // ---------------- Events ----------------

  addEvent(name: string) {
    const time = this.keyTime();
    this.edit((anim) => M.setKey(anim, M.EVENTS, { time, name }));
    this.selectedKeys = [{ ...M.EVENTS, time } as M.KeyRef];
  }

  updateEvent(index: number, fields: Record<string, unknown>) {
    this.edit((anim) => {
      const e = anim.events?.[index];
      if (!e) return;
      Object.assign(e, fields);
      anim.events!.sort((a, b) => a.time - b.time);
    });
  }

  deleteEvent(index: number) {
    this.edit((anim) => anim.events?.splice(index, 1));
  }

  // ---------------- Animations ----------------

  setDuration(duration: number | undefined) {
    this.edit((anim) => {
      if (duration === undefined) delete anim.duration;
      else anim.duration = Math.max(0, Math.round(duration * 1000) / 1000);
    });
  }

  newAnimation(name: string, record = true) {
    if (!this.data) return;
    if (!/^[A-Za-z0-9_-]+$/.test(name)) return this.say('error', '이름은 영문, 숫자, _, - 만 쓸 수 있습니다.');
    if (this.data.source.animations[name]) return this.say('error', `"${name}" 애니메이션이 이미 있습니다.`);
    if (record) this.history.push(this.snapshot());
    this.data.setAnimation(name, { duration: 1 });
    this.refreshNames();
    this.updateUndo();
    this.selectAnimation(name);
  }

  duplicateAnimation(name: string) {
    if (!this.data || !this.animName) return;
    if (this.data.source.animations[name]) return this.say('error', `"${name}" 애니메이션이 이미 있습니다.`);
    if (!/^[A-Za-z0-9_-]+$/.test(name)) return this.say('error', '이름은 영문, 숫자, _, - 만 쓸 수 있습니다.');
    this.history.push(this.snapshot());
    this.data.setAnimation(name, structuredClone(this.anim));
    this.refreshNames();
    this.updateUndo();
    this.selectAnimation(name);
  }

  renameAnimation(name: string) {
    if (!this.data || !this.animName || name === this.animName) return;
    if (!/^[A-Za-z0-9_-]+$/.test(name)) return this.say('error', '이름은 영문, 숫자, _, - 만 쓸 수 있습니다.');
    if (this.data.source.animations[name]) return this.say('error', `"${name}" 애니메이션이 이미 있습니다.`);
    this.history.push(this.snapshot());
    const anim = this.anim;
    this.data.removeAnimation(this.animName);
    this.data.setAnimation(name, anim);
    this.refreshNames();
    this.updateUndo();
    this.selectAnimation(name);
  }

  deleteAnimation() {
    if (!this.data || !this.animName) return;
    this.history.push(this.snapshot());
    this.data.removeAnimation(this.animName);
    this.refreshNames();
    if (!this.animNames.length) this.data.setAnimation('idle', { duration: 1 }), this.refreshNames();
    this.updateUndo();
    this.selectAnimation(this.animNames[0]);
  }

  // ---------------- Undo / save ----------------

  private restore(snapshot: string) {
    const all = JSON.parse(snapshot) as Record<string, L2DAnimation>;
    for (const name of [...this.data!.animations.keys()]) this.data!.removeAnimation(name);
    for (const [name, anim] of Object.entries(all)) this.data!.setAnimation(name, anim);
    this.refreshNames();
    if (!this.animNames.includes(this.animName)) this.animName = this.animNames[0] ?? '';
    this.selectedKeys = this.selectedKeys.filter((k) => this.animName && M.getKey(this.anim, k));
    this.updateUndo();
    this.rev++;
    this.pose();
  }

  undo() {
    const prev = this.history.undo(this.snapshot());
    if (prev !== null) this.restore(prev);
  }

  redo() {
    const next = this.history.redo(this.snapshot());
    if (next !== null) this.restore(next);
  }

  async save() {
    if (!this.info || !this.data) return;
    if (!this.info.editable) return this.say('error', this.info.note ?? '이 프로젝트는 저장할 수 없습니다.');
    this.saving = true;
    try {
      const animations = this.data.source.animations;
      const res = await fetch(`/api/project/animations?id=${encodeURIComponent(this.info.id)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ animations }),
      });
      const body = await res.json();
      if (!body.ok) {
        const errors = (body.errors ?? []).slice(0, 3).map((e: { path: string; message: string }) => `${e.path}: ${e.message}`);
        throw new Error(errors.length ? errors.join(' / ') : (body.error ?? res.statusText));
      }
      this.saved = this.snapshot();
      this.updateUndo();
      this.externalChange = false;
      this.say('ok', `저장했습니다 (${this.info.id}/animations.json).`);
    } catch (e) {
      this.say('error', `저장 실패: ${(e as Error).message}`);
    } finally {
      this.saving = false;
    }
  }

  exportJson() {
    if (!this.data) return;
    const blob = new Blob([JSON.stringify(this.data.source.animations, null, 2) + '\n'], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${this.data.name}-animations.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
}

export const editor = new Editor();
