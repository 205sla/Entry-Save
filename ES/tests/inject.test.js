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
    writes: 0,
    getItem(key) {
      return data.has(key) ? data.get(key) : null;
    },
    setItem(key, value) {
      this.writes += 1;
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
    content: [[{
      type: 'function_create',
      params: [{ params: [name], type: 'function_field_label' }],
    }]],
    paramMap,
  };
}

// 콜백을 즉시 실행하지 않아 실제 300ms 복원 / 500ms 감시 순서를 검증한다.
function createClock() {
  let now = 0;
  let nextId = 0;
  const timers = new Map();
  function schedule(callback, delay, repeat = false) {
    const id = ++nextId;
    timers.set(id, { callback, due: now + delay, delay, repeat });
    return id;
  }
  return {
    setTimeout: (callback, delay) => schedule(callback, delay),
    clearTimeout: (id) => timers.delete(id),
    setInterval: (callback, delay) => schedule(callback, delay, true),
    clearInterval: (id) => timers.delete(id),
    advance(ms) {
      const end = now + ms;
      while (true) {
        const next = [...timers].sort((a, b) => a[1].due - b[1].due)[0];
        if (!next || next[1].due > end) break;
        const [id, timer] = next;
        now = timer.due;
        if (timer.repeat) timer.due += timer.delay;
        else timers.delete(id);
        timer.callback();
      }
      now = end;
    },
  };
}

