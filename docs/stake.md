# Stake 게임에 넣기 (4단계)

LLM2D 스켈레톤을 Stake Engine 웹 SDK 게임(PixiJS 8 + Svelte 5 + `pixi-svelte`)에서 Spine처럼
씁니다. 예제 앱: [`apps/reel-demo`](../apps/reel-demo) (5x3 보드, 착지·당첨 애니메이션, 당첨에
반응하는 여우 호스트).

![릴 데모](images/reel-demo.png)

## 1. 게임용으로 내보내기

이미지를 아틀라스 페이지로 묶고 JSON을 줄인 파일을 게임의 static 폴더에 씁니다.

```bash
pnpm export samples/kit/kit.l2d.json samples/coin/coin.l2d.json --out ../my-game/static/assets/llm2d
```

모바일용 절반 해상도 세트도 만들 수 있습니다(크기는 그대로, 텍스처만 축소).

```bash
pnpm export samples/kit/kit.l2d.json --out ../my-game/static/assets/llm2d-half --scale 0.5
```

Claude에게 맡길 때는 MCP 도구 `export_project`가 같은 일을 합니다(`atlas`, `scale`, `max_size` 옵션).

결과물: `<이름>/<이름>.l2d.json` + `<이름>.png`(아틀라스 페이지, 크면 `-2.png` 등이 추가됨).
원본과 아틀라스 버전을 같은 프레임으로 렌더해 비교하면 픽셀 차이가 최대 1입니다.

## 2. 패키지 설치

레지스트리 없이 설치할 수 있도록 tgz 파일을 만듭니다.

```bash
pnpm pack:lib
```

`out/packages/`에 `llm2d-core`, `llm2d-pixi`, `llm2d-svelte` tgz가 생깁니다. 게임 저장소로 복사한 뒤
게임 앱의 `package.json`에 추가합니다. `@llm2d/svelte`가 나머지 둘에 의존하므로 `pnpm.overrides`로
같은 tgz를 가리키게 합니다(Stake 모노레포라면 루트 `package.json`).

```json
{
  "dependencies": {
    "@llm2d/svelte": "file:./vendor/llm2d-svelte-0.1.0.tgz"
  },
  "pnpm": {
    "overrides": {
      "@llm2d/core": "file:./vendor/llm2d-core-0.1.0.tgz",
      "@llm2d/pixi": "file:./vendor/llm2d-pixi-0.1.0.tgz"
    }
  }
}
```

```bash
pnpm install
```

패키지는 JS(`dist/`)와 타입 선언을 담고 있어서 `svelte-check`와 Vite 빌드가 그대로 됩니다.
작업 공간 밖의 별도 앱에 이 tgz를 설치해 `svelte-check`, Vite 6.2 빌드, 브라우저 실행까지 확인했습니다.

## 3. 로더 등록과 에셋 선언

`pixi-svelte`의 `AssetsLoader`는 `sprite` 종류 에셋을 `PIXI.Assets.load`로 그대로 불러옵니다.
`registerLlm2dLoader()`를 먼저 호출하면 `.l2d.json`이 스켈레톤으로 로드됩니다. pixi-svelte는
수정할 필요가 없습니다.

```ts
// 게임 진입점 (앱이 마운트되기 전)
import { registerLlm2dLoader } from '@llm2d/svelte';
registerLlm2dLoader();
```

```ts
// game/assets.ts — 기존 Spine 에셋 옆에 그대로 추가
export default {
  // ...
  fox: { type: 'sprite', src: new URL('../../assets/llm2d/kit/kit.l2d.json', import.meta.url).href },
  coin: { type: 'sprite', src: new URL('../../assets/llm2d/coin/coin.l2d.json', import.meta.url).href },
};
```

## 4. 컴포넌트

`SpineProvider` / `SpineTrack` / `SpineSlot`과 같은 자리에 씁니다.

```svelte
<script lang="ts">
  import { Llm2dProvider, Llm2dTrack, Llm2dBone } from '@llm2d/svelte';
  import { Sprite } from 'pixi-svelte';
</script>

<!-- 심볼: 중심 기준, 셀 크기에 맞춤 -->
<Llm2dProvider key="coin" x={cellX} y={cellY} anchor={0.5} width={SYMBOL_SIZE}>
  <Llm2dTrack trackIndex={0} animationName={win ? 'win' : 'idle'} loop mix={0.1} />
</Llm2dProvider>

<!-- 호스트: 원점(발)이 (x, y)에 오고 높이 520에 맞춤 -->
<Llm2dProvider key="fox" x={1080} y={600} height={520}>
  <Llm2dTrack
    trackIndex={0}
    animationName={hostAnimation}
    loop={hostAnimation === 'idle'}
    listener={{
      complete: (e) => e.animation.name === 'cheer' && (hostAnimation = 'idle'),
      event: (_e, ev) => ev.name === 'land' && playSound('thud'),
    }}
  />
  <Llm2dTrack trackIndex={1} animationName="blink" />
  <!-- 뼈를 따라다니는 오브젝트 (예: 손에 든 동전) -->
  <Llm2dBone boneName="hand_r">
    <Sprite key="coinIcon" anchor={0.5} />
  </Llm2dBone>
</Llm2dProvider>
```

| 컴포넌트 | 주요 props |
|---|---|
| `Llm2dProvider` | `key`(로드된 에셋 키) 또는 `asset`, `x`, `y`, `anchor`(경계 상자 기준, 0.5 = 중심, 생략 시 스켈레톤 원점), `width`/`height`(맞춤), `scale`, `tint`, `alpha`, `visible`, `debug`, `onactor` |
| `Llm2dTrack` | `trackIndex`, `animationName`, `loop`, `mix`(전환 시간), `mixOut`(제거 시 페이드), `timeScale`, `alpha`, `listener` |
| `Llm2dBone` | `boneName`; 자식이 뼈의 위치·회전·크기를 따라감 |

`animationName`을 바꾸면 이전 애니메이션에서 부드럽게 넘어갑니다. 컴포넌트를 제거하면 그 트랙이
`mixOut` 동안 사라집니다. `listener`는 Spine과 같은 모양(`start`, `complete`, `end`, `interrupt`, `event`)입니다.

## 5. 애니메이션 이름 약속

| 대상 | 이름 | 반복 |
|---|---|---|
| 심볼 | `idle` | 예 |
| 심볼 | `land` (이벤트 `land`) | 아니요 |
| 심볼 | `win` | 예 |
| 심볼 | `anticipation` | 예 |
| 캐릭터 | `idle`, `blink`(트랙 1), `talk`, `wave`, `cheer`/`jump` (이벤트 `jump`, `land`) | 상황별 |
| 타이틀 | `big_win_title` 프리셋 결과 (이벤트 `slam`) | 아니요 |

## Spine 대신 쓸 때 다른 점

- 에셋 선언: `type: 'spine'` + `{ atlas, skeleton }` 대신 `type: 'sprite'` + `.l2d.json` 하나
- 컴포넌트 이름: `SpineProvider` → `Llm2dProvider`, `SpineTrack` → `Llm2dTrack`, `SpineSlot`/`SpineBone` → `Llm2dBone`
- `anchor`는 스켈레톤 경계 상자 기준입니다. 생략하면 스켈레톤 원점(캐릭터는 발 사이)이 `(x, y)`에 옵니다.
- 런타임 API(`actor.state.setAnimation(0, 'win', true)`, `addAnimation`, `setEmptyAnimation`)는 spine-ts와 같습니다.
