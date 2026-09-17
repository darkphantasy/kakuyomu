// 「離れた時点で実行中だった場合だけ、戻ってきたら1回だけ確認する」を検証する
const fs = require('fs');
const vm = require('vm');

const html = fs.readFileSync('kaku_scraping/src/index.html', 'utf8');
const script = html.match(/<script>([\s\S]*)<\/script>/)[1];

let handlers = null;
let stateCallCount = 0;
const runner = {
  withSuccessHandler(f) { handlers.ok = f; return runner; },
  withFailureHandler(f) { handlers.ng = f; return runner; },
  webGetDocSizes() { return runner; },
  webGetReadingProgress() { return runner; },
  webGetState() { stateCallCount++; return runner; },
  webGetLinks() { return runner; },
};
const scriptObj = {};
Object.defineProperty(scriptObj, 'run', { get() { handlers = {}; return runner; } });

let visHandler = null;
const docObj = {
  hidden: false,
  addEventListener(evt, fn) { if (evt === 'visibilitychange') visHandler = fn; },
  getElementById: () => ({
    value: '', textContent: '', childNodes: [], firstChild: null, lastChild: null, style: {},
    insertBefore(){}, removeChild(){}, appendChild(){},
  }),
  querySelectorAll: () => [],
  createElement: () => ({ appendChild(){}, classList:{add(){}}, style:{} }),
};

const sandbox = {
  console,
  document: docObj,
  window: { addEventListener: () => {} },
  google: { script: scriptObj },
  setTimeout: (fn, ms) => { sandbox.__lastTimeout = { fn, ms }; return ++sandbox.__timeoutId; },
  clearTimeout: () => {},
  confirm: () => true,
  Number, Object, Date, JSON, Math,
};
sandbox.__timeoutId = 0;

vm.createContext(sandbox);
vm.runInContext(script, sandbox);
sandbox.renderTable = () => {};
sandbox.maybeFetchProgress = () => {};
sandbox.maybeFetchSizes = () => {};
sandbox.refreshChangedWorks = () => {};
vm.runInContext('lastState = { works: [] };', sandbox);

const call = (fn, ...args) => vm.runInContext(`${fn}(${JSON.stringify(args).slice(1, -1)})`, sandbox);

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log((ok ? '  OK   ' : '  FAIL ') + name + (ok ? '' : `\n         期待: ${JSON.stringify(expected)}\n         実際: ${JSON.stringify(actual)}`));
  ok ? pass++ : fail++;
}

console.log('\n■ visibilitychange ハンドラが登録されている');
check('登録されている', typeof visHandler, 'function');

console.log('\n■ 何も実行していない時にタブを切り替えても何も起きない');
vm.runInContext('lastState = { works: [], running: { active: false } };', sandbox);
stateCallCount = 0;
docObj.hidden = true;  visHandler();
docObj.hidden = false; visHandler();
check('webGetState は呼ばれない', stateCallCount, 0);

console.log('\n■ 実行中に隠れて、戻ってきたら1回だけ確認する');
vm.runInContext('lastState = { works: [], running: { active: true } };', sandbox);
stateCallCount = 0;
docObj.hidden = true;  visHandler(); // 実行中に隠れた
docObj.hidden = false; visHandler(); // 戻ってきた
check('webGetState が1回だけ呼ばれる', stateCallCount, 1);

console.log('\n■ 1回確認したら、その後は再度呼ばれない（隠れ直さない限り）');
stateCallCount = 0;
docObj.hidden = false; visHandler(); // 何も変化していない状態で再度visibleイベントが来ても
check('二重に呼ばれない', stateCallCount, 0);

console.log('\n■ 実行中に隠れて戻ってきて、さらにもう一度隠れて戻ってきたら、また1回確認する');
vm.runInContext('lastState = { works: [], running: { active: true } };', sandbox);
stateCallCount = 0;
docObj.hidden = true;  visHandler();
docObj.hidden = false; visHandler();
check('1回目', stateCallCount, 1);
docObj.hidden = true;  visHandler();
docObj.hidden = false; visHandler();
check('2回目もちゃんと確認する', stateCallCount, 2);

console.log('\n■ 隠れる前に active だったかどうかで判定する（隠れた瞬間のスナップショット）');
vm.runInContext('lastState = { works: [], running: { active: true } };', sandbox);
docObj.hidden = true; visHandler(); // 実行中に隠れた
vm.runInContext('lastState = { works: [], running: { active: false } };', sandbox); // 隠れている間に完了（に相当する更新）
stateCallCount = 0;
docObj.hidden = false; visHandler(); // 戻ってきた
check('隠れた時点でactiveだったので確認する（今の見かけ上のactiveではなく隠れた瞬間で判定）',
  stateCallCount, 1);

console.log(`\n合計: ${pass} 件成功 / ${fail} 件失敗\n`);
process.exit(fail ? 1 : 0);
