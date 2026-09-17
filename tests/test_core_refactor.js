// 可読性リファクタで抽出したヘルパー（Kakuyomu_to_docs.js）が元の振る舞いを保っているか検証する
const fs = require('fs');
const vm = require('vm');

// ---- GAS モック ----
let propsStore = {};
const propsApi = {
  getProperties: () => Object.assign({}, propsStore),
  getProperty: k => (k in propsStore ? propsStore[k] : null),
  setProperty: (k, v) => { propsStore[k] = String(v); },
  setProperties: o => { Object.keys(o).forEach(k => { propsStore[k] = String(o[k]); }); },
  deleteProperty: k => { delete propsStore[k]; },
};

let htmlByUrl = {};
let docs = {};            // docId -> { trashed, end }
let batchUpdates = [];    // Docs.Documents.batchUpdate の呼び出し履歴
let createdDocs = 0;
let sheetOps = [];        // Sheet 操作の履歴

function makeSheet() {
  return {
    _maxCols: 26, _maxRows: 1000, _name: 'Sheet1',
    getName() { return this._name; }, setName(n) { this._name = n; sheetOps.push('setName:' + n); },
    getFilter: () => null, clear() { sheetOps.push('clear'); },
    getMaxColumns() { return this._maxCols; }, getMaxRows() { return this._maxRows; },
    insertColumnsAfter(a, n) { this._maxCols += n; sheetOps.push('insertColumnsAfter'); },
    insertRowsAfter(a, n) { this._maxRows += n; sheetOps.push('insertRowsAfter'); },
    deleteColumns(a, n) { this._maxCols -= n; sheetOps.push(`deleteColumns(${a},${n})`); },
    deleteRows(a, n) { this._maxRows -= n; sheetOps.push(`deleteRows(${a},${n})`); },
    getRange() {
      const r = {
        setValues(v) { sheetOps.push('setValues:' + v.length + 'x' + v[0].length); return r; },
        setBackground() { return r; }, setFontColor() { return r; }, setFontWeight() { return r; },
        setHorizontalAlignment() { return r; }, createFilter() { sheetOps.push('createFilter'); return r; },
      };
      return r;
    },
    setFrozenRows() { sheetOps.push('setFrozenRows'); },
    setColumnWidth(i, w) { sheetOps.push(`setColumnWidth(${i},${w})`); },
    setColumnWidths(s, n, w) { sheetOps.push(`setColumnWidths(${s},${n},${w})`); },
  };
}
let sheetObj = makeSheet();
const ssObj = {
  getId: () => 'SS1', getUrl: () => 'https://sheets/SS1',
  getSheetByName: n => (n === '索引' ? sheetObj : null),
  getSheets: () => [sheetObj],
};

const sandbox = {
  console, Logger: { log: () => {} },
  PropertiesService: { getScriptProperties: () => propsApi },
  ScriptApp: { getScriptId: () => 'SCRIPT', getOAuthToken: () => 'tok', getProjectTriggers: () => [] },
  Utilities: { formatDate: () => '2026-09-09 12:00', sleep: () => {}, newBlob: () => ({ getBytes: () => [] }) },
  DriveApp: {
    getFileById: id => {
      if (id === 'SCRIPT') return { getParents: () => ({ hasNext: () => true, next: () => ({ getId: () => 'FOLDER' }) }) };
      if (id === 'SS1') return { isTrashed: () => false, moveTo: () => {} };
      const d = docs[id]; if (!d) throw new Error('not found');
      return { isTrashed: () => !!d.trashed, moveTo: () => {} };
    },
    getFolderById: () => ({ getFilesByName: () => ({ hasNext: () => false }), searchFiles: () => ({ hasNext: () => false }) }),
    getRootFolder: () => ({ getId: () => 'ROOT' }),
  },
  SpreadsheetApp: { openById: () => ssObj, create: () => { sheetOps.push('create'); return ssObj; } },
  UrlFetchApp: {
    fetch: url => ({ getResponseCode: () => (url in htmlByUrl ? 200 : 404), getContentText: () => htmlByUrl[url] || '' }),
  },
  Docs: {
    Documents: {
      get: (id) => ({ body: { content: [{ endIndex: docs[id].end }] } }),
      batchUpdate: (req, id) => { batchUpdates.push({ id, req }); },
      create: () => { createdDocs++; const id = 'NEW' + createdDocs; docs[id] = { end: 2 }; return { documentId: id }; },
    },
  },
  MimeType: { PLAIN_TEXT: 'text/plain' },
  LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync('kaku_scraping/src/Kakuyomu_to_docs.js', 'utf8'), sandbox);
