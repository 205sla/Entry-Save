# Chrome Web Store Submission — Entry Save Manager

> Each section has a 1,000-character limit. English text is the value to paste into the submission form; Korean is for internal reference.

---

## 1. Single Purpose Description (전용 목적 설명)

### English

Entry Save Manager has one single purpose: enable creators on playentry.org (Entry) to persist and restore their project's user-defined variable and list values in the browser's localStorage, so interactive Entry works can implement save/load mechanics (e.g., game progress, inventory).

The extension only persists variables and lists whose names begin with the "@" prefix, excluding the reserved status variable "@확장프로그램". It hooks at most three user-defined identifiers inside an Entry project: the function "@저장" (save trigger), the function "@가져오기" (cross-project import trigger), and the variable "@확장프로그램" (installation status flag, set to 1 at runtime but not saved or imported). It performs no other functionality, no analytics, no tracking, and no remote network requests. All saved data stays in the user's browser localStorage and is never transmitted off-device.

### 한국어

Entry Save Manager의 단일 목적: playentry.org(엔트리) 창작자가 작품의 사용자 정의 변수/리스트 값을 브라우저 localStorage에 저장·복원할 수 있게 하여 세이브·로드 기능(예: 게임 진행도, 인벤토리)을 구현하도록 돕는 것입니다.

저장 대상은 이름이 "@"로 시작하는 변수와 리스트로 한정되며, 예약 상태 변수 "@확장프로그램"은 제외됩니다. 엔트리 프로젝트 내부에서 최대 세 개의 사용자 정의 식별자만 후킹합니다 — 함수 "@저장"(저장 트리거), 함수 "@가져오기"(교차 작품 가져오기 트리거), 변수 "@확장프로그램"(설치 확인 플래그, 실행 중 1로 설정하지만 저장·가져오기 대상 아님). 그 외 기능·분석·추적·원격 네트워크 요청은 일체 없으며, 모든 저장 데이터는 사용자의 브라우저 localStorage에 머무르고 외부로 전송되지 않습니다.

---

## 2. activeTab Justification (activeTab 사용 근거)

### English

The popup UI (popup.js) uses activeTab to identify the currently active tab via chrome.tabs.query({active: true, currentWindow: true}) and to run a minimal localStorage-management script against only that tab. This is required to:

1. Determine whether the current page is a playentry.org project and display its project ID in the popup.
2. Enumerate localStorage keys beginning with "entry_save_" to show how many saved projects exist.
3. Delete the current project's key when the user clicks "현재 작품 초기화" (Reset current project).
4. Delete all "entry_save_*" keys when the user clicks "모든 데이터 초기화" (Reset all data).

activeTab grants access only after an explicit user gesture (clicking the extension icon and opening the popup), so no passive or background access occurs. The extension does not read page DOM, cookies, or credentials, and does not interact with any other tab.

### 한국어

팝업 UI(popup.js)가 `chrome.tabs.query({active: true, currentWindow: true})`로 현재 활성 탭을 식별하고, 그 탭에만 최소한의 localStorage 관리 스크립트를 실행하기 위해 activeTab이 필요합니다. 용도:

1. 현재 페이지가 playentry.org 작품인지 판별하고 프로젝트 ID를 팝업에 표시
2. "entry_save_"로 시작하는 localStorage 키를 열거해 저장된 작품 수 표시
3. "현재 작품 초기화" 클릭 시 해당 키 삭제
4. "모든 데이터 초기화" 클릭 시 전체 "entry_save_*" 키 삭제

activeTab은 사용자가 확장 아이콘을 클릭해 팝업을 연 직후에만 권한이 부여되어 백그라운드 수집이 불가능합니다. 페이지 DOM·쿠키·자격증명은 읽지 않으며, 다른 탭에도 접근하지 않습니다.

---

## 3. scripting Justification (scripting 사용 근거)

### English

The scripting permission is used exclusively inside the popup (popup.js) via chrome.scripting.executeScript with { allFrames: true }, solely to manage the extension's own localStorage entries. Three operations occur:

1. Enumerate all localStorage keys beginning with "entry_save_" to show a count in the popup.
2. On "Reset current project", remove the single key for the active project.
3. On "Reset all data", remove every "entry_save_*" key.

The injected function is fewer than five lines and operates only on localStorage keys carrying the extension's own "entry_save_" prefix. It does not touch DOM, cookies, credentials, session storage, or third-party data.

The allFrames option is required because Entry pages host their runtime inside nested iframes (e.g., /iframe/<id>), and each frame owns a separate localStorage origin-scope. Without allFrames we could not locate or clean up data saved from the iframe where the Entry engine actually executes.

### 한국어

scripting 권한은 팝업(popup.js)에서만 사용되며, `chrome.scripting.executeScript`에 `{ allFrames: true }` 옵션을 붙여 확장이 스스로 만든 localStorage 항목을 관리하는 용도로만 쓰입니다. 세 가지 작업:

1. "entry_save_"로 시작하는 모든 localStorage 키 열거 → 팝업에 개수 표시
2. "현재 작품 초기화" 클릭 시 활성 작품의 단일 키 삭제
3. "모든 데이터 초기화" 클릭 시 전체 "entry_save_*" 키 삭제

주입 함수는 5줄 이내이며 확장 전용 접두사 "entry_save_"가 붙은 localStorage 키만 다룹니다. DOM·쿠키·자격증명·sessionStorage·제3자 데이터에 전혀 접근하지 않습니다.

엔트리 페이지는 런타임을 중첩 iframe(예: /iframe/<id>)에 올리고 각 프레임의 localStorage origin scope가 분리되므로 allFrames 옵션이 필수입니다. 이 옵션이 없으면 실제 엔트리 엔진이 실행되는 iframe의 저장 데이터를 찾거나 정리할 수 없습니다.

---

## 4. Host Permission Justification (호스트 권한 사용 근거)

### English

The extension requests host access strictly scoped to https://playentry.org/* and https://*.playentry.org/*. This scope is the minimum required for the extension's content scripts to run:

- inject.js executes in the MAIN world so it can directly reference the page's window.Entry runtime object. This is the only way to read the user's "@"-prefixed variables/lists and to hook the "@저장" / "@가져오기" functions at runtime. No equivalent API exists in the isolated world.
- content.js runs in the isolated world as a bridge that re-injects inject.js when Entry's single-page-app router changes URLs without a full page reload, and listens for status messages from inject.js.

No <all_urls>, no wildcards across unrelated domains, no remote script execution, and no network requests from content scripts. If this host match were removed, window.Entry would be inaccessible and the core save/load functionality could not operate. The extension has no use for any other origin.

### 한국어

확장은 호스트 접근을 오로지 `https://playentry.org/*` 와 `https://*.playentry.org/*`로만 요청합니다. 콘텐츠 스크립트가 동작하기 위한 최소 범위입니다:

- inject.js는 MAIN world에서 실행되어야 페이지의 `window.Entry` 런타임 객체를 직접 참조할 수 있습니다. 이 경로로만 사용자의 "@" 접두사 변수/리스트를 읽고 런타임에 "@저장" / "@가져오기" 함수를 후킹할 수 있습니다. isolated world에서는 동등한 API가 없습니다.
- content.js는 isolated world에서 브리지 역할을 하며, 엔트리 SPA 라우터가 전체 리로드 없이 URL을 바꿀 때 inject.js를 재주입하고 inject.js의 상태 메시지를 수신합니다.

`<all_urls>`, 무관한 도메인 와일드카드, 원격 스크립트 실행, 콘텐츠 스크립트발 네트워크 요청은 전혀 없습니다. 이 호스트 매치를 제거하면 `window.Entry`에 접근할 수 없어 핵심 저장·불러오기 기능이 동작하지 않습니다. playentry.org 외 다른 출처는 사용하지 않습니다.
