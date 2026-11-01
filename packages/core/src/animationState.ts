import { AnimationData, type EventData, type SkeletonData } from './data.ts';
import { lerp, lerpAngle } from './math.ts';
import type { Skeleton } from './skeleton.ts';

export interface TrackListener {
  /** The entry became the current entry of its track. */
  start?(entry: TrackEntry): void;
  /** Another animation was set on the track while this one was current. */
  interrupt?(entry: TrackEntry): void;
  /** The entry will never be applied again. */
  end?(entry: TrackEntry): void;
  /** Reached the end of the animation (every loop for looping animations). */
  complete?(entry: TrackEntry): void;
  /** A user event keyed in the animation was passed. */
  event?(entry: TrackEntry, event: EventData): void;
}

const EMPTY = new AnimationData('<empty>', 0, [], []);

export class TrackEntry {
  readonly animation: AnimationData;
  readonly trackIndex: number;
  loop: boolean;
  /** Speed multiplier for this entry. */
  timeScale = 1;
  /** Weight of this track over the tracks below it (0..1). */
  alpha = 1;
  /** Seconds elapsed on this entry (already scaled). Negative while waiting on a delay. */
  trackTime = 0;
  /** For queued entries: start once the previous entry's trackTime reaches this. */
  delay = 0;
  /** Crossfade length from the previous entry, in seconds. */
  mixDuration = 0;
  mixTime = 0;
  mixingFrom: TrackEntry | null = null;
  next: TrackEntry | null = null;
  listener: TrackListener | null = null;
  /** Internal: union of channels written by this entry and its mixing chain. */
  mask: Uint8Array | null = null;

  constructor(animation: AnimationData, trackIndex: number, loop: boolean) {
    this.animation = animation;
    this.trackIndex = trackIndex;
    this.loop = loop;
  }

  /** Time inside the animation, accounting for looping. */
  get animationTime(): number {
    const d = this.animation.duration;
    const t = Math.max(0, this.trackTime);
    if (d <= 0) return 0;
    return this.loop ? t % d : Math.min(t, d);
  }

  get isComplete(): boolean {
    return !this.loop && this.trackTime >= this.animation.duration;
  }
}

/**
 * Plays animations on numbered tracks. Higher tracks are applied over lower ones, so a
 * track-1 "blink" can run on top of a track-0 "idle". Switching animations on a track
 * crossfades from the previous one. The API mirrors spine-ts so game code ports easily.
 */
export class AnimationState {
  readonly data: SkeletonData;
  readonly tracks: (TrackEntry | null)[] = [];
  /** Global speed multiplier. */
  timeScale = 1;
  /** Crossfade used when no specific mix is set. */
  defaultMix = 0.15;

  private readonly mixes = new Map<string, number>();
  private readonly listeners: TrackListener[] = [];
  private readonly masks = new Map<AnimationData, Uint8Array>();
  private readonly base: Float32Array;
  private readonly baseAttachments: Int16Array;
  private readonly scratch: Float32Array;
  private readonly scratchAttachments: Int16Array;

  constructor(data: SkeletonData) {
    this.data = data;
    this.base = new Float32Array(data.channelCount);
    this.scratch = new Float32Array(data.channelCount);
    this.baseAttachments = new Int16Array(data.slots.length);
    this.scratchAttachments = new Int16Array(data.slots.length);
  }

  addListener(listener: TrackListener): void {
    this.listeners.push(listener);
  }

  removeListener(listener: TrackListener): void {
    const i = this.listeners.indexOf(listener);
    if (i >= 0) this.listeners.splice(i, 1);
  }

  /** Crossfade duration between two specific animations. */
  setMix(from: string, to: string, duration: number): void {
    this.mixes.set(`${from}\u0000${to}`, duration);
  }

  getMix(from: AnimationData, to: AnimationData): number {
    return this.mixes.get(`${from.name}\u0000${to.name}`) ?? this.defaultMix;
  }

  getCurrent(trackIndex: number): TrackEntry | null {
    return this.tracks[trackIndex] ?? null;
  }

  private findAnimation(name: string): AnimationData {
    const a = this.data.animations.get(name);
    if (!a) {
      const names = [...this.data.animations.keys()].join(', ');
      throw new Error(`Animation "${name}" not found. Available: ${names}`);
    }
    return a;
  }

  /** Plays an animation now, crossfading from whatever the track was playing. */
  setAnimation(trackIndex: number, name: string, loop = false): TrackEntry {
    return this.setEntry(trackIndex, new TrackEntry(this.findAnimation(name), trackIndex, loop));
  }

