// index.html: 一覧の「ドキュメント」列が広がって「作品」列が潰れないこと（2026-11、Firefox で発生）。
//   原因: white-space:nowrap の分冊リンクを隙間なく並べていたため、Firefox はリンクの境目でも折り返さず、
//   分冊の多い作品（5 冊など）のリンク全体が 1 行の塊になって列の最小幅が広がった。
//   対策: ① リンクの間に空白（テキスト）を挟む ② サイト表示（カクヨム/なろう）は途中で折り返さない
//         ③ 広い画面では作品名の列に下限幅（スマホ幅では付けない＝横にはみ出さない）
const fs = require('fs');
const path = require('path');
const { createUiSandbox, inertRunner } = require('./harness/dom-mock');
const { check, section, finish } = require('./harness/check');

const html = fs.readFileSync(path.join(__dirname, '..', 'kaku_scraping', 'src', 'index.html'), 'utf8');

// 子要素を記録する最小の要素（renderTable が作る行を検査するため）
function mkEl(tag) {
  const el = {
    tagName: tag, children: [], style: {}, className: '', textContent: '', classList: { add() {} },
    appendChild(c) { this.children.push(c); return c; },
    querySelector: () => ({ textContent: '' }),
    get firstChild() { return this.children[0] || null; },
  };
  return el;
}

const ui = createUiSandbox({ runner: inertRunner(), stubFetchers: false });
const rows = [];
ui.sandbox.document.createElement = tag => mkEl(tag);
ui.sandbox.document.createTextNode = text => ({ nodeType: 3, text: text });
ui.sandbox.document.querySelectorAll = () => [];
ui.g("$('works')").appendChild = tr => { rows.push(tr); };

const docIds = ['d1', 'd2', 'd3', 'd4', 'd5'];
ui.g('lastState = ' + JSON.stringify({ works: [{
  workId: '1', title: '分冊の多い作品', shortTitle: '分冊の多い作品', site: 'kakuyomu', url: 'u',
  total: '500', updatedAt: '2026-11-09 04:25', docIds: docIds,
}] }));
ui.g('docSizes = ' + JSON.stringify({ d1: 850000, d2: 850000, d3: 850000, d4: 850000, d5: 850000 }));
ui.g('renderTable()');

section('分冊リンクの間に空白を挟む（折り返せる位置を作る）');
check('1 行描画される', rows.length, 1);
const tdDocs = rows[0].children.find(c => c.className === 'docs hide-sp');
const kinds = tdDocs.children.map(c => (c.nodeType === 3 ? '空白' : 'リンク'));
check('リンクと空白が交互に並ぶ（先頭・末尾に余計な空白は無い）', kinds,
  ['リンク', '空白', 'リンク', '空白', 'リンク', '空白', 'リンク', '空白', 'リンク']);
check('空白は普通の半角スペース', tdDocs.children.filter(c => c.nodeType === 3).every(c => c.text === ' '), true);

section('作品名の列に下限幅のためのクラスを付ける');
check('作品名のセルは title-cell', rows[0].children[0].className, 'title-cell');

section('CSS');
check('下限幅は広い画面だけ（スマホ幅では横にはみ出すため付けない）',
  /@media \(min-width: 641px\) \{ td\.title-cell \{ min-width: [\d.]+em; \} \}/.test(html), true);
check('サイト表示（カクヨム/なろう）は途中で折り返さない', /\.site-tag \{[^}]*white-space: nowrap/.test(html), true);

finish();
