// index.html: kakuyomuExtractCandidates_() の抽出ロジック（未読・全話数の正規表現が
// 空白文字（半角/全角スペース・&nbsp;）の有無に関わらずマッチすることを確認する）。
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

function runRaw(items) {
  let promptArgs = null;
  const alerts = [];
  const sandbox = {
    console,
    document: {
      querySelectorAll: sel => (sel === '.widget-antennaList-item' ? items : []),
      getElementById: () => null, addEventListener() {},
      createElement: () => ({ appendChild(){}, style: {} }),
    },
    window: { addEventListener() {}, prompt: (m, d) => { promptArgs = { m, d }; return d; } },
    google: { script: { run: new Proxy({}, { get: () => () => {} }) } },
    setTimeout: () => {}, clearTimeout: () => {}, confirm: () => true,
    alert: m => { alerts.push(m); },
    Number, Object, Date, JSON, Math, String, Array,
  };
  vm.createContext(sandbox);
  vm.runInContext(script, sandbox, { filename: 'index.html' });
  vm.runInContext('kakuyomuExtractCandidates_()', sandbox);
  return { promptArgs, alerts };
}

function run(items) {
  return JSON.parse(runRaw(items).promptArgs.d);
}

section('未読・全話数の間に空白（半角/全角/&nbsp;）があっても数値を拾う');
const cases = [
  ['空白なし',   '未読1話',            '連載中210話'],
  ['半角スペース', '未読 1 話',          '連載中 210 話'],
  ['全角スペース', '未読　1話',      '連載中　210話'],
  ['&nbsp;',     '未読 1話',      '連載中 210話'],
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

section('対象が1件も見つからない場合は無言で終わらず alert する（違うページで実行した時の気づき用）');
const r4 = runRaw([]);
check('prompt は呼ばれない', r4.promptArgs, null);
check('alert が1回出る', r4.alerts.length, 1);

section('抽出中の例外は catch されて alert される（「クリックしても何も起きない」ように見えるのを防ぐ）');
const badItem = { querySelector() { throw new Error('模擬エラー'); }, querySelectorAll: () => [] };
const r5 = runRaw([badItem]);
check('prompt は呼ばれない', r5.promptArgs, null);
check('alert にエラー内容が出る', r5.alerts.length === 1 && r5.alerts[0].indexOf('模擬エラー') >= 0, true);

finish();
