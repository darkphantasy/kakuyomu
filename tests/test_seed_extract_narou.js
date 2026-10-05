// 「候補から選んで登録」の小説家になろう対応。
//   ・extractSeedCandidates_() のなろう部分: ブックマーク一覧の HTML から URL・全文タイトル・全話数・
//     しおり・未読を読み、残りのページも読み込む（ポップアップは非同期の前に開く）
//   ・貼り付け後の候補: Nコードで照合し、開始話数の初期値はしおりを挟んだ話
//   ・ブックマークレットは void で包む／tools のコンソール版と index.html の関数は同一
// 模擬 HTML は実物（2026-10）と同じクラス名・属性の形だけを持つ（作品名などは架空）。
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const { check, section, finish } = require('./harness/check');
const { createUiSandbox } = require('./harness/dom-mock');

const SRC = path.join(__dirname, '..', 'kaku_scraping');
const html = fs.readFileSync(path.join(SRC, 'src', 'index.html'), 'utf8');
const script = html.match(/<script>([\s\S]*)<\/script>/)[1];

// ブックマーク 1 件ぶん。kind: 'siori'（しおり＋未読あり）/ 'read'（しおり＋未読はありません）/
//   'first'（しおり無し＝最初から読む）/ 'short'（短編）
function bmItem(ncode, title, kind, total, siori) {
  const label = kind === 'short'
    ? '<span class="c-up-label c-up-label--novel-short">短編</span>'
    : '<span class="c-up-label c-up-label--novel-long">連載</span>';
  const shown = title.length > 8 ? title.slice(0, 8) + '…' : title; // 一覧の表示は途中で切られる
  const totalSpan = kind === 'short' ? '' : `<span class="p-up-bookmark-item__data-item">全${total}エピソード</span>`;
  let buttons = '';
  if (kind === 'siori' || kind === 'read') {
    buttons = `<div class="p-up-bookmark-item__button-group">\n` +
      `<a href="https://ncode.syosetu.com/${ncode}/${siori}/" class="p-up-bookmark-item__button c-button c-button--outline"><span class="p-icon p-icon--siori" aria-hidden="true" class="p-up-bookmark-item__siori-icon"></span>ep.${siori}</a>\n` +
      (kind === 'siori'
        ? `<a href="https://ncode.syosetu.com/${ncode}/${siori + 1}/" class="p-up-bookmark-item__button c-button c-button--primary">ep.${siori + 1}<span class="p-up-bookmark-item__unread">未読<span class="p-up-bookmark-item__unread-num">${total - siori}</span></span></a>`
        : `<div class="p-up-bookmark-item__button c-button c-button--primary" disabled>未読はありません</div>`) +
      `\n</div>`;
  } else if (kind === 'first') {
    buttons = `<div class="p-up-bookmark-item__button-group">\n<a class="p-up-bookmark-item__button p-up-bookmark-item__button--firstep c-button" href="https://ncode.syosetu.com/${ncode}/1/">最初から読む</a>\n</div>`;
  }
  const esc = t => t.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  return `<li class="c-up-panel__list-item p-up-bookmark-item">\n<div class="c-up-chk-item c-up-chk-item--upper">\n` +
    `<div class="p-up-bookmark-item__title">\n<a href="https://ncode.syosetu.com/${ncode}/">${label}&nbsp;${esc(shown)}\n</a>\n</div>\n` +
    `<li class="c-up-dropdown__item c-up-dropdown__item--delete js-delete_bookmark_confirm" data-useridfavncode="1_2" data-title="${esc(title)}"><a href="JavaScript:void(0);">登録解除</a></li>\n` +
    `<div class="p-up-bookmark-item__data"><a href="https://mypage.syosetu.com/1" class="p-up-bookmark-item__data-item">作者</a>${totalSpan}</div>\n` +
    `${buttons}\n</div>\n</li><!-- /.c-up-panel__list-item -->\n`;
}

// ブックマーク一覧の 1 ページ（current / last はページ番号）
function bmPage(items, current, last) {
  const pager = last > 1
    ? `<div class="c-up-pager c-up-pager--sm"><div class="c-up-pager__num"><span class="c-up-pager__item is-current">${current}</span></div>` +
      `<a href="?p=${last}" class="c-up-pager__item" title="最後のページ">»</a></div>`
    : '';
  return `<html><body>${pager}<ul class="c-up-panel__list js-favnovel">${items.join('')}</ul>${pager}</body></html>`;
}

