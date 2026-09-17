// 一括続き取得を「フェーズ機械（BATCH_NEXT 分岐）」に移した後の流れを一気通貫で検証する。
//   - ボタン（webStartContinuationAll）が新着確認をせず即座に返ること
//   - 新着確認の各瞬間に webGetState が active:true と「確認済み k / N」を返すこと
//   - 新着なし／ありの両方で正しく完了し、結果1行（BATCH_RESULT）が残ること
//   - 時間切れ（BATCH_DEFERRED）でキューを保ったままトリガーを張り直すこと
//   - 実行中の追加投入とキュー取消で分母（BATCH_TOTAL）が整合すること
const fs = require('fs');
const vm = require('vm');

let propsStore = {};
const propsApi = {
  getProperties: () => Object.assign({}, propsStore),
  getProperty: k => (k in propsStore ? propsStore[k] : null),
  setProperty: (k, v) => { propsStore[k] = String(v); },
  setProperties: o => { Object.keys(o).forEach(k => { propsStore[k] = String(o[k]); }); },
  deleteProperty: k => { delete propsStore[k]; },
};

let files = {};
let docs = {};
let createdDocs = 0;
let triggers = [];
let tocFetches = [];     // 目次取得の履歴（その瞬間の webGetState を添える）

function makeFile(name) {
  return {
    getId: () => 'F:' + name,
    getBlob: () => ({ getDataAsString: () => files[name] }),
    setTrashed: () => { delete files[name]; },
  };
}
const folder = {
  getFilesByName: name => { const has = name in files; let used = false;
    return { hasNext: () => has && !used, next: () => { used = true; return makeFile(name); } }; },
  searchFiles: q => { const prefix = q.match(/'(.+)'/)[1];
    const names = Object.keys(files).filter(n => n.indexOf(prefix) >= 0); let i = 0;
    return { hasNext: () => i < names.length, next: () => makeFile(names[i++]) }; },
  createFile: (name, content) => { files[name] = content; return makeFile(name); },
};

function workPage(workId, title, n) {
  const apollo = { [`Work:${workId}`]: { title } };
  for (let i = 0; i < n; i++) apollo[`Episode:${100 + i}`] = { title: `第${i + 1}話`, publishedAt: `2026-01-${String(i + 1).padStart(2, '0')}` };
  return `<html><script id="__NEXT_DATA__">${JSON.stringify({ props: { pageProps: { __APOLLO_STATE__: apollo } } })}</script></html>`;
}
function episodePage(i) {
  return `<html><script id="__NEXT_DATA__">${JSON.stringify({ props: { pageProps: { __APOLLO_STATE__: { 'Episode:x': { body: `<p>　本文${i}</p>` } } } } })}</script></html>`;
}
let htmlByUrl = {};

const sheet = {
  getName: () => '索引', setName() {}, getFilter: () => null, clear() {},
  getMaxColumns: () => 26, getMaxRows: () => 1000, insertColumnsAfter() {}, insertRowsAfter() {},
  deleteColumns() {}, deleteRows() {}, setFrozenRows() {}, setColumnWidth() {}, setColumnWidths() {},
  getRange: () => { const r = { setValues: () => r, setBackground: () => r, setFontColor: () => r, setFontWeight: () => r, setHorizontalAlignment: () => r, createFilter: () => r }; return r; },
};
const ss = { getId: () => 'SS1', getUrl: () => 'u', getSheetByName: () => sheet, getSheets: () => [sheet] };

