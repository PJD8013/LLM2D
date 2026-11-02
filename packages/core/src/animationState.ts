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
  /** Speed multiplier for this entry (0 or more). */
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
  /** True once `end` was sent: the entry is not applied any more. */
  ended = false;
  /**
   * Internal: where the last iteration began when looping was switched off part-way, so the
   * animation plays to the end of that iteration instead of jumping to its last frame.
   */
  loopStart = 0;
  private _loop: boolean;

  constructor(animation: AnimationData, trackIndex: number, loop: boolean) {
    this.animation = animation;
    this.trackIndex = trackIndex;
    this._loop = loop;
  }

  /**
   * Whether the animation repeats. Turning it off while looping lets the current iteration
   * finish, then fires `complete` and holds the last frame.
   */
  get loop(): boolean {
    return this._loop;
  }

  set loop(value: boolean) {
    if (value === this._loop) return;
    this._loop = value;
    const d = this.animation.duration;
    this.loopStart = !value && d > 0 && this.trackTime > 0 ? Math.floor(this.trackTime / d) * d : 0;
  }

  /** Time inside the animation, accounting for looping. */
  get animationTime(): number {
    const d = this.animation.duration;
    const t = Math.max(0, this.trackTime);
    if (d <= 0) return 0;
    return this._loop ? t % d : Math.min(Math.max(0, t - this.loopStart), d);
  }

  get isComplete(): boolean {
    return !this._loop && this.trackTime - this.loopStart >= this.animation.duration;
  }
}

type Notice = { type: 'start' | 'interrupt' | 'end' | 'complete'; entry: TrackEntry } | { type: 'event'; entry: TrackEntry; event: EventData };

/**
 * Plays animations on numbered tracks. Higher tracks are applied over lower ones, so a
 * track-1 "blink" can run on top of a track-0 "idle". Switching animations on a track
 * crossfades from the previous one. The API mirrors spine-ts so game code ports easily.
 *
 * Listeners are called after the state change that caused them is complete (like spine's
 * event queue), so a listener may call setAnimation, addAnimation or clearTrack safely.
 */
export class AnimationState {
  readonly data: SkeletonData;
  readonly tracks: (TrackEntry | null)[] = [];
  /** Global speed multiplier (0 or more). */
  timeScale = 1;
  /** Crossfade used when no specific mix is set. */
  defaultMix = 0.15;

  private readonly mixes = new Map<string, number>();
  private readonly listeners: TrackListener[] = [];
  private readonly masks = new WeakMap<AnimationData, Uint8Array>();
  private readonly base: Float32Array;
  private readonly baseAttachments: Int16Array;
  private readonly scratch: Float32Array;
  private readonly scratchAttachments: Int16Array;
  private readonly notices: Notice[] = [];
  private draining = false;
  private _version = 0;

  constructor(data: SkeletonData) {
    this.data = data;
    this.base = new Float32Array(data.channelCount);
    this.scratch = new Float32Array(data.channelCount);
    this.baseAttachments = new Int16Array(data.slots.length);
    this.scratchAttachments = new Int16Array(data.slots.length);
  }

  /** Counts changes (tracks set or cleared, time advanced): a renderer re-poses when it moves. */
  get version(): number {
    return this._version;
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
    const entry = new TrackEntry(this.findAnimation(name), trackIndex, loop);
    this.setEntry(trackIndex, entry);
    this.drain();
    return entry;
  }

  /**
   * Queues an animation after the last queued entry of the track. With delay <= 0 it starts
   * when the previous animation ends (for a looping one, at the end of its current loop), minus
   * the crossfade, plus delay. With delay > 0 it starts that many seconds after the previous
   * entry started.
   */
  addAnimation(trackIndex: number, name: string, loop = false, delay = 0): TrackEntry {
    const entry = this.queueEntry(new TrackEntry(this.findAnimation(name), trackIndex, loop), delay);
    this.drain();
    return entry;
  }

