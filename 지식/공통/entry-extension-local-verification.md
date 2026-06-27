# Entry 확장 로컬 검증 가이드

작성일: 2026-06-02

이 문서는 `C:\Users\young\prg\ENTRY` 아래 Entry 관련 Chrome 확장 프로젝트가 로컬 Entry 만들기 화면을 기준으로 기능을 검증할 때 공유해야 할 기준을 정리한다.

이 문서는 로컬 Entry 만들기 화면에서 실제 주입/상호작용 검증이 필요한 프로젝트에만 적용한다. 모든 Entry 관련 프로젝트가 로컬 Entry 서버를 띄워야 하는 것은 아니다.

## 대상

- Entry Debugger
- Entry Save Manager
- 변수리스트관리자
- 앞으로 추가될 Entry 만들기 화면용 Chrome 확장

공통 검증 URL:

```text
http://127.0.0.1:8080/ws/abcdef0123456789abcdef01
```

## 기본 원칙

1. 배포용 manifest는 실제 사이트 범위를 좁게 유지한다.
   - 예: `https://playentry.org/ws/*`
   - Chrome Web Store 제출용 폴더에 로컬 URL 권한을 섞지 않는다.

2. 로컬 검증은 개발용 확장 폴더를 따로 생성해서 수행한다.
   - 예: Entry Debugger의 `npm run build:dev`
   - 생성물은 `dist/` 아래에 두고 Git에 포함하지 않는다.

3. 개발용 manifest는 Chrome match pattern 제약을 따른다.
   - Chrome extension match pattern에는 포트를 직접 넣지 않는다.
   - 로컬 검증용 match 예:

```json
"matches": [
  "https://playentry.org/ws/*",
  "http://127.0.0.1/*",
  "http://localhost/*"
]
```

4. 로컬 URL의 실제 동작 범위는 content script 내부에서 다시 제한한다.
   - 예: `location.pathname`이 `/ws/`로 시작하는지 확인
   - 필요하면 `url.port === "8080"`도 내부 조건으로 확인

## 로컬 Entry 서버 체크리스트

서버 시작:

```powershell
cd "C:\Users\young\prg\ENTRY\_docs\local-entry-testing"
.\start-local-entry-server.bat
```

수동 시작:

```powershell
cd "C:\Users\young\prg\ENTRY\upstream\entryjs-develop"
npm run serve:local
```

첫 실행은 webpack 컴파일이 오래 걸릴 수 있다. `entry.js`가 약 35MB이고 TensorFlow, lodash, hardware block 쪽 Babel 처리 로그가 나온다. `wait until bundle finished` 상태에서는 테스트를 시작하지 않는다.

HTML 응답 확인:

```powershell
Invoke-WebRequest -UseBasicParsing -Headers @{Accept='text/html'} http://127.0.0.1:8080/ws/abcdef0123456789abcdef01
```

`Accept: text/html` 없이 요청하면 SPA fallback 대신 404처럼 보일 수 있다.

## 로컬 Entry 템플릿 주의사항

로컬 EntryJS 템플릿은 일부 외부 스크립트를 `https://playentry.org/...`에서 직접 읽는다. Chrome에서 ORB 차단이 발생하면 Entry 초기화가 실패할 수 있다.

이번에 확인한 대표 증상:

```text
requestfailed: https://playentry.org/lib/lodash/dist/lodash.min.js net::ERR_BLOCKED_BY_ORB
ReferenceError: _ is not defined
TypeError: Entry.init is not a function
```

대응:

- `upstream\entryjs-develop\example\example.ejs`에서 lodash를 로컬 경로로 읽도록 바꾼다.

```html
<script type="text/javascript" src="/node_modules/lodash/lodash.min.js"></script>
```

이 변경 뒤에는 webpack dev server가 자동 재컴파일한다.

## 확장 자동 스모크 테스트 기준

Chrome 확장 자동 검증은 Playwright persistent context로 수행한다.

필수 조건:

- `headless: false`
- `--load-extension=<확장 폴더>`
- `--disable-extensions-except=<확장 폴더>`
- Playwright 기본 인자 중 `--disable-extensions` 무시

예:

```js
await chromium.launchPersistentContext(userDataDir, {
  headless: false,
  ignoreDefaultArgs: ['--disable-extensions'],
  args: [
    '--disable-extensions-except=' + extensionDir,
    '--load-extension=' + extensionDir,
  ],
});
```

시스템 Chrome은 환경에 따라 명령줄 확장 로드가 불안정할 수 있다. 안정적인 자동 검증에는 Playwright가 설치한 Chromium을 우선 사용한다.