const sandbox = {
  console, Logger: { log: () => {} },
  PropertiesService: { getScriptProperties: () => propsApi },
  ScriptApp: {
    getScriptId: () => 'SCRIPT', getOAuthToken: () => 'tok',
    getProjectTriggers: () => triggers.map(t => ({ getHandlerFunction: () => t })),
    deleteTrigger: () => { triggers = []; },
    newTrigger: fn => ({ timeBased: () => ({ after: () => ({ create: () => { triggers.push(fn); } }) }) }),
  },
  Utilities: { formatDate: () => '12:00', sleep() {}, newBlob: c => ({ getBytes: () => c }) },
  DriveApp: {
    getFileById: id => {
      if (id === 'SCRIPT') return { getParents: () => ({ hasNext: () => true, next: () => ({ getId: () => 'F' }) }) };
      if (id === 'SS1') return { isTrashed: () => false, moveTo() {} };
      if (id.startsWith('F:')) return makeFile(id.slice(2));
      if (docs[id]) return { isTrashed: () => false, moveTo() {} };
      throw new Error('not found ' + id);
    },
    getFolderById: () => folder, getRootFolder: () => ({ getId: () => 'ROOT' }),
  },
  SpreadsheetApp: { openById: () => ss, create: () => ss },
  UrlFetchApp: {
    fetch: (url, opt) => {
      if (opt && opt.method === 'PATCH') { const id = url.match(/files\/([^?]+)/)[1]; files[id.slice(2)] = Buffer.from(opt.payload).toString(); return { getResponseCode: () => 200, getContentText: () => '' }; }
      const m = url.match(/works\/(\d+)$/);
      if (m) tocFetches.push({ workId: m[1], state: vm.runInContext('webGetState()', sandbox) });
      return { getResponseCode: () => (url in htmlByUrl ? 200 : 404), getContentText: () => htmlByUrl[url] || '' };
    },
    fetchAll: reqs => reqs.map(r => ({ getResponseCode: () => (r.url in htmlByUrl ? 200 : 404), getContentText: () => htmlByUrl[r.url] || '' })),
  },
  Docs: {
    Documents: {
      get: id => ({ body: { content: [{ endIndex: docs[id].end }] } }),
      batchUpdate: (req, id) => { req.requests.forEach(r => { if (r.insertText) docs[id].end += r.insertText.text.length; }); },
      create: () => { createdDocs++; const id = 'DOC' + createdDocs; docs[id] = { end: 2 }; return { documentId: id }; },
    },
  },
  MimeType: { PLAIN_TEXT: 'text/plain' },
  LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
  CacheService: { getScriptCache: () => ({ removeAll() {}, get: () => null, put() {}, getAll: () => ({}) }) },
  HtmlService: {},
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync('kaku_scraping/src/Kakuyomu_to_docs.js', 'utf8'), sandbox);
vm.runInContext(fs.readFileSync('kaku_scraping/src/WebApp.js', 'utf8'), sandbox);
const g = s => vm.runInContext(s, sandbox);

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log((ok ? '  OK   ' : '  FAIL ') + name + (ok ? '' : `\n         期待: ${JSON.stringify(expected)}\n         実際: ${JSON.stringify(actual)}`));
  ok ? pass++ : fail++;
}

// 記録3作品（各5話取得済み）。目次側の話数は各ケースで差し替える
function setupRecords() {
  propsStore = { INDEX_SHEET_ID: 'SS1' };
  ['200', '300', '400'].forEach(id => {
    propsStore['RESUME_' + id] = JSON.stringify({ title: 'W' + id, url: 'https://kakuyomu.jp/works/' + id, total: 5, lastEpisodeId: '104', docIds: ['DOC_' + id] });
    docs['DOC_' + id] = { end: 100 };
  });
  files = {}; triggers = []; tocFetches = []; createdDocs = 0;
}
function setToc(counts) {
  htmlByUrl = {};
  Object.keys(counts).forEach(id => {
    htmlByUrl['https://kakuyomu.jp/works/' + id] = workPage(id, 'W' + id, counts[id]);
    for (let i = 0; i < counts[id]; i++) htmlByUrl[`https://kakuyomu.jp/works/${id}/episodes/${100 + i}`] = episodePage(i + 1);
  });
}

console.log('\n■ ボタン: 新着確認をせず即座に返る');
setupRecords(); setToc({ 200: 5, 300: 5, 400: 5 });
const r1 = g('webStartContinuationAll()');
check('ok で返り、確認する旨のメッセージ', [r1.ok, r1.message.indexOf('順に確認') >= 0], [true, true]);
check('リクエスト中に目次取得が走っていない', tocFetches.length, 0);
check('PHASE=BATCH_NEXT・キュー3・分母3・新着あり0・トリガー1本',
  [propsStore.PHASE, JSON.parse(propsStore.BATCH_QUEUE).length, propsStore.BATCH_TOTAL, propsStore.BATCH_FETCHED, triggers],
  ['BATCH_NEXT', 3, '3', '0', ['continuesFetch']]);
const s1 = g('webGetState()');
check('webGetState: active・batchNext・確認済み 0/3', [s1.running.active, s1.running.batchNext, s1.running.batchDone, s1.running.batchTotal], [true, true, 0, 3]);