  /** Fades the track out to the pose below it over `mixDuration`, then clears it. */
  setEmptyAnimation(trackIndex: number, mixDuration = 0): TrackEntry {
    const e = new TrackEntry(EMPTY, trackIndex, false);
    this.setEntry(trackIndex, e, mixDuration);
    this.drain();
    return e;
  }

  addEmptyAnimation(trackIndex: number, mixDuration = 0, delay = 0): TrackEntry {
    const e = new TrackEntry(EMPTY, trackIndex, false);
    this.queueEntry(e, delay, mixDuration);
    this.drain();
    return e;
  }

  clearTrack(trackIndex: number): void {
    const e = this.tracks[trackIndex];
    if (!e) return;
    this.tracks[trackIndex] = null;
    this._version++;
    for (let q: TrackEntry | null = e.next; q; q = q.next) this.notify('end', q);
    e.next = null;
    for (let f: TrackEntry | null = e; f; f = f.mixingFrom) this.notify('end', f);
    this.drain();
  }

  clearTracks(): void {
    for (let i = 0; i < this.tracks.length; i++) this.clearTrack(i);
  }

  private setEntry(trackIndex: number, entry: TrackEntry, mix?: number): void {
    const current = this.tracks[trackIndex] ?? null;
    while (this.tracks.length <= trackIndex) this.tracks.push(null);
    this.tracks[trackIndex] = entry;
    this._version++;
    if (current) {
      // Entries queued after the current one are dropped with it.
      for (let q: TrackEntry | null = current.next; q; q = q.next) this.notify('end', q);
      current.next = null;
      this.notify('interrupt', current);
      const duration = mix ?? this.getMix(current.animation, entry.animation);
      if (duration > 0) {
        entry.mixingFrom = current;
        entry.mixDuration = duration;
        // Keep the chain short; very old entries are dropped.
        let depth = 0;
        for (let f: TrackEntry | null = current; f; f = f.mixingFrom) {
          if (++depth >= 3 && f.mixingFrom) {
            for (let g: TrackEntry | null = f.mixingFrom; g; g = g.mixingFrom) this.notify('end', g);
            f.mixingFrom = null;
          }
        }
      } else {
        for (let f: TrackEntry | null = current; f; f = f.mixingFrom) this.notify('end', f);
      }
    }
    this.notify('start', entry);
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
    if (delay <= 0) {
      const d = last.animation.duration;
      let end: number;
      if (d <= 0) end = Math.max(0, last.trackTime);
      else if (last.loop) end = d * (1 + Math.floor(Math.max(0, last.trackTime) / d));
      else end = Math.max(last.loopStart + d, last.trackTime);
      delay = Math.max(0, end + delay - entry.mixDuration);
    }
    entry.delay = delay;
    last.next = entry;
    this._version++;
    return entry;
  }

  /** Advances time. Fires events, completes, and starts queued entries. */
  update(dt: number): void {
    dt *= Math.max(0, this.timeScale);
    this._version++;
    for (let i = 0; i < this.tracks.length; i++) {
      let e = this.tracks[i];
      let left = dt;
      while (e) {
        const ts = Math.max(0, e.timeScale);
        const next = e.next;
        // Seconds (unscaled) until the queued entry is due.
        const until = next ? (e.trackTime >= next.delay ? 0 : ts > 0 ? (next.delay - e.trackTime) / ts : Infinity) : Infinity;
        if (next && until <= left) {
          this.advance(e, until * ts);
          this.updateMixing(e, until);
          left -= until;
          e.next = null;
          next.mixingFrom = next.mixDuration > 0 ? e : null;
          if (next.mixingFrom) this.notify('interrupt', e);
          else for (let f: TrackEntry | null = e; f; f = f.mixingFrom) this.notify('end', f);
          this.tracks[i] = next;
          this.notify('start', next);
          e = next;
          continue;
        }
        this.advance(e, left * ts);
        this.updateMixing(e, left);
        if (e.animation === EMPTY && !e.mixingFrom && !e.next) {
          this.tracks[i] = null;
          this.notify('end', e);
        }
        break;
      }
    }
    this.drain();
  }

