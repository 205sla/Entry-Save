# Entry pageType 핸드셰이크 설계

`/ws/`(만들기)와 `/project/`(작품보기)가 별도 namespace(storage key)를 써야 합니다. 현재 실사이트 기준으로 `/ws/`는 top frame에 런타임이 직접 있고, `/project/`는 자식 `/iframe/<id>` 프레임에 런타임이 있습니다. 자식 frame의 `location.pathname`은 `/iframe/<id>`라서 부모가 project인지, 혹은 향후 다른 top pageType인지 직접 알 수 없습니다.

이 문서는 자식 frame이 부모로부터 pageType을 안전하게 받는 메커니즘을 설명합니다.

범위: Entry 만들기/실행 화면에 주입되는 Chrome 확장 유형 공통. 메시지 타입과 코드 위치는 Entry Save Manager 구현 사례입니다.

---

## 문제 정의

### Frame 구조

```
[Top frame: https://playentry.org/project/<id>]
├── content.js (Isolated world) — 매니페스트 + Isolated 주입
├── inject.js (MAIN world) — 매니페스트 + MAIN 주입 (firing 불안정)
└── <iframe src="https://playentry.org/iframe/<id>?s=...">
    └── [Child frame: https://playentry.org/iframe/<id>]
        ├── content.js (Isolated world) — 매니페스트 (`all_frames: true`)
        ├── inject.js (MAIN world) — 매니페스트 + fallback 주입
        └── window.Entry — 작품 runtime 실체가 여기 있음
```

> ⚠️ **정정(2026-06-11 실사이트 검증)**: `/ws/<id>`(만들기)는 현재 **top 프레임에 `window.Entry`가 직접 있고 자식 iframe이 없다**. iframe 핸드셰이크가 필요한 건 **`/project/<id>`(작품보기)뿐**(런타임이 자식 `/iframe/<id>`에 호스팅). `/noframe/<id>`도 top 프레임 런타임. 컨텍스트별 토폴로지 전체는 ENTRY 워크스페이스 루트의 `_docs/entry-runtime-access.md` 참고.

### 자식에서 부모를 알 수 없는 이유

- `window.top.location.pathname` — origin이 다르면 SecurityError
- `document.referrer` — referrer-policy로 빈 문자열일 수 있음
- 자기 pathname (`/iframe/<id>`)만으로는 부모가 ws인지 project인지 노프

### 그래서 필요한 것

자식 `/iframe/`의 inject.js가 storage key를 결정할 때 **부모의 pageType**을 알아야 함. same-origin 여부나 referrer 정책에 기대지 않는 통신 수단 필요 → **`postMessage`**.

---

## 핸드셰이크 프로토콜

### 메시지 타입

```js
// 자식 → 부모: "당신 누구세요?"
{ type: 'ENTRY_SAVE_MANAGER', action: 'REQUEST_PAGE_TYPE' }

// 부모 → 자식: "나는 ws (또는 project)야"
{ type: 'ENTRY_SAVE_MANAGER', action: 'PAGE_TYPE', pageType: 'ws' | 'project' }
```

### 흐름

```
[자식 inject.js IIFE 시작]
    │
    │ pageType = ESM.getPageTypeFromPathname('/iframe/<id>')  → null
    │ resolved = false
    │
    ├─ if (!resolved && parent !== window):
    │      │ requestPageTypeFromParent()  →  parent.postMessage(REQUEST_PAGE_TYPE)
    │      │
    │      │ 핸드셰이크 타이머 시작 (500ms 간격, 최대 20회 = 10초)
    │      │ 매번 requestPageTypeFromParent() 재시도
    │      ↓
    │
    │
[부모 content.js (top frame)]
    │
    │ message 리스너:
    │   if (REQUEST_PAGE_TYPE):
    │     pt = getCurrentTopPageType()  // 자기 pathname에서 결정
    │     event.source.postMessage(PAGE_TYPE, pt)
    │
    ↓ ↑ postMessage
    │
[자식 inject.js]
    │
    │ message 리스너:
    │   if (PAGE_TYPE && source === parent):
    │     ptState.type = data.pageType
    │     ptState.resolved = true
    │     → 다음 핸드셰이크 tick에서 타이머 정리
```