console.log('\n■ トリガー実行: 全件新着なし → 確認中の各瞬間で進捗が見え、最後に結果が残る');
g('continuesFetch()');
check('目次取得は3回', tocFetches.map(t => t.workId), ['200', '300', '400']);
check('各瞬間で active:true（画面が「待機中」にならない）', tocFetches.map(t => t.state.running.active), [true, true, true]);
check('確認済み件数が 1→2→3 と進む（取り出した時点で進む）', tocFetches.map(t => t.state.running.batchDone), [1, 2, 3]);
check('確認中は batchNext=true（「新着を確認中… k / 3 作品」表示）', tocFetches.map(t => t.state.running.batchNext), [true, true, true]);
check('完了: PHASE=DONE・BATCH_* は消える・トリガー削除',
  [propsStore.PHASE, 'BATCH_MODE' in propsStore, 'BATCH_QUEUE' in propsStore, 'BATCH_TOTAL' in propsStore, triggers],
  ['DONE', false, false, false, []]);
check('結果1行が残る', propsStore.BATCH_RESULT.indexOf('確認 3 作品・新着あり 0 作品') >= 0, true);
const s2 = g('webGetState()');
check('webGetState: active:false・lastBatchResult あり', [s2.running.active, s2.lastBatchResult.length > 0], [false, true]);

console.log('\n■ トリガー実行: 2作品目だけ新着あり → 取得して続きを確認し、結果は「新着あり 1」');
setupRecords(); setToc({ 200: 5, 300: 8, 400: 5 });
g('webStartContinuationAll()');
g('continuesFetch()');
check('目次取得の順序: 200(なし) → 300(あり・取得) → 400(なし)', tocFetches.map(t => t.workId), ['200', '300', '400']);
check('300 の記録が 8 話に更新されている', JSON.parse(propsStore.RESUME_300).total, 8);
check('400 を確認している瞬間は「実行中」ではなく再び確認中（batchNext）', tocFetches[2].state.running.batchNext, true);
check('完了: 結果は「確認 3 作品・新着あり 1 作品」', propsStore.BATCH_RESULT.indexOf('確認 3 作品・新着あり 1 作品') >= 0, true);
check('PHASE=DONE・トリガー削除', [propsStore.PHASE, triggers], ['DONE', []]);

console.log('\n■ 時間切れ: キューを保ったままトリガーを張り直し、PHASE は BATCH_NEXT のまま');
setupRecords(); setToc({ 200: 5, 300: 5, 400: 5 });
g('webStartContinuationAll()'); triggers = []; tocFetches = [];
const r2 = g('batchStartNext(PropertiesService.getScriptProperties(), Date.now() - 6 * 60 * 1000)');
check('BATCH_DEFERRED', r2, 'deferred');
check('目次取得はしていない・キューは3件のまま・トリガー1本・PHASE維持',
  [tocFetches.length, JSON.parse(propsStore.BATCH_QUEUE).length, triggers, propsStore.PHASE],
  [0, 3, ['continuesFetch'], 'BATCH_NEXT']);

console.log('\n■ 実行中の追加投入とキュー取消で分母が整合する');
setupRecords(); setToc({ 200: 5, 300: 5, 400: 5 });
propsStore.PHASE = 'FETCHING'; propsStore.BATCH_MODE = '1';
propsStore.BATCH_QUEUE = JSON.stringify([{ workId: '400', mode: 'cont' }]); propsStore.BATCH_TOTAL = '3';
const r3 = g('webStartContinuationAll()');
check('実行中なら順番待ちに追加', r3.message.indexOf('順番待ちに追加') >= 0, true);
check('キュー 1+3=4・分母 3+3=6', [JSON.parse(propsStore.BATCH_QUEUE).length, propsStore.BATCH_TOTAL], [4, '6']);
check('webGetState: 確認済み 6-4=2 / 6', [g('webGetState()').running.batchDone, g('webGetState()').running.batchTotal], [2, 6]);
g('webClearQueue()');
check('取消後: キュー0・分母は取り消し分を引いて 2（確認済み 2 と一致）・BATCH_MODE は残る',
  [JSON.parse(propsStore.BATCH_QUEUE).length, propsStore.BATCH_TOTAL, propsStore.BATCH_MODE], [0, '2', '1']);

console.log(`\n合計: ${pass} 件成功 / ${fail} 件失敗\n`);
process.exit(fail ? 1 : 0);
