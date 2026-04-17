/**
 * shared.js -- inject.js / popup.js 공유 상수 및 유틸리티
 */
var ESM = {
  STORAGE_KEY_PREFIX: 'entry_save_',

  /**
   * URL pathname에서 프로젝트 ID를 추출합니다.
   * /ws/xxx, /project/xxx, /iframe/xxx 형태에서 xxx를 반환합니다.
   * @param {string} pathname - URL 경로 (예: '/project/abc123')
   * @returns {string|null}
   */
  extractProjectId: function (pathname) {
    var match = pathname.match(/\/(ws|project|iframe)\/([a-f0-9]+)/);
    return match ? match[2] : null;
  }
};
