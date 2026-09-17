// index.html: kakuyomuExtractCandidates_() の抽出ロジック。
//   ・未読・全話数の正規表現が空白文字（半角/全角スペース・&nbsp;）の有無に関わらずマッチすること
//   ・結果の受け渡しが window.prompt() ではなく新しいタブの <textarea> で行われること
//     （長い文字列だと prompt() は環境によって表示・コピーの途中で切れることがあり、
//      貼り付け先で JSON.parse に失敗する不具合があったため）
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const { check, section, finish } = require('./harness/check');

const html = fs.readFileSync(path.join(__dirname, '..', 'kaku_scraping', 'src', 'index.html'), 'utf8');
const script = html.match(/<script>([\s\S]*)<\/script>/)[1];

// widget-antennaList-item 1件ぶんの最小 DOM モック。
function makeItem(workId, title, eventTexts) {
  return {
    querySelector(sel) {
      if (sel === '.widget-antennaList-workInfo') return { getAttribute: () => '/works/' + workId };
      if (sel === '.widget-antennaList-title') return { textContent: title };
      return null;
    },
    querySelectorAll(sel) {
      return (sel === '.widget-antennaList-event li') ? eventTexts.map(t => ({ textContent: t })) : [];
    },
  };
}

// window.open() が返す新しいタブの最小モック。document.createElement で作った要素は
// textarea の value を後から検査できるよう、そのまま返す（appendChild は記録するだけ）。
function makeFakeWindow() {
  const body = { children: [], appendChild(el) { this.children.push(el); } };
  return {
    document: {
      title: '',
      body: body,
      createElement: () => ({ style: {}, appendChild(){}, focus(){}, select(){}, value: '', textContent: '', readOnly: false }),
    },
  };
}

function runRaw(items, expr, openReturnsNull) {
  let promptArgs = null;
  const alerts = [];
  let openedWindow = null;
  const sandbox = {
    console,
    document: {
      querySelectorAll: sel => (sel === '.widget-antennaList-item' ? items : []),
      getElementById: () => null, addEventListener() {},
      createElement: () => ({ appendChild(){}, style: {} }),
    },
    window: {
      addEventListener() {},
      prompt: (m, d) => { promptArgs = { m, d }; return d; },
      open: () => {
        if (openReturnsNull) return null;
        openedWindow = makeFakeWindow();
        return openedWindow;
      },
    },
    google: { script: { run: new Proxy({}, { get: () => () => {} }) } },
    setTimeout: () => {}, clearTimeout: () => {}, confirm: () => true,
    alert: m => { alerts.push(m); },
    Number, Object, Date, JSON, Math, String, Array,
  };
  vm.createContext(sandbox);
  vm.runInContext(script, sandbox, { filename: 'index.html' });
  const value = vm.runInContext(expr || 'kakuyomuExtractCandidates_()', sandbox);
  return { promptArgs, alerts, value, get window() { return openedWindow; } };
}

// 新しいタブに appendChild された <textarea> の value（＝抽出結果の JSON）を取り出す
function extractedJson(r) {
  const ta = r.window.document.body.children.find(el => el.value);
  return JSON.parse(ta.value);
}

function run(items) {
  return extractedJson(runRaw(items));
}

section('未読・全話数の間に空白（半角/全角/&nbsp;）があっても数値を拾う');
const cases = [
  ['空白なし',   '未読1話',            '連載中210話'],
  ['半角スペース', '未読 1 話',          '連載中 210 話'],
  ['全角スペース', '未読　1話',      '連載中　210話'],
  ['&nbsp;',     '未読 1話',      '連載中 210話'],
];
cases.forEach(([label, unreadText, totalText], i) => {
  const items = run([makeItem('1000' + i, '作品' + i, [unreadText, totalText])]);
  check(label + ': unread=1, total=210', [items[0].unread, items[0].total], [1, 210]);
});

section('完結済表記・桁区切りカンマにも対応する');
const items2 = run([makeItem('2000', '完結作品', ['完結済1,232話'])]);
check('カンマ区切りの全話数を数値化', items2[0].total, 1232);

section('未読の記載が無い作品は unread:null になる（全話既読）');
const items3 = run([makeItem('3000', '既読済み作品', ['連載中50話'])]);
check('unread は null・total は 50', [items3[0].unread, items3[0].total], [null, 50]);

section('結果は window.prompt ではなく新しいタブの textarea で渡す（長い文字列でも途中で切れないため）');
const r0 = runRaw([makeItem('4000', '作品', ['未読1話', '連載中10話'])]);
check('window.prompt は呼ばれない', r0.promptArgs, null);
check('textarea は選択状態にしてある（select が呼べる = 例外にならない）', typeof r0.window.document.body.children[1].select, 'function');

section('window.open がブロックされた場合（ポップアップブロック）は window.prompt にフォールバックする');
const r0b = runRaw([makeItem('4001', '作品', ['未読1話', '連載中10話'])], null, /* openReturnsNull */ true);
check('prompt が呼ばれ、JSON が渡る', JSON.parse(r0b.promptArgs.d)[0].url.indexOf('4001') >= 0, true);

section('対象が1件も見つからない場合は無言で終わらず alert する（違うページで実行した時の気づき用）');
const r4 = runRaw([]);
check('新しいタブは開かない', r4.window, null);
check('alert が1回出る', r4.alerts.length, 1);

section('抽出中の例外は catch されて alert される（「クリックしても何も起きない」ように見えるのを防ぐ）');
const badItem = { querySelector() { throw new Error('模擬エラー'); }, querySelectorAll: () => [] };
const r5 = runRaw([badItem]);
check('新しいタブは開かない', r5.window, null);
check('alert にエラー内容が出る', r5.alerts.length === 1 && r5.alerts[0].indexOf('模擬エラー') >= 0, true);

section('この画面でリンクを押したときは動作確認として同じ処理をその場で実行する');
// GAS の Web アプリは iframe の中で動くため、リンクを踏んでも javascript: は実行されない。
// クリックを握りつぶすと「押しても何も起きない」ため、代わりに関数をその場で呼んで結果を見せる。
const r6 = runRaw([], 'runBookmarkletHere()');
check('false を返す（javascript: への遷移はさせない）', r6.value, false);
check('カクヨムのページではないので「0 件」の警告が出る', r6.alerts.length, 1);
check('その警告に実行ページの案内が含まれる', r6.alerts[0].indexOf('閲覧履歴') >= 0, true);

finish();
