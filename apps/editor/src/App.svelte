<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { editor, type Tool } from './lib/editor.svelte.ts';
  import { Stage } from './lib/stage.ts';
  import Inspector from './components/Inspector.svelte';
  import Timeline from './components/Timeline.svelte';

  let viewport: HTMLDivElement;
  let timeline: ReturnType<typeof Timeline> | undefined = $state();
  let help = $state(false);

  const TOOLS: { id: Tool; label: string; key: string }[] = [
    { id: 'rotate', label: '회전', key: 'R' },
    { id: 'translate', label: '이동', key: 'T' },
    { id: 'scale', label: '크기', key: 'S' },
  ];

  onMount(() => {
    const stage = new Stage(editor);
    editor.stage = stage;
    (window as unknown as { __editor: typeof editor }).__editor = editor;
    void stage.mount(viewport).then(() => editor.init());
    const unload = (e: BeforeUnloadEvent) => {
      if (editor.dirty) e.preventDefault();
    };
    window.addEventListener('beforeunload', unload);
    return () => {
      window.removeEventListener('beforeunload', unload);
      stage.destroy();
    };
  });

  // Onion skins follow the toggle immediately.
  $effect(() => {
    void editor.onion;
    untrack(() => editor.pose());
  });

  function ask(title: string, value = ''): string | null {
    const v = prompt(title, value);
    return v ? v.trim() : null;
  }

  function keydown(e: KeyboardEvent) {
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    // Save works everywhere; other shortcuts leave text fields alone.
    if (mod && k === 's') {
      e.preventDefault();
      (e.target as HTMLElement).blur?.();
      void editor.save();
      return;
    }
    if ((e.target as HTMLElement).closest('input, select, textarea')) return;
    if (mod && k === 'z') {
      e.preventDefault();
      e.shiftKey ? editor.redo() : editor.undo();
    } else if (mod && k === 'y') {
      e.preventDefault();
      editor.redo();
    } else if (mod && k === 'c') editor.copy();
    else if (mod && k === 'v') editor.paste();
    else if (mod) return;
    else if (k === ' ') {
      e.preventDefault();
      editor.playing = !editor.playing;
    } else if (k === 'arrowleft') editor.step(e.shiftKey ? -10 : -1);
    else if (k === 'arrowright') editor.step(e.shiftKey ? 10 : 1);
    else if (k === 'home') editor.seek(0);
    else if (k === 'end') editor.seek(editor.duration);
    else if (k === 'r') editor.tool = 'rotate';
    else if (k === 't' || k === 'w') editor.tool = 'translate';
    else if (k === 's') editor.tool = 'scale';
    else if (k === 'k') e.shiftKey ? editor.keySelected() : editor.keySelected([editor.tool]);
    else if (k === 'delete' || k === 'backspace') editor.deleteSelectedKeys();
    else if (k === 'o') editor.onion = !editor.onion;
    else if (k === 'f') editor.stage?.resetView(), timeline?.fitAll();
    else if (k === 'escape') (editor.selectedKeys = []), editor.selectBone(null);
    else if (k === '?') help = !help;
    else return;
  }
</script>

<svelte:window onkeydown={keydown} />

