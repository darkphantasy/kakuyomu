// GAS API の最小モック。Kakuyomu_to_docs.js / WebApp.js を Node の vm に読み込み、
// フェーズ機械（continuesFetch → FETCHING → BUILD → finishRun）や web* 関数を実行時エラーなく
// 通せるようにする土台。実機の挙動を正確に再現するものではなく、
// 「状態遷移・プロパティ・呼び出し順が設計どおりか」を確かめるための器。
//
// 使い方:
//   const { createGasSandbox, workPage, episodePage } = require('./harness/gas-mock');
//   const { g, state } = createGasSandbox({ htmlByUrl: {...} });
//   g('webStartFetch("https://kakuyomu.jp/works/777")');   // sandbox 内で式を評価
//   state.props.PHASE                                       // Script Properties を直接見る
//
// state（すべて可変。テストから直接書き換えてよい）:
//   props        … Script Properties（key → string）
//   files        … フォルダ内のファイル name → content（バッファ txt など）
//   docs         … docId → { end }（Docs の body.content 終端 index）
//   createdDocs  … Docs.Documents.create の呼び出し回数（docId は 'DOC<n>'）
//   triggers     … 登録中のトリガー（ハンドラ関数名の配列）
//   batchUpdates … Docs.batchUpdate の記録 [{id, n}]
//   insertedTexts … Docs.batchUpdate の insertText で挿入した文字列（挿入順）
//   sheetOps     … 索引シートへの操作名の記録
//   sheetRows    … 索引スプレッドシートのタブ名 → 最後に setValues した2次元配列
//   htmlByUrl    … UrlFetchApp が返す HTML（url → html。無ければ 404）
//   cache        … CacheService の中身
//   logs         … Logger.log の記録
//
// opts:
//   htmlByUrl … 初期の URL → HTML 表
//   files     … 読み込むソース（既定 ['Kakuyomu_to_docs.js', 'Narou.js', 'WebApp.js']）
//   fetch     … (url, opt) => response | undefined。UrlFetchApp.fetch の前段フック
//               （Drive export の Range 応答など、テスト固有の応答を差し込む）
//   now       … Utilities.formatDate が返す固定文字列（既定 '2026-09-11 12:00'）
const fs   = require('fs');
const vm   = require('vm');
const path = require('path');

const SRC_DIR = path.join(__dirname, '..', '..', 'kaku_scraping', 'src');

// カクヨムの作品ページ（目次）を模した HTML。n 話ぶんのエピソードを持つ
function workPage(workId, title, n) {
  const apollo = { [`Work:${workId}`]: { title } };
  for (let i = 0; i < n; i++) {
    apollo[`Episode:${100 + i}`] = { title: `第${i + 1}話`, publishedAt: `2026-01-${String(i + 1).padStart(2, '0')}` };
  }
  return `<html><script id="__NEXT_DATA__">${JSON.stringify({ props: { pageProps: { __APOLLO_STATE__: apollo } } })}</script></html>`;
}

// エピソードページを模した HTML（字下げ行と会話行を 1 つずつ）
function episodePage(i) {
  const body = `<p>　本文${i}</p><p>「会話」</p>`;
  return `<html><script id="__NEXT_DATA__">${JSON.stringify({ props: { pageProps: { __APOLLO_STATE__: { 'Episode:x': { body } } } } })}</script></html>`;
}

// workId の作品（n 話）の目次 URL と各話 URL を htmlByUrl に登録する
function registerWork(htmlByUrl, workId, title, n) {
  htmlByUrl[`https://kakuyomu.jp/works/${workId}`] = workPage(workId, title, n);
  for (let i = 0; i < n; i++) {
    htmlByUrl[`https://kakuyomu.jp/works/${workId}/episodes/${100 + i}`] = episodePage(i + 1);
  }
  return htmlByUrl;
}

// ---- 小説家になろう（ncode.syosetu.com）を模した HTML。実物（2026-10）と同じクラス名・URL 形だけを持つ ----
// 目次の1ページ（1ページ 100 話。page は 1 始まり、n は全話数）
function narouTocPage(ncode, title, n, page) {
  const perPage = 100;
  const last = Math.max(1, Math.ceil(n / perPage));
  let items = '';
  for (let i = (page - 1) * perPage + 1; i <= Math.min(n, page * perPage); i++) {
    items += `<div class="p-eplist__sublist">\n<a href="/${ncode}/${i}/" class="p-eplist__subtitle">\n第${i}話 &amp; 話\n</a>\n<div class="p-eplist__update">2026/01/01</div>\n</div>\n`;
  }
  const pager = (last > 1)
    ? `<div class="c-pager"><div class="c-pager__pager">` +
      (page < last ? `<a href="/${ncode}/?p=${page + 1}" class="c-pager__item c-pager__item--next">次へ</a>` : '') +
      `<a href="/${ncode}/?p=${last}" class="c-pager__item c-pager__item--last">最後へ</a></div></div>`
    : '';
  return `<html><head><meta property="og:title" content="${title}"></head><body>` +
    `<h1 class="p-novel__title">${title}</h1>${pager}<div class="p-eplist">${items}</div>${pager}</body></html>`;
}

