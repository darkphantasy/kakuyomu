// index.html: 削除済みリストまわり（確認して呼び直す call()、削除済みタブ、候補一覧の目印）
const { createUiSandbox } = require('./harness/dom-mock');
const { check, section, finish } = require('./harness/check');

const calls = [];
let responses = [];   // 呼ばれた順に返す応答
let confirmAnswer = true;
const confirms = [];

const ui = createUiSandbox({
  runner: () => {
    const r = {};
    r.withSuccessHandler = fn => { r.ok = fn; return r; };
    r.withFailureHandler = fn => { r.fail = fn; return r; };
    ['webStartFetch', 'webSeedSelected', 'webSeedResumeRecord', 'webForgetRemoved'].forEach(name => {
      r[name] = (...args) => { calls.push([name].concat(args)); r.ok(responses.shift()); };
    });
    r.webKick = () => { calls.push(['webKick']); r.ok({ ok: true }); };
    r.webGetState = () => { calls.push(['webGetState']); };
    return r;
  },
});
const { g, state, sandbox } = ui;
sandbox.confirm = msg => { confirms.push(msg); return confirmAnswer; };

section('needConfirm が返ったら確認し、OK なら confirmed=true を末尾に足して呼び直す');
responses = [
  { ok: false, needConfirm: true, message: '次の作品は、以前に一覧から削除した作品です。' },
  { ok: true, kick: true, message: '取得を開始しました。' },
];
g('call("webStartFetch", ["https://kakuyomu.jp/works/111", "", ""])');
check('確認ダイアログにサーバーの文言を出す', confirms, ['次の作品は、以前に一覧から削除した作品です。']);
check('呼び直しは末尾に true を足す', calls.filter(c => c[0] === 'webStartFetch'),
  [['webStartFetch', 'https://kakuyomu.jp/works/111', '', ''], ['webStartFetch', 'https://kakuyomu.jp/works/111', '', '', true]]);
check('確認の段階ではエラーとしてログに出さない', state.logs.some(l => l.indexOf('削除した作品') >= 0), false);
check('呼び直しが成功したら通常どおり蹴る', calls.some(c => c[0] === 'webKick'), true);

section('キャンセルなら呼び直さず「取り消しました」とだけ出す');
calls.length = 0; confirms.length = 0; confirmAnswer = false; state.logs.length = 0;
responses = [{ ok: false, needConfirm: true, message: '確認' }];
g('call("webSeedSelected", [[{ url: "https://kakuyomu.jp/works/111" }]], "［X］")');
check('呼び出しは1回だけ', calls.map(c => c[0]), ['webSeedSelected']);
check('取り消しログ', state.logs.some(l => l.indexOf('［X］取り消しました。') >= 0), true);
check('ボタンは有効に戻る', g('busy'), false);
confirmAnswer = true;

const removedState = {
  works: [{ workId: '333', title: '一覧の作品', shortTitle: '一覧の作品', url: 'u', total: '2', updatedAt: 'x', docIds: [] }],
  removed: [{ workId: '111', title: '読了した作品', shortTitle: '読了した作品', url: 'https://kakuyomu.jp/works/111', total: 120, removedAt: '2026-09-28 12:00' }],
  running: { active: false }, queueCount: 0, shortFilename: true, lastBatchResult: '',
};

section('削除済みタブ：件数を表示し、タブに切り替えられる');
ui.render(removedState);
check('タブ見出しに件数', state.texts.tabRemovedCount, '(1)');
check('見出しに件数', state.texts.removedCount, '(1 作品)');
check('空表示は隠す', g("$('removedEmpty').style.display"), 'none');
g('setActiveTab("removed")');
check('削除済みパネルが表示される', g("$('tabPanel-removed').hidden"), false);
check('一覧・候補パネルは隠れる', [g("$('tabPanel-works').hidden"), g("$('tabPanel-seed').hidden")], [true, true]);
check('削除済みタブに active クラス', state.tabButtons[2].className, 'tab-btn active');

section('候補一覧：削除済みの作品に目印を付け、「未読ありを全選択」では選ばない');
g(`$('seedPaste').value = ${JSON.stringify(JSON.stringify([
  { url: 'https://kakuyomu.jp/works/111', title: '読了した作品', unread: 5, total: 125 },
  { url: 'https://kakuyomu.jp/works/222', title: '新しい作品', unread: 3, total: 10 },
]))};`);
g('doParseSeed()');
g('doSelectUnreadSeed()');
check('削除済みの作品は選ばれない', g('seedCandidates["111"].checked'), false);
check('そうでない未読ありの作品は選ばれる', g('seedCandidates["222"].checked'), true);
check('removedMap_ で引ける', g('removedMap_()["111"].total'), 120);

section('空の削除済み');
ui.render(Object.assign({}, removedState, { removed: [] }));
check('タブ見出しの件数は空', state.texts.tabRemovedCount, '');
check('空表示を出す', g("$('removedEmpty').style.display"), 'block');
ui.render(Object.assign({}, removedState, { removed: undefined }));
check('removed が無い応答でも落ちない', state.texts.tabRemovedCount, '');

finish();
