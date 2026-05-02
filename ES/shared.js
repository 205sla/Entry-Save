/**
 * shared.js -- inject.js / content.js / popup.js 공유 상수 및 유틸리티
 */
var ESM = {
  STORAGE_KEY_PREFIX: 'entry_save_',

  // /ws/ 페이지 namespace 접두사. /project/ 페이지(기본)는 prefix 없이
  // STORAGE_KEY_PREFIX + projectId를 사용하고, /ws/ 페이지만 NAMESPACE_WS를 추가로 붙임.
  NAMESPACE_WS: 'ws_',

  /**
   * URL pathname에서 프로젝트 ID를 추출합니다.
   * /ws/xxx, /project/xxx, /iframe/xxx, /noframe/xxx 형태에서 xxx를 반환합니다.
   * @param {string} pathname - URL 경로 (예: '/project/abc123')
   * @returns {string|null}
   */
  extractProjectId: function (pathname) {
    var match = pathname.match(/\/(ws|project|iframe|noframe)\/([a-f0-9]+)/);
    return match ? match[2] : null;
  },

  /**
   * pathname에서 페이지 타입을 결정합니다.
   * /iframe/ 프레임은 부모 frame의 타입을 알아야 하므로 null을 반환 — 호출자가
   * 부모로부터 postMessage 핸드셰이크로 받아야 합니다.
   * @param {string} pathname
   * @returns {'ws'|'project'|null}
   */
  getPageTypeFromPathname: function (pathname) {
    if (pathname.indexOf('/ws/') === 0) return 'ws';
    if (pathname.indexOf('/project/') === 0) return 'project';
    if (pathname.indexOf('/noframe/') === 0) return 'project'; // noframe = iframe-less project view
    return null;
  },

  /**
   * 페이지 타입과 프로젝트 ID로 localStorage 키를 결정합니다. 키 생성의 단일 진입점.
   *
   * 매핑 (모든 호출이 이 규칙을 따름):
   *   pageType = 'project' 또는 null/undefined → "entry_save_<id>"          (기본, prefix 없음)
   *   pageType = 'ws'                            → "entry_save_ws_<id>"     (워크스페이스 전용)
   *
   * 사용 패턴:
   *   - 자기 페이지 저장/로드  : buildStorageKey(현재pageType, 현재projectId)
   *   - '@가져오기' 교차 로드  : buildStorageKey('project', 대상projectId)  ← 항상 project 강제(=기본 키)
   *   - 팝업 현재작품 초기화   : buildStorageKey(현재pageType, 현재projectId)
   */
  buildStorageKey: function (pageType, projectId) {
    if (pageType === 'ws') {
      return this.STORAGE_KEY_PREFIX + this.NAMESPACE_WS + projectId;
    }
    return this.STORAGE_KEY_PREFIX + projectId;
  }
};
