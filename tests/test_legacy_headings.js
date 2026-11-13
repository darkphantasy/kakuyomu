// 旧形式の話見出し（HEADING_3）を HEADING_4 に揃える独立ツール（Reformat_existing_docs.js の convertLegacyEpisodeHeadings）。
//   ・最初の H4 より前の H3 だけが対象。新形式の部分の H3（章）は触らない
//   ・追記の境目に章の見出しがあれば、その 1 件は残す（[NNN] の行数で判定）
//   ・数が合わなければ何も書き換えない
//   ・Docs API は構造のみ（本文テキストを含む fields を使わない）
const fs   = require('fs');
const path = require('path');
const vm   = require('vm');
const { check, section, finish } = require('./harness/check');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'kaku_scraping', 'src', 'Reformat_existing_docs.js'), 'utf8');

// paras: [[style, text], ...]。text は改行抜き。index は UTF-16 で連続に割り当てる。
function sandbox(paras, opts) {
  opts = opts || {};
  const state = { gets: [], updates: [], logs: [] };
  let idx = 1;
  const content = [{ endIndex: 1 }]; // sectionBreak 相当
  paras.forEach(([style, text]) => {
    idx += text.length + 1;
    content.push({ endIndex: idx, paragraph: { paragraphStyle: { namedStyleType: style } } });
  });
  const exportText = paras.map(p => p[1]).join('\r\n\r\n');
  const ctx = {
    Logger: { log: s => state.logs.push(String(s)) },
    Docs: { Documents: {
      get: (id, o) => { state.gets.push(o.fields); return { body: { content } }; },
      batchUpdate: (body, id) => { state.updates.push(...body.requests); },
    } },
    UrlFetchApp: { fetch: () => ({ getResponseCode: () => opts.exportCode || 200, getContentText: () => exportText }) },
    ScriptApp: { getOAuthToken: () => 'tok' },
  };
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  vm.runInContext('convertLegacyEpisodeHeadings()', ctx);
  // 変換された段落の本文
  const starts = [];
  let i = 1;
  paras.forEach(([, text]) => { starts.push([i, text]); i += text.length + 1; });
  const changed = state.updates
    .filter(r => r.updateParagraphStyle && r.updateParagraphStyle.paragraphStyle.namedStyleType === 'HEADING_4')
    .map(r => starts.find(s => s[0] === r.updateParagraphStyle.range.startIndex)[1]);
  return { state, changed };
}

section('境目に章の見出しがある（旧: 話 H3 → 新: 章 H3 + 話 H4）');
{
  const { state, changed } = sandbox([
    ['HEADING_2', '作品（2）'],
    ['HEADING_3', '第1話 はじまり [001]'], ['NORMAL_TEXT', '本文'],
    ['HEADING_3', '第2話 つづき [002]'], ['NORMAL_TEXT', '本文 [12]'],
    ['NORMAL_TEXT', '────────────────'], ['NORMAL_TEXT', '【取得記録】'],
    ['HEADING_3', '第二章'],
    ['HEADING_4', '第3話 [003]'], ['NORMAL_TEXT', '本文'],
    ['HEADING_3', '第三章'],
    ['HEADING_4', '第4話 [004]'], ['NORMAL_TEXT', '本文'],
  ]);
  check('旧形式の話 2 件だけが HEADING_4 になる', changed, ['第1話 はじまり [001]', '第2話 つづき [002]']);
  check('太字の当て直しも同じ件数', state.updates.filter(r => r.updateTextStyle).length, 2);
  check('Docs API は構造のみで読む', state.gets.every(f => !/textRun|content\)\)/.test(f) && !/elements/.test(f)), true);
}

section('境目に章の見出しが無い（章の途中から追記）');
{
  const { changed } = sandbox([
    ['HEADING_3', '第1話 [001]'], ['NORMAL_TEXT', '本文'],
    ['HEADING_3', '第2話 [002]'], ['NORMAL_TEXT', '本文'],
    ['HEADING_4', '第3話 [003]'], ['NORMAL_TEXT', '本文'],
  ]);
  check('最初の H4 より前の H3 はすべて話', changed, ['第1話 [001]', '第2話 [002]']);
}

section('すべて旧形式（H4 が無い）');
{
  const { changed } = sandbox([
    ['HEADING_3', '第1話 [001]'], ['NORMAL_TEXT', '本文'],
    ['HEADING_3', '第2話 [002]'], ['NORMAL_TEXT', '本文'],
  ]);
  check('全部 HEADING_4 になる', changed, ['第1話 [001]', '第2話 [002]']);
}

section('すでに新形式だけ');
{
  const { state } = sandbox([
    ['HEADING_3', '第一章'], ['HEADING_4', '第1話 [001]'], ['NORMAL_TEXT', '本文'],
  ]);
  check('書き換えない', state.updates.length, 0);
}

section('数が合わなければ中止');
{
  const { state } = sandbox([
    ['HEADING_3', '見出しだが番号なし'], ['HEADING_3', 'これも'], ['HEADING_3', '第1話 [001]'],
    ['HEADING_4', '第2話 [002]'],
  ]);
  check('書き換えない', state.updates.length, 0);
  check('ログに中止の理由', state.logs.some(l => /数が合わないため中止/.test(l)), true);
}
{
  const { state } = sandbox([['HEADING_3', '第1話 [001]']], { exportCode: 403 });
  check('エクスポート失敗でも書き換えない', state.updates.length, 0);
}

finish();
