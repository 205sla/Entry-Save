'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const esDir = path.join(__dirname, '..');

function createVariable(id, name, value) {
  return {
    id_: id,
    name_: name,
    value_: value,
    setValue(next) {
      this.value_ = next;
    },
  };
}

function createList(id, name, values) {
  return {
    id_: id,
    name_: name,
    array_: values.map((value) => ({ data: value })),
  };
}

function createStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem(key) {
      return data.has(key) ? data.get(key) : null;
    },
    setItem(key, value) {
      data.set(key, String(value));
    },
    removeItem(key) {
      data.delete(key);
    },
    key(index) {
      return Array.from(data.keys())[index] || null;
    },
    get length() {
      return data.size;
    },
    dump() {
      return Object.fromEntries(data.entries());
    },
  };
}

function createFunctionDefinition(name, paramMap) {
  return {
    content: {
      type: 'function_field_label',
      params: [name],
    },
    paramMap,
  };
}

async function createHarness(options = {}) {
  const projectId = options.projectId || '6a2a68332a04cc7dacf10718';
  const sourceProjectId = options.sourceProjectId || '1234567890abcdef12345678';
  const listeners = new Map();
  const intervals = [];
  const timeouts = [];
  const calls = {
    save: 0,
    load: 0,
  };
  const variables = [
    createVariable('score', '@점수', 0),
    createVariable('status', '@확장프로그램', 0),
    createVariable('plain', '점수', 999),
  ];
  const lists = [
    createList('bag', '@가방', ['old']),
    createList('plain-list', '가방', ['ignored']),
  ];
  const functions = {
    save: createFunctionDefinition('@저장'),
    load: createFunctionDefinition('@가져오기', { stringParam0: 0 }),
  };
  const entry = {
    projectId,
    engine: {
      state: options.engineState || 'stop',
      toggleRun() {},
    },
    block: {
      func_save: {
        func() {
          calls.save += 1;
          return 'save-original';
        },
      },
      func_load: {
        func() {
          calls.load += 1;
          return 'load-original';
        },
      },
    },
    container: { objects_: [] },
    variableContainer: {
      variables_: variables,
      lists_: lists,
      functions_: functions,
      getFunction(id) {
        return this.functions_[id];
      },
    },
  };
  const localStorage = createStorage(options.storage);
  const window = {
    Entry: entry,
    parent: null,
    top: null,
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(listener);
    },
    postMessage() {},
  };
  window.parent = window;
  window.top = window;

  const context = vm.createContext({
    window,
    Entry: entry,
    localStorage,
    location: {
      href: 'https://playentry.org/project/' + projectId,
      pathname: '/project/' + projectId,
    },
    console,
    Promise,
    Date,
    JSON,
    Object,
    Array,
    String,
    Number,
    RegExp,
    setTimeout(callback) {
      timeouts.push(callback);
      callback();
      return timeouts.length;
    },
    clearTimeout() {},
    setInterval(callback) {
      intervals.push(callback);
      return intervals.length;
    },
    clearInterval() {},
  });
  vm.runInContext(fs.readFileSync(path.join(esDir, 'shared.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(esDir, 'inject.js'), 'utf8'), context);
  await Promise.resolve();
  await Promise.resolve();

  return {
    context,
    entry,
    variables,
    lists,
    calls,
    localStorage,
    intervals,
    sourceProjectId,
    tick() {
      for (const callback of intervals) callback();
    },
    variable(name) {
      return variables.find((item) => item.name_ === name);
    },
    list(name) {
      return lists.find((item) => item.name_ === name);
    },
    send(action, payload, source = window) {
      for (const listener of listeners.get('message') || []) {
        listener({
          source,
          data: {
            type: 'ENTRY_SAVE_MANAGER',
            action,
            ...(payload || {}),
          },
        });
      }
    },
  };
}

describe('Entry Save MAIN runtime', () => {
  it('@저장 함수 호출 시 @ 변수와 리스트를 현재 namespace에 저장한다', async () => {
    const harness = await createHarness();
    harness.variable('@점수').value_ = 7;
    harness.list('@가방').array_ = [{ data: '칼' }, { data: 3 }];

    const result = harness.entry.block.func_save.func.call({});

    assert.equal(result, 'save-original');
    assert.equal(harness.calls.save, 1);
    const stored = JSON.parse(
      harness.localStorage.getItem('entry_save_' + harness.entry.projectId)
    );
    assert.deepEqual(
      stored.variables.map((item) => [item.name, item.value]),
      [['@점수', 7], ['@확장프로그램', 0]]
    );
    assert.deepEqual(
      stored.lists.map((item) => [item.name, item.array]),
      [['@가방', ['칼', 3]]]
    );
  });

  it('@가져오기 함수는 project namespace의 저장본을 현재 작품에 복원한다', async () => {
    const sourceId = 'aaaaaaaaaaaaaaaaaaaaaaaa';
    const harness = await createHarness({
      sourceProjectId: sourceId,
      storage: {
        ['entry_save_' + sourceId]: JSON.stringify({
          variables: [
            { id: 'other', name: '@점수', value: 42 },
            { id: 'bad', name: '@악성', value: { nested: true } },
            { id: 'plain', name: '점수', value: 1 },
          ],
          lists: [
            { id: 'bag', name: '@가방', array: ['검', false, { bad: true }] },
            { id: 'plain-list', name: '가방', array: ['ignored'] },
          ],
        }),
      },
    });

    const result = harness.entry.block.func_load.func.call({
      values: [sourceId],
    });

    assert.equal(result, 'load-original');
    assert.equal(harness.calls.load, 1);
    assert.equal(harness.variable('@점수').value_, 42);
    assert.deepEqual(
      harness.list('@가방').array_.map((item) => item.data),
      ['검', false]
    );
    assert.equal(harness.variable('점수').value_, 999);
  });

  it('Entry.engine 교체 후 새 engine에 재후킹하고 실행 중이면 저장본을 즉시 복원한다', async () => {
    const projectId = 'bbbbbbbbbbbbbbbbbbbbbbbb';
    const harness = await createHarness({
      projectId,
      storage: {
        ['entry_save_' + projectId]: JSON.stringify({
          variables: [{ id: 'score', name: '@점수', value: 77 }],
          lists: [],
        }),
      },
    });
    assert.equal(harness.variable('@점수').value_, 0);

    const nextEngine = {
      state: 'run',
      toggleRun() {},
    };
    harness.entry.engine = nextEngine;
    harness.context.Entry = harness.entry;
    harness.tick();

    assert.equal(harness.variable('@점수').value_, 77);
    assert.equal(nextEngine.toggleRun._isSaveMgrEngineHook, true);
  });

  it('URL_CHANGED는 자기 후킹만 복구하고 재초기화를 허용한다', async () => {
    const harness = await createHarness();
    const wrappedSave = harness.entry.block.func_save.func;
    const wrappedLoad = harness.entry.block.func_load.func;
    assert.equal(wrappedSave._isSaveMgrHook, true);
    assert.equal(wrappedLoad._isSaveMgrHook, true);

    harness.send('URL_CHANGED');

    assert.notEqual(harness.entry.block.func_save.func, wrappedSave);
    assert.notEqual(harness.entry.block.func_load.func, wrappedLoad);
    assert.equal(harness.context.window.__entrySaveManagerLoaded, false);
  });
});
