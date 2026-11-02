<script lang="ts">
  import { SLOT_CHANNELS, type L2DCurve } from '@llm2d/core';
  import { editor } from '../lib/editor.svelte.ts';
  import * as M from '../lib/model.ts';
  import CurveEditor from './CurveEditor.svelte';

  const fmt = (v: number, d = 2) => String(Math.round(v * 10 ** d) / 10 ** d);

  // Pose values of the selected bone (relative to setup), refreshed whenever the pose changes.
  const bone = $derived.by(() => {
    void editor.poseRev;
    const name = editor.selectedBone;
    const sk = editor.stage?.skeleton;
    if (!name || !sk || !editor.data) return null;
    const b = editor.data.bones[editor.data.findBone(name)];
    const time = M.snap(editor.time, editor.fps);
    const keyed = (channel: M.BoneChannel) => !!M.getKey(editor.anim, { group: 'bones', target: name, channel, time });
    const ik = editor.data.ik.find((c) => c.bones.includes(b.index) && sk.channels[editor.data!.ikChannelBase + c.index] > 0);
    return {
      name,
      parent: b.parent >= 0 ? editor.data.bones[b.parent].name : '-',
      values: M.boneOffsets(editor.data, sk, name),
      keyed: { rotate: keyed('rotate'), translate: keyed('translate'), scale: keyed('scale') },
      ikTarget: ik ? editor.data.bones[ik.target].name : null,
    };
  });

  const slot = $derived.by(() => {
    void editor.poseRev;
    const name = editor.selectedSlot;
    const sk = editor.stage?.skeleton;
    if (!name || !sk || !editor.data) return null;
    const s = editor.data.findSlot(name);
    const o = editor.data.slotChannelBase + s * SLOT_CHANNELS;
    const c = sk.channels;
    const hex = (v: number) =>
      Math.round(Math.min(1, Math.max(0, v)) * 255)
        .toString(16)
        .padStart(2, '0');
    return {
      name,
      attachments: editor.data.attachments[s].map((a) => a.name),
      attachment: sk.attachments[s] >= 0 ? editor.data.attachments[s][sk.attachments[s]].name : '',
      alpha: c[o + 3],
      rgb: `#${hex(c[o])}${hex(c[o + 1])}${hex(c[o + 2])}`,
    };
  });

  // The selected keys, with their key objects.
  const picked = $derived.by(() => {
    void editor.rev;
    if (!editor.data || !editor.animName) return [];
    return editor.selectedKeys.map((ref) => ({ ref, key: M.getKey(editor.anim, ref) })).filter((p) => p.key);
  });
  const curves = $derived(picked.filter((p) => p.ref.channel !== 'attachment' && p.ref.group !== 'events').map((p) => p.key!.curve));
  const sameCurve = $derived(curves.every((c) => JSON.stringify(c) === JSON.stringify(curves[0])));

  const events = $derived.by(() => {
    void editor.rev;
    return editor.data && editor.animName ? (editor.anim.events ?? []) : [];
  });
  const durationAuto = $derived.by(() => {
    void editor.rev;
    return editor.data && editor.animName ? editor.anim.duration === undefined : true;
  });

  function num(v: string): number | null {
    const n = Number(v);
    return v.trim() !== '' && Number.isFinite(n) ? n : null;
  }

  function setBone(channel: M.BoneChannel, field: 'value' | 'x' | 'y', v: string) {
    const n = num(v);
    if (n === null || !bone) return;
    editor.keyBone(bone.name, channel, { [field]: n });
  }

  function toggleKey(channel: M.BoneChannel) {
    if (!bone) return;
    const time = M.snap(editor.time, editor.fps);
    const ref = { group: 'bones', target: bone.name, channel, time } as M.KeyRef;
    if (bone.keyed[channel]) editor.edit((anim) => M.deleteKeys(anim, [ref]));
    else editor.keySelected([channel]);
  }

  function rename() {
    const name = prompt('새 이름', editor.animName);
    if (name) editor.renameAnimation(name.trim());
  }
</script>

