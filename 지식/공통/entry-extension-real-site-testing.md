# Entry 확장 실제 사이트 테스트 전략

작성일: 2026-05-31

## 결론

Entry 만들기/실행 화면에 주입되는 Chrome 확장 검증은 로컬 재현과 실제 사이트 테스트를 분리한다. 아래 예시는 Entry Save Manager 기준 경로를 사용한다.

- `entryjs-develop` 로컬 서버는 `/ws/<id>` 만들기 화면의 Entry 런타임 API 호환성 스모크 테스트에만 사용한다.
- `/project/<id>`, `/iframe/<id>`, `/noframe/<id>`, 실제 Chrome extension 주입, iframe pageType handshaking, SPA URL 변경은 실제 `https://playentry.org`에서 검증한다.
- 로컬에서 `/project` 실행 화면을 임의 HTML로 재현하지 않는다. 실제 사이트와 차이가 커서 테스트 신뢰도를 떨어뜨린다.

## 공개 소스 확인 결과

공개 자료 기준:

- `entrylabs/entryjs`는 공개되어 있으며, Entry 워크스페이스/블록코딩 런타임 라이브러리다.
- Entry 공식 문서도 `entryjs` dev-server로 `localhost:8080` 워크스페이스를 띄우는 흐름을 안내한다.
- `entrylabs/entry-offline`은 Electron 기반 오프라인 앱이며 실제 `playentry.org` 웹사이트와 동일한 실행 환경으로 보기는 어렵다.
- 실제 `playentry.org`의 전체 웹앱 껍데기, 로그인/작품 상세/iframe 배치/서버 API까지 동일하게 재현할 수 있는 공개 저장소는 확인되지 않았다.

참고:

- https://github.com/entrylabs/entryjs
- https://docs.playentry.org/guide/entryjs/2018-03-09-getting_started.html
- https://github.com/entrylabs/entry-offline
- https://github.com/entrylabs

## 테스트 계층

### 1. 순수 로직 테스트

대상:

- `shared.js`의 projectId 추출
- pageType 판별
- storage key 생성
- migration/legacy key 처리

환경:

- Node 또는 브라우저 없는 단위 테스트

목적:

- Entry 사이트 변경과 무관한 규칙을 빠르게 검증한다.

### 2. 로컬 `entryjs-develop` 스모크 테스트

대상:

- `http://127.0.0.1:8080/ws/<hex-id>`
- `window.Entry`
- `Entry.variableContainer`
- 변수/리스트 구조
- 함수/신호/엔진 API의 기본 호환성

목적:

- EntryJS 업데이트 후 확장 코드가 Entry 런타임 API와 크게 충돌하지 않는지 확인한다.

주의:

- 이 환경을 실제 `playentry.org/ws/*`와 동일하다고 보지 않는다.
- `/project`, `/iframe` 실행 화면을 로컬에서 흉내내지 않는다.

### 3. 실제 사이트 E2E 테스트

대상:

- `https://playentry.org/ws/<fixtureProjectId>`
- `https://playentry.org/project/<fixtureProjectId>`
- `https://playentry.org/noframe/<fixtureProjectId>` 지원을 유지할 경우
- `/project` 내부의 `/iframe/<id>` 자식 frame

확인할 것:

- content script가 실제 URL에서 주입되는지
- MAIN world/fallback 주입이 작동하는지
- `/project` top frame과 `/iframe` child frame 사이 pageType handshaking이 작동하는지
- `/ws` 저장 키는 `entry_save_ws_<id>`인지
- `/project` 저장 키는 `entry_save_<id>`인지
- 새로고침 후 자동 로드가 되는지
- `@저장`, `@가져오기`, `@확장프로그램`이 실제 작품에서 동작하는지

## 실제 사이트 자동화 방향

반복 검증은 Playwright persistent context로 자동화한다. 확장 프로그램 테스트는 persistent context가 필요하고, Playwright 문서는 bundled Chromium 사용을 권장한다.

참고:

- https://playwright.dev/docs/chrome-extensions
- https://developer.chrome.com/docs/extensions/reference/manifest/content-scripts

기본 형태:

```js
const { chromium } = require('playwright');

const extensionPath = String.raw`C:\Users\young\prg\ENTRY\extensions\Entry Save\Entry Save\ES`;
const profilePath = String.raw`C:\Users\young\prg\ENTRY\_e2e\entry-profile`;

const context = await chromium.launchPersistentContext(profilePath, {
  channel: 'chromium',
  headless: false,
  args: [
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
  ],
});
```

첫 실행 때 사용자가 직접 로그인하면 이후 자동화는 같은 profilePath의 세션을 재사용한다. 계정 비밀번호는 저장소나 테스트 코드에 기록하지 않는다.

## 자동화에서 사용할 접근법

UI 클릭을 최소화하고 Entry 런타임을 직접 조작한다.

- 만들기 화면(`/ws/*`): 보통 top frame의 `window.Entry`를 사용한다.
- 실행 화면(`/project/*`): top frame에는 Entry가 없을 수 있으므로 `/iframe/*` 자식 frame을 찾아 그 안의 `window.Entry`를 사용한다.
- `Entry.variableContainer.variables_`, `Entry.variableContainer.lists_`를 통해 `@` 변수/리스트를 조작한다.
- 저장/불러오기 함수가 실제 작품에 있으면 해당 함수 블록을 호출한다.
- 필요 시 신호를 직접 보낸다.
- 저장 후 각 frame의 `localStorage`에서 `entry_save_ws_<id>`와 `entry_save_<id>`를 확인한다.

## 사용자 도움이 필요한 일

실제 사이트 테스트는 계정과 작품 상태가 필요하므로 처음 한 번은 사용자 작업이 필요하다.

사용자에게 요청할 내용:

1. 테스트 전용 Entry 계정을 준비하고, 자동화 브라우저에서 1회 로그인한다.
2. 테스트 전용 작품을 만들거나 기존 `.ent`를 업로드해 fixture 작품을 만든다.
3. 작품에는 최소한 다음 요소를 포함한다.
   - `@저장` 함수
   - `@가져오기` 함수
   - `@확장프로그램` 변수
   - 저장 대상 `@` 변수 1개 이상
   - 저장 대상 `@` 리스트 1개 이상
   - 필요하면 신호 1개
4. fixture 작품 ID를 알려준다.
5. `/noframe/<id>`도 공식 지원 대상으로 계속 볼지 결정한다.
6. 자동화 테스트가 해당 fixture 작품의 localStorage와 런타임 변수 값을 바꿔도 되는지 확인한다.

## 금지/주의 사항

- 실제 사이트 테스트를 대체하려고 로컬 `/project` 페이지를 다시 만들지 않는다.
- 개인 작품이나 중요한 작품을 자동화 대상으로 쓰지 않는다.
- 계정 비밀번호, 쿠키, 세션 토큰을 문서나 저장소에 기록하지 않는다.
- 자동화는 전용 profilePath를 사용하고, 필요하면 사용자가 로그인 세션을 직접 초기화한다.
- 테스트 실패 시 먼저 실제 사이트 구조 변경, iframe URL, manifest 주입 여부, MAIN world fallback 여부를 확인한다.

## 다음 구현 후보

- `real-entry-e2e` 폴더 추가
- Playwright persistent profile 생성 스크립트
- fixture project ID를 받는 설정 파일
- `/ws` 저장/로드 검증
- `/project` iframe 저장/로드 검증
- `/noframe` 검증은 사용자 결정 후 포함