// extractSeedCandidates_() をなろうのページ上で実行する。fetchPages: URL → HTML（無ければ 404）
async function runNarou(pageHtml, fetchPages, opts = {}) {
  const events = [];
  const alerts = [];
  let textarea = null;
  const mkEl = () => ({ style: {}, textContent: '', value: '', focus() {}, select() {} });
  const win = {
    document: { title: '', body: { appendChild(el) { if (el.value) textarea = el; } }, createElement: mkEl },
  };
  let promptArgs = null;
  const sandbox = {
    console, URL, Promise,
    location: { hostname: 'syosetu.com', href: opts.href || 'https://syosetu.com/favnovelmain/list/' },
    document: {
      documentElement: { outerHTML: pageHtml },
      querySelectorAll: () => [], getElementById: () => null, addEventListener() {},
      createElement: () => ({ appendChild() {}, style: {} }),
    },
    window: {
      addEventListener() {},
      open: () => { events.push('open'); return opts.blockPopup ? null : win; },
      prompt: (m, d) => { promptArgs = { m, d }; },
    },
    fetch: async url => {
      events.push('fetch ' + url);
      const body = fetchPages[url];
      return { ok: body != null, status: body != null ? 200 : 404, text: async () => body };
    },
    google: { script: { run: new Proxy({}, { get: () => () => {} }) } },
    setTimeout: fn => { fn(); return 0; }, clearTimeout() {}, confirm: () => true,
    alert: m => { alerts.push(m); },
    Number, Object, Date, JSON, Math, String, Array,
  };
  vm.createContext(sandbox);
  vm.runInContext(script, sandbox, { filename: 'index.html' });
  await vm.runInContext('extractSeedCandidates_()', sandbox);
  return {
    events, alerts, promptArgs,
    items: textarea ? JSON.parse(textarea.value) : (promptArgs ? JSON.parse(promptArgs.d) : null),
  };
}

