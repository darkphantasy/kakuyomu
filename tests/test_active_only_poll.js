// 「取得操作を実行している間だけポーリングする」への変更を検証する
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
      value: '', textContent: '', childNodes: [], firstChild: null, lastChild: null, style: {},
      insertBefore(){}, removeChild(){}, appendChild(){},
    }),
    querySelectorAll: () => [],
    addEventListener: () => {},
    createElement: () => ({ appendChild(){}, classList:{add(){}}, style:{} }),
  },
  window: { addEventListener: () => {} },
  google: { script: scriptObj },
  setTimeout: (fn, ms) => { sandbox.__lastTimeout = { fn, ms }; return ++sandbox.__timeoutId; },
  clearTimeout: () => { sandbox.__cleared = (sandbox.__cleared || 0) + 1; },
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

console.log('\n■ 待機中は次回のポーリングを予約しない');
sandbox.__lastTimeout = null;
call('refresh');
handlers.ok({ works: [], running: { active: false }, queueCount: 0, shortFilename: true });
check('active:false の応答後、setTimeout は呼ばれない', sandbox.__lastTimeout, null);

console.log('\n■ 実行中は7秒後にポーリングを継続する');
sandbox.__lastTimeout = null;
call('refresh');
handlers.ok({ works: [], running: { active: true }, queueCount: 0, shortFilename: true });
check('active:true の応答後、7秒後に次回が予約される', sandbox.__lastTimeout.ms, 7000);

console.log('\n■ 実行中→待機中の遷移で、その回を最後にポーリングが止まる');
sandbox.__lastTimeout = null;
call('refresh');
handlers.ok({ works: [], running: { active: true }, queueCount: 0, shortFilename: true });
check('継続中はまだ予約される', sandbox.__lastTimeout !== null, true);
// スケジュールされたコールバックを実際に発火させて次の refresh を起こす
var scheduled = sandbox.__lastTimeout.fn;
sandbox.__lastTimeout = null;
scheduled(); // refresh() が呼ばれ、新しい handlers がセットされる
handlers.ok({ works: [], running: { active: false }, queueCount: 0, shortFilename: true }); // 完了した
check('完了を検知した回を最後に、以降は予約されない', sandbox.__lastTimeout, null);

console.log('\n■ 失敗時は短い間隔で再試行する（無限に停止しない）');
sandbox.__lastTimeout = null;
call('refresh');
handlers.ng({ message: 'boom' });
check('失敗時は POLL_MS(7000) 後に再試行', sandbox.__lastTimeout.ms, 7000);

console.log('\n■ ページ読込時の refresh() は1回だけ状態を取りに行く（自動ループはしない）');
// window.addEventListener('load', ...) 相当を直接検証するのではなく、
// refresh() 自体が「応答が来るまでは何も予約しない」ことを確認する
sandbox.__lastTimeout = null;
call('refresh');
check('応答が来る前は何も予約されていない', sandbox.__lastTimeout, null);

console.log(`\n合計: ${pass} 件成功 / ${fail} 件失敗\n`);
process.exit(fail ? 1 : 0);