### 타이밍 보장

- 자동 로드는 엔진 `stop → run` 전이 시 발생 — 페이지 로드 후 수 초 이상 걸림
- 핸드셰이크는 500ms 간격, 보통 1~2번 안에 응답 받음
- 타임아웃(10초) 후엔 `'project'` 폴백 (대다수 시나리오)

따라서 storage key 결정 시점에 거의 항상 `ptState.resolved === true`.

---

## 코드 위치

### 자식 측 (inject.js)

Entry Save Manager 구현 사례: [inject.js](../../ES/inject.js)
```js
const ptState = {
  type: ESM.getPageTypeFromPathname(location.pathname),  // /iframe/이면 null
  resolved: false,
  handshakeTimer: null,
};
ptState.resolved = ptState.type !== null;

function requestPageTypeFromParent() {
  if (window.parent === window) return;  // top frame이면 스킵
  window.parent.postMessage({ type: 'ENTRY_SAVE_MANAGER', action: 'REQUEST_PAGE_TYPE' }, '*');
}

if (!ptState.resolved && window.parent !== window) {
  requestPageTypeFromParent();
  let attempts = 0;
  ptState.handshakeTimer = setInterval(() => {
    if (ptState.resolved || attempts >= 20) {
      clearInterval(ptState.handshakeTimer);
      ptState.handshakeTimer = null;
      return;
    }
    attempts++;
    requestPageTypeFromParent();
  }, 500);
}
```

PAGE_TYPE 응답 수신:
```js
window.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || data.type !== 'ENTRY_SAVE_MANAGER') return;

  if (data.action === 'PAGE_TYPE') {
    if (event.source !== window.parent) return;  // 부모 외 source 거부
    const pt = data.pageType;
    if (pt === 'ws' || pt === 'project') {
      ptState.type = pt;
      ptState.resolved = true;
    }
    return;
  }
  // ... URL_CHANGED 등 다른 message
});
```

### 부모 측 (content.js)

Entry Save Manager 구현 사례: [content.js](../../ES/content.js)
```js
const isTopFrame = (window.top === window);

function getCurrentTopPageType() {
  return ESM.getPageTypeFromPathname(location.pathname);  // 'ws' | 'project' | null
}

if (isTopFrame) {
  window.addEventListener('message', function (event) {
    if (event.source === window) return;  // 자기 자신 무시
    const data = event.data;
    if (!data || data.type !== 'ENTRY_SAVE_MANAGER') return;
    if (data.action !== 'REQUEST_PAGE_TYPE') return;
    const pt = getCurrentTopPageType();
    if (!pt) return;
    event.source.postMessage({
      type: 'ENTRY_SAVE_MANAGER',
      action: 'PAGE_TYPE',
      pageType: pt,
    }, '*');
  });

  // 초기에도 한번 broadcast (iframe이 늦게 로드되는 경우 대비)
  setTimeout(broadcastPageTypeToChildren, 1500);
  setTimeout(broadcastPageTypeToChildren, 3000);
}
```

### 능동 broadcast (URL 변경 시)

SPA 라우팅으로 top frame의 pageType이 바뀌거나 새 `/project/` 자식 iframe이 늦게 붙으면, 자식 iframe이 자동으로 재요청하지 못할 수 있다. 그래서 부모가 능동적으로 현재 pageType을 broadcast:

Entry Save Manager 구현 사례: [content.js](../../ES/content.js)
```js
function broadcastPageTypeToChildren() {
  if (!isTopFrame) return;
  const pt = getCurrentTopPageType();
  if (!pt) return;
  for (let i = 0; i < window.frames.length; i++) {
    try {
      window.frames[i].postMessage({
        type: 'ENTRY_SAVE_MANAGER',
        action: 'PAGE_TYPE',
        pageType: pt,
      }, '*');
    } catch (_) { /* cross-origin 실패는 무시 */ }
  }
}

// URL 변경 감지 시 호출
observer.observe(...).onChange = function () {
  ...
  broadcastPageTypeToChildren();
};
```

---

## 보안 / 견고성 검증

### 1. 자기 자신의 메시지 무시

