# Entry Save Manager — 지식 베이스

이 폴더는 v1.2.x → v1.3.9 개발 과정에서 겪은 Entry Save Manager 전용 문제·해결·설계 결정·디버깅 기법을 정리한 기록입니다. 여러 Entry 확장 프로젝트에 재사용되는 MV3, pageType handshaking, 실제 사이트 E2E 전략은 `지식\공통`에 함께 둔 스냅샷을 기준으로 봅니다.

## 관련 공통 지식

이 프로젝트가 의존하는 상위 계층 지식(SSOT). 자세한 링크는 아래 「확장 유형 공통 문서」 표와 함께 본다.

- 전체 공통: `_docs/entry-runtime-access.md` (ENTRY 워크스페이스 루트 문서, repo 외부) — `window.Entry` 접근·**전체화면 engine 교체 재후킹**(v1.3.7의 근거)
- 확장 유형 공통: [`지식/공통`](공통/README.md) — MV3 함정·pageType 핸드셰이크·실사이트 E2E
- 지식 카탈로그·규칙: `_docs/INDEX.md`, `_docs/지식-관리.md` (ENTRY 워크스페이스 루트 문서, repo 외부)

## 📚 문서 구성

| 파일 | 내용 | 언제 읽나 |
|---|---|---|
| [01-문제-해결-기록.md](01-문제-해결-기록.md) | 시간 순으로 정리한 모든 버그·해결·설계 변경 (변경사항 이해의 단일 출처) | 새 버그 만났을 때, "이거 예전에 해결한 적 있던가?" 싶을 때 |
| [04-스토리지-키-규칙.md](04-스토리지-키-규칙.md) | localStorage key 명명 규칙 변천사와 현재(v1.3.9) 규칙 | 키 형식 바꿀 때, 데이터 호환성 고민 시 |
| [05-디버깅-가이드.md](05-디버깅-가이드.md) | 빠른 진단 명령, 로그 해석, 흔한 증상→원인 매핑 | 사용자 버그 리포트 받았을 때 가장 먼저 |

## 확장 유형 공통 문서

| 파일 | 내용 | 언제 읽나 |
|---|---|---|
| [MV3 content_scripts 함정 정리](공통/mv3-content-script-pitfalls.md) | Manifest V3 + `world: "MAIN"` content_script의 비공식 동작·함정·우회법 | content_script 동작이 이상할 때, 새 의존성 추가하기 전 |
| [Entry pageType 핸드셰이크 설계](공통/entry-page-type-handshake.md) | top frame ↔ iframe pageType 전달 메커니즘 (postMessage 설계) | namespace/storage key 관련 변경 시 |
| [Entry 확장 실제 사이트 테스트 전략](공통/entry-extension-real-site-testing.md) | 로컬 EntryJS 테스트와 실제 playentry.org E2E 테스트의 역할 분리, 사용자 준비사항 | 테스트 환경을 다시 설계하거나 실제 사이트 회귀 테스트를 자동화할 때 |

## 🧭 빠른 탐색

**"왜 ESM is not defined 오류가 나지?"**
→ [MV3 content_scripts 함정 정리](공통/mv3-content-script-pitfalls.md) "MAIN world wrapper와 var 글로벌"

**"/project/와 /ws/가 데이터를 같이 쓰는데?"**
→ [04-스토리지-키-규칙.md](04-스토리지-키-규칙.md)

**"@저장이 안 동작해"**
→ [05-디버깅-가이드.md](05-디버깅-가이드.md) "후킹 진단"

**"로컬에서 /project 실행 화면도 만들어서 테스트할까?"**
→ [Entry 확장 실제 사이트 테스트 전략](공통/entry-extension-real-site-testing.md) "결론"

**"자식 iframe이 부모가 ws인지 project인지 어떻게 알지?"**
→ [Entry pageType 핸드셰이크 설계](공통/entry-page-type-handshake.md)

**"v1.3.0 사용자 데이터는 어떻게 처리하지?"**
→ [04-스토리지-키-규칙.md](04-스토리지-키-규칙.md) "마이그레이션"

## 🏗 아키텍처 한 장 요약

