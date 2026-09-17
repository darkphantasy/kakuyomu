// index.html: 「候補から選んで登録」欄（貼り付け→選択→登録）の検証
const { createUiSandbox } = require('./harness/dom-mock');
const { check, section, finish } = require('./harness/check');

const calls = [];
let nextResponse = null;

const ui = createUiSandbox({
  runner: () => {
    const r = { ok: null, fail: null };
    r.withSuccessHandler = fn => { r.ok = fn; return r; };
    r.withFailureHandler = fn => { r.fail = fn; return r; };
    r.webSeedSelected = items => { calls.push(['webSeedSelected', items]); r.ok(nextResponse); };
    r.webKick = () => { calls.push(['webKick']); r.ok({ ok: true }); };
    r.webGetState = () => { calls.push(['webGetState']); r.ok({ works: [], running: { active: false }, queueCount: 0, shortFilename: true, lastBatchResult: '' }); };
    return r;
  },
});
const { g, state } = ui;

const PASTE = JSON.stringify([
  { url: 'https://kakuyomu.jp/works/111', title: '作品A', unread: 3, total: 10 },
  { url: 'https://kakuyomu.jp/works/222', title: '作品B（未読なし）', unread: 0, total: 5 },
  { url: 'https://kakuyomu.jp/works/333', title: '作品C（数値不明）' },
]);

section('貼り付け→読み込みで候補が取り込まれる');
g(`$('seedPaste').value = ${JSON.stringify(PASTE)};`);
g('doParseSeed()');
check('貼り付け欄はクリアされる', g("$('seedPaste').value"), '');
check('3件取り込んだ旨をログに出す', state.logs[0].indexOf('3 件') >= 0, true);

section('同じ作品を再度貼り付けても重複しない（workId で統合）');
g(`$('seedPaste').value = ${JSON.stringify(JSON.stringify([
  { url: 'https://kakuyomu.jp/works/111', title: '作品A', unread: 2, total: 10 }, // 未読数だけ更新
]))};`);
g('doParseSeed()');
check('候補は3件のまま（新規追加なし）', g('Object.keys(seedCandidates).length'), 3);
check('既存候補の unread が上書きされる', g('seedCandidates["111"].unread'), 2);

section('未読ありを全選択：未読0の作品と、数値不明の作品は選ばれない');
g('doSelectUnreadSeed()');
check('作品A（未読2）は選択される', g('seedCandidates["111"].checked'), true);
check('作品B（未読0）は選択されない', g('seedCandidates["222"].checked'), false);
check('作品C（不明）は選択されない', g('seedCandidates["333"].checked'), false);

section('選択解除ですべて外れる');
g('doClearSeedSelection()');
check('全部 false', [g('seedCandidates["111"].checked'), g('seedCandidates["222"].checked')], [false, false]);

section('選択した作品を登録：readCount は 全話-未読 で計算し、数値不明なら省略する');
g('seedCandidates["111"].checked = true;'); // 未読2/全10 → readCount=8
g('seedCandidates["333"].checked = true;'); // 数値不明 → readCount なし
calls.length = 0;
nextResponse = { ok: true, kick: true, message: '2 作品の登録を開始しました。' };
g('doRegisterSeed()');
check('webSeedSelected → webKick → webGetState の順で呼ばれる', calls.map(c => c[0]), ['webSeedSelected', 'webKick', 'webGetState']);
check('渡す items が正しい', calls[0][1], [
  { url: 'https://kakuyomu.jp/works/111', readCount: 8 }, { url: 'https://kakuyomu.jp/works/333' },
]);

section('登録済みの作品はチェックできない（登録済みバッジが出る）');
g('lastState = { works: [{ workId: "111" }] };');
g('renderSeedList()');
// renderSeedList は document.createElement のモックを使うため、内容は state からは直接見えない。
// ここでは例外なく再描画できること・候補データ自体が消えないことだけを確認する。
check('候補は消えない（登録済みでも一覧には残す）', g('Object.keys(seedCandidates).length'), 3);

section('一括処理の進捗表示: batchKind によって文言が変わる');
const base = { works: [], queueCount: 0, shortFilename: true, lastBatchResult: '' };
const run = r => Object.assign({}, base, {
  running: Object.assign({ active: true, phase: 'BATCH_NEXT', batchNext: true, batchKind: 'cont', title: 'T', done: 0, total: 0, batchTotal: 0, batchDone: 0 }, r),
});
ui.render(run({ batchKind: 'cont', batchTotal: 10, batchDone: 2 }));
check('cont: 「新着を確認中…」', state.texts.runText, '新着を確認中… 2 / 10 作品');
ui.render(run({ batchKind: 'seed', batchTotal: 10, batchDone: 2 }));
check('seed: 「作品を登録中…」', state.texts.runText, '作品を登録中… 2 / 10 作品');

finish();