// 1話ぶんの本文ページ（opts.preface / opts.afterword で前書き・後書きを付ける）
function narouEpisodePage(i, opts = {}) {
  const div = (mod, inner) => `<div class="js-novel-text p-novel__text${mod ? ' p-novel__text--' + mod : ''}">\n${inner}\n</div>\n`;
  return `<html><body><h1 class="p-novel__title p-novel__title--rensai">第${i}話</h1><div class="p-novel__body">\n` +
    (opts.preface ? div('preface', `<p id="Lp1">前書き${i}</p>\n<p id="Lp2"><br /></p>`) : '') +
    div('', `<p id="L1"><br /></p>\n<p id="L2">　本文${i}の<ruby>漢字<rp>（</rp><rt>かんじ</rt><rp>）</rp></ruby>。</p>\n<p id="L3">「会話${i}」</p>`) +
    (opts.afterword ? div('afterword', `<p id="La1">後書き${i}</p>`) : '') +
    `</div></body></html>`;
}

// ncode の作品（n 話）の目次全ページと各話 URL を htmlByUrl に登録する
function registerNarouWork(htmlByUrl, ncode, title, n, epOpts) {
  const base = `https://ncode.syosetu.com/${ncode}/`;
  const last = Math.max(1, Math.ceil(n / 100));
  htmlByUrl[base] = narouTocPage(ncode, title, n, 1);
  for (let p = 2; p <= last; p++) htmlByUrl[`${base}?p=${p}`] = narouTocPage(ncode, title, n, p);
  for (let i = 1; i <= n; i++) htmlByUrl[`${base}${i}/`] = narouEpisodePage(i, epOpts);
  return htmlByUrl;
}

