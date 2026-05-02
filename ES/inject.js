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
  const PREFIX = '@';                      // 추적 대상 변수/리스트 접두사
  const SAVE_FUNC_NAME = '@저장';          // 저장 트리거 함수 이름
  const LOAD_FUNC_NAME = '@가져오기';      // 교차 작품 데이터 가져오기 트리거
  const STATUS_VAR_NAME = '@확장프로그램'; // 확장프로그램 설치 확인 변수
  const STORAGE_KEY_PREFIX = ESM.STORAGE_KEY_PREFIX;

  // 타이밍 상수 (ms)
  const POLL_INTERVAL = 500;               // Entry 객체 / 엔진 상태 폴링 간격
  const STATE_CHECK_DELAY = 300;           // 상태 전이 후 확인 딜레이
  const HOOK_RETRY_MAX = 20;              // 함수 후킹 최대 재시도 (POLL_INTERVAL × N)

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

  // toggleRun 후킹 원본 참조 (URL 변경 시 복구용)
  let originalToggleRun = null;
  let hookedEngine = null;

  // '@저장' 함수 블록 후킹 원본 참조 (URL 변경 시 복구용)
  let hookedSaveBlockKey = null;
  let originalSaveBlockFunc = null;

  // '@가져오기' 함수 블록 후킹 원본 참조
  let hookedLoadBlockKey = null;
  let originalLoadBlockFunc = null;

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

  // 부모가 없는 경우(top frame인데 /ws/도 /project/도 아님)에는 핸드셰이크 불필요 → 'ws' 폴백
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
          dlog('핸드셰이크 타임아웃 (' + HANDSHAKE_MAX_ATTEMPTS + '회 시도) — \'ws\' 폴백 사용 예정');
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
    dlog('pageType 미해결이지만 부모 없음 → \'ws\' 폴백 사용');
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
    const filtered = vars.filter((v) => v.name_ && v.name_.startsWith(PREFIX));
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
   * Entry의 변수는 number/string만 허용하며 객체/배열/함수는 주입 위험.
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
    const raw = localStorage.getItem(key);
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
          if (!isValidVariableValue(saved.value)) {
            console.warn(`[Entry Save Manager] 변수 스킵 — 허용되지 않는 값 타입: ${saved.name} (${typeof saved.value})`);
            varSkip++; return;
          }
          const target = currentVars.find(
            (v) => v.id_ === saved.id || v.name_ === saved.name
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
            (l) => l.id_ === saved.id || l.name_ === saved.name
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

  /**
   * Entry 엔진의 상태 변화를 지속적으로 감시합니다.
   * 엔진이 'run' 상태로 전환될 때마다 loadData()를 호출합니다.
   * - /ws/ 페이지: Play 버튼 클릭 시 (toggleRun 후킹)
   * - /project/ 페이지: 자동 실행 시 초기 'run' 감지 + 재실행 감지 (폴링)
   * 정지 후 재실행 시에도 매번 데이터를 불러옵니다.
   */
  function watchEngineState() {
    if (!Entry.engine) {
      console.warn('[Entry Save Manager] Entry.engine을 찾을 수 없습니다.');
      return;
    }

    let prevState = Entry.engine.state || 'stop';
    dlog(`watchEngineState 시작 — 초기 상태: ${prevState}, pageType:`, pageType, 'resolved:', pageTypeResolved);

    // ── 초기 진입 시 이미 'run' 상태인 경우 (예: /project/ 자동 실행) ──
    //  폴링/toggleRun 후킹으로는 전이를 감지할 수 없으므로 즉시 초기 로드 수행
    if (prevState === 'run') {
      info('진입 시 이미 실행 중 — 초기 로드');
      setTimeout(() => {
        loadData();
        setExtensionStatusFlag();
      }, STATE_CHECK_DELAY);
    }

    // ── 방법 1: toggleRun 후킹 (즉각 감지) ──
    if (Entry.engine.toggleRun && !originalToggleRun) {
      originalToggleRun = Entry.engine.toggleRun;
      hookedEngine = Entry.engine;
      const boundOriginal = originalToggleRun.bind(Entry.engine);
      Entry.engine.toggleRun = function (...args) {
        const result = boundOriginal(...args);

        // toggleRun 후 약간의 딜레이를 두고 상태 확인
        setTimeout(() => {
          const newState = Entry.engine.state;
          debug(`toggleRun 후 상태: ${prevState} → ${newState}`);
          if (newState === 'run') {
            info('실행 시작 감지 — 데이터 로드');
            loadData();
            setExtensionStatusFlag();
          }
          prevState = newState;
        }, STATE_CHECK_DELAY);

        return result;
      };
      info('toggleRun 후킹 완료');
    }

    // ── 방법 2: 상태 폴링 (자동 실행 및 폴백) ──
    if (enginePollTimer) clearInterval(enginePollTimer);
    enginePollTimer = setInterval(() => {
      const currentState = Entry.engine.state;

      // non-run → run 전이 감지
      if (currentState === 'run' && prevState !== 'run') {
        debug(`엔진 상태 전이 감지: ${prevState} → ${currentState}`);
        info('실행 시작 감지(폴링) — 데이터 로드');
        setTimeout(() => {
          loadData();
          setExtensionStatusFlag();
        }, STATE_CHECK_DELAY);
      }

      prevState = currentState;
    }, POLL_INTERVAL);
  }

  /**
   * Entry 함수 content에서 함수 이름(라벨)을 추출합니다.
   * JSON.stringify 후 정규식 또는 문자열 검색으로 추출합니다.
   */
  function extractFunctionName(funcObj) {
    try {
      if (!funcObj || !funcObj.content) return '';
      const jsonStr = JSON.stringify(funcObj.content);
      const matches = [];
      const regex = /"type"\s*:\s*"function_field_label"\s*,\s*"params"\s*:\s*\[\s*"([^"]+)"/g;
      let match;
      while ((match = regex.exec(jsonStr)) !== null) {
        matches.push(match[1]);
      }
      return matches.join(' ').trim();
    } catch (e) {
      return '';
    }
  }

  /**
   * 주어진 이름과 일치하는 Entry 함수의 ID를 찾습니다.
   * extractFunctionName으로 먼저 시도하고, 실패 시 JSON 직접 검색합니다.
   */
  function findFunctionIdByName(targetName) {
    const functions = Entry.variableContainer && Entry.variableContainer.functions_;
    if (!functions) {
      debug('functions_ 없음');
      return null;
    }

    const funcEntries = Object.entries(functions);

    // 방법 1: 이름 추출 매칭
    for (const [funcId, funcObj] of funcEntries) {
      const name = extractFunctionName(funcObj);
      if (name === targetName) {
        debug(`이름 매칭: "${targetName}" → id=${funcId}`);
        return funcId;
      }
    }

    // 방법 2: JSON 직접 검색
    for (const [funcId, funcObj] of funcEntries) {
      try {
        if (JSON.stringify(funcObj.content).includes(targetName)) {
          debug(`JSON 검색: "${targetName}" → id=${funcId}`);
          return funcId;
        }
      } catch (e) { /* ignore */ }
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

  /**
   * '@저장' 함수 블록을 후킹합니다. 성공 시 true.
   * 이미 다른 인스턴스가 후킹했거나(signature 체크) 스키마가 준비 안 되면 스킵.
   */
  function tryHookSave(funcId) {
    const blockKey = 'func_' + funcId;
    const schema = Entry.block && Entry.block[blockKey];
    if (!schema || !schema.func) return false;
    if (schema.func._isSaveMgrHook) {
      debug(`@저장: 이미 다른 인스턴스가 후킹 — ${blockKey}`);
      return true;
    }
    if (hookedSaveBlockKey === blockKey && originalSaveBlockFunc) return true;

    const origFunc = schema.func;
    hookedSaveBlockKey = blockKey;
    originalSaveBlockFunc = origFunc;

    const wrapper = function (sprite, script) {
      info('"@저장" 함수 호출 감지!');
      saveData();
      return origFunc.call(this, sprite, script);
    };
    wrapper._isSaveMgrHook = true;
    schema.func = wrapper;
    info(`"@저장" 함수 블록 (${blockKey}) 후킹 완료 ✓`);
    return true;
  }

  /**
   * '@가져오기' 함수 블록을 후킹합니다. 성공 시 true.
   */
  function tryHookLoad(funcId) {
    const blockKey = 'func_' + funcId;
    const schema = Entry.block && Entry.block[blockKey];
    if (!schema || !schema.func) return false;
    if (schema.func._isSaveMgrHook) {
      debug(`@가져오기: 이미 다른 인스턴스가 후킹 — ${blockKey}`);
      return true;
    }
    if (hookedLoadBlockKey === blockKey && originalLoadBlockFunc) return true;

    const { paramMap, paramKey } = getFuncParamKey(funcId);
    if (!paramMap || !paramKey) {
      console.warn('[Entry Save Manager] "@가져오기" 함수의 paramMap 없음 — 동작 불가');
      return false;
    }

    const origFunc = schema.func;
    hookedLoadBlockKey = blockKey;
    originalLoadBlockFunc = origFunc;

    const wrapper = function (sprite, script) {
      try {
        // 1차: 호출 블록 인스턴스의 평가된 인자
        let sourceId = readCallBlockArg(this, paramMap, paramKey);
        // 2차: 정적 리터럴 fallback
        if (sourceId == null) {
          sourceId = readCallBlockLiteralStatic(blockKey);
          if (sourceId != null) debug('"@가져오기": this.values 비어있음 — 정적 리터럴 사용');
        }

        if (!sourceId) {
          console.warn('[Entry Save Manager] "@가져오기": 파라미터 값을 읽을 수 없음');
        } else if (!isValidProjectId(sourceId)) {
          console.warn(`[Entry Save Manager] "@가져오기": 유효하지 않은 프로젝트 ID — "${sourceId}"`);
        } else if (sourceId === getProjectId()) {
          debug('"@가져오기": 자기 자신 ID → 현재 저장본 재로드');
          loadData();
        } else {
          info(`"@가져오기" 호출 — 소스 ID: ${sourceId}`);
          loadData(sourceId);
        }
      } catch (e) {
        console.error('[Entry Save Manager] "@가져오기" 처리 오류:', e);
      }
      return origFunc.call(this, sprite, script);
    };
    wrapper._isSaveMgrHook = true;
    schema.func = wrapper;
    info(`"@가져오기" 함수 블록 (${blockKey}, param=${paramKey}) 후킹 완료 ✓`);
    return true;
  }

  /**
   * '@저장' / '@가져오기' 함수 호출을 후킹합니다.
   * 함수 블록이 아직 등록되지 않았으면 폴링으로 재시도합니다.
   * 둘 중 하나만 있어도 정상 동작합니다.
   */
  async function hookFunctionCalls() {
    let saveDone = !!hookedSaveBlockKey;
    let loadDone = !!hookedLoadBlockKey;

    for (let attempt = 1; attempt <= HOOK_RETRY_MAX; attempt++) {
      debug(`hookFunctionCalls() 시도 #${attempt} — save:${saveDone}, load:${loadDone}`);

      if (!saveDone) {
        const id = findFunctionIdByName(SAVE_FUNC_NAME);
        if (id && tryHookSave(id)) saveDone = true;
      }
      if (!loadDone) {
        const id = findFunctionIdByName(LOAD_FUNC_NAME);
        if (id && tryHookLoad(id)) loadDone = true;
      }
      if (saveDone && loadDone) return;

      await new Promise(r => setTimeout(r, POLL_INTERVAL));
    }

    if (!saveDone) {
      console.error('[Entry Save Manager] "@저장" 함수 후킹 최대 재시도 초과');
    }
    if (!loadDone) {
      // "@가져오기"는 선택 기능 — 함수 미정의가 흔한 케이스이므로 운영 모드에서는 침묵
      debug('"@가져오기" 미후킹 (함수 없거나 스키마 문제 — 선택 기능이므로 무시 가능)');
    }
    if (DEBUG && Entry.block) {
      const funcKeys = Object.keys(Entry.block).filter(k => k.startsWith('func_'));
      debug('최종 Entry.block func_ 키:', funcKeys);
    }
  }

  // ─────────────────────────────────────────────
  //  URL 변경 시 정리 (SPA 대응)
  // ─────────────────────────────────────────────
  //  content.js가 URL 변경을 감지하면 URL_CHANGED 메시지를 보냅니다.
  //  기존 폴링을 정리하고 플래그를 리셋하여 재주입 시 재초기화를 허용합니다.

  window.addEventListener('message', (event) => {
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

    // toggleRun 후킹 복구
    if (hookedEngine && originalToggleRun) {
      try {
        hookedEngine.toggleRun = originalToggleRun;
        debug('toggleRun 원본 복구 완료');
      } catch (e) {
        debug('toggleRun 복구 실패:', e);
      }
      hookedEngine = null;
      originalToggleRun = null;
    }

    // '@저장' 함수 블록 후킹 복구 (signature 체크로 자기 래퍼만 복구)
    if (hookedSaveBlockKey && originalSaveBlockFunc && window.Entry && Entry.block && Entry.block[hookedSaveBlockKey]) {
      try {
        const curFunc = Entry.block[hookedSaveBlockKey].func;
        if (curFunc && curFunc._isSaveMgrHook) {
          Entry.block[hookedSaveBlockKey].func = originalSaveBlockFunc;
          debug(`'@저장' 블록(${hookedSaveBlockKey}) 원본 복구 완료`);
        } else {
          debug(`'@저장' 블록(${hookedSaveBlockKey}) 이미 교체됨 — 복구 스킵`);
        }
      } catch (e) {
        debug('@저장 블록 복구 실패:', e);
      }
    }
    hookedSaveBlockKey = null;
    originalSaveBlockFunc = null;

    // '@가져오기' 함수 블록 후킹 복구
    if (hookedLoadBlockKey && originalLoadBlockFunc && window.Entry && Entry.block && Entry.block[hookedLoadBlockKey]) {
      try {
        const curFunc = Entry.block[hookedLoadBlockKey].func;
        if (curFunc && curFunc._isSaveMgrHook) {
          Entry.block[hookedLoadBlockKey].func = originalLoadBlockFunc;
          debug(`'@가져오기' 블록(${hookedLoadBlockKey}) 원본 복구 완료`);
        } else {
          debug(`'@가져오기' 블록(${hookedLoadBlockKey}) 이미 교체됨 — 복구 스킵`);
        }
      } catch (e) {
        debug('@가져오기 블록 복구 실패:', e);
      }
    }
    hookedLoadBlockKey = null;
    originalLoadBlockFunc = null;

    window.__entrySaveManagerLoaded = false;
  });

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

    // 1) 함수 호출 후킹 (저장 트리거 — '@저장' 함수)
    //    폴링 방식으로 함수/블록이 준비될 때까지 재시도
    hookFunctionCalls();

    // 2) 엔진 상태 감시 — 매 실행 시 데이터 로드 (모든 페이지 공통)
    watchEngineState();

    info('초기화 완료 ✓');
  }

  // ── Entry 준비 완료 후 초기화 시작 ──
  init();
})();
