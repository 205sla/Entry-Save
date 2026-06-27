'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadShared() {
  const context = vm.createContext({});
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, '..', 'shared.js'), 'utf8'),
    context
  );
  return context.ESM;
}

describe('Entry Save shared helpers', () => {
  it('Entry 실행 경로에서 작품 ID를 추출한다', () => {
    const ESM = loadShared();
    assert.equal(
      ESM.extractProjectId('/project/6a2a68332a04cc7dacf10718'),
      '6a2a68332a04cc7dacf10718'
    );
    assert.equal(
      ESM.extractProjectId('/ws/6a2a68332a04cc7dacf10718'),
      '6a2a68332a04cc7dacf10718'
    );
    assert.equal(
      ESM.extractProjectId('/iframe/6a2a68332a04cc7dacf10718?s=abc'),
      '6a2a68332a04cc7dacf10718'
    );
    assert.equal(
      ESM.extractProjectId('/noframe/6a2a68332a04cc7dacf10718'),
      '6a2a68332a04cc7dacf10718'
    );
    assert.equal(ESM.extractProjectId('/online'), null);
  });

  it('top frame pathname에서 저장 namespace용 pageType을 결정한다', () => {
    const ESM = loadShared();
    assert.equal(ESM.getPageTypeFromPathname('/ws/abc12345'), 'ws');
    assert.equal(ESM.getPageTypeFromPathname('/project/abc12345'), 'project');
    assert.equal(ESM.getPageTypeFromPathname('/noframe/abc12345'), 'project');
    assert.equal(ESM.getPageTypeFromPathname('/iframe/abc12345'), null);
    assert.equal(ESM.getPageTypeFromPathname('/online'), null);
  });

  it('project와 ws 저장 키를 분리한다', () => {
    const ESM = loadShared();
    assert.equal(
      ESM.buildStorageKey('project', 'abc12345'),
      'entry_save_abc12345'
    );
    assert.equal(
      ESM.buildStorageKey(null, 'abc12345'),
      'entry_save_abc12345'
    );
    assert.equal(
      ESM.buildStorageKey('ws', 'abc12345'),
      'entry_save_ws_abc12345'
    );
  });

  it('@확장프로그램을 저장 데이터가 아닌 예약 변수로 분류한다', () => {
    const ESM = loadShared();
    assert.equal(ESM.PREFIX, '@');
    assert.equal(ESM.STATUS_VAR_NAME, '@확장프로그램');
    assert.equal(ESM.isReservedVariableName('@확장프로그램'), true);
    assert.equal(ESM.isReservedVariableName('@점수'), false);
  });
});