function createGasSandbox(opts = {}) {
  const state = {
    props: {}, files: {}, docs: {}, createdDocs: 0, triggers: [],
    batchUpdates: [], insertedTexts: [], sheetOps: [], sheetRows: {}, htmlByUrl: opts.htmlByUrl || {}, cache: {}, logs: [],
  };

  const propsApi = {
    getProperties: () => Object.assign({}, state.props),
    getProperty:   k => (k in state.props ? state.props[k] : null),
    setProperty:   (k, v) => { state.props[k] = String(v); },
    setProperties: o => { Object.keys(o).forEach(k => { state.props[k] = String(o[k]); }); },
    deleteProperty: k => { delete state.props[k]; },
  };

  function makeFile(name) {
    return {
      getId:      () => 'F:' + name,
      getName:    () => name,
      getSize:    () => (state.files[name] || '').length,
      getLastUpdated: () => new Date(),
      getBlob:    () => ({ getDataAsString: () => state.files[name] }),
      setTrashed: () => { delete state.files[name]; },
      isTrashed:  () => !(name in state.files),
      moveTo() {},
    };
  }
  const folder = {
    getId: () => 'FOLDER',
    getFilesByName: name => {
      const has = name in state.files; let used = false;
      return { hasNext: () => has && !used, next: () => { used = true; return makeFile(name); } };
    },
    searchFiles: q => {
      const m = q.match(/'(.+?)'/); const prefix = m ? m[1] : '';
      const names = Object.keys(state.files).filter(n => n.indexOf(prefix) >= 0); let i = 0;
      return { hasNext: () => i < names.length, next: () => makeFile(names[i++]) };
    },
    createFile: (name, content) => { state.files[name] = content; return makeFile(name); },
  };

  // 索引スプレッドシートのタブ。名前ごとに別の実体を持ち、最後に書き込んだ行を state.sheetRows[名前] に残す。
  function makeSheet(name) {
    const sh = {
      getName: () => name, setName(n) { delete sheets[name]; name = n; sheets[n] = sh; },
      getFilter: () => null, clear() { state.sheetOps.push('clear'); },
      getMaxColumns: () => 26, getMaxRows: () => 1000, insertColumnsAfter() {}, insertRowsAfter() {},
      deleteColumns() {}, deleteRows() {}, setFrozenRows() {}, setColumnWidth() {}, setColumnWidths() {},
      getRange: () => {
        const r = { setValues(v) { state.sheetOps.push('setValues'); state.sheetRows[name] = v; return r; }, getValues: () => [],
          setBackground: () => r, setFontColor: () => r, setFontWeight: () => r, setHorizontalAlignment: () => r, createFilter: () => r };
        return r;
      },
      getLastRow: () => 1, getLastColumn: () => 7, getDataRange: () => ({ getValues: () => [], getFormulas: () => [] }),
    };
    return sh;
  }
  const sheets = { '索引': null };
  sheets['索引'] = makeSheet('索引');
  const ss = {
    getId: () => 'SS1', getUrl: () => 'u',
    getSheetByName: n => sheets[n] || null,
    getSheets: () => Object.keys(sheets).map(k => sheets[k]),
    insertSheet: n => { state.sheetOps.push('insertSheet:' + n); sheets[n] = makeSheet(n); return sheets[n]; },
  };

  const httpResponse = (url, opt) => {
    const hooked = opts.fetch && opts.fetch(url, opt);
    if (hooked) return hooked;
    if (opt && opt.method === 'PATCH') { // writeFileContent（Drive 上のファイル上書き）
      const id = url.match(/files\/([^?]+)/)[1];
      state.files[id.slice(2)] = Buffer.from(opt.payload).toString();
      return { getResponseCode: () => 200, getContentText: () => '', getHeaders: () => ({}) };
    }
    const ok = url in state.htmlByUrl;
    return { getResponseCode: () => (ok ? 200 : 404), getContentText: () => state.htmlByUrl[url] || '', getHeaders: () => ({}) };
  };

  const sandbox = {
    console,
    Logger: { log: m => { state.logs.push(String(m)); } },
    PropertiesService: { getScriptProperties: () => propsApi },
    ScriptApp: {
      getScriptId: () => 'SCRIPT', getOAuthToken: () => 'tok',
      getProjectTriggers: () => state.triggers.map(t => ({ getHandlerFunction: () => t })),
      deleteTrigger: () => { state.triggers = []; },
      newTrigger: fn => ({ timeBased: () => ({ after: () => ({ create: () => { state.triggers.push(fn); } }) }) }),
    },
    Utilities: {
      formatDate: () => (opts.now || '2026-09-11 12:00'),
      sleep: () => {},
      newBlob: c => ({ getBytes: () => c }),
    },
    DriveApp: {
      getFileById: id => {
        if (id === 'SCRIPT') return { getParents: () => ({ hasNext: () => true, next: () => folder }) };
        if (id === 'SS1') return { isTrashed: () => false, moveTo() {} };
        if (id.startsWith('F:')) return makeFile(id.slice(2));
        if (state.docs[id]) return { isTrashed: () => false, moveTo() {}, getSize: () => state.docs[id].end,
          getLastUpdated: () => new Date(state.docs[id].updatedMs || Date.now()) };
        throw new Error('not found ' + id);
      },
      getFolderById: () => folder,
      getRootFolder: () => ({ getId: () => 'ROOT' }),
    },
    SpreadsheetApp: { openById: () => ss, create: () => ss },
    UrlFetchApp: {
      fetch: httpResponse,
      fetchAll: reqs => reqs.map(r => httpResponse(r.url, r)),
    },
    Docs: {
      Documents: {
        get: id => ({ body: { content: [{ endIndex: state.docs[id].end }] } }),
        batchUpdate: (req, id) => {
          state.batchUpdates.push({ id, n: req.requests.length });
          req.requests.forEach(r => { if (r.insertText) { state.docs[id].end += r.insertText.text.length; state.insertedTexts.push(r.insertText.text); } });
        },
        create: () => {
          state.createdDocs++;
          const id = 'DOC' + state.createdDocs;
          state.docs[id] = { end: 2 };
          return { documentId: id };
        },
      },
    },
    MimeType: { PLAIN_TEXT: 'text/plain' },
    LockService: { getScriptLock: () => ({ waitLock() {}, tryLock: () => true, releaseLock() {} }) },
    CacheService: {
      getScriptCache: () => ({
        get: k => (k in state.cache ? state.cache[k] : null),
        put: (k, v) => { state.cache[k] = v; },
        remove: k => { delete state.cache[k]; },
        removeAll: ks => { ks.forEach(k => { delete state.cache[k]; }); },
        getAll: ks => { const o = {}; ks.forEach(k => { if (k in state.cache) o[k] = state.cache[k]; }); return o; },
      }),
    },
    HtmlService: {},
  };
  vm.createContext(sandbox);

  (opts.files || ['Kakuyomu_to_docs.js', 'Narou.js', 'WebApp.js']).forEach(name => {
    vm.runInContext(fs.readFileSync(path.join(SRC_DIR, name), 'utf8'), sandbox, { filename: name });
  });

  const g = code => vm.runInContext(code, sandbox);
  return { sandbox, state, g };
}

module.exports = { createGasSandbox, workPage, episodePage, registerWork, narouTocPage, narouEpisodePage, registerNarouWork, SRC_DIR };
