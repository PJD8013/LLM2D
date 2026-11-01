# LLM2D

Stake Engine 슬롯 게임용 2D 뼈대 애니메이션 도구입니다. AI(Claude)가 리깅과 애니메이션을
만들고, 게임에서는 PixiJS 8 런타임으로 재생합니다. 자체 포맷과 런타임을 쓰므로 외부
라이선스 비용이 없습니다.

```
그림(레이어) ──► 자동 리깅 ──► Claude가 동작 작성 ──► .l2d.json + 이미지 ──► Stake 게임(PixiJS 8 + Svelte 5)
                 (2단계)        (3단계, MCP)            (1단계: 포맷·런타임)       (4단계)
```

## 현재 상태: 3단계 완료

| 구성 요소 | 위치 | 내용 |
|---|---|---|
| 포맷 v0.1 | [`docs/format.md`](docs/format.md) | 뼈, 슬롯, region/mesh 첨부물, 가중치, IK, 애니메이션, 이벤트 |
| 코어 엔진 | [`packages/core`](packages/core) | 검증기, 뼈 계산, 2본 IK, 메시 스키닝, 커브 30여 종, 트랙·전환·대기열·이벤트. DOM 의존 없음 |
| PixiJS 8 런타임 | [`packages/pixi`](packages/pixi) | `Llm2dActor`. API를 spine-pixi-v8과 맞춤(`actor.state.setAnimation(0, 'win', true)`) |
| 뷰어 | [`apps/viewer`](apps/viewer) | 애니메이션 재생, 속도, 전환 시간, 타임라인, 뼈/메시/IK 표시, 파일 끌어다 놓기 |
| 자동 리깅 | [`packages/rig`](packages/rig), [`docs/rigging.md`](docs/rigging.md) | PSD 읽기 → 알파 윤곽으로 메시 생성 → 중심선 따라 체인 뼈 자동 배치 → 자동 가중치. 관절 좌표만 `rig.json`에 적으면 됨 |
| 구부림 테스트 | [`packages/core/src/bendTest.ts`](packages/core/src/bendTest.ts) | 관절 회전, IK 웅크리기·흔들기로 메시가 접히거나 찢어지는지 자동 검사 |
| Claude 연결 (MCP) | [`packages/mcp`](packages/mcp), [`docs/mcp.md`](docs/mcp.md) | Claude가 리깅·애니메이션·렌더 확인·내보내기를 직접 하는 도구 16개. `.mcp.json`으로 Claude Code에 바로 연결 |
| 모션 프리셋 | [`packages/motion`](packages/motion) | 심볼(idle, land, win, 기대감, 빅윈 타이틀)과 캐릭터(흔들림, 숨쉬기, 깜빡임, 말하기, 손 흔들기, 점프) 등 16종 |
| 미리보기 렌더러 | [`packages/preview`](packages/preview) | 헤드리스 브라우저로 그림 확인 이미지, 애니메이션 프레임, 구부림 자세를 PNG로 렌더 |
| 샘플 | [`samples`](samples) | Bolt(호스트 로봇), Gem(심볼: idle/land/win), Kit(PSD에서 자동 리깅한 여우: 휘는 팔·다리·꼬리·귀·스카프). 모두 원본 그림 |
| 렌더 스크립트 | [`scripts/render.ts`](scripts/render.ts) | 헤드리스 브라우저로 애니메이션 프레임이나 구부림 테스트 자세를 한 장에 모아 PNG로 저장. 3단계에서 Claude가 결과를 눈으로 확인하는 데 씀 |

## 시작하기

Node 22.18 이상과 pnpm이 필요합니다. 빌드 단계 없이 TypeScript를 바로 실행합니다.

```bash
pnpm install
```

```bash
pnpm dev                 # 뷰어 실행 (http://localhost:5173)
```

```bash
pnpm test                # 단위 테스트
```

```bash
pnpm typecheck           # 타입 검사
```

