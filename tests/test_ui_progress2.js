// index.html のクライアント側ロジック（次話・サイズの重複排除、可変ポーリング）を検証する
const fs = require('fs');
const vm = require('vm');

const html = fs.readFileSync('kaku_scraping/src/index.html', 'utf8');
const script = html.match(/<script>([\s\S]*)<\/script>/)[1];

let sizeCalls = [];      // webGetDocSizes に渡された ids の履歴
let progressCalls = [];  // webGetReadingProgress に渡された map の履歴
let handlers = null;

const runner = {
  withSuccessHandler(f) { handlers.ok = f; return runner; },
  withFailureHandler(f) { handlers.ng = f; return runner; },
  webGetDocSizes(ids) { sizeCalls.push(ids); return runner; },
  webGetReadingProgress(map) { progressCalls.push(map); return runner; },
  webGetState() { return runner; },
  webGetLinks() { return runner; },
};

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
  setInterval: () => 0, clearInterval: () => {},
  setTimeout: (fn, ms) => { sandbox.__lastTimeout = { fn, ms }; return sandbox.__timeoutId = (sandbox.__timeoutId || 0) + 1; },
  clearTimeout: () => {},
  confirm: () => true,
  Number, Object, Date, JSON, Math,
};
const scriptObj = {};
Object.defineProperty(scriptObj, 'run', { get() { handlers = {}; return runner; } });
sandbox.google = { script: scriptObj };

vm.createContext(sandbox);
vm.runInContext(script, sandbox);
sandbox.renderTable = () => {};
vm.runInContext('lastState = { works: [] };', sandbox);

const call = (fn, ...args) => vm.runInContext(`${fn}(${JSON.stringify(args).slice(1, -1)})`, sandbox);
const state = name => vm.runInContext(name, sandbox);
const setVar = (name, val) => vm.runInContext(`${name} = ${JSON.stringify(val)};`, sandbox);

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log((ok ? '  OK   ' : '  FAIL ') + name + (ok ? '' : `\n         期待: ${JSON.stringify(expected)}\n         実際: ${JSON.stringify(actual)}`));
  ok ? pass++ : fail++;
}

const mkWork = (id, upd, docIds) => ({ workId: id, title: 't' + id, shortTitle: 't' + id,
  url: 'u', total: '100', updatedAt: upd, docIds: docIds || ['d' + id] });

console.log('\n■ render() の呼び出し順（次話 → サイズ）で重複を避ける');
sizeCalls = []; progressCalls = [];
setVar('readingEp', {}); setVar('pendingEpIds', {}); setVar('docSizes', {}); setVar('pendingSizeIds', {});
setVar('knownUpdatedAt', {});
const works = [mkWork('w1', 'x', ['d1']), mkWork('w2', 'x', ['d2'])];
call('render', { works: works, running: { active: false }, queueCount: 0, shortFilename: true });
check('次話が先に呼ばれ、サイズ側は同じ作品を除外する（サイズ側の直接呼び出しは0件）',
  sizeCalls.length, 0);
check('次話の問い合わせは1回（2作品まとめて5件以下なので1チャンク）', progressCalls.length, 1);

console.log('\n■ 次話の判定結果からサイズも反映される（応答をシミュレート）');
handlers.ok({ progress: { w1: 42 }, sizes: { d1: 12345 } }); // w2 の d2 は判定でカバーされなかった想定
check('progress が readingEp に反映される', state('readingEp').w1, 42);
check('sizes が docSizes に反映される', state('docSizes').d1, 12345);
check('カバーされなかった d2 は fetchSizes へフォローされる', sizeCalls, [['d2']]);

console.log('\n■ 次話が既知の作品はサイズ側で普通に処理される（skipしない）');
sizeCalls = []; progressCalls = [];
setVar('pendingEpIds', {});
call('maybeFetchSizes', [mkWork('w3', 'x', ['d3'])]); // w3 の進捗は既に確定済み・pending でもない
check('進捗が pending でない作品は通常どおりサイズを問い合わせる', sizeCalls, [['d3']]);

console.log('\n■ 同じ作品への次話問い合わせが重なったら、後から出した方の結果だけを使う');
// ページ読込時の問い合わせ（追記前の状態＝「最新」）が、一括取得完了後の再問い合わせ
// （新着あり＝12話）より遅れて返っても、古い「最新」で上書きしない。
setVar('readingEp', {}); setVar('pendingEpIds', {}); setVar('docSizes', { d9: 1 });
call('fetchProgressChunk', [mkWork('w9', 'x', ['d9'])]);
const staleReq = handlers;
call('fetchProgressChunk', [mkWork('w9', 'y', ['d9'])]);
const freshReq = handlers;
freshReq.ok({ progress: { w9: 12 }, sizes: {} });
check('新しい問い合わせの結果が入る', state('readingEp').w9, 12);
staleReq.ok({ progress: { w9: 'latest' }, sizes: {} });
check('遅れて返った古い問い合わせの「最新」では上書きされない', state('readingEp').w9, 12);
check('問い合わせ中フラグは新しい方の応答で外れている', 'w9' in state('pendingEpIds'), false);

console.log('\n■ 取得操作を実行している間だけポーリングする');
sizeCalls = []; progressCalls = [];
sandbox.__lastTimeout = null;
call('refresh');
handlers.ok({ works: [], running: { active: true }, queueCount: 0, shortFilename: true });
check('実行中はPOLL_MS(7秒)後に次回をスケジュールする', sandbox.__lastTimeout.ms, 7000);

sandbox.__lastTimeout = null;
call('refresh');
handlers.ok({ works: [], running: { active: false }, queueCount: 0, shortFilename: true });
check('待機中は次回を予約しない（ボタン操作・手動更新・再読込まで止まる）', sandbox.__lastTimeout, null);

sandbox.__lastTimeout = null;
call('refresh');
handlers.ng({ message: 'boom' });
check('失敗時はPOLL_MSで再試行する（無限に止まらない）', sandbox.__lastTimeout.ms, 7000);

console.log(`\n合計: ${pass} 件成功 / ${fail} 件失敗\n`);
process.exit(fail ? 1 : 0);