  /**
   * Queues an animation after the last queued entry of the track. With delay <= 0 it starts
   * when the previous animation ends (minus the crossfade, plus delay). With delay > 0 it
   * starts that many seconds after the previous entry started.
   */
  addAnimation(trackIndex: number, name: string, loop = false, delay = 0): TrackEntry {
    return this.queueEntry(new TrackEntry(this.findAnimation(name), trackIndex, loop), delay);
  }

  /** Fades the track out to the pose below it over `mixDuration`, then clears it. */
  setEmptyAnimation(trackIndex: number, mixDuration = 0): TrackEntry {
    const e = new TrackEntry(EMPTY, trackIndex, false);
    this.setEntry(trackIndex, e, mixDuration);
    return e;
  }

  addEmptyAnimation(trackIndex: number, mixDuration = 0, delay = 0): TrackEntry {
    const e = new TrackEntry(EMPTY, trackIndex, false);
    this.queueEntry(e, delay, mixDuration);
    return e;
  }

  clearTrack(trackIndex: number): void {
    const e = this.tracks[trackIndex];
    if (!e) return;
    this.tracks[trackIndex] = null;
    for (let f: TrackEntry | null = e; f; f = f.mixingFrom) this.emit('end', f);
  }

  clearTracks(): void {
    for (let i = 0; i < this.tracks.length; i++) this.clearTrack(i);
  }

  private setEntry(trackIndex: number, entry: TrackEntry, mix?: number): TrackEntry {
    const current = this.tracks[trackIndex] ?? null;
    if (current) {
      current.next = null;
      this.emit('interrupt', current);
      const duration = mix ?? this.getMix(current.animation, entry.animation);
      if (duration > 0) {
        entry.mixingFrom = current;
        entry.mixDuration = duration;
        // Keep the chain short; very old entries are dropped.
        let depth = 0;
        for (let f: TrackEntry | null = current; f; f = f.mixingFrom) {
          if (++depth >= 3 && f.mixingFrom) {
            for (let g: TrackEntry | null = f.mixingFrom; g; g = g.mixingFrom) this.emit('end', g);
            f.mixingFrom = null;
          }
        }
      } else {
        for (let f: TrackEntry | null = current; f; f = f.mixingFrom) this.emit('end', f);
      }
    }
    while (this.tracks.length <= trackIndex) this.tracks.push(null);
    this.tracks[trackIndex] = entry;
    this.emit('start', entry);
    return entry;
  }

  private queueEntry(entry: TrackEntry, delay: number, mix?: number): TrackEntry {
    let last = this.tracks[entry.trackIndex] ?? null;
    if (!last) {
      this.setEntry(entry.trackIndex, entry, 0);
      entry.trackTime = -Math.max(0, delay);
      return entry;
    }
    while (last.next) last = last.next;
    entry.mixDuration = mix ?? this.getMix(last.animation, entry.animation);
    entry.delay = delay > 0 ? delay : Math.max(0, last.animation.duration + delay - entry.mixDuration);
    last.next = entry;
    return entry;
  }

  /** Advances time. Fires events, completes, and starts queued entries. */
  update(dt: number): void {
    dt *= this.timeScale;
    for (let i = 0; i < this.tracks.length; i++) {
      const e = this.tracks[i];
      if (!e) continue;
      let d = dt * e.timeScale;
      const next = e.next;
      if (next && e.trackTime + d >= next.delay) {
        const used = Math.max(0, next.delay - e.trackTime);
        this.advance(e, used);
        this.updateMixing(e, used);
        const leftover = (d - used) / (e.timeScale || 1);
        e.next = null;
        next.mixingFrom = next.mixDuration > 0 ? e : null;
        if (!next.mixingFrom) for (let f: TrackEntry | null = e; f; f = f.mixingFrom) this.emit('end', f);
        else this.emit('interrupt', e);
        this.tracks[i] = next;
        this.emit('start', next);
        d = leftover * next.timeScale;
        this.advance(next, d);
        this.updateMixing(next, d);
        continue;
      }
      this.advance(e, d);
      this.updateMixing(e, d);
      if (e.animation === EMPTY && !e.mixingFrom) {
        this.tracks[i] = null;
        this.emit('end', e);
      }
    }
  }

  private updateMixing(e: TrackEntry, d: number): void {
    const from = e.mixingFrom;
    if (!from) return;
    const fd = d * (from.timeScale / (e.timeScale || 1));
    this.advance(from, fd);
    this.updateMixing(from, fd);
    e.mixTime += d;
    if (e.mixTime >= e.mixDuration) {
      for (let f: TrackEntry | null = from; f; f = f.mixingFrom) this.emit('end', f);
      e.mixingFrom = null;
    }
  }