<div class="inspector">
  <section>
    <h2>애니메이션</h2>
    <div class="row">
      <strong class="grow">{editor.animName}</strong>
      <button type="button" onclick={rename}>이름 바꾸기</button>
    </div>
    <label class="row">
      <span>길이</span>
      <input
        type="number"
        step="0.05"
        min="0"
        value={fmt(editor.duration, 3)}
        disabled={durationAuto}
        onchange={(e) => {
          const n = num(e.currentTarget.value);
          if (n !== null) editor.setDuration(n);
        }}
        aria-label="길이(초)"
      />
      <span>초</span>
      <label><input type="checkbox" checked={durationAuto} onchange={(e) => editor.setDuration(e.currentTarget.checked ? undefined : editor.duration)} /> 자동</label>
    </label>
  </section>

  {#if bone}
    <section data-testid="bone-panel">
      <h2>뼈 <span class="name">{bone.name}</span></h2>
      <p class="hint">부모 {bone.parent} · 값은 셋업 포즈 기준(회전·이동은 더하기, 크기는 곱하기)</p>
      {#if bone.ikTarget}<p class="warn">IK로 움직이는 뼈입니다. 목표 뼈 <b>{bone.ikTarget}</b>을(를) 옮기세요.</p>{/if}
      <div class="grid">
        <button type="button" class="key" class:on={bone.keyed.rotate} onclick={() => toggleKey('rotate')} title="회전 키 넣기/지우기">◆</button>
        <span>회전</span>
        <input type="number" step="1" value={fmt(bone.values.rotate)} onchange={(e) => setBone('rotate', 'value', e.currentTarget.value)} aria-label="회전" />
        <span class="unit">°</span>
        <span></span>

        <button type="button" class="key" class:on={bone.keyed.translate} onclick={() => toggleKey('translate')} title="이동 키 넣기/지우기">◆</button>
        <span>이동</span>
        <input type="number" step="1" value={fmt(bone.values.x)} onchange={(e) => setBone('translate', 'x', e.currentTarget.value)} aria-label="이동 x" />
        <input type="number" step="1" value={fmt(bone.values.y)} onchange={(e) => setBone('translate', 'y', e.currentTarget.value)} aria-label="이동 y" />
        <span></span>

        <button type="button" class="key" class:on={bone.keyed.scale} onclick={() => toggleKey('scale')} title="크기 키 넣기/지우기">◆</button>
        <span>크기</span>
        <input type="number" step="0.05" value={fmt(bone.values.scaleX, 3)} onchange={(e) => setBone('scale', 'x', e.currentTarget.value)} aria-label="크기 x" />
        <input type="number" step="0.05" value={fmt(bone.values.scaleY, 3)} onchange={(e) => setBone('scale', 'y', e.currentTarget.value)} aria-label="크기 y" />
        <span></span>
      </div>
      <button type="button" onclick={() => editor.keySelected()}>현재 자세로 키 넣기 (Shift+K)</button>
    </section>
  {/if}

  <section>
    <h2>슬롯</h2>
    <select value={editor.selectedSlot ?? ''} onchange={(e) => editor.selectSlot(e.currentTarget.value || null)} aria-label="슬롯 선택">
      <option value="">(슬롯 선택)</option>
      {#each editor.data?.slots ?? [] as s (s.name)}<option value={s.name}>{s.name}</option>{/each}
    </select>
    {#if slot}
      <label class="row">
        <span>그림</span>
        <select value={slot.attachment} onchange={(e) => editor.keySlot(slot.name, 'attachment', { name: e.currentTarget.value || null })} aria-label="첨부 그림">
          <option value="">(숨김)</option>
          {#each slot.attachments as a (a)}<option value={a}>{a}</option>{/each}
        </select>
      </label>
      <label class="row">
        <span>투명도</span>
        <input type="range" min="0" max="1" step="0.01" value={slot.alpha} onchange={(e) => editor.keySlot(slot.name, 'alpha', { value: Number(e.currentTarget.value) })} aria-label="투명도" />
        <span class="unit">{fmt(slot.alpha)}</span>
      </label>
      <label class="row">
        <span>색</span>
        <input
          type="color"
          value={slot.rgb}
          onchange={(e) => editor.keySlot(slot.name, 'color', { value: e.currentTarget.value.slice(1) + Math.round(slot.alpha * 255).toString(16).padStart(2, '0') })}
          aria-label="색"
        />
      </label>
      <p class="hint">값을 바꾸면 현재 시간에 키가 들어갑니다.</p>
    {/if}
  </section>

  {#if picked.length}
    <section data-testid="key-panel">
      <h2>선택한 키 <span class="name">{picked.length}개</span></h2>
      {#if picked.length === 1}
        {@const p = picked[0]}
        <p class="hint">{p.ref.group === 'events' ? '이벤트' : `${p.ref.target} · ${M.channelLabel(p.ref.channel)}`}</p>
        <label class="row">
          <span>시간</span>
          <input type="number" step={1 / editor.fps} min="0" value={fmt(p.key!.time, 4)} onchange={(e) => num(e.currentTarget.value) !== null && editor.setKeyTime(num(e.currentTarget.value)!)} aria-label="키 시간" />
          <span class="unit">초</span>
        </label>
        {#if p.ref.channel === 'rotate' || p.ref.channel === 'alpha' || p.ref.channel === 'mix'}
          <label class="row">
            <span>값</span>
            <input type="number" step={p.ref.channel === 'rotate' ? 1 : 0.05} value={fmt(Number(p.key!.value), 3)} onchange={(e) => num(e.currentTarget.value) !== null && editor.setKeyFields({ value: num(e.currentTarget.value) })} aria-label="키 값" />
          </label>
        {:else if p.ref.channel === 'translate' || p.ref.channel === 'scale'}
          <label class="row">
            <span>x / y</span>
            <input type="number" step="0.05" value={fmt(Number(p.key!.x ?? (p.ref.channel === 'scale' ? 1 : 0)), 3)} onchange={(e) => num(e.currentTarget.value) !== null && editor.setKeyFields({ x: num(e.currentTarget.value) })} aria-label="키 x" />
            <input type="number" step="0.05" value={fmt(Number(p.key!.y ?? (p.ref.channel === 'scale' ? 1 : 0)), 3)} onchange={(e) => num(e.currentTarget.value) !== null && editor.setKeyFields({ y: num(e.currentTarget.value) })} aria-label="키 y" />
          </label>
        {:else if p.ref.channel === 'color'}
          <label class="row">
            <span>색</span>
            <input type="text" value={String(p.key!.value)} onchange={(e) => /^[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(e.currentTarget.value) && editor.setKeyFields({ value: e.currentTarget.value })} aria-label="키 색" />
          </label>
        {:else if p.ref.channel === 'attachment'}
          <p class="hint">그림: {p.key!.name ?? '(숨김)'}</p>
        {/if}
      {/if}
      {#if curves.length}
        <h3>다음 키까지의 곡선</h3>
        <CurveEditor curve={sameCurve ? curves[0] : undefined} mixed={!sameCurve} onchange={(c: L2DCurve | undefined) => editor.setCurve(c)} />
      {/if}
      <button type="button" class="danger" onclick={() => editor.deleteSelectedKeys()}>선택한 키 지우기 (Delete)</button>
    </section>
  {/if}

  <section>
    <h2>이벤트</h2>
    <ul class="events">
      {#each events as ev, i (i)}
        <li>
          <button type="button" class="time" onclick={() => editor.seek(ev.time, false)}>{fmt(ev.time)}s</button>
          <input type="text" value={ev.name} onchange={(e) => e.currentTarget.value.trim() && editor.updateEvent(i, { name: e.currentTarget.value.trim() })} aria-label="이벤트 이름" />
          <button type="button" class="x" onclick={() => editor.deleteEvent(i)} aria-label="이벤트 지우기">×</button>
        </li>
      {/each}
    </ul>
    <button type="button" onclick={() => editor.addEvent('event')}>현재 시간에 이벤트 추가</button>
  </section>
</div>

<style>
  .inspector {
    display: grid;
    gap: 2px;
    align-content: start;
  }
  section {
    padding: 10px 12px;
    border-bottom: 1px solid #ffffff12;
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 7px;
    min-width: 0;
  }
  section > :global(*) {
    min-width: 0;
    max-width: 100%;
  }
  h2 {
    margin: 0;
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: #9aa0b8;
  }
  h3 {
    margin: 4px 0 0;
    font-size: 12px;
    color: #9aa0b8;
    font-weight: 500;
  }
  .name {
    color: #ffb020;
    text-transform: none;
    letter-spacing: 0;
    font-size: 13px;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }
  .row strong {
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .row > span:first-child {
    min-width: 42px;
    color: #9aa0b8;
  }
  .row input[type='number'],
  .row input[type='text'] {
    width: 70px;
  }
  .row input[type='range'] {
    flex: 1;
    min-width: 0;
  }
  select {
    max-width: 100%;
  }
  .grow {
    flex: 1;
  }
  .grid {
    display: grid;
    grid-template-columns: 26px 34px 1fr 1fr 0;
    gap: 5px;
    align-items: center;
  }
  .grid input {
    width: 100%;
    min-width: 0;
  }
  .unit {
    color: #9aa0b8;
  }
  .key {
    padding: 0;
    width: 24px;
    height: 24px;
    color: #59607a;
    background: transparent;
    border: 1px solid #ffffff22;
  }
  .key.on {
    color: #ffb020;
    border-color: #ffb02088;
  }
  .hint {
    margin: 0;
    font-size: 11px;
    color: #8c92aa;
  }
  .warn {
    margin: 0;
    font-size: 12px;
    color: #ffd27a;
  }
  .danger {
    color: #ff8a8a;
  }
  .events {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 4px;
  }
  .events li {
    display: flex;
    gap: 4px;
  }
  .events input {
    flex: 1;
    width: 0;
    min-width: 0;
  }
  .events .time {
    width: 54px;
  }
  .events .x {
    width: 26px;
    padding: 0;
  }
</style>
