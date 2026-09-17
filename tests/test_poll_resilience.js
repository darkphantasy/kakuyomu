// 描画で例外が出てもポーリングが止まらないこと（保険側の修正）を検証する
const fs = require('fs');
const vm = require('vm');

const html = fs.readFileSync('kaku_scraping/src/index.html', 'utf8');
const script = html.match(/<script>([\s\S]*)<\/script>/)[1];

let handlers = null;
const runner = {
  withSuccessHandler(f) { handlers.ok = f; return runner; },
  withFailureHandler(f) { handlers.ng = f; return runner; },
  webGetDocSizes() { return runner; },
  webGetReadingProgress() { return runner; },
  webGetState() { return runner; },
  webGetLinks() { return runner; },
};
const scriptObj = {};
Object.defineProperty(scriptObj, 'run', { get() { handlers = {}; return runner; } });

const sandbox = {
  console,
  document: {
    getElementById: () => ({
      value: '', textContent: '', childNodes: [], firstChild: null, lastChild: null,
      insertBefore() {}, removeChild() {}, appendChild() {},
    }),
    querySelectorAll: () => [],
    addEventListener: () => {},
    createElement: () => ({ appendChild() {}, classList: { add() {} }, style: {} }),
  },
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
vm.runInContext('lastState = { works: [] };', sandbox);

const call = (fn, ...args) => vm.runInContext(`${fn}(${JSON.stringify(args).slice(1, -1)})`, sandbox);

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log((ok ? '  OK   ' : '  FAIL ') + name + (ok ? '' : `\n         期待: ${JSON.stringify(expected)}\n         実際: ${JSON.stringify(actual)}`));
  ok ? pass++ : fail++;
}

const activeState = { works: [], running: { active: true }, queueCount: 0, shortFilename: true };

console.log('\n■ 描画が正常なときは従来どおり');
sandbox.renderTable = () => {};
sandbox.__lastTimeout = null;
call('refresh');
handlers.ok(activeState);
check('実行中なら7秒後に次回が予約される', sandbox.__lastTimeout.ms, 7000);

console.log('\n■ 描画で例外が出てもポーリングは生き残る');
// render() の中で呼ばれる renderTable を例外にして、描画失敗を再現する
vm.runInContext('renderTable = function () { throw new Error("描画失敗"); };', sandbox);
sandbox.__lastTimeout = null;
let threw = null;
call('refresh');
try { handlers.ok(activeState); } catch (e) { threw = String(e.message || e); }
check('描画の例外はハンドラの外に出る（握り潰さない）', threw, '描画失敗');
check('それでも次回のポーリングは予約済み（二度と止まらない）', sandbox.__lastTimeout.ms, 7000);

console.log('\n■ 待機中は従来どおり予約しない');
vm.runInContext('renderTable = function () {};', sandbox);
sandbox.__lastTimeout = null;
call('refresh');
handlers.ok({ works: [], running: { active: false }, queueCount: 0, shortFilename: true });
check('active:false なら予約しない', sandbox.__lastTimeout, null);

console.log('\n■ 応答が壊れていても落ちない');
sandbox.__lastTimeout = null;
call('refresh');
threw = null;
try { handlers.ok(undefined); } catch (e) { threw = String(e.message || e); }
check('running が無い応答でも予約判定で落ちない', sandbox.__lastTimeout, null);

console.log(`\n合計: ${pass} 件成功 / ${fail} 件失敗\n`);
process.exit(fail ? 1 : 0);