  /** Advances the entries `e` is fading out from; `dt` is unscaled, as the fade runs in real time. */
  private updateMixing(e: TrackEntry, dt: number): void {
    const from = e.mixingFrom;
    if (!from) return;
    this.advance(from, dt * Math.max(0, from.timeScale));
    this.updateMixing(from, dt);
    e.mixTime += dt;
    if (e.mixTime >= e.mixDuration) {
      for (let f: TrackEntry | null = from; f; f = f.mixingFrom) this.notify('end', f);
      e.mixingFrom = null;
    }
  }

  /** Moves an entry's clock and queues events/complete for the passed interval. */
  private advance(e: TrackEntry, d: number): void {
    const t0 = e.trackTime;
    const t1 = t0 + d;
    e.trackTime = t1;
    if (d <= 0 || t1 < 0) return;
    const from = Math.max(0, t0);
    const anim = e.animation;
    const dur = anim.duration;
    // Events in [lo, hi), or [lo, hi] when the interval runs to the end of the animation.
    const fire = (lo: number, hi: number, inclusiveEnd: boolean) => {
      for (const ev of anim.events) if (ev.time >= lo && (ev.time < hi || (inclusiveEnd && ev.time === hi))) this.notify('event', e, ev);
    };
    if (dur <= 0) {
      if (t0 <= 0) {
        fire(0, 0, true);
        this.notify('complete', e);
      }
      return;
    }
    if (e.loop) {
      const first = Math.floor(from / dur);
      const last = Math.floor(t1 / dur);
      for (let loop = first; loop <= last; loop++) {
        const lo = loop === first ? from - loop * dur : 0;
        if (loop < last) {
          fire(lo, dur, true);
          this.notify('complete', e);
        } else fire(lo, t1 - loop * dur, false);
      }
      return;
    }
    const a0 = Math.max(0, from - e.loopStart);
    const a1 = t1 - e.loopStart;
    if (a0 < dur) {
      const reached = a1 >= dur;
      fire(a0, Math.min(a1, dur), reached);
      if (reached) this.notify('complete', e);
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
        const alpha = Math.max(0, e.alpha);
        for (let c = 0; c < mask.length; c++)
          if (mask[c]) ch[c] = angles[c] ? lerpAngle(this.base[c], ch[c], alpha) : lerp(this.base[c], ch[c], alpha);
        if (alpha < 0.5) skeleton.attachments.set(this.baseAttachments);
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

  /** Queues a listener call; `end` is sent once per entry and nothing follows it. */
  private notify(type: 'start' | 'interrupt' | 'end' | 'complete', entry: TrackEntry): void;
  private notify(type: 'event', entry: TrackEntry, event: EventData): void;
  private notify(type: Notice['type'], entry: TrackEntry, event?: EventData): void {
    if (entry.ended) return;
    if (type === 'end') entry.ended = true;
    this.notices.push(type === 'event' ? { type, entry, event: event! } : { type, entry });
  }

  /** Calls the listeners for queued notices, including ones queued by those listeners. */
  private drain(): void {
    if (this.draining) return;
    this.draining = true;
    try {
      for (let i = 0; i < this.notices.length; i++) {
        const n = this.notices[i];
        const listeners = this.listeners.slice();
        if (n.type === 'event') {
          n.entry.listener?.event?.(n.entry, n.event);
          for (const l of listeners) l.event?.(n.entry, n.event);
        } else {
          n.entry.listener?.[n.type]?.(n.entry);
          for (const l of listeners) l[n.type]?.(n.entry);
        }
      }
    } finally {
      this.notices.length = 0;
      this.draining = false;
    }
  }
}
