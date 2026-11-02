# LLM2D 파일 포맷 v0.1 (`*.l2d.json`)

LLM2D 스켈레톤 하나는 JSON 파일 하나와 그 파일이 가리키는 이미지들로 이뤄집니다.
사람도 LLM도 읽고 고치기 쉽도록 설계했습니다.

- 타입 정의: [`packages/core/src/format.ts`](../packages/core/src/format.ts)
- 검증기: [`packages/core/src/validate.ts`](../packages/core/src/validate.ts) (`pnpm validate <file>`)
- 예제: [`samples/bolt/bolt.l2d.json`](../samples/bolt/bolt.l2d.json), [`samples/gem/gem.l2d.json`](../samples/gem/gem.l2d.json)

## 좌표와 단위 규칙

| 항목 | 규칙 |
|---|---|
| 좌표계 | x는 오른쪽, **y는 아래쪽** (PixiJS와 같음) |
| 원점 | 스켈레톤 원점. 캐릭터는 보통 발 사이 바닥, 심볼은 중심 |
| 각도 | **도(degree)**. 양수는 화면에서 시계 방향 |
| 뼈 변환 | 부모 뼈 기준 로컬 값 |
| 그림 배치 | 셋업 포즈 기준 **스켈레톤 공간 좌표**. 레이어 그림을 캔버스에 놓인 위치 그대로 쓸 수 있음 |
| 애니메이션 값 | 셋업 포즈 기준 **상대값**. 회전·이동은 더하고, 크기는 곱함 |
| 색 | `RRGGBB` 또는 `RRGGBBAA` 16진수 |
| 시간 | 초 |

그림을 뼈 기준이 아니라 스켈레톤 공간에 두는 이유: PSD 레이어나 AI가 만든 부위 이미지는
원래 캔버스 좌표를 갖고 있으므로 변환 없이 바로 쓸 수 있고, 뼈 위치를 고쳐도 그림이 따라
움직이지 않습니다. 런타임이 셋업 포즈의 역행렬(inverse bind)로 자동 결합합니다.

## 최상위 구조

```jsonc
{
  "format": "llm2d",          // 고정
  "version": "0.1",           // 고정
  "name": "bolt",
  "meta": { },                // 선택. 자유 형식 메모
  "bounds": { "x": -100, "y": -100, "width": 200, "height": 200 }, // 선택. 없으면 셋업 포즈로 계산
  "images": { },
  "bones": [ ],
  "slots": [ ],
  "attachments": { },
  "ik": [ ],                  // 선택
  "animations": { }
}
```

## images

```json
"images": {
  "head": { "path": "images/head.png", "width": 224, "height": 156 }
}
```

`width`/`height`는 스켈레톤 단위의 논리 크기입니다. PNG 해상도는 달라도 됩니다
(예: 2배 해상도 PNG). 경로는 `.l2d.json` 파일 기준 상대 경로입니다.

텍스처 아틀라스를 쓰면 여러 이미지가 PNG 한 장(페이지)을 함께 쓰고, `frame`으로 그 안의
영역(PNG 픽셀)을 가리킵니다. `pnpm export`가 아틀라스를 만들 때 자동으로 채웁니다.

```json
"head": { "path": "kit.png", "width": 253, "height": 189, "frame": { "x": 2, "y": 2, "width": 506, "height": 378 } }
```

## bones

```json
"bones": [
  { "name": "root" },
  { "name": "hip", "parent": "root", "x": 0, "y": -170, "rotation": -90, "length": 20 },
  { "name": "torso", "parent": "hip", "x": 18, "y": 0, "length": 150 }
]
```

| 필드 | 기본값 | 설명 |
|---|---|---|
| `name` | (필수) | 고유 이름 |
| `parent` | | 첫 번째 뼈(루트)만 생략. 부모는 반드시 먼저 나와야 함 |
| `x`, `y` | 0 | 부모 기준 위치 |
| `rotation` | 0 | 부모 기준 회전(도) |
| `scaleX`, `scaleY` | 1 | 크기 |
| `length` | 0 | 뼈의 로컬 +x 방향 길이. IK와 디버그 표시에 사용 |

## slots

