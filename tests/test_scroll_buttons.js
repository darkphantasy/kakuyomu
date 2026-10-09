// index.html: 右下の「先頭へ／末尾へ」固定ボタン。
//   GAS の Web アプリは iframe の中で動き、マウスジェスチャ拡張がその中のスクロールに届かない
//   環境があるための代替。処理中に setBusy() が全 <button> を無効化するため、ボタンは
//   <button> ではなく <a> で作ることも検査する（処理中でも押せるように）。
const fs = require('fs');
const path = require('path');
const { createUiSandbox, inertRunner } = require('./harness/dom-mock');
const { check, section, finish } = require('./harness/check');

const html = fs.readFileSync(path.join(__dirname, '..', 'kaku_scraping', 'src', 'index.html'), 'utf8');

section('先頭へ: window.scrollTo(top:0) を呼び、href="#" の移動は止める');
const ui = createUiSandbox({ runner: inertRunner(), scrollHeight: 4200 });
const r1 = ui.g("scrollToEdge('top')");
check('false を返す（href="#" によるページ内ジャンプをさせない）', r1, false);
check('top:0 へスクロール', JSON.stringify(ui.state.scrolls[0]), JSON.stringify([{ top: 0, behavior: 'smooth' }]));

section('末尾へ: ページの高さまでスクロールする');
const r2 = ui.g("scrollToEdge('bottom')");
check('false を返す', r2, false);
check('scrollHeight（4200）へスクロール', JSON.stringify(ui.state.scrolls[1]), JSON.stringify([{ top: 4200, behavior: 'smooth' }]));

section('smooth 指定に未対応でも動く（scrollTo(x, y) へフォールバック）');
const ui2 = createUiSandbox({ runner: inertRunner(), scrollHeight: 900 });
ui2.sandbox.window.scrollTo = (...a) => {
  if (a.length === 1 && typeof a[0] === 'object') throw new TypeError('options not supported');
  ui2.state.scrolls.push(a);
};
ui2.g("scrollToEdge('bottom')");
check('scrollTo(0, 900)', JSON.stringify(ui2.state.scrolls[0]), JSON.stringify([0, 900]));

section('ボタンの作り');
const tag = id => (html.match(new RegExp('<(\\w+)[^>]*id="' + id + '"')) || [])[1];
check('先頭へ・末尾へとも <a>（<button> だと処理中に setBusy が無効化してしまう）', [tag('scrollTop'), tag('scrollBottom')], ['a', 'a']);
check('onclick は scrollToEdge の戻り値を返す', [/id="scrollTop"[^>]*onclick="return scrollToEdge\('top'\)"/.test(html), /id="scrollBottom"[^>]*onclick="return scrollToEdge\('bottom'\)"/.test(html)], [true, true]);
check('画面に固定表示する（position: fixed）', /\.scroll-nav\s*\{[^}]*position:\s*fixed/.test(html), true);

finish();
