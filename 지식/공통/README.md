# Entry 확장 유형 지식

이 폴더는 `extensions` 아래 여러 Chrome 확장 프로젝트에 반복 적용되는 지식을 둔다. 이 repo 안의 사본은 Entry Save Manager 릴리스와 함께 볼 수 있도록 포함한 스냅샷이다. 특정 확장 하나에만 종속되는 selector, 설정 키, 메시지 payload, 릴리스 이력은 해당 확장의 `지식` 또는 `knowledge` 폴더에 둔다.

## 문서 목록

- [Entry 확장 로컬 검증 가이드](./entry-extension-local-verification.md)
- [Entry 확장 실제 사이트 테스트 전략](./entry-extension-real-site-testing.md)
- [MV3 content_scripts 함정 정리](./mv3-content-script-pitfalls.md)
- [Entry pageType 핸드셰이크 설계](./entry-page-type-handshake.md)

## 추가 기준

- Entry 만들기 화면에 주입되는 확장 전체에 적용되면 이 폴더에 둔다.
- Entry Save, Entry Debugger, 변수리스트관리자 등 하나에만 종속되면 해당 프로젝트의 `지식` 폴더에 둔다.
- 공통 패턴 문서에서 특정 프로젝트 코드를 예시로 쓰는 경우에는 "구현 사례"로 표시하고 프로젝트 파일 링크를 명시한다.
