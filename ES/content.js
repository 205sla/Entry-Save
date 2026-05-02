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

  // 디버그 로그 — 배포 시 false. inject.js의 DEBUG와 함께 토글하면 됨.
  const DEBUG = false;
  function debug(...args) { if (DEBUG) console.log('[Entry Save Manager]', ...args); }
  function dlog(...args) { if (DEBUG) console.log('[ESM-DBG][content]', `[${location.pathname}]`, ...args); }
  debug('content.js 로드됨 (Isolated World)');
  dlog('content.js IIFE 시작 — top:', window.top === window, 'href:', location.href);

  // ─────────────────────────────────────────────
  //  페이지 타입 결정 (top frame 전용)
  // ─────────────────────────────────────────────
  //  /ws/<id> 워크스페이스와 /project/<id> 작품보기는 별도 namespace로 저장됩니다.
  //  엔트리 런타임은 /iframe/<id> 자식 frame에서 동작하므로, 자식 frame은 자기
  //  pathname만으로는 부모가 ws인지 project인지 알 수 없습니다.
  //
  //  → top frame의 content.js가 자식 frame들의 REQUEST_PAGE_TYPE 메시지에 응답해
  //    pageType을 알려줍니다.

  const isTopFrame = (window.top === window);

  // 동적: SPA 라우팅으로 /ws/ ↔ /project/ 전환 시에도 최신값을 유지
  function getCurrentTopPageType() {
    return ESM.getPageTypeFromPathname(location.pathname);
  }

  // 모든 자식 iframe에 현재 pageType을 능동 브로드캐스트
  // (자식 inject.js가 PAGE_TYPE 메시지를 수신해 storage key를 갱신)
  function broadcastPageTypeToChildren() {
    if (!isTopFrame) {
      dlog('broadcastPageTypeToChildren — top frame 아님, 스킵');
      return;
    }
    const pt = getCurrentTopPageType();
    if (!pt) {
      dlog('broadcastPageTypeToChildren — pageType null (현재 pathname:', location.pathname + '), 스킵');
      return;
    }
    try {
      const frames = window.frames;
      let sent = 0;
      for (let i = 0; i < frames.length; i++) {
        try {
          frames[i].postMessage(
            {
              type: 'ENTRY_SAVE_MANAGER',
              action: 'PAGE_TYPE',
              pageType: pt,
            },
            '*'
          );
          sent++;
        } catch (_) { /* cross-origin, will be ignored */ }
      }
      dlog('브로드캐스트 완료 — pt:', pt, 'frames.length:', frames.length, 'sent:', sent);
    } catch (e) {
      console.error('[Entry Save Manager] pageType 브로드캐스트 오류:', e);
    }
  }

  if (isTopFrame) {
    // 자식 iframe들의 REQUEST_PAGE_TYPE 요청에 응답
    window.addEventListener('message', function (event) {
      if (event.source === window) return; // 자기 frame 자체는 무시
      const data = event.data;
      if (!data || data.type !== 'ENTRY_SAVE_MANAGER') return;
      if (data.action !== 'REQUEST_PAGE_TYPE') return;
      if (!event.source) return;
      const pt = getCurrentTopPageType();
      dlog('REQUEST_PAGE_TYPE 수신 — 현재 top pt:', pt);
      if (!pt) {
        dlog('  → pt null이라 응답 안 함');
        return;
      }
      try {
        event.source.postMessage(
          {
            type: 'ENTRY_SAVE_MANAGER',
            action: 'PAGE_TYPE',
            pageType: pt,
          },
          '*'
        );
        dlog('  → PAGE_TYPE 응답 전송:', pt);
      } catch (e) {
        console.error('[Entry Save Manager] PAGE_TYPE 응답 실패:', e);
        dlog('  → 응답 실패:', e);
      }
    });
    debug('top frame pageType:', getCurrentTopPageType());
    dlog('top frame 리스너 등록 — 초기 pageType:', getCurrentTopPageType());

    // 초기에도 한번 브로드캐스트 (iframe이 늦게 로드되는 경우 대비)
    setTimeout(broadcastPageTypeToChildren, 1500);
    setTimeout(broadcastPageTypeToChildren, 3000);
  } else {
    dlog('iframe 모드 — top frame 응답 대기');
  }

  // ─────────────────────────────────────────────
  //  폴백: shared.js → inject.js를 <script> 태그로 순차 주입
  // ─────────────────────────────────────────────
  //  Manifest의 "world": "MAIN" 설정이 동작하지 않는 환경에서의 안전장치.
  //  inject.js는 ESM(shared.js의 객체)에 의존하므로 shared.js를 먼저 로드해야 함.
  //  이미 MAIN world로 매니페스트에 의해 로드된 경우엔 inject.js 내부의
  //  중복 방지 플래그(__entrySaveManagerLoaded)로 인해 재실행되지 않습니다.

  function injectOneScript(filename, onLoad, onError) {
    try {
      const script = document.createElement('script');
      script.src = chrome.runtime.getURL(filename);
      script.type = 'text/javascript';
      script.onload = function () {
        if (onLoad) onLoad();
        script.remove();
      };
      script.onerror = function () {
        console.error('[Entry Save Manager] ' + filename + ' 폴백 삽입 실패');
        if (onError) onError();
      };
      (document.head || document.documentElement).appendChild(script);
    } catch (e) {
      console.error('[Entry Save Manager] ' + filename + ' 삽입 오류:', e);
      if (onError) onError(e);
    }
  }

  function injectScriptFallback() {
    // shared.js 먼저 → 성공 시 inject.js 주입 (ESM 의존성 보장)
    injectOneScript('shared.js', function () {
      dlog('shared.js 폴백 삽입 완료 → inject.js 주입');
      debug('shared.js 폴백 삽입 완료');
      injectOneScript('inject.js', function () {
        dlog('inject.js 폴백 삽입 완료');
        debug('inject.js 폴백 삽입 완료');
      });
    });
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
        debug('저장 완료 알림 수신:', data.payload);
        break;
      case 'LOAD_COMPLETE':
        debug('로드 완료 알림 수신:', data.payload);
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
      debug('URL 변경 감지:', lastUrl);

      // 작품 페이지인 경우에만 재삽입 (/noframe/ 포함 — iframe-less 작품보기)
      if (lastUrl.includes('/project/') || lastUrl.includes('/ws/') || lastUrl.includes('/noframe/')) {
        dlog('URL 변경 → URL_CHANGED 전송 + 브로드캐스트 + 재주입 예약 (' + URL_CHANGE_DELAY + 'ms 후)');
        setTimeout(function () {
          // MAIN world 플래그 리셋을 위해 커스텀 이벤트 전송
          window.postMessage(
            { type: 'ENTRY_SAVE_MANAGER', action: 'URL_CHANGED' },
            '*'
          );
          // SPA로 /ws/ ↔ /project/ 전환 시 자식 iframe의 pageType 캐시도 갱신
          broadcastPageTypeToChildren();
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
