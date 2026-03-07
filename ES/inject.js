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
 * ============================================================
 */

(function () {
  'use strict';

  // ─────────────────────────────────────────────
  //  상수 정의
  // ─────────────────────────────────────────────
  const PREFIX = '@';                      // 추적 대상 변수/리스트 접두사
  const SAVE_FUNC_NAME = '@저장';          // 저장 트리거 함수 이름
  const STATUS_VAR_NAME = '@확장프로그램'; // 확장프로그램 설치 확인 변수
  const STORAGE_KEY_PREFIX = 'entry_save_'; // localStorage 키 접두사

  // 중복 초기화 방지 플래그
  if (window.__entrySaveManagerLoaded) return;
  window.__entrySaveManagerLoaded = true;

  // 페이지 타입 판별 (/project/ 및 /iframe/ 둘 다 작품 실행 페이지)
  const isProjectPage = location.pathname.startsWith('/project/') || location.pathname.startsWith('/iframe/');
  const isWorkspacePage = location.pathname.startsWith('/ws/');

  /**
   * URL 경로에서 프로젝트 ID를 추출합니다.
   * /ws/xxx, /project/xxx, /iframe/xxx 형태에서 xxx를 반환합니다.
   */
  function getProjectIdFromUrl() {
    const match = location.pathname.match(/\/(ws|project|iframe)\/([a-f0-9]+)/);
    return match ? match[2] : null;
  }

  /**
   * 프로젝트 ID를 반환합니다. Entry.projectId 우선, 없으면 URL에서 추출.
   */
  function getProjectId() {
    return (window.Entry && window.Entry.projectId) || getProjectIdFromUrl();
  }

  console.log('[Entry Save Manager] inject.js 로드됨 (MAIN world)');
  console.log(`[DEBUG] 페이지 타입: ${isProjectPage ? '/project/' : isWorkspacePage ? '/ws/' : '기타'} — URL: ${location.href}`);

  // ─────────────────────────────────────────────
  //  유틸리티 함수
  // ─────────────────────────────────────────────

  /**
   * Entry 객체가 준비될 때까지 폴링 방식으로 대기합니다.
   * /project/ 페이지에서는 Entry.engine과 block까지 대기합니다.
   * @returns {Promise<void>}
   */
  function waitForEntry() {
    return new Promise((resolve) => {
      let pollCount = 0;
      const check = () => {
        pollCount++;

        // 기본 체크
        const hasEntry = !!window.Entry;
        const hasVC = !!(window.Entry && window.Entry.variableContainer);
        const hasPid = !!(window.Entry && window.Entry.projectId) || !!getProjectIdFromUrl();
        const hasEngine = !!(window.Entry && window.Entry.engine);
        const hasBlock = !!(window.Entry && window.Entry.block);

        if (pollCount <= 5 || pollCount % 10 === 0) {
          console.log(`[DEBUG] waitForEntry 폴링 #${pollCount} — Entry:${hasEntry}, vc:${hasVC}, pid:${hasPid}(${getProjectId()||""}), engine:${hasEngine}, block:${hasBlock}`);
        }

        // 5번째 폴링에서 진단 정보 출력
        if (pollCount === 5 && !hasEntry) {
          console.log('[DEBUG] ===== Entry 미발견 진단 =====');

          // iframe 검색
          const iframes = document.querySelectorAll('iframe');
          console.log('[DEBUG] iframe 개수:', iframes.length);
          iframes.forEach((iframe, i) => {
            try {
              const iframeEntry = iframe.contentWindow && iframe.contentWindow.Entry;
              console.log(`[DEBUG]   iframe[${i}] src:${iframe.src}, Entry:${!!iframeEntry}`);
            } catch (e) {
              console.log(`[DEBUG]   iframe[${i}] src:${iframe.src}, 접근 불가 (cross-origin)`);
            }
          });

          // window 전역 변수 중 entry 관련 검색
          const entryRelated = Object.keys(window).filter(k =>
            /entry/i.test(k)
          );
          console.log('[DEBUG] window에서 entry 관련 키:', entryRelated);

          // #entryCanvas, .entryEngine 등 DOM 요소 검색
          const canvas = document.querySelector('#entryCanvas, canvas');
          console.log('[DEBUG] canvas 요소:', canvas ? canvas.id || canvas.tagName : '없음');

          console.log('[DEBUG] ========================');
        }

        // window.Entry가 있지만 다른 조건이 부족한 경우
        if (hasEntry && !hasVC && pollCount === 10) {
          console.log('[DEBUG] Entry 존재하지만 variableContainer 없음');
          console.log('[DEBUG] Entry 키:', Object.keys(window.Entry).slice(0, 30));
        }

        const basic = hasEntry && hasVC && hasPid;

        if (!basic) {
          setTimeout(check, 500);
          return;
        }

        // /project/ 페이지에서는 block과 engine도 대기
        if (isProjectPage) {
          if (!hasEngine || !hasBlock) {
            setTimeout(check, 500);
            return;
          }
        }

        console.log(`[DEBUG] waitForEntry 완료! (${pollCount}회 폴링)`);
        resolve();
      };
      check();
    });
  }

  /**
   * 현재 프로젝트에 대한 localStorage 키를 반환합니다.
   * @returns {string} 예: "entry_save_abc123"
   */
  function getStorageKey() {
    return STORAGE_KEY_PREFIX + getProjectId();
  }

  // ─────────────────────────────────────────────
  //  '@' 변수/리스트 필터 & 직렬화
  // ─────────────────────────────────────────────

  function getTargetVariables() {
    const container = Entry.variableContainer;
    const vars = container.variables_ || [];
    console.log('[DEBUG] 전체 변수 개수:', vars.length);
    const filtered = vars.filter((v) => v.name_ && v.name_.startsWith(PREFIX));
    console.log('[DEBUG] "@" 접두사 변수 개수:', filtered.length);
    return filtered.map((v) => ({
      id: v.id_,
      name: v.name_,
      value: v.value_,
    }));
  }

  function getTargetLists() {
    const container = Entry.variableContainer;
    const lists = container.lists_ || [];
    console.log('[DEBUG] 전체 리스트 개수:', lists.length);
    const filtered = lists.filter((l) => l.name_ && l.name_.startsWith(PREFIX));
    console.log('[DEBUG] "@" 접두사 리스트 개수:', filtered.length);
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
    console.log('[DEBUG] ===== saveData() 호출됨 =====');
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
      console.log('[DEBUG] 저장 검증 — 일치:', verify === jsonStr, '길이:', jsonStr.length);
      console.log('[Entry Save Manager] 데이터 저장 완료:', key);
    } catch (e) {
      console.error('[Entry Save Manager] 저장 실패:', e);
      console.error('[DEBUG] 저장 실패 스택:', e.stack);
    }
  }

  // ─────────────────────────────────────────────
  //  Load (불러오기)
  // ─────────────────────────────────────────────

  function loadData() {
    try {
      const key = getStorageKey();
      const raw = localStorage.getItem(key);
      if (!raw) {
        console.log('[Entry Save Manager] 저장된 데이터 없음:', key);
        return;
      }

      const data = JSON.parse(raw);
      console.log('[Entry Save Manager] 저장된 데이터 로드:', data);

      const container = Entry.variableContainer;

      // ── 변수 복원 ──
      if (data.variables && Array.isArray(data.variables)) {
        const currentVars = container.variables_ || [];
        data.variables.forEach((saved) => {
          const target = currentVars.find(
            (v) => v.id_ === saved.id || v.name_ === saved.name
          );
          if (target) {
            target.setValue(saved.value);
            console.log(`[Entry Save Manager] 변수 복원: ${saved.name} = ${saved.value}`);
          }
        });
      }

      // ── 리스트 복원 ──
      if (data.lists && Array.isArray(data.lists)) {
        const currentLists = container.lists_ || [];
        data.lists.forEach((saved) => {
          const target = currentLists.find(
            (l) => l.id_ === saved.id || l.name_ === saved.name
          );
          if (target && saved.array) {
            target.array_ = saved.array.map((item) => ({ data: item }));
            console.log(`[Entry Save Manager] 리스트 복원: ${saved.name} (${saved.array.length}개 항목)`);
          }
        });
      }
    } catch (e) {
      console.error('[Entry Save Manager] 로드 실패:', e);
    }
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
      console.log('[Entry Save Manager] 확장프로그램 상태 변수 설정: 1');
    } else {
      console.warn(`[Entry Save Manager] '${STATUS_VAR_NAME}' 변수를 찾을 수 없습니다.`);
    }
  }

  // ─────────────────────────────────────────────
  //  엔진 상태 감시 — 실행 시마다 데이터 로드
  // ─────────────────────────────────────────────

  /**
   * Entry 엔진의 상태 변화를 지속적으로 감시합니다.
   * 엔진이 'run' 상태로 전환될 때마다 loadData()를 호출합니다.
   * - /ws/ 페이지: Play 버튼 클릭 시 (toggleRun 후킹)
   * - /project/ 페이지: 자동 실행 및 재실행 감지 (폴링)
   * 정지 후 재실행 시에도 매번 데이터를 불러옵니다.
   */
  function watchEngineState() {
    if (!Entry.engine) {
      console.warn('[Entry Save Manager] Entry.engine을 찾을 수 없습니다.');
      return;
    }

    let prevState = Entry.engine.state || 'stop';
    console.log(`[DEBUG] watchEngineState 시작 — 초기 상태: ${prevState}`);

    // ── 방법 1: toggleRun 후킹 (즉각 감지) ──
    if (Entry.engine.toggleRun) {
      const originalToggleRun = Entry.engine.toggleRun.bind(Entry.engine);
      Entry.engine.toggleRun = function (...args) {
        const result = originalToggleRun(...args);

        // toggleRun 후 약간의 딜레이를 두고 상태 확인
        setTimeout(() => {
          const newState = Entry.engine.state;
          console.log(`[DEBUG] toggleRun 후 상태: ${prevState} → ${newState}`);
          if (newState === 'run') {
            console.log('[Entry Save Manager] 실행 시작 감지 — 데이터 로드');
            loadData();
            setExtensionStatusFlag();
          }
          prevState = newState;
        }, 300);

        return result;
      };
      console.log('[Entry Save Manager] toggleRun 후킹 완료');
    }

    // ── 방법 2: 상태 폴링 (자동 실행 및 폴백) ──
    const pollState = () => {
      const currentState = Entry.engine.state;

      // non-run → run 전이 감지
      if (currentState === 'run' && prevState !== 'run') {
        console.log(`[DEBUG] 엔진 상태 전이 감지: ${prevState} → ${currentState}`);
        console.log('[Entry Save Manager] 실행 시작 감지(폴링) — 데이터 로드');
        setTimeout(() => {
          loadData();
          setExtensionStatusFlag();
        }, 300);
      }

      prevState = currentState;
      setTimeout(pollState, 500);
    };
    pollState();
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
   * '@저장' 함수의 ID를 찾습니다.
   * extractFunctionName으로 먼저 시도하고, 실패 시 JSON 직접 검색합니다.
   */
  function findSaveFunctionId() {
    const functions = Entry.variableContainer.functions_;
    if (!functions) {
      console.log('[DEBUG] functions_ 없음');
      return null;
    }

    const funcEntries = Object.entries(functions);
    console.log('[DEBUG] 등록된 함수 개수:', funcEntries.length);

    // 방법 1: 이름 추출
    for (const [funcId, funcObj] of funcEntries) {
      const name = extractFunctionName(funcObj);
      console.log(`[DEBUG] 함수 — id: ${funcId}, 이름: "${name}"`);
      if (name === SAVE_FUNC_NAME) {
        console.log(`[DEBUG] ✓ 이름 매칭으로 "@저장" 발견! id: ${funcId}`);
        return funcId;
      }
    }

    // 방법 2: JSON 직접 검색
    for (const [funcId, funcObj] of funcEntries) {
      try {
        const jsonStr = JSON.stringify(funcObj.content);
        if (jsonStr.includes(SAVE_FUNC_NAME)) {
          console.log(`[DEBUG] ✓ JSON 검색으로 "@저장" 발견! id: ${funcId}`);
          return funcId;
        }
      } catch (e) { /* ignore */ }
    }

    console.warn('[DEBUG] "@저장" 함수를 찾지 못했습니다.');
    return null;
  }

  /**
   * Entry의 함수 시스템을 후킹하여 '@저장' 함수 호출 시 saveData()를 실행합니다.
   * 함수 블록이 아직 등록되지 않았으면 폴링으로 재시도합니다.
   */
  function hookFunctionCalls(retryCount) {
    retryCount = retryCount || 0;
    const MAX_RETRIES = 20; // 최대 10초 대기 (500ms × 20)

    console.log(`[DEBUG] hookFunctionCalls() 시도 #${retryCount + 1}`);

    const saveFuncId = findSaveFunctionId();

    if (saveFuncId) {
      const blockKey = 'func_' + saveFuncId;
      console.log(`[DEBUG] 함수 블록 키: ${blockKey}`);

      if (Entry.block && Entry.block[blockKey] && Entry.block[blockKey].func) {
        const origFunc = Entry.block[blockKey].func;
        Entry.block[blockKey].func = function (sprite, script) {
          console.log('[Entry Save Manager] "@저장" 함수 호출 감지!');
          saveData();
          return origFunc.call(this, sprite, script);
        };
        console.log(`[Entry Save Manager] "@저장" 함수 블록 (${blockKey}) 후킹 완료 ✓`);
        return; // 성공
      } else {
        console.log(`[DEBUG] Entry.block["${blockKey}"] 또는 .func가 아직 없음`);
      }
    }

    // 아직 준비되지 않았으면 재시도 (functions_, block 모두 대기)
    if (retryCount < MAX_RETRIES) {
      console.log(`[DEBUG] 함수 후킹 재시도 예정 (${retryCount + 1}/${MAX_RETRIES})...`);
      setTimeout(() => hookFunctionCalls(retryCount + 1), 500);
    } else {
      console.error('[Entry Save Manager] "@저장" 함수 후킹 최대 재시도 초과');
      // 마지막 시도: Entry.block에서 func_ 키 덤프
      if (Entry.block) {
        const funcKeys = Object.keys(Entry.block).filter(k => k.startsWith('func_'));
        console.log('[DEBUG] 최종 Entry.block func_ 키:', funcKeys);
      }
    }
  }

  // ─────────────────────────────────────────────
  //  초기화 (메인 로직)
  // ─────────────────────────────────────────────

  async function init() {
    console.log('[Entry Save Manager] Entry 객체 대기 중...');
    await waitForEntry();
    console.log('[Entry Save Manager] Entry 준비 완료. Project ID:', Entry.projectId);

    // Entry 객체 상태 출력
    console.log('[DEBUG] ===== Entry 객체 상태 =====');
    console.log('[DEBUG] Entry.engine:', !!Entry.engine);
    console.log('[DEBUG] Entry.engine.state:', Entry.engine ? Entry.engine.state : '(없음)');
    console.log('[DEBUG] Entry.variableContainer.functions_:', Entry.variableContainer.functions_ ? Object.keys(Entry.variableContainer.functions_).length + '개' : '(없음)');
    console.log('[DEBUG] Entry.block:', !!Entry.block);
    console.log('[DEBUG] func_ 블록:', Entry.block ? Object.keys(Entry.block).filter(k => k.startsWith('func_')) : '(없음)');
    console.log('[DEBUG] 기존 저장 데이터:', localStorage.getItem(getStorageKey()) ? '있음' : '없음');
    console.log('[DEBUG] ========================');

    // 1) 함수 호출 후킹 (저장 트리거 — '@저장' 함수)
    //    폴링 방식으로 함수/블록이 준비될 때까지 재시도
    hookFunctionCalls(0);

    // 2) 엔진 상태 감시 — 매 실행 시 데이터 로드 (모든 페이지 공통)
    watchEngineState();

    console.log('[Entry Save Manager] 초기화 완료 ✓');
  }

  // ── Entry 준비 완료 후 초기화 시작 ──
  init();
})();