그리는 순서대로(뒤에서 앞으로) 나열합니다. 슬롯은 뼈 하나에 붙고, 한 번에 첨부물 하나를
보여 줍니다.

```json
{ "name": "chest_light", "bone": "torso", "attachment": "chest_light", "color": "ffffff59", "blend": "add" }
```

| 필드 | 기본값 | 설명 |
|---|---|---|
| `bone` | (필수) | 따라갈 뼈 |
| `attachment` | 없음 | 셋업 포즈에서 보일 첨부물 이름. `null`이면 숨김 |
| `color` | `ffffffff` | 색조와 투명도 |
| `blend` | `normal` | `normal`, `add`, `multiply`, `screen` |

## attachments

`attachments[슬롯 이름][첨부물 이름]` 구조입니다. 같은 슬롯에 여러 첨부물을 두고
애니메이션으로 바꿀 수 있습니다(예: 표정 `face_idle` / `face_blink` / `face_happy`).

### region: 사각형 그림

```json
{ "type": "region", "image": "torso", "x": 0, "y": -264 }
```

`x`, `y`는 그림 **중심**의 스켈레톤 좌표입니다. 선택 필드로 `rotation`, `scaleX`, `scaleY`
(음수면 좌우 반전), `width`, `height`(기본은 이미지 논리 크기)가 있습니다. 슬롯의 뼈를
그대로 따라갑니다.

### mesh: 변형되는 그림

```jsonc
{
  "type": "mesh",
  "image": "antenna_stalk",
  "vertices": [-7, -592, -7, -580, ...],  // 스켈레톤 좌표 [x, y, ...]
  "uvs": [0, 0, 0, 0.125, ...],           // 이미지 안 위치 0..1
  "triangles": [0, 1, 17, ...],           // 정점 인덱스, 3개씩 삼각형 하나
  "hull": 18,                             // 선택. 외곽선을 이루는 앞쪽 정점 수
  "bones": ["antenna1", "antenna2", "antenna3"],
  "weights": [[0, 1], [0, 0.7, 1, 0.3], ...]
}
```

- `bones`, `weights`가 없으면 메시 전체가 슬롯의 뼈를 따라갑니다.
- `weights`는 정점마다 `[bones 인덱스, 가중치, ...]` 쌍입니다. 합은 1이어야 하며,
  아니면 자동으로 정규화하고 경고를 냅니다. 정점당 뼈는 4개까지 권장합니다.
  모든 가중치가 0인 정점은 `bones`를 똑같이 나눠 따라갑니다.

### clipping: 잘라 내는 다각형

```jsonc
{
  "type": "clipping",
  "vertices": [-11, -222, 13, -222, 32, -220, ...],  // 다각형, 스켈레톤 좌표 [x, y, ...] (3점 이상)
  "end": "shine"                                     // 선택. 여기까지 자름(포함). 기본: 마지막 슬롯
}
```

이 첨부물이 든 슬롯 **다음** 슬롯부터 `end` 슬롯까지는 다각형 안쪽만 그려집니다(Spine의 클리핑과
같음). 심볼 위를 지나가는 반짝임을 심볼 모양으로 자를 때 씁니다. 자기 자신은 아무것도 그리지 않고,
경계 상자(`bounds`)에도 들어가지 않습니다.

- 슬롯의 뼈를 따라가며, 메시처럼 `bones`, `weights`를 줄 수 있습니다.
- 슬롯의 첨부물을 숨기거나 다른 것으로 바꾸면 그동안은 자르지 않습니다.
- 한 슬롯의 클리핑 첨부물은 모두 같은 `end`를 가져야 하고, 자르는 범위끼리 겹치면 안 됩니다.
- 자동 리깅에서는 `rig.json`의 `parts.<레이어>.clip`으로 만듭니다([리깅](rigging.md)).

## ik

```json
"ik": [
  { "name": "leg_l", "bones": ["thigh_l", "shin_l"], "target": "foot_l_ik", "bendPositive": false }
]
```

- 뼈 1개: 그 뼈가 타깃을 바라봅니다(조준).
- 뼈 2개 `[부모, 자식]`: 자식 뼈 끝이 타깃에 닿도록 두 뼈를 꺾습니다(팔다리).
  자식은 부모의 직계 자식이어야 합니다.
