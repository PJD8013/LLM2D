# LLM2D

[![CI](https://github.com/PJD8013/LLM2D/actions/workflows/ci.yml/badge.svg)](https://github.com/PJD8013/LLM2D/actions/workflows/ci.yml)

Stake Engine 슬롯 게임용 2D 뼈대 애니메이션 도구입니다. AI(Claude)가 리깅과 애니메이션을
만들고, 사람이 편집기로 다듬고, 게임에서는 PixiJS 8 런타임으로 재생합니다. 자체 포맷과
런타임을 쓰므로 외부 라이선스 비용이 없습니다.

## 전체 흐름

```
그림 ─ 레이어 PSD ──────────────────────────────┐
     └ 그림 한 장(PNG/JPEG) ─► 자동 분리 ─► PSD ┘   docs/split.md
                                     │
                                     ▼
      자동 리깅: 관절 위치만 정하면 메시·뼈·가중치 자동, 구부림 테스트   docs/rigging.md
                                     │
                                     ▼
      Claude가 애니메이션 작성(MCP 도구, 렌더 결과를 보며 고침)          docs/mcp.md
                                     │  같은 animations.json
                                     ▼
      사람이 타임라인 편집기로 다듬기                                     docs/editor.md
                                     │
                                     ▼
      게임용 내보내기(아틀라스) ─► Stake 게임에서 재생(pixi-svelte)      docs/stake.md
```

## 구성 요소

**만들기 도구**

| 구성 요소 | 위치 | 내용 |
|---|---|---|
| 평면 그림 자동 분리 | [`packages/rig`](packages/rig), [`docs/split.md`](docs/split.md) | 레이어 없는 그림 한 장(PNG/JPEG)을 부위별 레이어 PSD로. 배경 제거, 번호 붙은 색 영역, 외곽선은 앞 부위로, 빛 번짐·그림자는 반투명 레이어로, 가려진 곳 자동 복원(다시 겹치면 원본과 픽셀 단위로 같음) |
| 자동 리깅 | [`packages/rig`](packages/rig), [`docs/rigging.md`](docs/rigging.md) | PSD 읽기(레이어 마스크·클리핑 음영·그룹·16비트 반영) → 알파 윤곽으로 메시 생성 → 중심선 따라 체인 뼈 자동 배치 → 자동 가중치. 관절 좌표만 `rig.json`에 적으면 됨 |
| 구부림 테스트 | [`packages/core/src/bendTest.ts`](packages/core/src/bendTest.ts) | 관절 회전, IK 웅크리기·흔들기로 메시가 접히거나 찢어지는지 자동 검사 |
| Claude 연결 (MCP) | [`packages/mcp`](packages/mcp), [`docs/mcp.md`](docs/mcp.md) | Claude가 분리·리깅·애니메이션·렌더 확인·내보내기를 직접 하는 도구 18개. `.mcp.json`으로 Claude Code에 바로 연결 |
| 모션 프리셋 | [`packages/motion`](packages/motion) | 심볼(idle, land, win, 기대감, 빅윈 타이틀, 반짝임 지나가기)과 캐릭터(흔들림, 숨쉬기, 깜빡임, 말하기, 손 흔들기, 점프) 등 18종 |
| 타임라인 편집기 | [`apps/editor`](apps/editor), [`docs/editor.md`](docs/editor.md) | 뼈를 잡아 돌리고 옮겨 키 넣기, 키 이동·복사·곡선(베지어) 편집, 슬롯·이벤트, 어니언 스킨, 실행 취소. MCP와 같은 `animations.json`에 저장하고, Claude가 고치면 자동으로 다시 불러옴 |
| 뷰어 | [`apps/viewer`](apps/viewer) | 애니메이션 재생, 속도, 전환 시간, 뼈/메시/IK 표시, 파일 끌어다 놓기 |
| 미리보기 렌더러 | [`packages/preview`](packages/preview), [`scripts/render.ts`](scripts/render.ts) | 헤드리스 브라우저로 그림 확인 이미지, 애니메이션 프레임, 구부림 자세를 PNG로. Claude가 결과를 눈으로 확인하는 데 씀 |
| 게임 내보내기 | [`packages/export`](packages/export) | 텍스처 아틀라스 묶기(가장자리 번짐 방지), 모바일용 축소, 줄인 JSON |

**게임 런타임**

| 구성 요소 | 위치 | 내용 |
|---|---|---|
| 포맷 v0.1 | [`docs/format.md`](docs/format.md) | 뼈, 슬롯, region/mesh/clipping 첨부물, 가중치, IK, 애니메이션, 이벤트 |
| 코어 엔진 | [`packages/core`](packages/core) | 검증기, 뼈 계산, 2본 IK, 메시 스키닝, 커브 30여 종, 트랙·전환·대기열·이벤트. DOM 의존 없음 |
| PixiJS 8 런타임 | [`packages/pixi`](packages/pixi) | `Llm2dActor`. API를 spine-pixi-v8과 맞춤(`actor.state.setAnimation(0, 'win', true)`), Pixi 에셋 로더 |
| Stake 연동 | [`packages/svelte`](packages/svelte), [`docs/stake.md`](docs/stake.md) | pixi-svelte용 `Llm2dProvider`/`Llm2dTrack`/`Llm2dBone`, 설치용 tgz(`pnpm pack:lib`) |

**예제와 샘플**

| 구성 요소 | 위치 | 내용 |
|---|---|---|
| 실제 Stake 게임 | [`examples/stake-lines`](examples/stake-lines) | 공식 web-sdk 샘플 게임 `lines`의 H1 심볼을 LLM2D 동전으로 교체하는 패치와 적용·캡처 스크립트(`pnpm stake:lines`) |
| 릴 데모 | [`apps/reel-demo`](apps/reel-demo) | Svelte 5 + pixi-svelte 5x3 보드. 착지·당첨 애니메이션과 당첨에 반응하는 여우 |
| 샘플 | [`samples`](samples) | Bolt(호스트 로봇), Gem(심볼: idle/land/win), Kit(PSD에서 자동 리깅한 여우: 휘는 팔·다리·꼬리·귀·스카프), Coin(MCP 도구로 리깅·애니메이션한 금화), Kit-flat(여우를 JPEG 한 장으로 합친 뒤 자동 분리해 다시 리깅). 모두 원본 그림 |

## 시작하기

Node 22.18 이상과 pnpm이 필요합니다. 빌드 단계 없이 TypeScript를 바로 실행합니다. 그림 확인과
렌더에는 Playwright의 Chromium을 씁니다.

```bash
pnpm install
```

```bash
pnpm exec playwright install chromium
```

### Claude에게 맡기기

저장소 폴더에서 Claude Code를 실행하면 MCP 서버(`llm2d` 도구)가 연결됩니다([`docs/mcp.md`](docs/mcp.md)).

```bash
claude
```

이렇게 요청하면 됩니다.

- "samples/kit/source/kit.psd로 캐릭터 프로젝트를 out/projects/fox에 만들고 리깅해줘. 꼬리는 체인, 다리는 IK로."
- "이 그림 한 장(fox.jpg)을 부위별로 나눠서 캐릭터로 만들어줘."
- "fox에 idle, 손 흔들기, 점프 만들어줘." → 편집기(`pnpm editor out/projects/fox`)에서 다듬기
- "완성되면 검증하고 ../my-game/static/assets/llm2d로 내보내줘."

### 하려는 일별 명령

| 하려는 일 | 명령 |
|---|---|
| 샘플 보기 (http://localhost:5173) | `pnpm dev` |
| 애니메이션 다듬기 (http://127.0.0.1:5174, 이 컴퓨터에서만) | `pnpm editor [프로젝트 폴더]` |
| 그림 한 장 → 영역 그림 / 레이어 PSD | `pnpm split regions <그림>` / `pnpm split build <그림> --spec split.json` |
| PSD 확인 / 리깅 | `pnpm rig inspect <psd> --spec rig.json` / `pnpm rig build <psd> --spec rig.json --out <폴더>` |
| 프레임·구부림 테스트 이미지 | `pnpm render --file kit/kit.l2d.json --anim cheer` / `pnpm render --file kit/kit.l2d.json --bend` |
| MCP 도구를 터미널에서 호출 | `pnpm mcp:call list` |
| 게임용 내보내기 (아틀라스) | `pnpm export <파일.l2d.json> --out <폴더>` |
| Stake 게임에 설치할 tgz | `pnpm pack:lib` |
| Stake web-sdk `lines` 게임에 붙이기 | `pnpm stake:lines apply ../web-sdk` |
| 릴 데모 (http://localhost:5180) | `pnpm --filter @llm2d/reel-demo dev` |
| 샘플 다시 생성 | `pnpm samples` |
| 검사 (CI와 같음) | `pnpm test && pnpm typecheck && pnpm validate` |

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

Stake 웹 SDK(pixi-svelte)에서는 Spine 컴포넌트와 같은 모양의 `Llm2dProvider`, `Llm2dTrack`,
`Llm2dBone`을 씁니다. [`docs/stake.md`](docs/stake.md)를 보세요.

## 지금 지원하지 않는 것

- **그리기 순서 애니메이션:** 슬롯의 앞뒤 순서는 고정입니다. 팔이 몸 앞뒤를 오가야 하면 교체 그림이나
  레이어 순서로 해결해야 합니다.
- **메시 변형 키(FFD), 패스·변환 제약:** 휘는 것은 뼈와 가중치로만 합니다. 제약은 IK만 있습니다.
  (클리핑은 지원합니다: 반짝임을 심볼 모양으로 자르는 `clipping` 첨부물.)
- **스킨:** 같은 뼈대에 다른 그림 세트를 끼우는 기능이 없어서, 심볼마다 프로젝트를 따로 만듭니다
  (모션 프리셋으로 같은 동작을 빠르게 다시 만들 수 있습니다).
- **편집기에서 리깅 수정:** 편집기는 애니메이션만 다룹니다. 뼈 위치·가중치는 `rig.json`(또는 MCP
  `set_rig_spec`)으로 고칩니다.
- **그림 한 장 분리의 한계:** 외곽선이 뚜렷한 만화풍에 가장 잘 맞고, 가려진 곳은 주변 색으로 추측합니다
  ([`docs/split.md`](docs/split.md#한계와-요령)).

## 설계 메모

- **자체 포맷인 이유:** Spine 런타임은 Spine 에디터 라이선스가 있어야 씁니다. 자체 포맷과
  런타임이면 게임마다, 해마다 내는 비용이 없습니다.
- **LLM 친화적 포맷:** 각도는 도, 그림 위치는 캔버스 좌표 그대로, 애니메이션 값은 셋업 포즈
  기준 상대값, 커브는 `easeOutBack` 같은 이름. 검증기는 `animations.win.bones.gem.rotate[2].time`
  처럼 정확한 위치와 고칠 방법을 알려 줍니다.
- **Spine과 같은 API:** `state.setAnimation / addAnimation / setEmptyAnimation`, 트랙 엔트리의
  `loop`, `timeScale`, `listener`가 spine-ts와 같아서 Stake 예제 코드를 옮기기 쉽습니다.
