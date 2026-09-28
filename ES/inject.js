/**
 * ============================================================
 *  inject.js — MAIN World 스크립트
 * ============================================================
 *  Manifest V3의 "world": "MAIN" 설정으로 웹페이지와 동일한
 *  실행 컨텍스트에서 실행되어 window.Entry 객체에 직접 접근합니다.
 *
 *  주요 기능:
 *    1) 작품 로딩 시 localStorage에서 저장된 데이터를 읽어 복원 (Load)
 *    2) '@저장' 함수 호출 시 '@' 변수/리스트를 localStorage에 저장 (Save)
 *    3) '@확장프로그램' 변수를 1로 설정하여 설치 유무를 알림
 *    4) '@가져오기' 함수 호출 시 파라미터의 평가된 프로젝트 ID를 이용해
 *       해당 작품의 저장 데이터를 현재 작품의 동일 이름(@) 변수/리스트에 적용
 * ============================================================
 */

(function () {
  'use strict';

  // ─────────────────────────────────────────────
  //  상수 정의
  // ─────────────────────────────────────────────
  const PREFIX = ESM.PREFIX;                      // 추적 대상 변수/리스트 접두사
  const SAVE_FUNC_NAME = ESM.SAVE_FUNC_NAME;      // 저장 트리거 함수 이름
  const LOAD_FUNC_NAME = ESM.LOAD_FUNC_NAME;      // 교차 작품 데이터 가져오기 트리거
  const STATUS_VAR_NAME = ESM.STATUS_VAR_NAME;    // 확장프로그램 설치 확인 변수
  const STORAGE_KEY_PREFIX = ESM.STORAGE_KEY_PREFIX;

  // 타이밍 상수 (ms)
  const POLL_INTERVAL = 500;               // Entry 객체 / 엔진 상태 폴링 간격
  const STATE_CHECK_DELAY = 300;           // 상태 전이 후 확인 딜레이

  // 디버그 로깅 (배포 시 false로 설정)
  const DEBUG = false;
  // 일반 정보성 로그 — [Entry Save Manager] prefix
  function info(...args) { if (DEBUG) console.log('[Entry Save Manager]', ...args); }
  // 내부 진단 로그 — [ESM] prefix + frame pathname
  function debug(...args) { if (DEBUG) console.log('[ESM]', `[${location.pathname}]`, ...args); }
  // namespace/핸드셰이크 추적 로그
  function dlog(...args) { if (DEBUG) console.log('[ESM-DBG][inject]', `[${location.pathname}]`, ...args); }

  // 중복 초기화 방지 플래그
  if (window.__entrySaveManagerLoaded) return;
  window.__entrySaveManagerLoaded = true;

  // 활성 폴링 타이머 (정리용)
  let enginePollTimer = null;
  let disposed = false;
  let runSession = null;

  // toggleRun 후킹 원본 참조 (URL 변경 시 복구용)
  let originalToggleRun = null;
  let hookedEngine = null;
  let toggleRunWrapper = null;

  // 스키마와 래퍼 자체를 추적해 교체·이름 변경 시 자기 후킹만 해제한다.
  const functionHooks = new Map();

  // 페이지 타입 판별 — /project/, /iframe/, /noframe/ 모두 작품 실행 페이지
  // (/noframe/은 자식 iframe 없이 top frame이 곧 runtime인 변형)
  const isProjectPage = location.pathname.startsWith('/project/')
                     || location.pathname.startsWith('/iframe/')
                     || location.pathname.startsWith('/noframe/');
  const isWorkspacePage = location.pathname.startsWith('/ws/');

  // ─────────────────────────────────────────────
  //  Storage namespace (pageType) 결정
  // ─────────────────────────────────────────────
  //  /project/ → 'project' → entry_save_<id>      (기본 키 = prefix 없음)
  //  /ws/      → 'ws'      → entry_save_ws_<id>   (워크스페이스 전용 prefix)
  //  /iframe/  → 부모로부터 postMessage로 받음 (응답 전엔 'project' 폴백 = 기본 키)
  //
  //  자식 iframe이 부모의 pageType을 알아야 정확한 키로 저장/로드할 수 있으므로
  //  REQUEST_PAGE_TYPE → PAGE_TYPE 핸드셰이크를 수행합니다.
  let pageType = ESM.getPageTypeFromPathname(location.pathname);
  let pageTypeResolved = pageType !== null;
  let pageTypeHandshakeTimer = null;

  dlog('IIFE 시작 — top:', window.top === window, 'parent===self:', window.parent === window,
       '| 초기 pageType:', pageType, 'resolved:', pageTypeResolved, 'href:', location.href);

  function requestPageTypeFromParent() {
    if (window.parent === window) {
      dlog('requestPageTypeFromParent — 부모 없음 (top frame), 스킵');
      return;
    }
    try {
      window.parent.postMessage(
        { type: 'ENTRY_SAVE_MANAGER', action: 'REQUEST_PAGE_TYPE' },
        '*'
      );
      dlog('REQUEST_PAGE_TYPE → 부모 frame에 전송');
    } catch (e) {
      dlog('REQUEST_PAGE_TYPE 전송 실패:', e);
    }
  }

  // 부모가 없는 경우에는 핸드셰이크 없이 getStorageKey()의 'project' 폴백 사용
  if (!pageTypeResolved && window.parent !== window) {
    dlog('pageType 미해결 → 핸드셰이크 시작');
    requestPageTypeFromParent();
    let handshakeAttempts = 0;
    const HANDSHAKE_MAX_ATTEMPTS = 20; // 500ms × 20 = 10초까지 시도
    pageTypeHandshakeTimer = setInterval(() => {
      if (pageTypeResolved || handshakeAttempts >= HANDSHAKE_MAX_ATTEMPTS) {
        clearInterval(pageTypeHandshakeTimer);
        pageTypeHandshakeTimer = null;
        if (!pageTypeResolved) {
          dlog('핸드셰이크 타임아웃 (' + HANDSHAKE_MAX_ATTEMPTS + '회 시도) — \'project\' 폴백 사용 예정');
        } else {
          dlog('핸드셰이크 성공 후 타이머 종료');
        }
        return;
      }
      handshakeAttempts++;
      dlog('핸드셰이크 재시도 #' + handshakeAttempts);
      requestPageTypeFromParent();
    }, 500);
  } else if (!pageTypeResolved) {
    dlog('pageType 미해결이지만 부모 없음 → \'project\' 폴백 사용');
  } else {
    dlog('pageType 자기 pathname에서 해결 → 핸드셰이크 불필요');
  }

  /**
   * URL 경로에서 프로젝트 ID를 추출합니다.
   * /ws/xxx, /project/xxx, /iframe/xxx 형태에서 xxx를 반환합니다.
   */
  function getProjectIdFromUrl() {
    return ESM.extractProjectId(location.pathname);
  }

  /**
   * 프로젝트 ID를 반환합니다. Entry.projectId 우선, 없으면 URL에서 추출.
   */
  function getProjectId() {
    return (window.Entry && window.Entry.projectId) || getProjectIdFromUrl();
  }

  info('inject.js 로드됨 (MAIN world)');
  debug(`페이지 타입: ${isProjectPage ? '/project/' : isWorkspacePage ? '/ws/' : '기타'} — URL: ${location.href}`);

  // ─────────────────────────────────────────────
  //  유틸리티 함수
  // ─────────────────────────────────────────────

  /**
   * Entry 객체가 준비될 때까지 폴링 방식으로 대기합니다.
   * /project/ 페이지에서는 Entry.engine과 block까지 대기합니다.
   * @returns {Promise<void>}
   */
  function waitForEntry() {
    return new Promise((resolve, reject) => {
      let pollCount = 0;
      // top frame(/ws/, /project/)에는 Entry가 없는 경우가 많음 — 자식 iframe만 동작.
      // 일정 횟수 후 포기해 무한 폴링/콘솔 노이즈를 막는다.
      const MAX_POLLS = 60; // 60 × 500ms = 30초
      const check = () => {
        if (disposed) {
          reject(new Error('Entry Save instance disposed'));
          return;
        }
        pollCount++;

        // 기본 체크
        const hasEntry = !!window.Entry;
        const hasVC = !!(window.Entry && window.Entry.variableContainer);
        const hasPid = !!(window.Entry && window.Entry.projectId) || !!getProjectIdFromUrl();
        const hasEngine = !!(window.Entry && window.Entry.engine);
        const hasBlock = !!(window.Entry && window.Entry.block);

        if (pollCount <= 5 || pollCount % 10 === 0) {
          debug(`waitForEntry 폴링 #${pollCount} — Entry:${hasEntry}, vc:${hasVC}, pid:${hasPid}(${getProjectId()||""}), engine:${hasEngine}, block:${hasBlock}`);
        }

        if (pollCount >= MAX_POLLS && !hasEntry) {
          debug(`waitForEntry 포기 (${pollCount}회 폴링) — 이 frame에 Entry 없음. 자식 iframe만 동작 예상.`);
          reject(new Error('Entry not found in this frame'));
          return;
        }

        // 5번째 폴링에서 진단 정보 출력
        if (DEBUG && pollCount === 5 && !hasEntry) {
          debug('===== Entry 미발견 진단 =====');
          const iframes = document.querySelectorAll('iframe');
          debug('iframe 개수:', iframes.length);
          iframes.forEach((iframe, i) => {
            try {
              const iframeEntry = iframe.contentWindow && iframe.contentWindow.Entry;
              debug(`  iframe[${i}] src:${iframe.src}, Entry:${!!iframeEntry}`);
            } catch (e) {
              debug(`  iframe[${i}] src:${iframe.src}, 접근 불가 (cross-origin)`);
            }
          });
          const entryRelated = Object.keys(window).filter(k => /entry/i.test(k));
          debug('window에서 entry 관련 키:', entryRelated);
          const canvas = document.querySelector('#entryCanvas, canvas');
          debug('canvas 요소:', canvas ? canvas.id || canvas.tagName : '없음');
          debug('========================');
        }

        // window.Entry가 있지만 다른 조건이 부족한 경우
        if (DEBUG && hasEntry && !hasVC && pollCount === 10) {
          debug('Entry 존재하지만 variableContainer 없음');
          debug('Entry 키:', Object.keys(window.Entry).slice(0, 30));
        }

        const basic = hasEntry && hasVC && hasPid;

        if (!basic) {
          setTimeout(check, POLL_INTERVAL);
          return;
        }

        // /project/ 페이지에서는 block과 engine도 대기
        if (isProjectPage) {
          if (!hasEngine || !hasBlock) {
            setTimeout(check, POLL_INTERVAL);
            return;
          }
        }

        debug(`waitForEntry 완료! (${pollCount}회 폴링)`);
        resolve();
      };
      check();
    });
  }

  /**
   * 현재 프로젝트·페이지 타입에 대한 localStorage 키를 반환합니다.
   *  - /project/ → "entry_save_<id>"      (기본, prefix 없음)
   *  - /ws/      → "entry_save_ws_<id>"   (워크스페이스 전용)
   *  - pageType 미해결 시 'project' 폴백 — 기본 키와 일치(=대다수 사용자/플레이어 시나리오)
   */
  function getStorageKey() {
    const pt = pageTypeResolved ? pageType : 'project';
    const key = ESM.buildStorageKey(pt, getProjectId());
    dlog('getStorageKey() →', key, '(pt:', pt, 'resolved:', pageTypeResolved + ', pid:', getProjectId() + ')');
    return key;
  }

  // ─────────────────────────────────────────────
  //  '@' 변수/리스트 필터 & 직렬화
  // ─────────────────────────────────────────────

  function getTargetVariables() {
    const container = Entry.variableContainer;
    const vars = container.variables_ || [];
    debug('전체 변수 개수:', vars.length);
    const filtered = vars.filter((v) => (
      v.name_
      && v.name_.startsWith(PREFIX)
      && !ESM.isReservedVariableName(v.name_)
    ));
    debug('"@" 접두사 변수 개수:', filtered.length);
    return filtered.map((v) => ({
      id: v.id_,
      name: v.name_,
      value: v.value_,
    }));
  }

  function getTargetLists() {
    const container = Entry.variableContainer;
    const lists = container.lists_ || [];
    debug('전체 리스트 개수:', lists.length);
    const filtered = lists.filter((l) => l.name_ && l.name_.startsWith(PREFIX));
    debug('"@" 접두사 리스트 개수:', filtered.length);
    return filtered.map((l) => ({
      id: l.id_,
      name: l.name_,
      array: l.array_ ? l.array_.map((item) => item.data) : [],
    }));
  }

  // ─────────────────────────────────────────────
  //  Save (저장)
  // ─────────────────────────────────────────────

  function saveData() {
    dlog('===== saveData() 호출됨 =====');
    try {
      const variables = getTargetVariables();
      const lists = getTargetLists();
      const data = {
        variables: variables,
        lists: lists,
        savedAt: new Date().toISOString(),
      };

      const key = getStorageKey();
      const jsonStr = JSON.stringify(data);
      localStorage.setItem(key, jsonStr);

      // 저장 검증
      const verify = localStorage.getItem(key);
      dlog('saveData 완료 — key:', key, '일치:', verify === jsonStr, '바이트:', jsonStr.length,
           '변수:', variables.length, '리스트:', lists.length);
      info('데이터 저장 완료:', key);
    } catch (e) {
      console.error('[Entry Save Manager] 저장 실패:', e);
      dlog('저장 실패 스택:', e.stack);
    }
  }

  // ─────────────────────────────────────────────
  //  Load (불러오기)
  // ─────────────────────────────────────────────

  /**
   * 저장된 변수 값이 복원 가능한 primitive 타입인지 검증합니다.
   * 기존 저장본의 number/string/boolean/null을 허용하고 객체·배열은 제외합니다.
   */
  function isValidVariableValue(value) {
    const t = typeof value;
    return value === null || t === 'number' || t === 'string' || t === 'boolean';
  }

  /**
   * 리스트 항목이 복원 가능한 primitive인지 검증합니다.
   */
  function isValidListItem(item) {
    const t = typeof item;
    return item === null || t === 'number' || t === 'string' || t === 'boolean';
  }

  /**
   * @param {string} [sourceProjectId] - 생략 시 현재 프로젝트(현재 페이지 namespace).
   *   지정 시('@가져오기') **항상 project namespace**에서 로드합니다 — 호출 페이지가
   *   /ws/이든 /project/이든 시리즈 작품의 플레이어 데이터를 가져오기 위함.
   */
  function loadData(sourceProjectId) {
    dlog('===== loadData() 호출됨 — source:', sourceProjectId || '(self)', '=====');
    // 자기 페이지 자동 로드: 현재 namespace 키 / '@가져오기' 교차 로드: 항상 project namespace 강제
    const key = sourceProjectId
      ? ESM.buildStorageKey('project', sourceProjectId)
      : getStorageKey();
    let raw;
    try {
      raw = localStorage.getItem(key);
    } catch (e) {
      console.error('[Entry Save Manager] 저장 데이터 읽기 실패:', e);
      return;
    }
    dlog('loadData — key:', key, 'raw:', raw ? `있음 (${raw.length}바이트)` : '없음');
    if (!raw) {
      if (sourceProjectId) {
        console.warn(`[Entry Save Manager] '@가져오기': 소스 작품(${sourceProjectId})의 저장 데이터 없음`);
      } else {
        info('저장된 데이터 없음:', key);
      }
      return;
    }

    // ── JSON 파싱 ──
    let data;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      console.error('[Entry Save Manager] 저장 데이터 파싱 실패 — 손상된 데이터일 수 있습니다:', e);
      return;
    }

    // ── 구조 검증 ──
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      console.error('[Entry Save Manager] 잘못된 데이터 형식(object 아님):', data);
      return;
    }

    info('저장된 데이터 로드:', data);

    const container = Entry.variableContainer;
    let varOk = 0, varSkip = 0, listOk = 0, listSkip = 0;

    // ── 변수 복원 ──
    if (Array.isArray(data.variables)) {
      const currentVars = container.variables_ || [];
      data.variables.forEach((saved) => {
        try {
          if (!saved || typeof saved !== 'object') {
            varSkip++; return;
          }
          if (typeof saved.name !== 'string' || !saved.name.startsWith(PREFIX)) {
            debug('변수 스킵 — 이름 유효성 실패:', saved && saved.name);
            varSkip++; return;
          }
          if (ESM.isReservedVariableName(saved.name)) {
            debug('변수 스킵 — 예약 변수:', saved.name);
            varSkip++; return;
          }
          if (!isValidVariableValue(saved.value)) {
            console.warn(`[Entry Save Manager] 변수 스킵 — 허용되지 않는 값 타입: ${saved.name} (${typeof saved.value})`);
            varSkip++; return;
          }
          const target = currentVars.find(
            (v) => typeof v.name_ === 'string'
              && v.name_.startsWith(PREFIX)
              && !ESM.isReservedVariableName(v.name_)
              && (sourceProjectId ? v.name_ === saved.name
                : v.id_ === saved.id || v.name_ === saved.name)
          );
          if (!target) { varSkip++; return; }
          if (typeof target.setValue !== 'function') {
            debug('변수 스킵 — setValue 없음:', saved.name);
            varSkip++; return;
          }
          target.setValue(saved.value);
          varOk++;
          info(`변수 복원: ${saved.name} = ${saved.value}`);
        } catch (e) {
          console.error(`[Entry Save Manager] 변수 복원 실패 (${saved && saved.name}):`, e);
          varSkip++;
        }
      });
    }

    // ── 리스트 복원 ──
    if (Array.isArray(data.lists)) {
      const currentLists = container.lists_ || [];
      data.lists.forEach((saved) => {
        try {
          if (!saved || typeof saved !== 'object') {
            listSkip++; return;
          }
          if (typeof saved.name !== 'string' || !saved.name.startsWith(PREFIX)) {
            debug('리스트 스킵 — 이름 유효성 실패:', saved && saved.name);
            listSkip++; return;
          }
          if (!Array.isArray(saved.array)) {
            console.warn(`[Entry Save Manager] 리스트 스킵 — array 필드가 배열 아님: ${saved.name}`);
            listSkip++; return;
          }
          const target = currentLists.find(
            (l) => typeof l.name_ === 'string'
              && l.name_.startsWith(PREFIX)
              && (sourceProjectId ? l.name_ === saved.name
                : l.id_ === saved.id || l.name_ === saved.name)
          );
          if (!target) { listSkip++; return; }

          const sanitized = saved.array.filter(isValidListItem);
          if (sanitized.length !== saved.array.length) {
            console.warn(`[Entry Save Manager] 리스트 ${saved.name}: 허용되지 않는 타입 ${saved.array.length - sanitized.length}개 제거`);
          }
          target.array_ = sanitized.map((item) => ({ data: item }));
          listOk++;
          info(`리스트 복원: ${saved.name} (${sanitized.length}개 항목)`);
        } catch (e) {
          console.error(`[Entry Save Manager] 리스트 복원 실패 (${saved && saved.name}):`, e);
          listSkip++;
        }
      });
    }

    debug(`로드 결과 — 변수: ${varOk} 복원 / ${varSkip} 스킵, 리스트: ${listOk} 복원 / ${listSkip} 스킵`);
  }

  // ─────────────────────────────────────────────
  //  '@확장프로그램' 변수 설정
  // ─────────────────────────────────────────────

  function setExtensionStatusFlag() {
    const container = Entry.variableContainer;
    const vars = container.variables_ || [];
    const statusVar = vars.find((v) => v.name_ === STATUS_VAR_NAME);
    if (statusVar) {
      statusVar.setValue(1);
      info('확장프로그램 상태 변수 설정: 1');
    } else {
      // '@확장프로그램' 변수가 없는 작품도 흔함 — 운영 모드에서는 침묵
      debug(`'${STATUS_VAR_NAME}' 변수를 찾을 수 없습니다.`);
    }
  }

  // ─────────────────────────────────────────────
  //  엔진 상태 감시 — 실행 시마다 데이터 로드
  // ─────────────────────────────────────────────

  function cancelPendingLoad() {
    if (runSession && runSession.timer !== null) {
      clearTimeout(runSession.timer);
      runSession.timer = null;
    }
  }

  // toggleRun과 폴링이 같은 실행 세션을 공유한다. pause→run은 새 실행이 아니다.
  function observeEngineState(engine) {
    if (disposed || !engine || engine !== (window.Entry && Entry.engine)) return;
    const state = engine.state;
    const stopped = (value) => value === 'stop' || value === 'stopping';
    if (!runSession || runSession.engine !== engine
        || (stopped(state) && !stopped(runSession.state))) {
      cancelPendingLoad();
      runSession = { engine, state, loaded: false, timer: null };
    }
    runSession.state = state;
    if (state !== 'run') {
      cancelPendingLoad();
      return;
    }
    if (runSession.loaded || runSession.timer !== null) return;
    const session = runSession;
    session.timer = setTimeout(() => {
      session.timer = null;
      if (disposed || runSession !== session || Entry.engine !== engine
          || engine.state !== 'run') return;
      session.loaded = true;
      loadData();
      setExtensionStatusFlag();
    }, STATE_CHECK_DELAY);
  }

  function releaseEngineHook() {
    if (hookedEngine && hookedEngine.toggleRun === toggleRunWrapper) {
      hookedEngine.toggleRun = originalToggleRun;
    }
    hookedEngine = null;
    originalToggleRun = null;
    toggleRunWrapper = null;
  }

  /** 새 engine을 폴링과 동일한 실행 세션 감시에 연결한다. */
  function hookEngineToggleRun(engine) {
    if (!engine || typeof engine.toggleRun !== 'function') return;
    if (engine === hookedEngine) return;
    releaseEngineHook();
    const original = engine.toggleRun;
    const wrapper = function (...args) {
      if (!disposed) {
        // 다음 500ms 폴링 전 실행하더라도 새 함수가 첫 호출부터 연결되도록 한다.
        hookFunctionCalls();
        observeEngineState(engine);
      }
      const result = original.apply(this, args);
      observeEngineState(engine);
      return result;
    };
    wrapper._isSaveMgrEngineHook = true;
    engine.toggleRun = wrapper;
    originalToggleRun = original;
    hookedEngine = engine;
    toggleRunWrapper = wrapper;
    info('toggleRun 후킹 완료');
  }

  /**
   * Entry 엔진의 상태 변화를 지속적으로 감시합니다.
   * 엔진이 'run' 상태로 전환될 때마다 loadData()를 호출합니다.
   * - /ws/ 페이지: Play 버튼 클릭 시 (toggleRun 후킹)
   * - /project/ 페이지: 자동 실행 시 초기 'run' 감지 + 재실행 감지 (폴링)
   * 정지 후 재실행 시에도 매번 데이터를 불러옵니다.
   */
  function watchEngineState() {
    const check = () => {
      if (disposed) return;
      hookFunctionCalls();
      const eng = window.Entry && Entry.engine;
      if (!eng) {
        cancelPendingLoad();
        runSession = null;
        return;
      }
      hookEngineToggleRun(eng);
      observeEngineState(eng);
    };
    check();
    if (enginePollTimer) clearInterval(enginePollTimer);
    enginePollTimer = setInterval(check, POLL_INTERVAL);
  }

  /**
   * Entry 함수 content에서 함수 이름(라벨)을 추출합니다.
   * 본문의 문자열은 읽지 않고 함수 정의의 제목 연결만 따라갑니다.
   */
  function extractFunctionName(funcObj) {
    try {
      if (!funcObj || !funcObj.content) return '';
      const content = funcObj.content;
      let definition;
      if (typeof content.getEventMap === 'function') {
        definition = content.getEventMap('funcDef')[0];
      } else {
        let json = typeof content.toJSON === 'function' ? content.toJSON() : content;
        if (typeof json === 'string') json = JSON.parse(json);
        const blocks = Array.isArray(json) ? json.flat() : [json];
        definition = blocks.find((block) => block && (
          block.type === 'function_create' || block.type === 'function_create_value'
        ));
      }
      let field = definition && definition.params && definition.params[0];
      const labels = [];
      const seen = new Set();
      while (field && !seen.has(field)) {
        seen.add(field);
        if (field.type === 'function_field_label') {
          if (!field.params || typeof field.params[0] !== 'string') return '';
          labels.push(field.params[0]);
        }
        field = typeof field.getOutputBlock === 'function'
          ? field.getOutputBlock() : field.params && field.params[1];
      }
      return labels.join(' ').trim();
    } catch (e) {
      return '';
    }
  }

  /**
   * 주어진 이름과 일치하는 Entry 함수의 ID를 찾습니다.
   * 제목 라벨 전체가 정확히 일치하는 함수만 사용합니다.
   */
  function findFunctionIdByName(targetName) {
    const functions = Entry.variableContainer && Entry.variableContainer.functions_;
    if (!functions) {
      debug('functions_ 없음');
      return null;
    }

    const funcEntries = Object.entries(functions);

    // 정확한 제목 매칭
    for (const [funcId, funcObj] of funcEntries) {
      const name = extractFunctionName(funcObj);
      if (name === targetName) {
        debug(`이름 매칭: "${targetName}" → id=${funcId}`);
        return funcId;
      }
    }

    debug(`"${targetName}" 함수를 찾지 못했습니다.`);
    return null;
  }

  /**
   * 함수 정의의 paramMap에서 stringParam_* 접두사 키를 우선 추출합니다.
   * 실측: Entry.block['func_<id>']에는 paramMap이 없으므로
   *       variableContainer에서 가져와야 합니다.
   */
  function getFuncParamKey(funcId) {
    const vc = Entry.variableContainer;
    const fn = (vc && typeof vc.getFunction === 'function')
      ? vc.getFunction(funcId)
      : (vc && vc.functions_ && vc.functions_[funcId]);
    if (!fn || !fn.paramMap) return { paramMap: null, paramKey: null };
    const keys = Object.keys(fn.paramMap);
    const paramKey = keys.find(k => k.startsWith('stringParam')) || keys[0] || null;
    return { paramMap: fn.paramMap, paramKey };
  }

  /**
   * 호출 블록 인스턴스(this)에서 평가된 인자 값을 안전하게 추출합니다.
   * Entry 런타임이 this.values에 평가 완료된 인자 배열을 채워둔 상태를 이용.
   */
  function readCallBlockArg(callBlockInstance, paramMap, paramKey) {
    if (!callBlockInstance || !paramMap || !paramKey) return null;
    const idx = paramMap[paramKey];
    if (typeof idx !== 'number') return null;
    const values = callBlockInstance.values;
    if (!values || idx >= values.length) return null;
    const v = values[idx];
    if (v === null || v === undefined) return null;
    return String(v).trim();
  }

  /**
   * 블록 트리에서 호출 블록의 리터럴 파라미터만 잡는 best-effort fallback.
   * 변수/계산식이 꽂힌 경우엔 null. this.values가 비어있는 예외 상황용.
   */
  function readCallBlockLiteralStatic(blockType) {
    try {
      const objs = Entry.container && Entry.container.objects_;
      if (!objs) return null;
      for (const o of objs) {
        const threads = o.script && typeof o.script.getThreads === 'function'
          ? o.script.getThreads() : [];
        for (const t of threads) {
          const blocks = typeof t.getBlocks === 'function' ? t.getBlocks() : [];
          for (const b of blocks) {
            if (b.type === blockType) {
              const literal = b.params && b.params[0] && b.params[0].params && b.params[0].params[0];
              if (literal != null) return String(literal).trim();
            }
          }
        }
      }
    } catch (_) { /* ignore */ }
    return null;
  }

  function isValidProjectId(id) {
    return typeof id === 'string' && /^[a-f0-9]{8,}$/i.test(id);
  }

  function releaseFunctionHook(hook) {
    // 다른 확장이 우리 래퍼를 감쌌어도 기존 래퍼는 저장·로드를 다시 실행하지 않는다.
    hook.active = false;
    if (hook.schema.func === hook.wrapper) {
      if (hook.hadOwnFunc) hook.schema.func = hook.original;
      else delete hook.schema.func;
    }
  }

  function invokeLoad(funcId, callBlock) {
    try {
      // 함수 편집으로 paramMap이 교체될 수 있으므로 호출 시점에 읽는다.
      const { paramMap, paramKey } = getFuncParamKey(funcId);
      let sourceId = readCallBlockArg(callBlock, paramMap, paramKey);
      if (sourceId == null) sourceId = readCallBlockLiteralStatic('func_' + funcId);
      if (!sourceId || !isValidProjectId(sourceId)) {
        console.warn('[Entry Save Manager] "@가져오기": 유효한 프로젝트 ID를 읽을 수 없음');
      } else if (sourceId === getProjectId()) {
        loadData();
      } else {
        loadData(sourceId);
      }
    } catch (e) {
      console.error('[Entry Save Manager] "@가져오기" 처리 오류:', e);
    }
  }

  // 제한된 재시도 대신 현재 함수 이름·ID·스키마를 지속적으로 확인한다.
  function hookFunctionCalls() {
    if (disposed || !window.Entry || !Entry.variableContainer) return;
    for (const name of [SAVE_FUNC_NAME, LOAD_FUNC_NAME]) {
      const funcId = findFunctionIdByName(name);
      const schema = funcId && Entry.block && Entry.block['func_' + funcId];
      const previous = functionHooks.get(name);
      if (previous && previous.funcId === funcId && previous.schema === schema
          && schema.func === previous.wrapper) continue;
      if (previous) {
        releaseFunctionHook(previous);
        functionHooks.delete(name);
      }
      if (!schema || typeof schema.func !== 'function') continue;
      const hook = {
        funcId, schema, original: schema.func, active: true,
        hadOwnFunc: Object.prototype.hasOwnProperty.call(schema, 'func'),
      };
      hook.wrapper = function (...args) {
        // 해제된 래퍼는 SPA 이동으로 Entry가 사라져도 원래 호출만 전달한다.
        if (!disposed && hook.active && window.Entry) {
          const functions = Entry.variableContainer && Entry.variableContainer.functions_;
          // 이름 변경 직후, 다음 폴링 전 호출도 잘못된 저장을 일으키지 않는다.
          if (extractFunctionName(functions && functions[funcId]) === name) {
            if (name === SAVE_FUNC_NAME) saveData();
            else invokeLoad(funcId, this);
          }
        }
        return hook.original.apply(this, args);
      };
      hook.wrapper._isSaveMgrHook = true;
      schema.func = hook.wrapper;
      functionHooks.set(name, hook);
    }
  }

  // ─────────────────────────────────────────────
  //  URL 변경 시 정리 (SPA 대응)
  // ─────────────────────────────────────────────
  //  content.js가 URL 변경을 감지하면 URL_CHANGED 메시지를 보냅니다.
  //  기존 폴링을 정리하고 플래그를 리셋하여 재주입 시 재초기화를 허용합니다.

  function onMessage(event) {
    if (disposed) return;
    const data = event.data;
    if (!data || data.type !== 'ENTRY_SAVE_MANAGER') return;

    // ── 부모 frame으로부터 PAGE_TYPE 응답 ──
    if (data.action === 'PAGE_TYPE') {
      const fromParent = (event.source === window.parent);
      dlog('PAGE_TYPE 메시지 수신 — pt:', data.pageType, 'fromParent:', fromParent,
           'sourceIsSelf:', event.source === window);
      if (!fromParent) {
        dlog('  → 부모가 아닌 source — 무시');
        return;
      }
      const pt = data.pageType;
      if ((pt === 'ws' || pt === 'project')) {
        const changed = pt !== pageType;
        pageType = pt;
        pageTypeResolved = true;
        dlog('  → pageType 적용:', pt, changed ? '(변경됨)' : '(이미 동일)');
      } else {
        dlog('  → 잘못된 pageType 값 — 무시');
      }
      return;
    }

    // ── URL 변경 (자기 frame 내부 메시지) ──
    if (event.source !== window) return;
    if (data.action !== 'URL_CHANGED') return;

    debug('URL 변경 감지 — 폴링 및 후킹 정리');
    if (enginePollTimer) {
      clearInterval(enginePollTimer);
      enginePollTimer = null;
    }
    if (pageTypeHandshakeTimer) {
      clearInterval(pageTypeHandshakeTimer);
      pageTypeHandshakeTimer = null;
    }
    // pageType 재결정: 자기 pathname이 ws/project이면 그걸로, 아니면 부모에 재요청
    pageType = ESM.getPageTypeFromPathname(location.pathname);
    pageTypeResolved = pageType !== null;

    disposed = true;
    cancelPendingLoad();
    runSession = null;
    releaseEngineHook();
    for (const hook of functionHooks.values()) releaseFunctionHook(hook);
    functionHooks.clear();
    window.removeEventListener('message', onMessage);

    window.__entrySaveManagerLoaded = false;
  }
  window.addEventListener('message', onMessage);

  // ─────────────────────────────────────────────
  //  초기화 (메인 로직)
  // ─────────────────────────────────────────────

  async function init() {
    info('Entry 객체 대기 중...');
    try {
      await waitForEntry();
    } catch (e) {
      // top frame에 Entry가 없는 경우(/project/, /ws/는 자식 iframe에 런타임이 있음)
      // → 조용히 종료. 같은 페이지의 자식 iframe inject.js가 동작을 담당.
      debug('init: Entry 미발견으로 종료 —', e.message);
      return;
    }
    if (disposed) return;
    info('Entry 준비 완료. Project ID:', Entry.projectId);

    // Entry 객체 상태 출력
    if (DEBUG) {
      debug('===== Entry 객체 상태 =====');
      debug('Entry.engine:', !!Entry.engine);
      debug('Entry.engine.state:', Entry.engine ? Entry.engine.state : '(없음)');
      debug('Entry.variableContainer.functions_:', Entry.variableContainer.functions_ ? Object.keys(Entry.variableContainer.functions_).length + '개' : '(없음)');
      debug('Entry.block:', !!Entry.block);
      debug('func_ 블록:', Entry.block ? Object.keys(Entry.block).filter(k => k.startsWith('func_')) : '(없음)');
      debug('기존 저장 데이터:', localStorage.getItem(getStorageKey()) ? '있음' : '없음');
      debug('========================');
    }

    // 함수 연결과 실행 세션을 함께 지속 감시한다.
    watchEngineState();

    info('초기화 완료 ✓');
  }

  // ── Entry 준비 완료 후 초기화 시작 ──
  init();
})();