설치:

```powershell
cd "C:\Users\young\prg\ENTRY\apps\MYentry-game"
npx playwright install chromium
```

Entry Debugger 검증 예:

```powershell
cd "C:\Users\young\prg\ENTRY\extensions\Entry Debugger"
npm run build:dev
npm run smoke:local
```

PR 생성 전 검증:

- Entry 관련 확장/앱 프로젝트에서 PR을 생성하거나 PR 브랜치를 업데이트하기 직전에는 해당 프로젝트의 Chromium 기반 smoke/e2e 테스트를 수행한다.
- 로컬 Entry 만들기 화면이 필요한 smoke/e2e일 때만 로컬 Entry 서버를 띄운다.
- 로컬 Entry 서버가 필요 없는 프로젝트는 프로젝트별 `verify:pr`, 정적 검사, Node 테스트, 빌드, 자체 e2e 등으로 PR 전 검증을 구성한다.
- Entry Debugger는 `npm run build:dev` 후 `npm run smoke:local`을 수행한다.
- GitHub 인증 문제로 PR 생성 대신 PR 생성 링크만 전달하는 경우에도, 링크 전달 전에 Chromium 테스트 결과를 확보한다.
- PR 생성 이후 브랜치에 기능 변경 커밋을 추가하면 PR 갱신 전 Chromium 테스트를 다시 수행한다.

성공 기준:

- `.propertyTab` 존재
- 확장 탭 `.propertyTabdebugging` 주입
- `#ed-debugger-panel` 표시 가능
- 패널 상태가 `연결됨`

## 실패 증상별 확인 순서

### 로컬 서버가 응답하지 않음

확인:

```powershell
Get-NetTCPConnection -LocalPort 8080 -State Listen -ErrorAction SilentlyContinue
```

로그:

```powershell
Get-Content -Tail 120 "$env:TEMP\entry-local-server.out.log"
Get-Content -Tail 120 "$env:TEMP\entry-local-server.err.log"
```

### `.propertyTab`이 없음

원인은 확장보다 Entry workspace 초기화 실패일 가능성이 높다.

확인할 브라우저 콘솔 증상:

- `_ is not defined`
- `Entry.init is not a function`
- 외부 스크립트 `ERR_BLOCKED_BY_ORB`

### `.propertyTab`은 있는데 확장 탭이 없음

확인 순서:

1. 개발용 manifest가 로컬 match를 포함하는지 확인
2. match pattern에 포트가 들어가 있지 않은지 확인
3. content script 내부 URL 판별이 로컬 `/ws/`를 허용하는지 확인
4. Playwright 실행 시 `--disable-extensions` 기본 인자를 무시했는지 확인

### Playwright가 브라우저 실행 파일을 못 찾음

증상:

```text
Executable doesn't exist at ... ms-playwright ...
Please run: npx playwright install
```

대응:

```powershell
cd "C:\Users\young\prg\ENTRY\apps\MYentry-game"
npx playwright install chromium
```

## 다른 확장에 적용할 패턴

Entry 만들기 화면에 주입되는 확장 프로젝트에는 최소 세 명령을 두면 좋다.

```json
{
  "scripts": {
    "check": "node tools/check-extension.js",
    "build:dev": "node tools/build-dev-extension.js",
    "smoke:local": "node tools/smoke-local-extension.js"
  }
}
```

권장 역할:

- `check`: manifest 리소스 존재, 버전 일치, JS 문법 확인
- `build:dev`: 배포용 확장을 복사해 로컬 match를 추가한 개발용 폴더 생성
- `smoke:local`: 로컬 Entry workspace에서 확장 주입 여부와 핵심 UI 표시 확인

로컬 Entry 서버가 필요 없는 프로젝트는 `smoke:local` 대신 자체 테스트 명령을 두고, 공통 PR 검증 진입점만 `verify:pr`처럼 맞춘다.

배포용 확장 폴더와 검증용 확장 폴더는 분리한다.

```text
extensions\<확장명>\<배포용 폴더>
extensions\<확장명>\dist\<확장명>-dev
```

## 테스트 종료

검증 뒤 직접 띄운 로컬 서버는 정리한다.

```powershell
cd "C:\Users\young\prg\ENTRY\_docs\local-entry-testing"
.\stop-local-entry-server.bat
```

또는:

```powershell
$listeners = Get-NetTCPConnection -LocalPort 8080 -State Listen -ErrorAction SilentlyContinue
$listeners | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object {
  Stop-Process -Id $_ -Force
}
```