```bash
pnpm validate samples/bolt/bolt.l2d.json   # 파일 검증 (이미지 존재 여부 포함)
```

```bash
pnpm samples             # 샘플 다시 생성 (Bolt/Gem: SVG→PNG, Kit: PSD 자동 리깅)
```

```bash
pnpm rig inspect samples/kit/source/kit.psd --spec samples/kit/rig.json   # 격자 + 뼈 확인 이미지
```

```bash
pnpm rig build samples/kit/source/kit.psd --spec samples/kit/rig.json --animations samples/kit/animations.ts --out samples/kit
```

```bash
pnpm render --file bolt/bolt.l2d.json --anim cheer --frames 8 --debug   # out/renders/에 PNG 저장
```

```bash
pnpm render --file kit/kit.l2d.json --bend   # 구부림 테스트 자세 이미지
```

```bash
pnpm mcp:call list       # MCP 서버의 도구를 터미널에서 직접 호출
```

자동 리깅 사용법은 [`docs/rigging.md`](docs/rigging.md), Claude 연결은 [`docs/mcp.md`](docs/mcp.md)에 있습니다.

`pnpm samples`, `pnpm rig`, `pnpm render`는 Playwright의 Chromium을 씁니다. 처음이면
`pnpm exec playwright install chromium`을 한 번 실행하세요.

## 게임에서 쓰기 (PixiJS 8)

```ts
import { Application } from 'pixi.js';
import { Llm2dActor, loadLlm2d } from '@llm2d/pixi';

const app = new Application();
await app.init({ resizeTo: window });

const bolt = new Llm2dActor(await loadLlm2d('/assets/bolt/bolt.l2d.json'));
bolt.position.set(400, 600);
app.stage.addChild(bolt);

bolt.state.setAnimation(0, 'idle', true);        // 트랙 0: 기본 동작
bolt.state.setAnimation(1, 'blink', false);      // 트랙 1: 위에 겹치기
bolt.state.addAnimation(0, 'cheer', false, 2);   // 2초 뒤 대기열 재생
bolt.state.addListener({
  event: (_entry, ev) => ev.name === 'land' && playSound('thud'),
  complete: (entry) => console.log(entry.animation.name, 'done'),
});
```

Stake 웹 SDK의 Spine 사용법(`SpineProvider`, `SpineTrack`)과 같은 모양의 Svelte 5 컴포넌트는
4단계에서 추가합니다.

## 다음 단계

1. ~~포맷, 코어 엔진, PixiJS 8 런타임, 뷰어, 샘플~~ ✅
2. ~~자동 리깅: PSD 읽기, 메시 생성, 체인 자동 배치, 자동 가중치, 구부림 테스트~~ ✅
3. ~~Claude 연결: MCP 서버, 모션 프리셋, 렌더 결과를 보며 고치는 반복 과정~~ ✅
4. **Stake 연동:** 텍스처 아틀라스 패킹, `pixi-svelte`용 Svelte 5 컴포넌트, 릴 심볼 예제
5. (선택) 평면 그림 한 장 자동 분리, 타임라인 편집 화면

## 설계 메모

- **자체 포맷인 이유:** Spine 런타임은 Spine 에디터 라이선스가 있어야 씁니다. 자체 포맷과
  런타임이면 게임마다, 해마다 내는 비용이 없습니다.
- **LLM 친화적 포맷:** 각도는 도, 그림 위치는 캔버스 좌표 그대로, 애니메이션 값은 셋업 포즈
  기준 상대값, 커브는 `easeOutBack` 같은 이름. 검증기는 `animations.win.bones.gem.rotate[2].time`
  처럼 정확한 위치와 고칠 방법을 알려 줍니다.
- **Spine과 같은 API:** `state.setAnimation / addAnimation / setEmptyAnimation`, 트랙 엔트리의
  `loop`, `timeScale`, `listener`가 spine-ts와 같아서 Stake 예제 코드를 옮기기 쉽습니다.
