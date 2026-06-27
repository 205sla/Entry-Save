# MV3 content_scripts 함정 정리

이 문서는 Manifest V3의 content_scripts (특히 `world: "MAIN"`) 사용 시 실제로 부딪힌 함정들과 우회법을 기록합니다. Chrome 공식 문서엔 잘 안 나오는 내용 중심.

범위: Entry 만들기/실행 화면에 주입되는 Chrome 확장 유형 공통. 원칙은 공통이지만, Entry Save Manager는 v1.3.6 롤백 이후 현재 공개 구현에서 `var ESM`을 유지한다. `window.ESM`/`globalThis.ESM` 전환은 테스트와 실사이트 검증을 갖춘 별도 변경으로만 다룬다.

---

## 함정 #1: MAIN world wrapper와 `var` 글로벌 (v1.3.5에서 발견)

### 증상

manifest의 같은 entry에 `js: ["shared.js", "inject.js"]`로 두 파일을 두고 MAIN world에 주입했는데, inject.js가 shared.js의 `var ESM`에 접근 못 함:

```
inject.js:75 Uncaught ReferenceError: ESM is not defined
```

### 원인

**MV3의 `world: "MAIN"` content_scripts는 각 파일을 별도의 wrapper(IIFE-like 격리 함수) 안에서 실행**합니다. 그래서:

```js
// shared.js (MAIN world 두 번째 entry의 첫 번째 파일)
var ESM = { ... };  // ← 이 wrapper의 지역 변수가 됨, window.ESM이 안 됨
```

```js
// inject.js (MAIN world 두 번째 entry의 두 번째 파일)
ESM.foo();  // ← ReferenceError — 다른 wrapper의 지역 변수에 못 접근
```

이건 페이지 자체의 일반 `<script>` 태그와는 다른 동작입니다. 일반 `<script>`에서 `var X = 1`은 window.X가 되지만, MAIN world content_script에서는 안 됨.

### 우회법

**명시적으로 window에 attach**:

```js
// shared.js
window.ESM = { ... };
```

또는 `globalThis.ESM = {...}` (워커 등 다른 컨텍스트에서도 동작).

### 검증된 동작

`window.ESM = {...}` 패턴은 다음 4가지 컨텍스트 모두에서 일관 동작:
1. MAIN world content_script (manifest로 주입) — wrapper 격리에도 window는 페이지 window
2. Isolated world content_script — isolated window지만 같은 sandbox 내에서 공유
3. Fallback `<script src="...">` 동적 주입 — 페이지 global이라 자동 동작
4. Popup HTML의 `<script>` 태그 — popup 자신의 window

### 절대 하지 말 것

- `var ESM = ...` 또는 `let ESM = ...` 형태의 top-level 선언으로 다른 MAIN world 파일이 접근하길 기대
- shared.js를 다른 MAIN world 파일과 묶지 말고 매번 fresh window 검사

### 권장 코드 예시

```js
globalThis.ESM = {
  STORAGE_KEY_PREFIX: 'entry_save_',
  ...
};
```

`inject.js`/`content.js`는 그냥 `ESM.foo()` 호출 (`window.ESM`을 안 써도 됨 — JS의 globalThis lookup chain이 처리).

> Entry Save Manager 1.3.8의 실제 [shared.js](../../ES/shared.js)는 역사적 롤백 맥락 때문에 아직 `var ESM = {...}`를 유지한다. 이 문서의 권장 예시는 새 설계나 별도 검증을 거친 전환 기준으로만 사용한다.

---

## 함정 #2: MAIN world content_script가 사이트 환경에 따라 firing 안 함

### 증상

manifest에 `world: "MAIN"`로 두었는데 페이지에 따라 그 entry가 아예 실행 안 됨. 콘솔에 어떤 로그도 안 뜨고 inject.js의 IIFE도 안 보임.

### 원인 (추정)

playentry.org 같은 일부 사이트의 보안 설정/Chrome 동작/Chrome 버전에 따라 MAIN world 주입이 막히거나 지연되는 듯. 공식 문서엔 안 나옴. 해당 프로젝트에서는 시기에 따라 다음 셋 중 하나로 동작:
1. **정상 firing** — manifest의 `[shared.js, inject.js]` 순서대로 실행
2. **Firing 안 함** — content.js의 fallback 경로만 동작
3. **부분 firing** — inject.js만 실행되거나 wrapper에 격리

