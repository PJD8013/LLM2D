/**
 * Editor state: the open project, the animation being edited, playhead, selection, undo and
 * saving. The animation JSON lives in `data.source.animations` (the SkeletonData being shown);
 * every edit recompiles that one animation and re-poses the stage.
 */
import { SkeletonData, type L2DAnimation, type L2DCurve, type L2DFile } from '@llm2d/core';
import { loadImageTextures, type LoadedLlm2d } from '@llm2d/pixi';
import { Assets, type Texture } from 'pixi.js';
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
  /** History state for the drag, pushed once the drag really changes something. */
  private dragUndo: string | null = null;
  private dragPushed = false;
  /** A change on disk arrived during a drag; handled when the drag ends. */
  private reloadPending = false;
  /** Texture URLs of the open project (versioned, so a reload picks up changed images). */
  private textureUrls: string[] = [];
  private textureVersion = 0;
  /** The latest open() call; an older one finishing later is ignored. */
  private openToken = 0;
  /** Counts edits, so a reload that was fetching while the user edited does not discard them. */
  private edits = 0;
  /** The skeleton file as last loaded (a change event for identical files is no reload). */
  private loadedFile = '';

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
    const token = ++this.openToken;
    const edits = this.edits;
    this.loading = true;
    try {
      const res = await fetch(`/api/project?id=${encodeURIComponent(id)}`);
      const body = await res.json();
      if (token !== this.openToken) return;
      if (!res.ok) throw new Error(body.error ?? res.statusText);
      const reloading = keep && this.info?.id === id;
      const text = JSON.stringify(body.file);
      if (reloading && text === this.loadedFile) return; // nothing new on disk
      if (reloading && this.edits !== edits) {
        // Edited while the files were being read: keep the edits, offer the reload instead.
        this.externalChange = true;
        return;
      }
      const file = body.file as L2DFile;
      const data = SkeletonData.fromJSON(file);
      // Versioned URLs: Pixi caches textures by URL, and a reload may bring changed images.
      const version = ++this.textureVersion;
      const urls: string[] = [];
      const textures = await loadImageTextures(data.images, new URL(`/files/${encodeURIComponent(id)}/`, location.href).href, (url) => {
        const src = `${url}?v=${version}`;
        urls.push(src);
        return Assets.load<Texture>(src);
      });
      if (token !== this.openToken || (reloading && this.edits !== edits)) {
        void Assets.unload(urls).catch(() => {});
        if (token === this.openToken) this.externalChange = true;
        return;
      }
      this.loadedFile = text;
      const sameProject = reloading;
      this.data = data;
      this.loaded = { data, textures };
      this.info = body.info;
      this.stage?.setSkeleton(this.loaded, sameProject);
      const old = this.textureUrls;
      this.textureUrls = urls;
      if (old.length) void Assets.unload(old).catch(() => {});
      this.history.clear();
      this.dirty = false;
      this.externalChange = false;
      this.reloadPending = false;
      this.dragBase = null;
      this.refreshNames();
      if (!sameProject) this.clipboard = null;
      if (!sameProject || !this.animNames.includes(this.animName)) {
        this.animName = this.animNames.includes('idle') ? 'idle' : (this.animNames[0] ?? '');
        this.time = 0;
        this.selectedKeys = [];
        this.selectedBone = null;
        this.selectedSlot = null;
      } else {
        // Keep the selection only where it still exists (a rebuilt rig may rename bones).
        if (this.selectedBone && data.findBone(this.selectedBone) < 0) this.selectedBone = null;
        if (this.selectedSlot && data.findSlot(this.selectedSlot) < 0) this.selectedSlot = null;
        this.selectedKeys = this.selectedKeys.filter((k) => M.getKey(this.anim, k));
      }
      if (!this.animName) this.newAnimation('idle', false);
      this.saved = this.snapshot();
      const url = new URL(location.href);
      url.searchParams.set('project', id);
      history.replaceState(null, '', url);
      this.updateUndo();
      this.rev++;
      this.pose();
      this.say(keep ? 'info' : null, keep ? '파일이 밖에서 바뀌어 다시 불러왔습니다.' : '');
    } catch (e) {
      if (token === this.openToken) this.say('error', `불러오기 실패: ${(e as Error).message}`);
    } finally {
      if (token === this.openToken) this.loading = false;
    }
  }

  private onExternalChange(id: string) {
    if (id !== this.info?.id || this.saving) return;
    // Mid-drag the change waits: replaying the drag would silently undo it.
    if (this.dragBase !== null) {
      this.reloadPending = true;
      return;
    }
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

  /** The animations as JSON with names in a stable order (renaming back is not a change). */
  private snapshot(): string {
    const all = this.data?.source.animations ?? {};
    return JSON.stringify(Object.fromEntries(Object.keys(all).sort().map((n) => [n, all[n]])));
  }

  /** An undo state: the animation shown plus all animations. */
  private historyState(): string {
    return `${this.animName}\n${this.snapshot()}`;
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

  /** Applies a change to the current animation as one undo step (none if nothing changed). */
  edit(fn: (anim: L2DAnimation) => void, record = true) {
    if (!this.data || !this.animName) return;
    const before = record ? this.historyState() : null;
    fn(this.anim);
    M.prune(this.anim);
    if (before !== null && this.historyState() !== before) this.history.push(before);
    this.commit();
  }

  private commit() {
    this.edits++;
    M.prune(this.anim);
    this.data!.setAnimation(this.animName, this.anim);
    this.updateUndo();
    this.rev++;
    this.pose();
  }

  /** Starts a drag: one undo step for everything until endDrag (none if nothing changes). */
  beginDrag() {
    this.dragBase = this.snapshot();
    this.dragUndo = this.historyState();
    this.dragPushed = false;
  }

  /** Re-applies a drag step from the state at the start of the drag. */
  dragStep(fn: (anim: L2DAnimation) => void) {
    if (!this.dragBase || !this.data) return;
    const base = JSON.parse(this.dragBase) as Record<string, L2DAnimation>;
    this.data.source.animations[this.animName] = base[this.animName] ?? {};
    fn(this.anim);
    M.prune(this.anim);
    if (!this.dragPushed && this.snapshot() !== this.dragBase) {
      this.history.push(this.dragUndo!);
      this.dragPushed = true;
    }
    this.commit();
  }

  endDrag() {
    if (this.dragBase === null) return;
    // Dragged back to where it started: no undo step.
    if (this.dragPushed && this.snapshot() === this.dragBase) this.history.dropLast();
    this.dragBase = null;
    this.dragUndo = null;
    this.dragPushed = false;
    this.updateUndo();
    if (this.reloadPending && this.info) {
      this.reloadPending = false;
      this.onExternalChange(this.info.id);
    }
  }

  /**
   * Key time at the playhead: a key of `track` within half a frame (keys made elsewhere are
   * often between frames), else the playhead snapped to a frame.
   */
  keyTime(track?: M.Track): number {
    const snapped = M.snap(this.time, this.fps);
    if (!track || !this.data || !this.animName || track.group === 'events') return snapped;
    let best: number | null = null;
    for (const k of M.keysOf(this.anim, track))
      if (Math.abs(k.time - this.time) <= 0.5 / this.fps + 1e-9 && (best === null || Math.abs(k.time - this.time) < Math.abs(best - this.time))) best = k.time;
    return best ?? snapped;
  }

  /** Warns when a key lands after the animation's set length (it would never play). */
  private checkPastEnd(time: number) {
    const d = this.anim.duration;
    if (d !== undefined && time > d + 1e-6) this.say('info', `${time.toFixed(2)}초 키가 애니메이션 길이(${d}초)보다 뒤에 있어 재생되지 않습니다. 길이를 늘리세요.`);
  }

  /** Writes a key for a bone channel at the playhead from the values given (others kept). */
  keyBone(bone: string, channel: M.BoneChannel, values: Partial<{ value: number; x: number; y: number }>, record = true) {
    const track: M.Track = { group: 'bones', target: bone, channel };
    const time = this.keyTime(track);
    const apply = (anim: L2DAnimation) => {
      const existing = M.getKey(anim, { ...track, time });
      const fromPose = M.boneKeyFromPose(this.data!, this.stage!.skeleton!, bone, channel, time);
      M.setKey(anim, track, { ...fromPose, ...(existing ?? {}), ...values, time });
    };
    if (record === false) this.dragStep(apply);
    else this.edit(apply);
    this.checkPastEnd(time);
  }

  /** Keys the selected bone's channels (all three, or one) with the pose shown. */
  keySelected(channels: M.BoneChannel[] = ['rotate', 'translate', 'scale']) {
    const bone = this.selectedBone;
    if (!bone || !this.stage?.skeleton) return this.say('info', '먼저 뼈를 선택하세요.');
    const tracks = channels.map((channel): M.Track => ({ group: 'bones', target: bone, channel }));
    const times = tracks.map((t) => this.keyTime(t));
    const keys = channels.map((ch, i) => M.boneKeyFromPose(this.data!, this.stage!.skeleton!, bone, ch, times[i]));
    this.edit((anim) => keys.forEach((k, i) => M.setKey(anim, tracks[i], k)));
    this.say('ok', `${bone}: ${channels.map(M.channelLabel).join(', ')} 키를 ${times[0].toFixed(2)}초에 넣었습니다.`);
    this.checkPastEnd(Math.max(...times));
  }

  /** Writes a slot key at the playhead. */
  keySlot(slot: string, channel: M.SlotChannel, key: Record<string, unknown>) {
    const track: M.Track = { group: 'slots', target: slot, channel };
    const time = this.keyTime(track);
    this.edit((anim) => M.setKey(anim, track, { ...key, time }));
    this.checkPastEnd(time);
  }

  /** Adds a key at a time using the value the animation has there (double-click on a track). */
  addKeyAt(track: M.Track, time: number) {
    if (!this.stage?.skeleton) return;
    this.seek(time);
    const t = this.keyTime(track);
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

  /** Sets the curve of the selected keys; `live` while a handle is dragged (one undo step). */
  setCurve(curve: L2DCurve | undefined, live = false) {
    const refs = this.selectedKeys;
    if (live && this.dragBase !== null) this.dragStep((anim) => M.setCurve(anim, refs, curve));
    else this.edit((anim) => M.setCurve(anim, refs, curve));
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
    if (!clip || !this.data) return;
    // Only keys whose bone, slot or IK constraint exists here.
    const data = this.data;
    const exists = (t: M.Track) =>
      t.group === 'events' || (t.group === 'bones' ? data.findBone(t.target) >= 0 : t.group === 'slots' ? data.findSlot(t.target) >= 0 : data.findIk(t.target) >= 0);
    const items = clip.items.filter((i) => exists(i.track));
    if (!items.length) return this.say('info', '붙일 수 있는 키가 없습니다(이 스켈레톤에 없는 뼈나 슬롯의 키).');
    const at = this.keyTime();
    let pasted: M.KeyRef[] = [];
    this.edit((anim) => (pasted = M.pasteKeys(anim, { items }, at)));
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
    if (record) this.history.push(this.historyState());
    if (record) this.edits++;
    this.data.setAnimation(name, { duration: 1 });
    this.refreshNames();
    this.updateUndo();
    this.selectAnimation(name);
  }

  duplicateAnimation(name: string) {
    if (!this.data || !this.animName) return;
    if (this.data.source.animations[name]) return this.say('error', `"${name}" 애니메이션이 이미 있습니다.`);
    if (!/^[A-Za-z0-9_-]+$/.test(name)) return this.say('error', '이름은 영문, 숫자, _, - 만 쓸 수 있습니다.');
    this.history.push(this.historyState());
    this.edits++;
    this.data.setAnimation(name, structuredClone(this.anim));
    this.refreshNames();
    this.updateUndo();
    this.selectAnimation(name);
  }

  renameAnimation(name: string) {
    if (!this.data || !this.animName || name === this.animName) return;
    if (!/^[A-Za-z0-9_-]+$/.test(name)) return this.say('error', '이름은 영문, 숫자, _, - 만 쓸 수 있습니다.');
    if (this.data.source.animations[name]) return this.say('error', `"${name}" 애니메이션이 이미 있습니다.`);
    this.history.push(this.historyState());
    this.edits++;
    const anim = this.anim;
    this.data.removeAnimation(this.animName);
    this.data.setAnimation(name, anim);
    this.refreshNames();
    this.updateUndo();
    this.selectAnimation(name);
  }

  deleteAnimation() {
    if (!this.data || !this.animName) return;
    this.history.push(this.historyState());
    this.edits++;
    this.data.removeAnimation(this.animName);
    this.refreshNames();
    if (!this.animNames.length) this.data.setAnimation('idle', { duration: 1 }), this.refreshNames();
    this.updateUndo();
    this.selectAnimation(this.animNames[0]);
  }

  // ---------------- Undo / save ----------------

  private restore(state: string) {
    this.edits++;
    const cut = state.indexOf('\n');
    const shown = state.slice(0, cut);
    const all = JSON.parse(state.slice(cut + 1)) as Record<string, L2DAnimation>;
    for (const name of [...this.data!.animations.keys()]) this.data!.removeAnimation(name);
    for (const [name, anim] of Object.entries(all)) this.data!.setAnimation(name, anim);
    this.refreshNames();
    // Back to the animation that was shown at that step (undoing a rename, copy or delete).
    if (this.animNames.includes(shown)) this.animName = shown;
    if (!this.animNames.includes(this.animName)) this.animName = this.animNames[0] ?? '';
    this.selectedKeys = this.selectedKeys.filter((k) => this.animName && M.getKey(this.anim, k));
    this.updateUndo();
    this.rev++;
    this.pose();
  }

  undo() {
    if (this.dragBase !== null) return;
    const prev = this.history.undo(this.historyState());
    if (prev !== null) this.restore(prev);
  }

  redo() {
    if (this.dragBase !== null) return;
    const next = this.history.redo(this.historyState());
    if (next !== null) this.restore(next);
  }

  async save() {
    if (!this.info || !this.data) return;
    if (!this.info.editable) return this.say('error', this.info.note ?? '이 프로젝트는 저장할 수 없습니다.');
    this.saving = true;
    try {
      // What is sent is what counts as saved: edits made while the request runs stay unsaved.
      const sent = this.snapshot();
      const res = await fetch(`/api/project/animations?id=${encodeURIComponent(this.info.id)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: `{"animations":${sent}}`,
      });
      const body = await res.json();
      if (!body.ok) {
        const errors = (body.errors ?? []).slice(0, 3).map((e: { path: string; message: string }) => `${e.path}: ${e.message}`);
        throw new Error(errors.length ? errors.join(' / ') : (body.error ?? res.statusText));
      }
      this.saved = sent;
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