```
┌─────────────────────────────────────────────────────────────────────┐
│  Browser Tab — playentry.org                                        │
│                                                                     │
│  ┌──────────────────────────────┐  ┌──────────────────────────────┐│
│  │ Top frame (/project/, /ws/,  │  │ Child iframe (/iframe/<id>)  ││
│  │  /noframe/)                   │  │                              ││
│  │                              │  │                              ││
│  │  Isolated world:             │  │  Isolated world:             ││
│  │  ─ shared.js + content.js    │  │  ─ shared.js + content.js    ││
│  │      ↕ postMessage            │  │      ↕ postMessage            ││
│  │  MAIN world:                 │  │  MAIN world:                 ││
│  │  ─ shared.js + inject.js     │  │  ─ shared.js + inject.js     ││
│  │     (window.Entry 접근 X)    │  │     (window.Entry 접근 ✓)   ││
│  └──────────────────────────────┘  └──────────────────────────────┘│
│        ↕ postMessage (REQUEST_PAGE_TYPE / PAGE_TYPE)                │
│        ↕ postMessage (URL_CHANGED)                                  │
└─────────────────────────────────────────────────────────────────────┘
                              ↑
                              │ chrome.scripting.executeScript
                              │ (allFrames: true)
                              ↓
┌─────────────────────────────────────────────────────────────────────┐
│  Extension Popup (popup.html / popup.js / popup.css)                │
│  ─ 현재 namespace 인식 UI                                            │
└─────────────────────────────────────────────────────────────────────┘
```

핵심 책임:
- **shared.js**: storage 키 빌더, pageType 결정, projectId 추출 (모든 컨텍스트 공유)
- **content.js**: SPA URL 변경 감지, top frame pageType 응답기, inject.js fallback 주입기
- **inject.js**: window.Entry 후킹 본체 — 자동 로드/저장, `@저장`/`@가져오기` wrapper, `@확장프로그램` 세팅
- **popup.js**: localStorage 관리 UI
- **background.js / welcome.html**: 최초 설치 시 새로고침 및 제작법 안내

## ⏱ 버전 히스토리 (요약)

| Ver | 핵심 변경 | 자세히 |
|---|---|---|
| 1.2.1 | 패밀리 사이트 링크 | (이전) |
| 1.3.0 | `/ws/` ↔ `/project/` namespace 분리 | [01](01-문제-해결-기록.md#v130) |
| 1.3.1 | 키 명명 규칙 반전: project가 기본 키 | [01](01-문제-해결-기록.md#v131) [04](04-스토리지-키-규칙.md) |
| 1.3.2 | `/noframe/` 페이지 지원 | [01](01-문제-해결-기록.md#v132) |
| 1.3.3 | 내부 리팩토링 + 콘솔 출력 최소화 | [01](01-문제-해결-기록.md#v133) |
| 1.3.4 | v1.3.0 → v1.3.1 데이터 자동 마이그레이션 (v1.3.6에서 롤백됨) | [01](01-문제-해결-기록.md#v134) |
| 1.3.5 | `var ESM` → `window.ESM` 변경 시도 (가설 기반, v1.3.6에서 롤백됨) | [01](01-문제-해결-기록.md#v135) |
| 1.3.6 | v1.3.3~1.3.5 회귀 → v1.3.2 동등 상태로 롤백 | [01](01-문제-해결-기록.md#v136) |
| 1.3.7 | 작품보기 전체화면(⛶) 시 `Entry.engine` 교체로 후킹 끊김 수정 (engine 교체 감지·재후킹) | [01](01-문제-해결-기록.md#v137) |
| 1.3.8 | `@확장프로그램` 예약 변수 제외 + 검증/패키징 인프라 | [01](01-문제-해결-기록.md#v138) |
| **1.3.9** | **최초 설치 새로고침 안내 + 제작법 영상 링크** (현재 상태) | [01](01-문제-해결-기록.md#v139) |

## 🎯 향후 작업 시 체크리스트

스토어 배포 전 항상 확인:
- [ ] `inject.js`의 `DEBUG = false` 확인
- [ ] `content.js`의 `DEBUG = false` 확인
- [ ] `manifest.json`의 version 증가
- [ ] [README.md](../README.md) changelog 갱신
- [ ] `npm run verify` 통과
- [ ] `npm run package:release`로 제출 ZIP 생성
- [ ] [05-디버깅-가이드.md](05-디버깅-가이드.md)의 "배포 전 셀프 테스트" 시나리오 통과

shared.js 수정 시:
- [ ] 현재 공개 구현은 v1.3.6 롤백 이후 `var ESM = ...` 형태를 유지한다.
- [ ] `window.ESM`/`globalThis.ESM` 재시도는 테스트 인프라와 실사이트 검증을 갖춘 별도 변경으로만 진행한다.
- [ ] 모든 컨텍스트(MAIN/Isolated/popup/fallback)에서 ESM 접근 가능한지 확인

storage key 형식 변경 시:
- [ ] 기존 사용자 데이터 마이그레이션 경로 마련 ([04](04-스토리지-키-규칙.md#마이그레이션))
- [ ] popup의 "전체 초기화"가 모든 형식 키를 잡는지 (prefix 매칭 확인)

페이지 타입 추가 시 (예: 새로운 `/embed/` 같은 URL):
- [ ] `shared.js` extractProjectId regex
- [ ] `shared.js` getPageTypeFromPathname 매핑
- [ ] `inject.js` isProjectPage 체크
- [ ] `content.js` SPA URL 변경 감지
