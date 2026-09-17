// index.html: 「候補から選んで登録」欄（貼り付け→選択→登録）の検証
//   候補一覧は積み上げ（マージ）ではなく、直近に読み込んだJSONだけを表示する置き換え方式。
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

const paste = items => `$('seedPaste').value = ${JSON.stringify(JSON.stringify(items))};`;

const SET_A = [
  { url: 'https://kakuyomu.jp/works/111', title: '作品A', unread: 3, total: 10 },
  { url: 'https://kakuyomu.jp/works/222', title: '作品B（未読なし）', unread: 0, total: 5 },
  { url: 'https://kakuyomu.jp/works/333', title: '作品C（数値不明）' },
];

section('貼り付け→読み込みで候補が表示される');
g(paste(SET_A));
g('doParseSeed()');
check('貼り付け欄はクリアされる', g("$('seedPaste').value"), '');
check('3件表示している旨をログに出す', state.logs[0].indexOf('3 件の候補を表示しています。') >= 0, true);
check('候補は3件', g('Object.keys(seedCandidates).length'), 3);

section('別のデータを貼り付けると、候補一覧は積み上げではなく置き換わる');
state.logs.length = 0;
g(paste([{ url: 'https://kakuyomu.jp/works/999', title: '作品X', unread: 1, total: 2 }]));
g('doParseSeed()');
check('古い候補（111/222/333）は消える', g('Object.keys(seedCandidates)'), ['999']);
check('新しい候補だけが残る', g('seedCandidates["999"].title'), '作品X');
check('1件表示している旨をログに出す', state.logs[0].indexOf('1 件の候補を表示しています。') >= 0, true);

section('未読ありを全選択：未読0の作品と、数値不明の作品は選ばれない（SET_A を読み直す）');
g(paste(SET_A));
g('doParseSeed()');
g('doSelectUnreadSeed()');
check('作品A（未読3）は選択される', g('seedCandidates["111"].checked'), true);
check('作品B（未読0）は選択されない', g('seedCandidates["222"].checked'), false);
check('作品C（不明）は選択されない', g('seedCandidates["333"].checked'), false);

section('選択解除ですべて外れる');
g('doClearSeedSelection()');
check('全部 false', [g('seedCandidates["111"].checked'), g('seedCandidates["222"].checked')], [false, false]);

section('選択した作品を登録：readCount は 全話-未読 で計算し、数値不明なら省略する');
g('seedCandidates["111"].checked = true;'); // 未読3/全10 → readCount=7
g('seedCandidates["333"].checked = true;'); // 数値不明 → readCount なし
calls.length = 0;
nextResponse = { ok: true, kick: true, message: '2 作品の登録を開始しました。' };
g('doRegisterSeed()');
check('webSeedSelected → webKick → webGetState の順で呼ばれる', calls.map(c => c[0]), ['webSeedSelected', 'webKick', 'webGetState']);
check('渡す items が正しい', calls[0][1], [
  { url: 'https://kakuyomu.jp/works/111', readCount: 7 }, { url: 'https://kakuyomu.jp/works/333' },
]);

section('開始話数：自動計算値と、任意指定での上書き');
check('自動計算値（作品A: 全10－未読3＋1）', g('seedAutoStartEpisode_(seedCandidates["111"])'), 8);
check('未読・全話数が不明なら自動計算できない', g('seedAutoStartEpisode_(seedCandidates["333"])'), null);
check('未指定なら自動計算値がそのまま readCount になる', g('seedEffectiveReadCount_(seedCandidates["111"])'), 7);

g('seedCandidates["111"].startEpisode = 5;'); // 5話目から取得したい（＝4話まで既読扱い）
check('手動指定があればそちらを優先する', g('seedEffectiveReadCount_(seedCandidates["111"])'), 4);

calls.length = 0;
nextResponse = { ok: true, message: '登録しました。' };
g('doRegisterSeed()'); // 111（手動指定）・333（数値不明）はチェック済みのまま
check('手動指定した開始話数が readCount に反映されて送られる', calls[0][1], [
  { url: 'https://kakuyomu.jp/works/111', readCount: 4 }, { url: 'https://kakuyomu.jp/works/333' },
]);

g('seedCandidates["111"].startEpisode = null;'); // 空欄に戻す＝自動計算に戻る
check('空欄に戻すと自動計算値に戻る', g('seedEffectiveReadCount_(seedCandidates["111"])'), 7);

section('候補一覧は置き換え方式なので、選択状態・開始話数の手動指定は再読み込みで引き継がれない');
g('seedCandidates["111"].startEpisode = 7;');
g(paste([{ url: 'https://kakuyomu.jp/works/111', title: '作品A', unread: 1, total: 10 }])); // 同じ作品IDを含むデータを再読み込み
g('doParseSeed()');
check('unread は新しい値になる', g('seedCandidates["111"].unread'), 1);
check('startEpisode の手動指定は引き継がれない（再読み込みでリセット）', g('seedCandidates["111"].startEpisode'), null);
check('checked も引き継がれない', g('seedCandidates["111"].checked'), false);

section('登録済みの作品はチェックできない（登録済みバッジが出る）');
g('lastState = { works: [{ workId: "111" }] };');
g('renderSeedList()');
// renderSeedList は document.createElement のモックを使うため、内容は state からは直接見えない。
// ここでは例外なく再描画できること・候補データ自体が消えないことだけを確認する。
check('候補は消えない（登録済みでも一覧には残す）', g('Object.keys(seedCandidates).length'), 1);

section('空配列 [] を貼り付けても、貼り付け欄を空にしても、候補一覧は空になる（置き換え方式なので同じ結果）');
state.logs.length = 0;
g(`$('seedPaste').value = '[]';`);
g('doParseSeed()');
check('候補が0件になる', g('Object.keys(seedCandidates).length'), 0);
check('取り込める候補が無かった旨をログに出す（既に空なのでクリアではなくこちらの文言）', state.logs[0].indexOf('取り込める候補がありませんでした') >= 0, true);

g(paste(SET_A));
g('doParseSeed()');
check('候補が3件に戻る', g('Object.keys(seedCandidates).length'), 3);

state.logs.length = 0;
g(`$('seedPaste').value = '';`);
g('doParseSeed()');
check('候補が0件になる', g('Object.keys(seedCandidates).length'), 0);
check('クリアした旨をログに出す', state.logs[0].indexOf('クリア') >= 0, true);

section('ブックマークレット: 抽出ロジックの関数から javascript: リンクを組み立てる');
const bm = g('buildSeedBookmarklet_()');
check('javascript: で始まる', bm.indexOf('javascript:') === 0, true);
const decoded = decodeURIComponent(bm.slice('javascript:'.length));
check('カクヨムのページで作品一覧を集めるロジックが入っている', decoded.indexOf('widget-antennaList-item') >= 0, true);
check('即時実行の形になっている（末尾が )(); ）', decoded.slice(-4), ')();');

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