// WebApp.js 側の関数も同じスコープに入れる（finishRun が invalidateDocSizeCache_ を呼ぶため）
sandbox.CacheService = { getScriptCache: () => ({ removeAll() {}, get: () => null, put() {}, getAll: () => ({}) }) };
sandbox.HtmlService = {};
vm.runInContext(fs.readFileSync('kaku_scraping/src/WebApp.js', 'utf8'), sandbox);

const g = name => vm.runInContext(name, sandbox);

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log((ok ? '  OK   ' : '  FAIL ') + name + (ok ? '' : `\n         期待: ${JSON.stringify(expected)}\n         実際: ${JSON.stringify(actual)}`));
  ok ? pass++ : fail++;
}

// ---- __NEXT_DATA__ 入りの作品ページ HTML を作る ----
function workPage(workId, title, epTitles) {
  const apollo = { [`Work:${workId}`]: { title } };
  epTitles.forEach((t, i) => { apollo[`Episode:${100 + i}`] = { title: t, publishedAt: `2026-01-${String(i + 1).padStart(2, '0')}` }; });
  const nd = { props: { pageProps: { __APOLLO_STATE__: apollo } } };
  return `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(nd)}</script></html>`;
}

console.log('\n■ loadResumeRecords_');
propsStore = {
  RESUME_a: JSON.stringify({ title: 'A', total: 3, updatedAt: '2026-01-01 00:00', docIds: ['d1'] }),
  RESUME_b: 'broken json',
  OTHER: 'x',
};
check('RESUME_ だけを拾い、壊れた JSON は {} になる',
  g('loadResumeRecords_()').map(r => [r.workId, r.rec.title || null]).sort(),
  [['a', 'A'], ['b', null]]);
check('all を渡すとそのスナップショットを使う',
  g('loadResumeRecords_({ RESUME_z: "{\\"title\\":\\"Z\\"}" })').map(r => r.workId), ['z']);

console.log('\n■ loadWorkCatalog_');
htmlByUrl = { 'https://kakuyomu.jp/works/777': workPage('777', '作品タイトル', ['第1話', '第2話']) };
const cat = g('loadWorkCatalog_("https://kakuyomu.jp/works/777", "777")');
check('タイトルと全話一覧をまとめて返す', [cat.title, cat.episodes.map(e => e.title)], ['作品タイトル', ['第1話', '第2話']]);
check('nextData も同梱される（診断用）', typeof cat.nextData, 'object');
check('HTML が取れなければ null', g('loadWorkCatalog_("https://kakuyomu.jp/works/none", "none")'), null);

console.log('\n■ prepareFetch / prepareContinuation / seedResumeRecord が同じ経路で動く');
propsStore = {};
check('prepareFetch は run 状態をセットして true', g('prepareFetch("https://kakuyomu.jp/works/777")'), true);
check('EPISODE_TOTAL / TITLE が入る', [propsStore.EPISODE_TOTAL, propsStore.TITLE, propsStore.PHASE], ['2', '作品タイトル', 'FETCHING']);
propsStore = {};
g('seedResumeRecord("https://kakuyomu.jp/works/777", [])');
check('seedResumeRecord は記録を作る', JSON.parse(propsStore.RESUME_777).total, 2);
htmlByUrl['https://kakuyomu.jp/works/777'] = workPage('777', '作品タイトル', ['第1話', '第2話', '第3話']);
check('prepareContinuation は差分（3話目）を拾う', [g('prepareContinuation("https://kakuyomu.jp/works/777")'), propsStore.CONT_FROM, propsStore.CONT_TO], [true, '3', '3']);

console.log('\n■ extractEpisodeText_');
const epHtml = `<html><script id="__NEXT_DATA__">${JSON.stringify({ props: { pageProps: { __APOLLO_STATE__: { 'Episode:1': { body: '<p>本文です</p>' } } } } })}</script></html>`;
check('__NEXT_DATA__ から本文を取る', g(`extractEpisodeText_(${JSON.stringify(epHtml)})`), '本文です');
check('__NEXT_DATA__ が無ければ HTML を直接見る',
  g('extractEpisodeText_(\'<div class="widget-episodeBody"><p>直読み</p></div>\')'), '直読み');