  /** Moves an entry's clock and fires events/complete for the passed interval. */
  private advance(e: TrackEntry, d: number): void {
    const t0 = e.trackTime;
    const t1 = t0 + d;
    e.trackTime = t1;
    if (d <= 0 || t1 < 0) return;
    const from = Math.max(0, t0);
    const anim = e.animation;
    const dur = anim.duration;
    const fire = (lo: number, hi: number, inclusiveEnd: boolean) => {
      for (const ev of anim.events)
        if (ev.time >= lo && (ev.time < hi || (inclusiveEnd && ev.time === hi))) this.emitEvent(e, ev);
    };
    if (dur <= 0) {
      if (from === 0 && t0 <= 0) this.emit('complete', e);
      return;
    }
    if (e.loop) {
      const first = Math.floor(from / dur);
      const last = Math.floor(t1 / dur);
      for (let loop = first; loop <= last; loop++) {
        const lo = loop === first ? from - loop * dur : 0;
        const hi = loop === last ? t1 - loop * dur : dur;
        fire(lo, hi, false);
        if (loop < last) this.emit('complete', e);
      }
    } else if (from < dur) {
      const reached = t1 >= dur;
      fire(from, Math.min(t1, dur), reached);
      if (reached) this.emit('complete', e);
    }
  }

  /** Poses the skeleton: setup pose, then every track in order. Call before updateWorldTransform(). */
  apply(skeleton: Skeleton): void {
    skeleton.setToSetupPose();
    const ch = skeleton.channels;
    for (const e of this.tracks) {
      if (!e || (e.trackTime < 0 && !e.mixingFrom)) continue;
      this.base.set(ch);
      this.baseAttachments.set(skeleton.attachments);
      const mask = this.applyEntry(e, skeleton);
      if (e.alpha < 1) {
        const angles = this.data.angleChannels;
        for (let c = 0; c < mask.length; c++)
          if (mask[c]) ch[c] = angles[c] ? lerpAngle(this.base[c], ch[c], e.alpha) : lerp(this.base[c], ch[c], e.alpha);
        if (e.alpha < 0.5) skeleton.attachments.set(this.baseAttachments);
      }
    }
  }

  private maskOf(anim: AnimationData): Uint8Array {
    let m = this.masks.get(anim);
    if (!m) {
      m = new Uint8Array(this.data.channelCount);
      for (const c of anim.channels) m[c] = 1;
      this.masks.set(anim, m);
    }
    return m;
  }

  private applyEntry(e: TrackEntry, skeleton: Skeleton): Uint8Array {
    const anim = e.animation;
    const own = this.maskOf(anim);
    const ch = skeleton.channels;
    const setup = this.data.setupChannels;
    if (!e.mixingFrom) {
      if (e.trackTime >= 0) anim.sample(e.animationTime, setup, ch, skeleton.attachments);
      return own;
    }
    const fromMask = this.applyEntry(e.mixingFrom, skeleton);
    const t = e.mixDuration > 0 ? Math.min(1, e.mixTime / e.mixDuration) : 1;
    const angles = this.data.angleChannels;
    const s = this.scratch;
    if (e.trackTime >= 0) {
      this.scratchAttachments.set(skeleton.attachments);
      anim.sample(e.animationTime, setup, s, this.scratchAttachments);
      for (const c of anim.channels) ch[c] = angles[c] ? lerpAngle(ch[c], s[c], t) : lerp(ch[c], s[c], t);
      for (const slot of anim.attachmentSlots) skeleton.attachments[slot] = this.scratchAttachments[slot];
    }
    const mask = (e.mask ??= new Uint8Array(this.data.channelCount));
    for (let c = 0; c < mask.length; c++) {
      if (fromMask[c] && !own[c])
        ch[c] = angles[c] ? lerpAngle(ch[c], this.base[c], t) : lerp(ch[c], this.base[c], t);
      mask[c] = fromMask[c] | own[c];
    }
    return mask;
  }

  private emit(type: 'start' | 'interrupt' | 'end' | 'complete', entry: TrackEntry): void {
    entry.listener?.[type]?.(entry);
    for (const l of this.listeners) l[type]?.(entry);
  }

  private emitEvent(entry: TrackEntry, event: EventData): void {
    entry.listener?.event?.(entry, event);
    for (const l of this.listeners) l.event?.(entry, event);
  }
}
