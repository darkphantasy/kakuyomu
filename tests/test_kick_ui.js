// index.html: webStart* の応答に kick:true が付いたときだけ webKick を投げる／ボタンは無効化しない
const { createUiSandbox } = require('./harness/dom-mock');
const { check, section, finish } = require('./harness/check');

const calls = [];              // サーバー関数名の呼び出し順
let nextResponse = null;       // 次の webStart* 応答
let kickFail = null;           // webKick を失敗させる場合のエラー
let disabledDuringKick = null; // webKick 呼び出し時点でボタンが無効だったか

const ui = createUiSandbox({
  runner: () => {
    const r = { ok: null, fail: null };
    r.withSuccessHandler = fn => { r.ok = fn; return r; };
    r.withFailureHandler = fn => { r.fail = fn; return r; };
    r.webGetState = () => { calls.push('webGetState'); r.ok({ works: [], running: { active: false }, queueCount: 0, shortFilename: true, lastBatchResult: '' }); };
    r.webStartContinuationAll = () => { calls.push('webStartContinuationAll'); r.ok(nextResponse); };
    r.webKick = () => {
      calls.push('webKick');
      disabledDuringKick = ui.state.buttons[0].disabled;
      if (kickFail) r.fail(kickFail); else r.ok({ ok: true });
    };
    return r;
  },
});
const { g, state } = ui;
const reset = () => { calls.length = 0; state.logs.length = 0; kickFail = null; disabledDuringKick = null; state.buttons.forEach(b => { b.disabled = false; }); };

section('kick:true の応答 → webKick を 1 回だけ投げ、その後 refresh する');
reset();
nextResponse = { ok: true, kick: true, message: '一括続き取得を開始しました。' };
g('call("webStartContinuationAll", [])');
check('呼び出し順: 開始 → webKick → webGetState', calls, ['webStartContinuationAll', 'webKick', 'webGetState']);
check('webKick 時点でボタンは有効（busy を触らない）', disabledDuringKick, false);
check('開始メッセージだけがログに出る', [state.logs.length, state.logs[0].indexOf('一括続き取得を開始しました。') >= 0], [1, true]);

section('kick 無しの応答（順番待ちに積んだだけ）→ webKick を投げない');
reset();
nextResponse = { ok: true, message: '実行中のため、順番待ちに追加しました。' };
g('call("webStartContinuationAll", [])');
check('呼び出し順: 開始 → webGetState のみ', calls, ['webStartContinuationAll', 'webGetState']);

section('ok:false の応答 → webKick を投げない');
reset();
nextResponse = { ok: false, message: '続き取得できる作品がありません。' };
g('call("webStartContinuationAll", [])');
check('webKick は呼ばれない', calls.indexOf('webKick'), -1);

section('webKick が失敗 → ログに残すだけで、ボタンは有効のまま・refresh は走る');
reset();
kickFail = { message: 'Exceeded maximum execution time' };
nextResponse = { ok: true, kick: true, message: '取得を開始しました。' };
g('call("webStartContinuationAll", [])');
check('失敗ログが 1 行出る', [state.logs.length, state.logs[1].indexOf('即時実行に失敗') >= 0], [2, true]);
check('ボタンは有効のまま', state.buttons[0].disabled, false);
check('webGetState（refresh）は走っている', calls.indexOf('webGetState') >= 0, true);

finish();
