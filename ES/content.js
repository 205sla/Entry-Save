/**
 * ============================================================
 *  content.js — Isolated World 스크립트
 * ============================================================
 *  Content Script는 웹페이지와 격리된 환경(Isolated World)에서 실행됩니다.
 *  window.Entry에 직접 접근할 수 없으므로, 핵심 로직은 inject.js가 담당합니다.
 *
 *  이 파일은 다음 역할을 합니다:
 *    1) inject.js가 정상 로드되었는지 확인 (보조적 역할)
 *    2) 필요 시 inject.js를 수동으로 DOM에 삽입 (폴백)
 *    3) 웹페이지 ↔ 확장프로그램 간의 메시지 브릿지 (향후 확장용)
 * ============================================================
 */

(function () {
  'use strict';

  const URL_CHANGE_DELAY = 2000;  // URL 변경 후 재삽입 대기 (ms)
  const FALLBACK_DELAY = 1000;    // 초기 폴백 삽입 대기 (ms)

  console.log('[Entry Save Manager] content.js 로드됨 (Isolated World)');

  // ─────────────────────────────────────────────
  //  폴백: inject.js를 <script> 태그로 직접 삽입
  // ─────────────────────────────────────────────
  //  Manifest의 "world": "MAIN" 설정이 동작하지 않는
  //  일부 환경을 위한 안전장치입니다.
  //  이미 MAIN world로 로드된 경우 inject.js 내부의
  //  중복 방지 플래그로 인해 재실행되지 않습니다.

  function injectScriptFallback() {
    try {
      const script = document.createElement('script');
      script.src = chrome.runtime.getURL('inject.js');
      script.type = 'text/javascript';

      script.onload = function () {
        console.log('[Entry Save Manager] inject.js 폴백 삽입 완료');
        // 삽입 후 태그를 제거하여 DOM을 깨끗하게 유지
        script.remove();
      };

      script.onerror = function () {
        console.error('[Entry Save Manager] inject.js 폴백 삽입 실패');
      };

      (document.head || document.documentElement).appendChild(script);
    } catch (e) {
      console.error('[Entry Save Manager] 스크립트 삽입 오류:', e);
    }
  }

  // ─────────────────────────────────────────────
  //  페이지 ↔ 확장프로그램 메시지 브릿지
  // ─────────────────────────────────────────────
  //  inject.js(MAIN world)에서 content.js(Isolated world)로
  //  정보를 전달받기 위한 리스너입니다.
  //  현재는 로깅 목적이며, 향후 chrome.storage 연동 등에 활용 가능합니다.

  window.addEventListener('message', function (event) {
    // 보안: 자기 자신의 페이지에서 온 메시지만 처리
    if (event.source !== window) return;

    const data = event.data;
    if (!data || data.type !== 'ENTRY_SAVE_MANAGER') return;

    switch (data.action) {
      case 'SAVE_COMPLETE':
        console.log('[Entry Save Manager] 저장 완료 알림 수신:', data.payload);
        break;
      case 'LOAD_COMPLETE':
        console.log('[Entry Save Manager] 로드 완료 알림 수신:', data.payload);
        break;
      case 'ERROR':
        console.error('[Entry Save Manager] 오류 알림 수신:', data.payload);
        break;
      default:
        break;
    }
  });

  // ─────────────────────────────────────────────
  //  URL 변경 감지 (SPA 대응)
  // ─────────────────────────────────────────────
  //  엔트리는 SPA이므로 URL이 변경되어도 페이지 전체가 리로드되지 않습니다.
  //  URL 변경 시 inject.js를 재삽입하여 새 작품에 대한 후킹을 보장합니다.

  let lastUrl = location.href;

  const observer = new MutationObserver(function () {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      console.log('[Entry Save Manager] URL 변경 감지:', lastUrl);

      // 작품 페이지인 경우에만 재삽입
      if (lastUrl.includes('/project/') || lastUrl.includes('/ws/')) {
        setTimeout(function () {
          // MAIN world 플래그 리셋을 위해 커스텀 이벤트 전송
          window.postMessage(
            { type: 'ENTRY_SAVE_MANAGER', action: 'URL_CHANGED' },
            '*'
          );
          injectScriptFallback();
        }, URL_CHANGE_DELAY);
      }
    }
  });

  observer.observe(document.body || document.documentElement, {
    childList: true,
    subtree: true,
  });

  // ─────────────────────────────────────────────
  //  초기 실행
  // ─────────────────────────────────────────────
  //  MAIN world inject.js의 폴백 삽입 시도 (안전장치)
  //  이미 "world": "MAIN"으로 로드된 경우에는 중복 방지 플래그로
  //  inject.js 내부 로직이 재실행되지 않습니다.

  // 약간의 딜레이 후 폴백 삽입 시도
  setTimeout(injectScriptFallback, FALLBACK_DELAY);
})();