<div class="app">
  <header>
    <h1>LLM2D <span>Editor</span></h1>
    <select value={editor.info?.id ?? ''} onchange={(e) => editor.open(e.currentTarget.value)} aria-label="프로젝트" disabled={editor.dirty}>
      {#each editor.projects as p (p.id)}<option value={p.id}>{p.name}{p.editable ? '' : ' (읽기 전용)'}</option>{/each}
    </select>
    <span class="sep"></span>
    <select value={editor.animName} onchange={(e) => editor.selectAnimation(e.currentTarget.value)} aria-label="애니메이션">
      {#each editor.animNames as n (n)}<option value={n}>{n}</option>{/each}
    </select>
    <button type="button" onclick={() => { const n = ask('새 애니메이션 이름', 'new'); if (n) editor.newAnimation(n); }}>새로</button>
    <button type="button" onclick={() => { const n = ask('복제할 이름', `${editor.animName}_copy`); if (n) editor.duplicateAnimation(n); }}>복제</button>
    <button type="button" onclick={() => confirm(`"${editor.animName}" 애니메이션을 지울까요?`) && editor.deleteAnimation()}>삭제</button>
    <span class="sep"></span>
    <button type="button" onclick={() => editor.undo()} disabled={!editor.canUndo} title="실행 취소 (Ctrl+Z)">↶</button>
    <button type="button" onclick={() => editor.redo()} disabled={!editor.canRedo} title="다시 실행 (Ctrl+Shift+Z)">↷</button>
    <span class="grow"></span>
    {#if editor.status}<span class="status {editor.status.kind}" data-testid="status">{editor.status.text}</span>{/if}
    <button type="button" onclick={() => editor.exportJson()} title="animations.json 내려받기">JSON 내보내기</button>
    <button type="button" class="primary" onclick={() => editor.save()} disabled={!editor.info?.editable || editor.saving || !editor.dirty} title={editor.info?.note ?? '저장 (Ctrl+S)'} data-testid="save">
      {editor.saving ? '저장 중…' : editor.dirty ? '저장 ●' : '저장됨'}
    </button>
    <button type="button" onclick={() => (help = !help)} title="단축키 (?)">?</button>
  </header>

  {#if editor.externalChange}
    <div class="banner">
      파일이 밖에서 바뀌었습니다(예: Claude가 MCP로 수정). 지금 편집한 내용은 아직 저장되지 않았습니다.
      <button type="button" onclick={() => editor.info && editor.open(editor.info.id, true)}>다시 불러오기 (편집 버림)</button>
      <button type="button" onclick={() => (editor.externalChange = false)}>무시</button>
    </div>
  {/if}
  {#if editor.info && !editor.info.editable}
    <div class="banner muted">{editor.info.note}</div>
  {/if}

  <main>
    <div class="viewport" bind:this={viewport}>
      <div class="tools">
        {#each TOOLS as t (t.id)}
          <button type="button" class:on={editor.tool === t.id} onclick={() => (editor.tool = t.id)} title={`${t.label} (${t.key})`}>{t.label} <kbd>{t.key}</kbd></button>
        {/each}
        <button type="button" onclick={() => editor.keySelected([editor.tool])} disabled={!editor.selectedBone} title="선택한 뼈에 키 (K)">키 <kbd>K</kbd></button>
        <button type="button" class:on={editor.onion} onclick={() => (editor.onion = !editor.onion)} title="앞뒤 0.1초 겹쳐 보기 (O)">어니언 <kbd>O</kbd></button>
      </div>
      <p class="tip">뼈를 끌거나, 뼈를 고른 뒤 빈 곳을 끌면 현재 시간에 키가 들어갑니다 · 화면 이동: 오른쪽/가운데 버튼 또는 Alt+끌기 · 휠: 확대 · 더블클릭: 맞춤</p>
    </div>
    <aside>
      <Inspector />
    </aside>
  </main>

  <footer>
    <div class="transport">
      <button type="button" onclick={() => editor.seek(0)} title="처음 (Home)">⏮</button>
      <button type="button" onclick={() => editor.step(-1)} title="이전 프레임 (←)">◀</button>
      <button type="button" class="play" onclick={() => (editor.playing = !editor.playing)} title="재생/정지 (Space)" data-testid="play">{editor.playing ? '⏸' : '▶'}</button>
      <button type="button" onclick={() => editor.step(1)} title="다음 프레임 (→)">▶|</button>
      <button type="button" onclick={() => editor.seek(editor.duration)} title="끝 (End)">⏭</button>
      <span class="time" data-testid="time">{editor.time.toFixed(2)} / {editor.duration.toFixed(2)}s</span>
      <label><input type="checkbox" bind:checked={editor.loop} /> 반복</label>
      <label>속도 <select bind:value={editor.speed}>{#each [0.25, 0.5, 1, 1.5, 2] as s (s)}<option value={s}>{s}x</option>{/each}</select></label>
      <label>FPS <select bind:value={editor.fps}>{#each [24, 30, 60] as f (f)}<option value={f}>{f}</option>{/each}</select></label>
      <label><input type="checkbox" bind:checked={editor.showAll} /> 모든 뼈·슬롯</label>
      <span class="grow"></span>
      <button type="button" onclick={() => timeline?.fitAll()} title="타임라인 맞춤 (F)">맞춤</button>
    </div>
    <div class="tl"><Timeline bind:this={timeline} /></div>
  </footer>

  {#if help}
    <div class="help" role="dialog" aria-label="단축키">
      <h2>단축키</h2>
      <dl>
        <dt>Space</dt><dd>재생 / 정지</dd>
        <dt>← → (Shift: 10프레임)</dt><dd>프레임 이동</dd>
        <dt>R / T / S</dt><dd>회전 / 이동 / 크기 도구</dd>
        <dt>K / Shift+K</dt><dd>선택한 뼈: 현재 도구 채널 / 세 채널 모두 키</dd>
        <dt>Delete</dt><dd>선택한 키 지우기</dd>
        <dt>Ctrl+C / Ctrl+V</dt><dd>키 복사 / 재생 위치에 붙이기</dd>
        <dt>Ctrl+Z / Ctrl+Shift+Z</dt><dd>실행 취소 / 다시 실행</dd>
        <dt>Ctrl+S</dt><dd>저장</dd>
        <dt>O</dt><dd>어니언 스킨(앞뒤 0.1초)</dd>
        <dt>F</dt><dd>화면·타임라인 맞춤</dd>
        <dt>화면</dt><dd>뼈 끌기 또는 뼈를 고른 뒤 빈 곳 끌기: 현재 도구로 편집(크기 도구에서 Shift: 축 하나만) · 빈 곳 클릭: 선택 해제 · 오른쪽/가운데 버튼, Alt+끌기: 화면 이동</dd>
        <dt>타임라인</dt><dd>클릭 선택(Shift 추가) · 끌어서 이동 · 빈 곳 끌어 범위 선택 · 더블클릭 키 추가 · Ctrl+휠 확대</dd>
      </dl>
      <button type="button" onclick={() => (help = false)}>닫기</button>
    </div>
  {/if}
</div>

<style>
  .app {
    display: grid;
    grid-template-rows: auto auto auto 1fr 260px;
    height: 100vh;
  }
  header {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 8px 12px;
    background: #151722;
    border-bottom: 1px solid #ffffff14;
  }
  h1 {
    margin: 0 8px 0 0;
    font-size: 15px;
  }
  h1 span {
    color: #ffb020;
    font-weight: 500;
  }
  .sep {
    width: 1px;
    height: 20px;
    background: #ffffff22;
    margin: 0 4px;
  }
  .grow {
    flex: 1;
  }
  .status {
    font-size: 12px;
    padding: 3px 8px;
    border-radius: 4px;
    max-width: 46ch;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .status.ok {
    background: #1f4d34;
    color: #b6f5cd;
  }
  .status.info {
    background: #2a3150;
    color: #c9d4ff;
  }
  .status.error {
    background: #5a2230;
    color: #ffc7cf;
  }
  .primary:not(:disabled) {
    background: #ffb020;
    color: #1b1d29;
    font-weight: 700;
  }
  .banner {
    padding: 6px 12px;
    background: #4b3a12;
    color: #ffe5a3;
    font-size: 13px;
    display: flex;
    gap: 8px;
    align-items: center;
  }
  .banner.muted {
    background: #23283b;
    color: #b8bfd8;
  }
  main {
    display: grid;
    grid-template-columns: 1fr 300px;
    min-height: 0;
    grid-row: 4;
  }
  .viewport {
    position: relative;
    min-height: 0;
    overflow: hidden;
    background: radial-gradient(circle at 50% 40%, #2a2f45, #171925);
  }
  .tools {
    position: absolute;
    top: 10px;
    left: 10px;
    display: flex;
    gap: 4px;
    z-index: 2;
  }
  .tools .on {
    background: #ffb020;
    color: #1b1d29;
  }
  kbd {
    font-size: 10px;
    opacity: 0.7;
  }
  .tip {
    position: absolute;
    bottom: 6px;
    left: 10px;
    margin: 0;
    font-size: 11px;
    color: #8c92aa;
    pointer-events: none;
  }
  aside {
    overflow-y: auto;
    overflow-x: hidden;
    background: #1b1d29;
    border-left: 1px solid #ffffff14;
  }
  footer {
    grid-row: 5;
    display: grid;
    grid-template-rows: auto 1fr;
    border-top: 1px solid #ffffff1c;
    min-height: 0;
  }
  .transport {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 5px 10px;
    background: #151722;
    font-size: 12px;
  }
  .transport .time {
    font-variant-numeric: tabular-nums;
    min-width: 110px;
    color: #e8eaf4;
  }
  .transport .play {
    width: 36px;
  }
  .tl {
    min-height: 0;
  }
  .help {
    position: fixed;
    right: 20px;
    top: 56px;
    width: 420px;
    background: #23263a;
    border: 1px solid #ffffff22;
    border-radius: 8px;
    padding: 14px 18px;
    z-index: 10;
    box-shadow: 0 10px 40px #0008;
  }
  .help h2 {
    margin: 0 0 8px;
    font-size: 15px;
  }
  dl {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 5px 14px;
    margin: 0 0 10px;
    font-size: 13px;
  }
  dt {
    color: #ffb020;
  }
  dd {
    margin: 0;
  }
</style>