(async () => {
  section('ブックマーク一覧から URL・全文タイトル・全話数・しおり・未読を読む');
  const p1 = bmPage([
    bmItem('n1111aa', '長いタイトルの作品 & その続き', 'siori', 439, 316),
    bmItem('n2222bb', '既読の作品', 'read', 168, 168),
    bmItem('n3333cc', '未読の作品', 'first', 301),
    bmItem('n4444dd', '短編の作品', 'short'),
  ], 1, 1);
  const r1 = await runNarou(p1, {});
  const byId = Object.fromEntries(r1.items.map(x => [x.url, x]));
  check('4 件', r1.items.length, 4);
  check('URL は目次の URL', r1.items[0].url, 'https://ncode.syosetu.com/n1111aa/');
  check('タイトルは data-title の全文（表示の「…」で切れない・実体参照を戻す）', r1.items[0].title, '長いタイトルの作品 & その続き');
  const pick = id => { const x = byId[`https://ncode.syosetu.com/${id}/`]; return [x.total, x.siori, x.unread]; };
  check('しおり＋未読あり: 全話数・しおり・未読', pick('n1111aa'), [439, 316, 123]);
  check('しおり＋未読はありません: 未読 0', pick('n2222bb'), [168, 168, 0]);
  check('しおり無し（最初から読む）: しおり・未読は null', pick('n3333cc'), [301, null, null]);
  check('短編: 全話数 1・しおり無し', pick('n4444dd'), [1, null, null]);
  check('1 ページだけなら残りのページは読まない', r1.events.filter(e => e.startsWith('fetch')).length, 0);

  section('残りのページも読み込む（ページ送りのリンクと同じ URL・重複は除く）');
  const href = 'https://syosetu.com/favnovelmain/isnoticelist/';
  const page = n => bmPage([bmItem('n' + n + '000xx', 'P' + n, 'siori', 10, 2), bmItem('n9999zz', '各ページに出る作品', 'first', 5)], n, 3);
  const r2 = await runNarou(page(2), { [href + '?p=1']: page(1), [href + '?p=3']: page(3) }, { href: href + '?p=2' });
  check('いま開いている 2 ページ目以外（1・3）を、開いている一覧の URL のまま p だけ変えて読む',
    r2.events.filter(e => e.startsWith('fetch')), ['fetch ' + href + '?p=1', 'fetch ' + href + '?p=3']);
  check('新しいタブは読み込みより先に開く（非同期の後だとポップアップとしてブロックされる）', r2.events[0], 'open');
  check('全ページぶん・重複なし', r2.items.map(x => x.title).sort(), ['P1', 'P2', 'P3', '各ページに出る作品'].sort());

  section('読み込めなかったページがあっても、取れたぶんは出す');
  const r3 = await runNarou(page(1), { [href.replace('isnoticelist', 'list') + '?p=2']: page(2) });
  check('1・2 ページ目のぶんは出る', r3.items.map(x => x.title).sort(), ['P1', 'P2', '各ページに出る作品'].sort());

  section('ポップアップがブロックされたら window.prompt で渡す');
  const r4 = await runNarou(p1, {}, { blockPopup: true });
  check('prompt に JSON が渡る', r4.items && r4.items.length, 4);

  section('ブックマーク一覧以外のなろうのページでは警告だけ出す');
  const r5 = await runNarou('<html><body>小説ページ</body></html>', {});
  check('タブは開かず alert が 1 回', [r5.events.length, r5.alerts.length], [0, 1]);
  check('ブックマーク一覧の URL を案内する', r5.alerts[0].indexOf('favnovelmain/list') >= 0, true);

  section('ブックマークレットは void で包む（Promise がページの内容に置き換わらないように）');
  const ui0 = createUiSandbox({ runner: () => new Proxy({}, { get: () => () => ({}) }) });
  check('javascript:void で始まる', ui0.g('decodeURIComponent(buildSeedBookmarklet_())').indexOf('javascript:void (function extractSeedCandidates_()'), 0);

  section('コンソール版（tools/extract_antenna_list.js）と index.html の関数は同一');
  const tool = fs.readFileSync(path.join(SRC, 'tools', 'extract_antenna_list.js'), 'utf8');
  const fromHtml = script.match(/      function extractSeedCandidates_\(\) \{[\s\S]*?\n      \}\n/)[0]
    .split('\n').map(l => l.replace(/^ {6}/, '')).join('\n').trim();
  const fromTool = tool.match(/function extractSeedCandidates_\(\) \{[\s\S]*?\n\}\n/)[0].trim();
  check('関数本体が一致する（片方だけ直していない）', fromHtml === fromTool, true);

  section('貼り付けた候補: Nコードで照合し、開始話数の初期値はしおりを挟んだ話');
  const calls = [];
  const ui = createUiSandbox({
    runner: () => {
      const r = {};
      r.withSuccessHandler = f => { r.ok = f; return r; };
      r.withFailureHandler = f => { r.ng = f; return r; };
      r.webSeedSelected = items => { calls.push(items); r.ok({ ok: true }); };
      r.webGetState = () => r; r.webKick = () => r;
      return r;
    },
  });
  ui.g('lastState = ' + JSON.stringify({ works: [{ workId: 'n2222bb' }], removed: [] }));
  ui.g(`$('seedPaste').value = ${JSON.stringify(JSON.stringify(r1.items.concat([{ url: 'https://NCODE.syosetu.com/N1111AA/5/', title: '重複' }])))};`);
  ui.g('doParseSeed()');
  check('候補は Nコードで 4 件（話のページ・大文字の URL も同じ作品にまとまる）', ui.g('Object.keys(seedCandidates).sort()'), ['n1111aa', 'n2222bb', 'n3333cc', 'n4444dd']);
  check('サーバーへ渡す URL は目次の URL', ui.g('seedCandidates["n3333cc"].url'), 'https://ncode.syosetu.com/n3333cc/');
  check('開始話数の初期値: しおりがあればその話', ui.g('seedAutoStartEpisode_(seedCandidates["n2222bb"])'), 168);
  check('しおりが無ければ空欄（全話取得済み扱い）', [ui.g('seedAutoStartEpisode_(seedCandidates["n3333cc"])'), ui.g('seedAutoStartEpisode_(seedCandidates["n4444dd"])')], [null, null]);
  check('一覧にある作品（n2222bb）は登録済みとして判定される', ui.g('renderSeedList(), (function(){ var r={}; lastState.works.forEach(function(w){r[w.workId]=true;}); return !!r["n2222bb"]; })()'), true);
  // 上の重複行（5話のURL）は後勝ちで n1111aa を上書きしているので、元の抽出結果だけで読み直す
  ui.g(`$('seedPaste').value = ${JSON.stringify(JSON.stringify(r1.items))};`);
  ui.g('doParseSeed()'); ui.g('doSelectUnreadSeed()');
  check('「未読ありを全選択」は未読がある未登録の作品だけ選ぶ', ['n1111aa', 'n2222bb', 'n3333cc', 'n4444dd'].map(id => ui.g(`seedCandidates["${id}"].checked`)), [true, false, false, false]);
  ui.g('doRegisterSeed()');
  check('登録時の readCount は しおり − 1（しおりの話から続き取得の対象になる）', calls[0], [{ url: 'https://ncode.syosetu.com/n1111aa/', readCount: 315 }]);

  finish();
})();