### 우회법: fallback 주입기 (content.js)

MV3 Isolated world content_script는 안정적으로 firing하므로, 거기에 fallback 로직을 두어 page에 직접 `<script>` 태그를 삽입:

```js
// content.js (Isolated world)
function injectOneScript(filename, onLoad) {
  const script = document.createElement('script');
  script.src = chrome.runtime.getURL(filename);
  script.onload = function () { onLoad(); script.remove(); };
  (document.head || document.documentElement).appendChild(script);
}

function injectScriptFallback() {
  injectOneScript('shared.js', function () {
    injectOneScript('inject.js', function () { /* done */ });
  });
}
setTimeout(injectScriptFallback, 1000);
```

핵심:
- **반드시 의존성을 onload 체인으로 직렬 주입** (병렬 주입하면 inject.js가 ESM 보기 전에 실행될 수 있음)
- `chrome.runtime.getURL(filename)`은 `web_accessible_resources`에 등록된 파일만 가능 → manifest에서 `shared.js`, `inject.js` 모두 등록 필요

### 중복 실행 방지

manifest 경로와 fallback 경로 둘 다 firing해서 IIFE가 두 번 실행되는 경우 대비:

```js
// inject.js
if (window.__entrySaveManagerLoaded) return;
window.__entrySaveManagerLoaded = true;
```

URL 변경 시 재주입이 필요할 때는 이 플래그를 reset.

---

## 함정 #3: Page CSP가 `chrome-extension://` script-src를 차단

### 증상

`script.src = chrome.runtime.getURL('inject.js')`로 동적 주입했는데 page CSP의 `script-src` 정책에 의해 거부될 수 있음. 콘솔에 `Refused to load the script ...` 같은 에러.

### 우회법

이 프로젝트에서는 발생 안 했지만, 발생 시 옵션:
1. `chrome.scripting.executeScript`를 background/popup에서 호출 (chrome-extension 권한이 우선)
2. 코드를 inline으로 끌어들여 `script.textContent`로 주입 — CSP가 inline-eval을 막으면 이것도 실패
3. (마지막 수단) Manifest의 `world: "MAIN"`만 신뢰하고 fallback 포기

---

## 함정 #4: Isolated world와 MAIN world의 변수는 진짜 다름

### 증상

content.js에서 `window.ESM = {...}`했는데 inject.js에서 ESM이 다른 객체이거나 undefined.

### 원인

Isolated world와 MAIN world는 **다른 sandbox**입니다. 각각 자기 window를 가짐. 같은 origin이지만 변수가 공유되지 않음.

### 우회법

shared.js를 양 world에 별도로 로드 — manifest의 두 content_scripts entry 각각에 `shared.js` 포함:

```json
"content_scripts": [
  {
    "js": ["shared.js", "content.js"],   // Isolated world
    ...
  },
  {
    "js": ["shared.js", "inject.js"],    // MAIN world
    "world": "MAIN",
    ...
  }
]
```

각 world가 자기 ESM 인스턴스를 가짐. shared.js가 stateless면(상수+순수 함수) 차이 없음.

### 함정 안의 함정

shared.js에 mutable state를 두면 두 world가 동기화 안 됨. **shared.js는 항상 stateless로 유지**.

---

## 함정 #5: SPA 라우팅에서 content_script 재주입은 자동으로 안 됨

### 증상

playentry.org는 SPA — URL이 `/ws/A` → `/project/A`로 바뀌어도 페이지 전체 리로드 안 됨. content_script는 처음 로드된 그대로 살아있음. inject.js의 후킹은 첫 작품에 묶여 있어 새 작품에 안 적용됨.

### 우회법

`MutationObserver`로 URL 변경 감지 → inject.js의 IIFE 플래그 리셋하고 재주입:

```js
// content.js
let lastUrl = location.href;
const observer = new MutationObserver(function () {
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    if (lastUrl.includes('/project/') || lastUrl.includes('/ws/') || lastUrl.includes('/noframe/')) {
      setTimeout(function () {
        window.postMessage({ type: 'ENTRY_SAVE_MANAGER', action: 'URL_CHANGED' }, '*');
        injectScriptFallback();
      }, URL_CHANGE_DELAY);
    }
  }
});
observer.observe(document.body || document.documentElement, { childList: true, subtree: true });
```