content.js의 응답기는 `event.source === window`이면 reject. (자기 frame 내부에서 보낸 메시지로 응답하지 않음)

inject.js의 PAGE_TYPE 수신은 `event.source === window.parent`이면 accept. (다른 frame이나 외부에서 위조된 메시지 거부)

### 2. type/action 검증

모든 메시지는 `type === 'ENTRY_SAVE_MANAGER'` AND 명시적 `action` 체크 후 처리. 무관한 postMessage 무시.

### 3. pageType 값 검증

```js
if (pt === 'ws' || pt === 'project') {
  ptState.type = pt;
  ptState.resolved = true;
}
```

`'admin'`, `'evil'` 등 임의 값 주입 거부.

### 4. 위조 가능성

postMessage는 동일 origin이면 누구나 보낼 수 있음. 자식 frame의 자식이 부모 frame인 척 메시지 보낼 수 있음. 그러나 우리는 `event.source === window.parent`만 허용 — 자식의 자식은 우리 자식 frame의 parent가 아니라 자식 frame 자체이므로 통과 못 함.

### 5. cross-origin frame과의 안전

postMessage는 origin과 무관하게 동작. `targetOrigin: '*'`을 사용하므로 자식 origin이 무엇이든 송수신 가능. (악의적 origin이 끼어들 수 있는 경로가 있으면 위험하지만, 우리는 frames 인덱스나 window.parent만 사용하므로 OK)

---

## 폴백 정책

### 응답이 안 올 때

- 10초 타임아웃 후 자동으로 `'project'`로 폴백 (대다수 사용자 시나리오에 부합)
- ws/project 외 page (예: `/community/`)에서는 부모의 `getCurrentTopPageType()`이 null → 응답 안 함 → 자식은 폴백

### 부모가 없을 때 (top frame이 /iframe/)

- 사용자가 `https://playentry.org/iframe/<id>` 직접 접근하는 드문 경우
- `window.parent === window` → 핸드셰이크 안 함, 즉시 폴백

---

## 흔한 실수 방지

### 실수 1: SPA 라우팅 시 자식 iframe pageType 캐시 갱신 안 됨

상황: SPA 라우팅 뒤 새 `/project/` 자식 iframe이 붙었거나 기존 자식 iframe의 pageType 캐시가 낡았는데, 자식 inject.js의 `ptState.type`이 갱신되지 않음.

해결: content.js의 URL 변경 감지에서 `broadcastPageTypeToChildren()` 호출 → 자식이 PAGE_TYPE 수신 → 갱신.

### 실수 2: top frame에 응답기를 등록 안 함

상황: top frame이 자식의 REQUEST_PAGE_TYPE을 받아도 응답 안 함 → 자식 핸드셰이크 영원히 타임아웃.

해결: top frame의 content.js에 `if (isTopFrame) { window.addEventListener('message', ...) }`. 이 프로젝트는 처리됨.

### 실수 3: 자식이 부모 외 source의 PAGE_TYPE을 신뢰

상황: 페이지 안의 다른 스크립트가 PAGE_TYPE 메시지를 위조 → 자식이 받아들여 잘못된 namespace 사용.

해결: `event.source === window.parent` 체크. 처리됨.

### 실수 4: pageType 값 검증 없이 적용

상황: 메시지에 `pageType: 'admin'` 같은 임의 값 → ESM.buildStorageKey가 처리 못 해 잘못된 키 생성.

해결: `pt === 'ws' || pt === 'project'` 가드. 처리됨.

---

## 향후 확장

새 페이지 타입 추가 (예: `/embed/<id>`):
1. shared.js의 `getPageTypeFromPathname`에 매핑 추가
2. 검증 가드 (`pt === 'ws' || pt === 'project' || pt === 'embed'`) 갱신
3. `buildStorageKey`에 매핑 추가 (어떤 키로 갈지)
4. content.js의 SPA URL 감지 패턴 추가
5. inject.js의 `isProjectPage` 등 페이지 종류 판별에 추가

[Entry Save 문제 해결 기록](../01-문제-해결-기록.md#v132)에 `/noframe/` 추가 시 정확히 이 절차 따름.