async function createHarness(options = {}) {
  const projectId = options.projectId || '6a2a68332a04cc7dacf10718';
  const pathname = options.pathname || ('/project/' + projectId);
  const sourceProjectId = options.sourceProjectId || '1234567890abcdef12345678';
  const listeners = new Map();
  const clock = createClock();
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
  const functions = options.functions || {
    save: createFunctionDefinition('@저장'),
    load: createFunctionDefinition('@가져오기', { stringParam0: 0 }),
  };
  const entry = {
    projectId,
    engine: {
      state: options.engineState || 'stop',
      toggleRun() { this.state = 'run'; },
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
    removeEventListener(type, listener) {
      listeners.set(type, (listeners.get(type) || []).filter((item) => item !== listener));
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
      href: 'https://playentry.org' + pathname,
      pathname,
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
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    setInterval: clock.setInterval,
    clearInterval: clock.clearInterval,
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
    advance: clock.advance,
    sourceProjectId,
    tick() {
      clock.advance(500);
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

describe('documented save format interoperability', () => {
  const guide = fs.readFileSync(path.join(esDir, '..', '지식', '06-저장-호환-규약.md'), 'utf8');
  const example = guide.match(/```js\r?\n(function createEntrySaveAdapter[\s\S]*?)\r?\n```/);
  assert.ok(example, '개발자 가이드의 실제 예제 코드를 검증해야 한다');
  const createAdapter = vm.runInNewContext(example[1] + '\ncreateEntrySaveAdapter;', { console });

  for (const pageType of ['project', 'ws']) {
    it(`${pageType}: 문서 예제와 확장 런타임의 저장본을 양방향으로 읽는다`, async () => {
      const projectId = '6a2a68332a04cc7dacf10718';
      const h = await createHarness({ projectId, pathname: `/${pageType}/${projectId}` });
      const values = [23, 0, '', false, null];
      const names = ['@점수', '@영', '@문자열', '@불리언', '@빈값'];
      for (const name of names.slice(1)) h.variables.push(createVariable(name, name, 'initial'));
      h.lists.push(createList('empty', '@빈리스트', ['initial']));
      const peer = {
        variableContainer: {
          variables_: names.map((name, i) => createVariable('peer-' + i, name, values[i]))
            .concat([createVariable('peer-status', '@확장프로그램', 9), createVariable('plain', '점수', 8)]),
          lists_: [createList('peer-bag', '@가방', ['열쇠', 3, false, null]), createList('peer-empty', '@빈리스트', [])],
        },
      };
      const adapter = createAdapter({ entry: peer, storage: h.localStorage, projectId, pageType });
      adapter.save();
      const key = 'entry_save_' + (pageType === 'ws' ? 'ws_' : '') + projectId;
      assert.deepEqual(Object.keys(h.localStorage.dump()), [key]);
      const raw = h.localStorage.getItem(key);
      const stored = JSON.parse(raw);
      assert.deepEqual(stored.variables.map((v) => v.value), values);
      assert.deepEqual(Object.keys(stored), ['variables', 'lists', 'savedAt']);

      assert.equal(h.entry.block.func_load.func.call({ values: [projectId] }), 'load-original');
      assert.deepEqual(names.map((name) => h.variable(name).value_), values);
      assert.equal(h.variable('@확장프로그램').value_, 0);
      assert.equal(h.variable('점수').value_, 999);
      assert.equal(JSON.stringify(h.list('@가방').array_), JSON.stringify([
        { data: '열쇠' }, { data: 3 }, { data: false }, { data: null },
      ]));
      assert.equal(h.list('@빈리스트').array_.length, 0);
      assert.equal(h.localStorage.getItem(key), raw, '가져오기는 저장본을 수정하지 않는다');

      h.variable('@점수').value_ = 42;
      assert.equal(h.entry.block.func_save.func(), 'save-original');
      for (const v of peer.variableContainer.variables_.slice(0, names.length)) v.value_ = 'reset';
      peer.variableContainer.lists_[0].array_ = [];
      peer.variableContainer.lists_[1].array_ = [{ data: 'reset' }];
      assert.equal(adapter.load(), true);
      assert.deepEqual(peer.variableContainer.variables_.slice(0, names.length).map((v) => v.value_), [42, ...values.slice(1)]);
      assert.equal(peer.variableContainer.variables_[names.length].value_, 9);
      assert.equal(peer.variableContainer.variables_[names.length + 1].value_, 8);
      assert.equal(JSON.stringify(peer.variableContainer.lists_.map((l) => l.array_)),
        JSON.stringify([h.list('@가방').array_, []]));
      assert.equal(h.localStorage.writes, 2, '각 구현은 저장 호출에만 한 번씩 기록한다');
    });
  }
});

describe('Entry Save MAIN runtime', () => {
  it('@저장 함수 호출 시 @ 변수와 리스트를 현재 namespace에 저장한다', async () => {
    const harness = await createHarness();
    harness.variable('@점수').value_ = 7;
    harness.variable('@확장프로그램').value_ = 1;
    harness.list('@가방').array_ = [{ data: '칼' }, { data: 3 }];

    const result = harness.entry.block.func_save.func.call({});

    assert.equal(result, 'save-original');
    assert.equal(harness.calls.save, 1);
    const stored = JSON.parse(
      harness.localStorage.getItem('entry_save_' + harness.entry.projectId)
    );
    assert.deepEqual(
      stored.variables.map((item) => [item.name, item.value]),
      [['@점수', 7]]
    );
    assert.deepEqual(
      stored.lists.map((item) => [item.name, item.array]),
      [['@가방', ['칼', 3]]]
    );
  });

  it('/ws/에서는 워크스페이스 전용 namespace에 저장한다', async () => {
    const projectId = 'cccccccccccccccccccccccc';
    const harness = await createHarness({
      projectId,
      pathname: '/ws/' + projectId,
    });
    harness.variable('@점수').value_ = 11;

    harness.entry.block.func_save.func.call({});

    assert.equal(harness.localStorage.getItem('entry_save_' + projectId), null);
    const stored = JSON.parse(
      harness.localStorage.getItem('entry_save_ws_' + projectId)
    );
    assert.deepEqual(
      stored.variables.map((item) => [item.name, item.value]),
      [['@점수', 11]]
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
            { id: 'status', name: '@확장프로그램', value: 0 },
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
    harness.variable('@확장프로그램').value_ = 1;

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
    assert.equal(harness.variable('@확장프로그램').value_, 1);
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
    assert.equal(harness.variable('@확장프로그램').value_, 0);

    const nextEngine = {
      state: 'run',
      toggleRun() {},
    };
    harness.entry.engine = nextEngine;
    harness.context.Entry = harness.entry;
    harness.tick();
    harness.advance(300);

    assert.equal(harness.variable('@점수').value_, 77);
    assert.equal(harness.variable('@확장프로그램').value_, 1);
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

describe('review regressions', () => {
  function seed(harness, projectId = harness.entry.projectId, value = 10) {
    harness.localStorage.setItem('entry_save_' + projectId, JSON.stringify({
      variables: [{ id: 'score', name: '@점수', value }],
      lists: [{ id: 'bag', name: '@가방', array: ['restored'] }],
    }));
  }

  it('toggleRun과 폴링은 한 번만 복원하며 빠른 정지 후 재실행은 다시 복원한다', async () => {
    const h = await createHarness();
    seed(h);
    h.entry.engine.toggleRun();
    h.advance(300);
    assert.equal(h.variable('@점수').value_, 10);
    h.variable('@점수').value_ = 11;
    h.advance(1000);
    assert.equal(h.variable('@점수').value_, 11);
    // stop 상태가 다음 폴링까지 유지되지 않아도 toggleRun이 새 실행을 감지한다.
    h.entry.engine.state = 'stop';
    h.entry.engine.toggleRun();
    h.advance(300);
    assert.equal(h.variable('@점수').value_, 10);
  });

  it('이미 실행 중인 초기 진입과 폴링으로 감지한 실행도 한 번만 복원한다', async () => {
    for (const engineState of ['run', 'stop']) {
      const h = await createHarness({ engineState });
      seed(h);
      h.entry.engine.state = 'run';
      h.advance(800);
      assert.equal(h.variable('@점수').value_, 10);
      h.variable('@점수').value_ = 12;
      h.advance(1000);
      assert.equal(h.variable('@점수').value_, 12);
    }
  });

  it('일시정지 후 재개는 진행 값을 초기화하지 않는다', async () => {
    const h = await createHarness();
    seed(h);
    h.entry.engine.toggleRun();
    h.advance(300);
    h.variable('@점수').value_ = 15;
    h.entry.engine.state = 'pause';
    h.advance(500);
    h.entry.engine.toggleRun();
    h.advance(1000);
    assert.equal(h.variable('@점수').value_, 15);
  });

  it('정지·engine 교체·URL 변경 후 이전 지연 복원이 실행되지 않는다', async () => {
    for (const action of ['stop', 'replace', 'navigate']) {
      const h = await createHarness();
      seed(h);
      h.entry.engine.toggleRun();
      h.advance(100);
      if (action === 'stop') h.entry.engine.state = 'stop';
      if (action === 'replace') h.entry.engine = { state: 'run', toggleRun() {} };
      if (action === 'navigate') h.send('URL_CHANGED');
      h.advance(200);
      assert.equal(h.variable('@점수').value_, 0, action);
      if (action === 'replace') {
        h.advance(500);
        assert.equal(h.variable('@점수').value_, 10);
      } else {
        h.advance(1000);
        assert.equal(h.variable('@점수').value_, 0, action);
      }
    }
  });

  it('10초 뒤 추가한 함수도 연결하고 폴링 직전 실행에도 첫 호출을 저장한다', async () => {
    for (const beforePoll of [false, true]) {
      const h = await createHarness({ functions: {} });
      h.advance(12000);
      h.entry.variableContainer.functions_.save = createFunctionDefinition('@저장');
      h.entry.variableContainer.functions_.load = createFunctionDefinition('@가져오기', { stringParam0: 0 });
      if (beforePoll) h.entry.engine.toggleRun();
      else h.advance(500);
      h.variable('@점수').value_ = 29;
      h.entry.block.func_save.func();
      assert.equal(JSON.parse(h.localStorage.getItem('entry_save_' + h.entry.projectId)).variables[0].value, 29);
      seed(h, h.sourceProjectId, 31);
      h.entry.block.func_load.func.call({ values: [h.sourceProjectId] });
      assert.equal(h.variable('@점수').value_, 31);
    }
  });

  it('스키마·func 교체 후 새 원본과 this·인자를 보존하고 저장·가져오기를 복구한다', async () => {
    const h = await createHarness();
    const calls = [];
    const native = function (...args) { calls.push([this, args]); return 'replacement'; };
    const saveSchema = Object.create({ func: native });
    h.entry.block.func_save = saveSchema;
    h.entry.block.func_load.func = native;
    h.advance(500);
    const receiver = { values: [h.sourceProjectId] };
    assert.equal(saveSchema.func.call(receiver, 'sprite', 'script'), 'replacement');
    assert.equal(h.localStorage.writes, 1);
    seed(h, h.sourceProjectId, 32);
    assert.equal(h.entry.block.func_load.func.call(receiver, 1, 2), 'replacement');
    assert.equal(h.variable('@점수').value_, 32);
    assert.deepEqual(calls, [[receiver, ['sprite', 'script']], [receiver, [1, 2]]]);
    h.send('URL_CHANGED');
    assert.equal(Object.hasOwn(saveSchema, 'func'), false);
    assert.equal(h.entry.block.func_load.func, native);
  });

  it('다른 확장이 기존 래퍼를 감싸도 저장은 한 번이며 정리 시 외부 래퍼를 보존한다', async () => {
    const h = await createHarness();
    const originalWrapper = h.entry.block.func_save.func;
    let externalCalls = 0;
    const external = function (...args) {
      externalCalls++;
      return originalWrapper.apply(this, args);
    };
    h.entry.block.func_save.func = external;
    h.advance(1500);
    assert.equal(h.entry.block.func_save.func(), 'save-original');
    assert.equal(h.localStorage.writes, 1);
    assert.equal(h.calls.save, 1);
    h.send('URL_CHANGED');
    assert.equal(h.entry.block.func_save.func, external);
    h.entry.block.func_save.func();
    assert.equal(h.localStorage.writes, 1);
    assert.equal(externalCalls, 2);
  });

  it('이름 변경 직후 저장을 멈추고 삭제 후 새 ID로 만든 함수를 연결한다', async () => {
    const h = await createHarness();
    h.entry.variableContainer.functions_.save = createFunctionDefinition('@저장안함');
    h.entry.block.func_save.func();
    assert.equal(h.localStorage.writes, 0);
    h.advance(500);
    assert.equal(h.entry.block.func_save.func._isSaveMgrHook, undefined);
    delete h.entry.variableContainer.functions_.save;
    h.entry.variableContainer.functions_.newSave = createFunctionDefinition('@저장');
    h.entry.block.func_newSave = { func() { return 'new ID'; } };
    h.advance(500);
    assert.equal(h.entry.block.func_newSave.func(), 'new ID');
    assert.equal(h.localStorage.writes, 1);
  });

  it('함수 편집 후 바뀐 paramMap으로 가져오기 인자를 읽는다', async () => {
    const h = await createHarness();
    seed(h, h.sourceProjectId, 33);
    h.entry.variableContainer.functions_.load.paramMap = { stringParam1: 1 };
    h.entry.block.func_load.func.call({ values: ['invalid', h.sourceProjectId] });
    assert.equal(h.variable('@점수').value_, 33);
  });

  it('@를 제거하거나 예약 변수로 바꾼 현재 대상은 ID가 같아도 복원하지 않는다', async () => {
    const h = await createHarness();
    seed(h);
    h.variables[0].name_ = '점수';
    h.lists[0].name_ = '가방';
    const saved = JSON.parse(h.localStorage.getItem('entry_save_' + h.entry.projectId));
    saved.variables.push({ id: 'status', name: '@예전이름', value: 50 });
    h.localStorage.setItem('entry_save_' + h.entry.projectId, JSON.stringify(saved));
    h.entry.block.func_load.func.call({ values: [h.entry.projectId] });
    assert.equal(h.variables[0].value_, 0);
    assert.equal(h.variables[1].value_, 0);
    assert.deepEqual(h.lists[0].array_, [{ data: 'old' }]);
  });

  it('교차 작품에서는 ID 충돌보다 같은 이름의 @ 대상에만 복원한다', async () => {
    const h = await createHarness();
    const score = h.variables[0];
    h.variables.unshift(createVariable(score.id_, '@다른변수', 99));
    h.lists.unshift(createList('bag', '@다른리스트', ['keep']));
    seed(h, h.sourceProjectId, 35);
    h.entry.block.func_load.func.call({ values: [h.sourceProjectId] });
    assert.equal(score.value_, 35);
    assert.equal(h.variables[0].value_, 99);
    assert.deepEqual(h.lists[0].array_, [{ data: 'keep' }]);
    assert.deepEqual(h.list('@가방').array_.map((item) => item.data), ['restored']);
  });

  it('부분 이름과 본문 속 예약 이름은 저장·가져오기 함수로 인식하지 않는다', async () => {
    const save = createFunctionDefinition('@저장안함');
    save.content[0][0].statements = [[{ type: 'text', params: ['@저장'] }]];
    const load = createFunctionDefinition('일반 함수');
    load.content[0][0].statements = [[{ type: 'text', params: ['@가져오기'] }]];
    const h = await createHarness({ functions: { save, load } });
    h.advance(15000);
    h.entry.block.func_save.func();
    h.entry.block.func_load.func();
    assert.equal(h.localStorage.writes, 0);
    assert.equal(h.entry.block.func_save.func._isSaveMgrHook, undefined);
    assert.equal(h.entry.block.func_load.func._isSaveMgrHook, undefined);
  });

  it('실제 Entry 제목 API와 문자열 JSON 모두 속성 순서와 무관하게 인식한다', async () => {
    const save = createFunctionDefinition('@저장');
    save.content = JSON.stringify(save.content);
    const label = { params: ['@가져오기'], type: 'function_field_label', getOutputBlock: () => null };
    const input = { type: 'function_field_string', getOutputBlock: () => label };
    const load = {
      content: { getEventMap: () => [{ params: [input] }] },
      paramMap: { stringParam0: 0 },
    };
    const h = await createHarness({ functions: { save, load } });
    h.entry.block.func_save.func();
    assert.equal(h.localStorage.writes, 1);
    seed(h, h.sourceProjectId, 36);
    h.entry.block.func_load.func.call({ values: [h.sourceProjectId] });
    assert.equal(h.variable('@점수').value_, 36);
  });

  it('해제된 래퍼는 Entry가 사라져도 다른 확장과 원래 함수의 호출을 전달한다', async () => {
    const h = await createHarness();
    const ownWrapper = h.entry.block.func_save.func;
    let peerCalls = 0;
    const peerWrapper = function (...args) {
      peerCalls += 1;
      return ownWrapper.apply(this, args);
    };
    h.entry.block.func_save.func = peerWrapper;
    h.send('URL_CHANGED');
    h.context.window.Entry = undefined;
    h.context.Entry = undefined;
    assert.equal(h.entry.block.func_save.func, peerWrapper);
    assert.equal(peerWrapper(), 'save-original');
    assert.equal(peerCalls, 1);
    assert.equal(h.calls.save, 1);
    assert.equal(h.localStorage.writes, 0);
  });

  it('저장소 읽기가 차단되어도 실행·상태 표시·원래 함수 호출을 유지한다', async () => {
    const h = await createHarness();
    seed(h, h.entry.projectId, 37);
    const getItem = h.localStorage.getItem;
    h.localStorage.getItem = () => { throw new Error('Storage access denied'); };

    h.entry.engine.toggleRun();
    assert.doesNotThrow(() => h.advance(1000));
    assert.equal(h.variable('@점수').value_, 0);
    assert.equal(h.variable('@확장프로그램').value_, 1);
    assert.equal(h.entry.block.func_load.func.call({ values: [h.entry.projectId] }), 'load-original');
    assert.equal(h.calls.load, 1);

    h.localStorage.getItem = getItem;
    h.entry.engine.state = 'stop';
    h.entry.engine.toggleRun();
    h.advance(300);
    assert.equal(h.variable('@점수').value_, 37);
  });

  it('기존 JSON의 falsy 값과 빈 리스트를 버전·savedAt 필드 없이 복원한다', async () => {
    const h = await createHarness();
    const values = [0, '', false, null];
    values.forEach((value, index) => h.variables.push(createVariable('legacy-' + index, '@값' + index, 'before')));
    h.localStorage.setItem('entry_save_' + h.entry.projectId, JSON.stringify({
      variables: values.map((value, index) => ({ id: 'legacy-' + index, name: '@값' + index, value })),
      lists: [{ id: 'bag', name: '@가방', array: [] }],
    }));
    h.entry.engine.toggleRun();
    h.advance(300);
    values.forEach((value, index) => assert.equal(h.variable('@값' + index).value_, value));
    assert.deepEqual(Array.from(h.list('@가방').array_), []);
    h.entry.block.func_save.func();
    const saved = JSON.parse(h.localStorage.getItem('entry_save_' + h.entry.projectId));
    assert.deepEqual(Object.keys(saved), ['variables', 'lists', 'savedAt']);
    assert.deepEqual(saved.variables.filter((v) => v.name.startsWith('@값')).map((v) => v.value), values);
    assert.deepEqual(saved.lists[0].array, []);
  });

  it('예약 이름은 변수에만 적용하여 기존 같은 이름의 리스트를 보존한다', async () => {
    const h = await createHarness();
    h.lists.push(createList('status-list', '@확장프로그램', ['legacy', null]));
    h.entry.block.func_save.func();
    const raw = h.localStorage.getItem('entry_save_' + h.entry.projectId);
    const saved = JSON.parse(raw);
    assert.equal(saved.variables.some((v) => v.name === '@확장프로그램'), false);
    assert.deepEqual(saved.lists.find((l) => l.name === '@확장프로그램').array, ['legacy', null]);
    h.list('@확장프로그램').array_ = [];
    h.entry.block.func_load.func.call({ values: [h.entry.projectId] });
    assert.deepEqual(h.list('@확장프로그램').array_.map((v) => v.data), ['legacy', null]);
    assert.equal(h.localStorage.getItem('entry_save_' + h.entry.projectId), raw);
  });

  it('만들기의 자기 ID 가져오기는 ws를 읽고 다른 ID는 project를 읽으며 저장하지 않는다', async () => {
    const projectId = 'cccccccccccccccccccccccc';
    const h = await createHarness({ projectId, pathname: '/ws/' + projectId });
    const data = (value) => JSON.stringify({ variables: [{ id: 'score', name: '@점수', value }], lists: [] });
    h.localStorage.setItem('entry_save_' + projectId, data(40));
    h.localStorage.setItem('entry_save_ws_' + projectId, data(41));
    h.localStorage.setItem('entry_save_' + h.sourceProjectId, data(42));
    h.localStorage.setItem('entry_save_ws_' + h.sourceProjectId, data(43));
    const writes = h.localStorage.writes;
    h.entry.block.func_load.func.call({ values: [projectId] });
    assert.equal(h.variable('@점수').value_, 41);
    h.entry.block.func_load.func.call({ values: ['  ' + h.sourceProjectId + '  '] });
    assert.equal(h.variable('@점수').value_, 42);
    assert.equal(h.localStorage.writes, writes);
  });

  it('SPA 정리 후 재주입 시 이전 감시자가 새 후킹을 해제하거나 복구하지 않는다', async () => {
    const h = await createHarness();
    h.send('URL_CHANGED');
    vm.runInContext(fs.readFileSync(path.join(esDir, 'inject.js'), 'utf8'), h.context);
    await new Promise((resolve) => setImmediate(resolve));
    h.advance(1000);
    h.entry.block.func_save.func();
    assert.equal(h.localStorage.writes, 1);
    h.send('URL_CHANGED');
    h.advance(1000);
    h.entry.block.func_save.func();
    assert.equal(h.localStorage.writes, 1);
  });
});