`URL_CHANGED` 메시지는 inject.js의 listener가 받아 후킹 정리 + `__entrySaveManagerLoaded = false`. 그 다음 재주입된 새 IIFE가 fresh init.

---

## 함정 #6: `iframe` 자식 frame은 부모 origin이 달라 parent.location 못 읽음

### 증상

자식 `/iframe/<id>` 프레임에서 `window.parent.location.pathname`을 읽으려 하면 `Uncaught DOMException: Blocked a frame with origin ...`.

### 원인

엔트리는 작품 runtime을 별도 origin(추정: 다른 subdomain)의 iframe에 호스팅. Same-origin policy로 parent.location 접근 불가.

### 우회법: postMessage 핸드셰이크

자식이 부모에게 요청, 부모가 응답:

```js
// 자식 (inject.js)
window.parent.postMessage({ type: 'ENTRY_SAVE_MANAGER', action: 'REQUEST_PAGE_TYPE' }, '*');

// 부모 (content.js)
window.addEventListener('message', (event) => {
  if (event.data?.action !== 'REQUEST_PAGE_TYPE') return;
  event.source.postMessage({
    type: 'ENTRY_SAVE_MANAGER',
    action: 'PAGE_TYPE',
    pageType: ESM.getPageTypeFromPathname(location.pathname)
  }, '*');
});

// 자식 (inject.js)
window.addEventListener('message', (event) => {
  if (event.source !== window.parent) return;
  if (event.data?.action !== 'PAGE_TYPE') return;
  // event.data.pageType 사용
});
```

자세한 설계는 [Entry pageType 핸드셰이크 설계](entry-page-type-handshake.md).

---

## 함정 #7: `web_accessible_resources` 등록 누락

### 증상

`chrome.runtime.getURL('shared.js')`로 동적 주입을 시도했는데 fetch가 실패하거나 `<script>` onerror.

### 원인

MV3에서는 chrome-extension URL로 페이지가 fetch하려면 `web_accessible_resources`에 등록되어야 함.

### 우회법

manifest:
```json
"web_accessible_resources": [
  {
    "resources": ["shared.js", "inject.js"],
    "matches": ["https://playentry.org/*", "https://*.playentry.org/*"]
  }
]
```

`matches`도 정확히 — `<all_urls>`는 보안상 비추, 사용 origin만 명시.

---

## 함정 #8: `activeTab` 권한은 사용자 gesture 후에만 grant

### 증상

popup의 `chrome.scripting.executeScript`가 가끔 권한 에러.

### 원인 (그리고 의도)

`activeTab`은 사용자가 확장 아이콘을 클릭한 직후에만 권한이 부여됨. 백그라운드에서 임의 탭에 접근하려는 시도는 차단. 이건 보안 기능이지 버그가 아님.

### 우회법

이 프로젝트에서는 popup이 열렸을 때만 executeScript 호출하므로 문제 없음. 만약 백그라운드에서 임의 탭에 접근해야 하면 `host_permissions`로 격상 — 단 스토어 심사 시 정당화 어려움.

---

## 정리 — 안전한 MV3 패턴

1. **공유 모듈은 `window.X = ...`로 명시 글로벌**
2. **각 world에 독립적으로 shared.js 주입** (manifest의 두 entry)
3. **fallback 주입기 보유** — manifest MAIN world가 firing 안 할 때 대비
4. **Fallback은 의존성 직렬 주입** (shared.js → 후속 파일)
5. **중복 실행 방지 플래그** (`window.__xxxLoaded`)
6. **SPA 라우팅 = MutationObserver**
7. **iframe ↔ parent 통신 = postMessage** (cross-origin 안전)
8. **shared.js는 stateless** (각 world의 인스턴스가 독립이므로)
9. **`web_accessible_resources`에 모든 동적 주입 파일 등록**
10. **`activeTab`/`scripting`만 사용해 권한 최소화**

---

## 참고 자료

- [Chrome MV3 content_scripts 공식 문서](https://developer.chrome.com/docs/extensions/reference/api/scripting)
- [world: "MAIN" 도입 안내](https://developer.chrome.com/docs/extensions/reference/api/scripting#type-ExecutionWorld)
- 본 프로젝트 관련 chromium 이슈들: 검색 키워드 "chrome content_script world MAIN var global wrapper"