console.log('\n■ buildIndexRows_');
const rows = g(`buildIndexRows_(${JSON.stringify([
  { workId: 'a', title: 'A', total: 3, updatedAt: 'u', url: 'https://kakuyomu.jp/works/a', docIds: ['d1', 'd2'] },
  { workId: 'b', title: 'B', total: 1, updatedAt: 'u', url: '', docIds: [] },
])})`);
check('ヘッダー列 = 6 + 最大分冊数', rows[0], ['短縮作品名', '作品タイトル', '話数', 'ファイル数', '最終更新', '元URL', 'ファイル1', 'ファイル2']);
check('分冊リンクは位置で採番し、無い列は空', rows[1].slice(6), ['=HYPERLINK("https://docs.google.com/document/d/d1","1冊目")', '=HYPERLINK("https://docs.google.com/document/d/d2","2冊目")']);
check('URL 無し・分冊無しの行', [rows[2][5], rows[2][6], rows[2][7]], ['', '', '']);

console.log('\n■ updateIndexSpreadsheet（分割後も同じ操作列になる）');
propsStore = {
  INDEX_SHEET_ID: 'SS1',
  RESUME_a: JSON.stringify({ title: 'A', total: 3, updatedAt: '2026-01-02 00:00', url: 'u', docIds: ['d1', 'd2', 'd3'] }),
  RESUME_b: JSON.stringify({ title: 'B', total: 1, updatedAt: '2026-01-01 00:00', url: 'u', docIds: [] }),
};
sheetOps = []; sheetObj = makeSheet();
g('updateIndexSpreadsheet()');
check('既存シートを開き直し、clear → setValues(3x9) → 装飾 → 余分削除 → フィルタ → 列幅 の順',
  sheetOps, ['clear', 'setValues:3x9', 'setFrozenRows', 'deleteColumns(10,17)', 'deleteRows(4,997)', 'createFilter',
             'setColumnWidth(1,200)', 'setColumnWidth(2,340)', 'setColumnWidth(3,64)', 'setColumnWidth(4,84)',
             'setColumnWidth(5,150)', 'setColumnWidth(6,70)', 'setColumnWidths(7,3,72)']);
propsStore.INDEX_SHEET_ID = ''; delete propsStore.INDEX_SHEET_ID;
sheetOps = []; sheetObj = makeSheet();
g('updateIndexSpreadsheet()');
check('ID が無ければ新規作成して ID を保存する', [sheetOps[0], propsStore.INDEX_SHEET_ID], ['create', 'SS1']);

console.log('\n■ resolveBuildTarget_');
docs = { last: { end: 100 } }; batchUpdates = []; createdDocs = 0;
let ids = ['first', 'last'];
let t = g(`resolveBuildTarget_(true, ${JSON.stringify(ids)}, "T", "")`);
check('続き取得で末尾ドキュメントが使えれば追記（\\n\\n を先に入れて cursor+2）',
  [t.docId, t.cursor, t.docPart, batchUpdates[0].req.requests[0].insertText.text], ['last', 101, 1, '\n\n']);

docs = { last: { end: 100, trashed: true } }; batchUpdates = []; createdDocs = 0;
const arr = ['first', 'last'];
vm.runInContext(`globalThis.__ids = ${JSON.stringify(arr)};`, sandbox);
t = g('resolveBuildTarget_(true, globalThis.__ids, "T", "")');
check('末尾がゴミ箱なら新規作成し、docIds に push される',
  [t.docId, t.docPart, g('globalThis.__ids')], ['NEW1', 2, ['first', 'last', 'NEW1']]);

docs = { last: { end: 900002 } }; batchUpdates = []; createdDocs = 0;
vm.runInContext(`globalThis.__ids = ["last"];`, sandbox);
t = g('resolveBuildTarget_(true, globalThis.__ids, "T", "")');
check('上限到達なら新規（追記しない）', [t.docId, batchUpdates.length === 0 || batchUpdates[0].id !== 'last'], ['NEW1', true]);

createdDocs = 0;
vm.runInContext(`globalThis.__ids = [];`, sandbox);
t = g('resolveBuildTarget_(false, globalThis.__ids, "T", "")');
check('初回取得は常に新規（docPart=0）', [t.docId, t.docPart, t.cursor > 1], ['NEW1', 0, true]);

console.log('\n■ finishRun（docIds 未指定でも落ちない）');
propsStore = { EPISODE_TOTAL: '5', TITLE: 'T', SOURCE_URL: 'u', INDEX_SHEET_ID: 'SS1' };
sheetObj = makeSheet();
g('finishRun(PropertiesService.getScriptProperties(), "w1", undefined, Date.now())');
check('記録の docIds は []', JSON.parse(propsStore.RESUME_w1).docIds, []);
check('PHASE=DONE で終わる', propsStore.PHASE, 'DONE');

console.log(`\n合計: ${pass} 件成功 / ${fail} 件失敗\n`);
process.exit(fail ? 1 : 0);
