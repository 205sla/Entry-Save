'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'background.js'),
  'utf8'
);

function createHarness() {
  let installedListener = null;
  const createdTabs = [];
  const context = vm.createContext({
    chrome: {
      runtime: {
        onInstalled: {
          addListener(listener) {
            installedListener = listener;
          },
        },
        getURL(file) {
          return 'chrome-extension://entry-save-manager/' + file;
        },
      },
      tabs: {
        create(options) {
          createdTabs.push(options);
        },
      },
    },
  });

  vm.runInContext(source, context);
  assert.equal(typeof installedListener, 'function');

  return {
    trigger(reason) {
      installedListener({ reason });
    },
    createdTabs,
  };
}

describe('install welcome page', () => {
  it('최초 설치 때만 확장 내부 안내 페이지를 연다', () => {
    const harness = createHarness();
    harness.trigger('install');

    assert.deepEqual(
      JSON.parse(JSON.stringify(harness.createdTabs)),
      [{ url: 'chrome-extension://entry-save-manager/welcome.html' }]
    );
  });

  it('업데이트와 Chrome 업데이트 때는 안내 페이지를 열지 않는다', () => {
    const harness = createHarness();
    harness.trigger('update');
    harness.trigger('chrome_update');

    assert.deepEqual(harness.createdTabs, []);
  });
});