- `bendPositive`: `true`면 자식이 부모 기준 시계 방향으로 꺾입니다. 기본값 `true`.
- `mix`: 0..1, 기본 1. 애니메이션으로 바꿀 수 있습니다.
- 타깃 뼈는 체인 안에 있으면 안 됩니다. 보통 루트 밑에 둡니다. 발 그림을 타깃 뼈에
  붙이면 발이 바닥에 고정됩니다.
- 부모 뼈의 크기는 균일하다고 가정합니다.

## animations

```jsonc
"animations": {
  "win": {
    "duration": 1.2,  // 선택. 기본은 마지막 키 시간
    "bones": {
      "gem": {
        "rotate":    [{ "time": 0, "value": 0, "curve": "easeInOutSine" }, { "time": 0.2, "value": -7 }],
        "translate": [{ "time": 0, "x": 0, "y": -36, "curve": "easeInQuad" }, { "time": 0.12, "y": 0 }],
        "scale":     [{ "time": 0, "x": 1, "y": 1, "curve": "easeOutBack" }, { "time": 0.25, "x": 1.2, "y": 1.2 }]
      }
    },
    "slots": {
      "glow": {
        "color": [{ "time": 0, "value": "ffffff00" }, { "time": 0.3, "value": "ffd0e0ff" }],
        "alpha": [{ "time": 0, "value": 0 }, { "time": 0.3, "value": 0.95 }],
        "attachment": [{ "time": 0, "name": "glow" }, { "time": 1, "name": null }]
      }
    },
    "ik": { "leg_l": { "mix": [{ "time": 0, "value": 1 }] } },
    "events": [{ "time": 0.92, "name": "land", "volume": 0.8 }]
  }
}
```

### 타임라인 종류

| 대상 | 타임라인 | 키 값 | 적용 방식 |
|---|---|---|---|
| 뼈 | `rotate` | `value` (도) | 셋업 회전에 **더함** |
| 뼈 | `translate` | `x`, `y` (없으면 0) | 셋업 위치에 **더함** |
| 뼈 | `scale` | `x`, `y` (없으면 1) | 셋업 크기에 **곱함** |
| 슬롯 | `color` | `value` (`RRGGBB[AA]`) | 절대값 |
| 슬롯 | `alpha` | `value` (0..1) | 절대값, color 다음에 적용 |
| 슬롯 | `attachment` | `name` (`null`이면 숨김) | 단계 변화 |
| IK | `mix` | `value` (0..1) | 절대값 |

- 키는 시간 순서로 정렬돼 있어야 합니다.
- 첫 키 이전에는 첫 키 값, 마지막 키 이후에는 마지막 키 값을 유지합니다.
- 회전 키 사이 보간은 값 그대로입니다. 0 → 360이면 한 바퀴 돕니다.
- 이벤트의 `time`, `name` 외 필드는 그대로 전달됩니다(효과음, 파티클 연동용).

### 커브

키의 `curve`는 **그 키에서 다음 키까지**의 움직임을 정합니다.

- `"linear"` (기본), `"stepped"` (다음 키까지 값 유지)
- [easings.net](https://easings.net) 이름: `easeInSine`, `easeOutSine`, `easeInOutSine`,
  `Quad`, `Cubic`, `Quart`, `Quint`, `Expo`, `Circ`, `Back`, `Elastic`, `Bounce` 계열
  (예: `easeOutBack`, `easeInOutCubic`, `easeOutElastic`)
- CSS와 같은 베지어 `[x1, y1, x2, y2]`

## 런타임 재생 규칙

- 매 프레임 셋업 포즈에서 시작해 트랙 0, 1, 2… 순서로 덮어씁니다. 위 트랙은 자기가 키를
  가진 값만 바꿉니다(예: 트랙 0 `idle` 위에 트랙 1 `blink`).
- 같은 트랙에서 애니메이션을 바꾸면 `defaultMix`(기본 0.15초) 또는 `setMix(from, to, 초)`
  동안 섞어서 넘어갑니다. 새 애니메이션이 키를 갖지 않은 값은 아래 트랙의 포즈로 돌아갑니다.
- `complete`는 반복 애니메이션이면 매 반복마다 발생합니다.
