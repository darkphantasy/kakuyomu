// 一括続き取得の「作品の切り替え中」に webGetState() が active:false を返す窓があるか検証する。
//   finishRun は clearRunState() で PHASE を消した後に batchStartNext() で次の作品の
//   目次取得（ネットワーク・ページングあり）を行う。その間 PHASE が空 = 実行中と判定されない。
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

// 目次取得のたびに「その瞬間の active」を記録する（＝Web UI がポーリングしたらどう見えるか）
let activeSamples = [];
function sampleActive(label) {
  activeSamples.push({ label, active: vm.runInContext('webGetState().running.active', sandbox) });
}

let files = {};
const folder = {
  getFilesByName: () => ({ hasNext: () => false }),
  searchFiles: () => ({ hasNext: () => false }),
  createFile: () => ({ getId: () => 'F' }),
};

function workPage(workId, title, n) {
  const apollo = { [`Work:${workId}`]: { title } };
  for (let i = 0; i < n; i++) apollo[`Episode:${100 + i}`] = { title: `第${i + 1}話`, publishedAt: `2026-01-${String(i + 1).padStart(2, '0')}` };
  return `<html><script id="__NEXT_DATA__">${JSON.stringify({ props: { pageProps: { __APOLLO_STATE__: apollo } } })}</script></html>`;
}

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
    getProjectTriggers: () => [], deleteTrigger() {},
    newTrigger: () => ({ timeBased: () => ({ after: () => ({ create() {} }) }) }),
  },
  Utilities: { formatDate: () => '2026-09-11 12:00', sleep() {}, newBlob: c => ({ getBytes: () => c }) },
  DriveApp: {
    getFileById: id => {
      if (id === 'SCRIPT') return { getParents: () => ({ hasNext: () => true, next: () => ({ getId: () => 'F' }) }) };
      return { isTrashed: () => false, moveTo() {} };
    },
    getFolderById: () => folder, getRootFolder: () => ({ getId: () => 'ROOT' }),
  },
  SpreadsheetApp: { openById: () => ss, create: () => ss },
  UrlFetchApp: {
    fetch: url => {
      // 目次取得の最中＝まさに「次の作品を準備中」の瞬間
      const m = url.match(/works\/(\d+)$/);
      if (m) sampleActive('目次取得中(' + m[1] + ')');
      const body = htmlByUrl[url];
      return { getResponseCode: () => (body ? 200 : 404), getContentText: () => body || '' };
    },
    fetchAll: reqs => reqs.map(() => ({ getResponseCode: () => 404, getContentText: () => '' })),
  },
  Docs: { Documents: { get: () => ({ body: { content: [{ endIndex: 2 }] } }), batchUpdate() {}, create: () => ({ documentId: 'DOC1' }) } },
  MimeType: { PLAIN_TEXT: 'text/plain' },
  LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
  CacheService: { getScriptCache: () => ({ removeAll() {}, get: () => null, put() {}, getAll: () => ({}) }) },
  HtmlService: {},
};

// 作品A(完了済み)＋キューに B,C,D。B,C は新着なし、D だけ新着あり。
const htmlByUrl = {
  'https://kakuyomu.jp/works/200': workPage('200', 'B', 5),  // 記録5話＝新着なし
  'https://kakuyomu.jp/works/300': workPage('300', 'C', 5),  // 新着なし
  'https://kakuyomu.jp/works/400': workPage('400', 'D', 9),  // 記録5話＝新着あり
};

vm.createContext(sandbox);
vm.runInContext(fs.readFileSync('kaku_scraping/src/Kakuyomu_to_docs.js', 'utf8'), sandbox);
vm.runInContext(fs.readFileSync('kaku_scraping/src/WebApp.js', 'utf8'), sandbox);

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log((ok ? '  OK   ' : '  FAIL ') + name + (ok ? '' : `\n         期待: ${JSON.stringify(expected)}\n         実際: ${JSON.stringify(actual)}`));
  ok ? pass++ : fail++;
}

function setupBatchFinish() {
  activeSamples = [];
  propsStore = {
    // 直前まで作品A を取得していた run 状態
    WORK_ID: '100', TITLE: 'A', SOURCE_URL: 'https://kakuyomu.jp/works/100',
    EPISODE_TOTAL: '3', LAST_EPISODE_ID: '102', PHASE: 'BUILD', BUILD_CURSOR: '10',
    // 一括続き取得のキュー（B,C は新着なし、D は新着あり）
    BATCH_MODE: '1',
    BATCH_QUEUE: JSON.stringify([
      { workId: '200', mode: 'cont' }, { workId: '300', mode: 'cont' }, { workId: '400', mode: 'cont' },
    ]),
    INDEX_SHEET_ID: 'SS1',
    RESUME_200: JSON.stringify({ title: 'B', url: 'https://kakuyomu.jp/works/200', total: 5, lastEpisodeId: '104', docIds: ['d'] }),
    RESUME_300: JSON.stringify({ title: 'C', url: 'https://kakuyomu.jp/works/300', total: 5, lastEpisodeId: '104', docIds: ['d'] }),
    RESUME_400: JSON.stringify({ title: 'D', url: 'https://kakuyomu.jp/works/400', total: 5, lastEpisodeId: '104', docIds: ['d'] }),
  };
}

console.log('\n■ 一括続き取得：作品の切り替え中に Web UI がどう見えるか');
setupBatchFinish();
// runFetchPhase は EPISODES 無しで即 return するので、finishRun の分岐だけを見る
vm.runInContext('finishRun(PropertiesService.getScriptProperties(), "100", ["DOC1"], Date.now())', sandbox);

console.log('   ポーリングがこの瞬間に当たったら何が見えるか:');
activeSamples.forEach(s => console.log(`     - ${s.label} → active: ${s.active}`));

check('次の作品の目次取得が3回走る（B・C は新着なしで読み飛ばし、D で確定）', activeSamples.length, 3);
check('【修正後】その全ての瞬間で active:true（＝画面は「準備中」のままポーリングを続ける）',
  activeSamples.map(s => s.active), [true, true, true]);
// D は同一実行枠で最後まで完走する（B・C は新着なしで読み飛ばし）
check('処理自体は正しく進み、D の記録が9話に更新されている',
  [JSON.parse(propsStore.RESUME_400).total, propsStore.PHASE], [9, 'DONE']);

console.log('\n■ 対比: トリガーに回す経路（canInline=false）では PHASE_BATCH_NEXT が立つので active:true');
setupBatchFinish();
vm.runInContext('finishRun(PropertiesService.getScriptProperties(), "100", ["DOC1"], Date.now() - 5 * 60 * 1000)', sandbox);
check('PHASE=BATCH_NEXT', propsStore.PHASE, 'BATCH_NEXT');
check('この経路なら active:true のまま', vm.runInContext('webGetState().running.active', sandbox), true);

console.log(`\n合計: ${pass} 件成功 / ${fail} 件失敗\n`);
process.exit(fail ? 1 : 0);
