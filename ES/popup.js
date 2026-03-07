/**
 * popup.js — Extension Popup 스크립트
 *
 * 현재 탭의 localStorage에 저장된 Entry Save Manager 데이터를 관리합니다.
 * - 현재 작품 데이터 초기화
 * - 모든 작품 데이터 초기화
 */

const STORAGE_KEY_PREFIX = 'entry_save_';

// ─────────────────────────────────
//  DOM 요소
// ─────────────────────────────────
const pageStatusEl = document.getElementById('pageStatus');
const projectIdEl = document.getElementById('projectId');
const dataStatusEl = document.getElementById('dataStatus');
const btnResetCurrent = document.getElementById('btnResetCurrent');
const btnResetAll = document.getElementById('btnResetAll');
const toastEl = document.getElementById('toast');
const toastTitleEl = document.getElementById('toastTitle');
const toastMsgEl = document.getElementById('toastMsg');
const confirmOverlay = document.getElementById('confirmOverlay');
const confirmTitleEl = document.getElementById('confirmTitle');
const confirmMsgEl = document.getElementById('confirmMsg');
const btnConfirmCancel = document.getElementById('btnConfirmCancel');
const btnConfirmOk = document.getElementById('btnConfirmOk');

// ─────────────────────────────────
//  현재 탭 정보 가져오기
// ─────────────────────────────────

let currentProjectId = null;

async function getCurrentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function extractProjectId(url) {
  try {
    const u = new URL(url);
    const match = u.pathname.match(/\/(ws|project|iframe)\/([a-f0-9]+)/);
    return match ? match[2] : null;
  } catch (e) {
    return null;
  }
}

function isEntryPage(url) {
  try {
    return new URL(url).hostname.includes('playentry.org');
  } catch (e) {
    return false;
  }
}

// ─────────────────────────────────
//  localStorage 접근 (content script 경유)
// ─────────────────────────────────

async function executeInTab(tabId, func, args) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func,
    args: args || [],
  });
  return results[0]?.result;
}

// 탭의 localStorage에서 entry_save_ 키 목록 가져오기
async function getSaveKeys(tabId) {
  return executeInTab(tabId, () => {
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key.startsWith('entry_save_')) {
        keys.push(key);
      }
    }
    return keys;
  });
}

// 특정 키 삭제
async function removeKey(tabId, key) {
  return executeInTab(tabId, (k) => {
    localStorage.removeItem(k);
  }, [key]);
}

// 모든 entry_save_ 키 삭제
async function removeAllSaveKeys(tabId) {
  return executeInTab(tabId, () => {
    const keysToRemove = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key.startsWith('entry_save_')) {
        keysToRemove.push(key);
      }
    }
    keysToRemove.forEach(k => localStorage.removeItem(k));
    return keysToRemove.length;
  });
}

// iframe 내부의 localStorage도 확인
async function getSaveKeysFromAllFrames(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: () => {
      const keys = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key.startsWith('entry_save_')) {
          keys.push(key);
        }
      }
      return keys;
    },
  });
  // 모든 프레임의 결과를 합쳐서 중복 제거
  const allKeys = new Set();
  results.forEach(r => {
    if (r.result) r.result.forEach(k => allKeys.add(k));
  });
  return [...allKeys];
}

async function removeKeyFromAllFrames(tabId, key) {
  await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: (k) => { localStorage.removeItem(k); },
    args: [key],
  });
}

async function removeAllSaveKeysFromAllFrames(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: () => {
      const keysToRemove = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key.startsWith('entry_save_')) {
          keysToRemove.push(key);
        }
      }
      keysToRemove.forEach(k => localStorage.removeItem(k));
      return keysToRemove.length;
    },
  });
  return results.reduce((sum, r) => sum + (r.result || 0), 0);
}

// ─────────────────────────────────
//  UI 업데이트
// ─────────────────────────────────

async function updateUI() {
  const tab = await getCurrentTab();

  if (!tab || !isEntryPage(tab.url)) {
    pageStatusEl.textContent = '엔트리 페이지 아님';
    pageStatusEl.classList.add('inactive');
    projectIdEl.textContent = '—';
    dataStatusEl.textContent = '—';
    btnResetCurrent.disabled = true;
    btnResetAll.disabled = true;
    return;
  }

  pageStatusEl.textContent = '엔트리 페이지';
  pageStatusEl.classList.add('active');

  currentProjectId = extractProjectId(tab.url);
  projectIdEl.textContent = currentProjectId || '(작품 페이지 아님)';

  try {
    const keys = await getSaveKeysFromAllFrames(tab.id);

    if (keys.length === 0) {
      dataStatusEl.textContent = '저장된 데이터 없음';
      dataStatusEl.classList.add('inactive');
      btnResetCurrent.disabled = true;
      btnResetAll.disabled = true;
    } else {
      dataStatusEl.textContent = `${keys.length}개 작품`;
      dataStatusEl.classList.add('active');

      // 현재 작품 데이터 존재 여부 확인
      const currentKey = currentProjectId ? STORAGE_KEY_PREFIX + currentProjectId : null;
      btnResetCurrent.disabled = !currentKey || !keys.includes(currentKey);
      btnResetAll.disabled = false;
    }
  } catch (e) {
    dataStatusEl.textContent = '확인 실패';
    dataStatusEl.classList.add('inactive');
    console.error('데이터 확인 실패:', e);
  }
}

// ─────────────────────────────────
//  토스트 / 확인 다이얼로그
// ─────────────────────────────────

function showToast(title, msg) {
  toastTitleEl.textContent = title;
  toastMsgEl.textContent = msg;
  toastEl.classList.add('show');
  setTimeout(() => toastEl.classList.remove('show'), 4000);
}

let confirmCallback = null;

function showConfirm(title, msg, callback) {
  confirmTitleEl.textContent = title;
  confirmMsgEl.textContent = msg;
  confirmCallback = callback;
  confirmOverlay.classList.add('show');
}

function hideConfirm() {
  confirmOverlay.classList.remove('show');
  confirmCallback = null;
}

// ─────────────────────────────────
//  이벤트 핸들러
// ─────────────────────────────────

btnResetCurrent.addEventListener('click', () => {
  showConfirm(
    '현재 작품 데이터 초기화',
    `프로젝트 ID: ${currentProjectId}\n\n이 작품에 저장된 변수/리스트 데이터가 삭제됩니다. 이 작업은 되돌릴 수 없습니다.`,
    async () => {
      const tab = await getCurrentTab();
      const key = STORAGE_KEY_PREFIX + currentProjectId;
      await removeKeyFromAllFrames(tab.id, key);
      showToast('초기화 완료', `현재 작품의 데이터가 삭제되었습니다.`);
      await updateUI();
    }
  );
});

btnResetAll.addEventListener('click', () => {
  showConfirm(
    '⚠️ 모든 데이터 초기화',
    '모든 엔트리 작품에 저장된 변수/리스트 데이터가 삭제됩니다.\n\n이 작업은 되돌릴 수 없습니다!',
    async () => {
      const tab = await getCurrentTab();
      const count = await removeAllSaveKeysFromAllFrames(tab.id);
      showToast('전체 초기화 완료', `${count}개 작품의 데이터가 삭제되었습니다.`);
      await updateUI();
    }
  );
});

btnConfirmCancel.addEventListener('click', hideConfirm);

btnConfirmOk.addEventListener('click', async () => {
  if (confirmCallback) {
    await confirmCallback();
  }
  hideConfirm();
});

// ── 초기화 ──
updateUI();
