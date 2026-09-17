// index.html の <script> 部を Node の vm に読み込むための最小 DOM モック。
// 描画の文言・ログ・サーバー呼び出しの順序・ボタンの有効/無効を確かめる用。
//
// 使い方:
//   const { createUiSandbox } = require('./harness/dom-mock');
//   const { g, state, render } = createUiSandbox({ runner });
//   render({ works: [], running: { active: false }, queueCount: 0, shortFilename: true, lastBatchResult: '' });
//   state.texts.runText   // #runText の textContent
//
// state:
//   texts     … 要素 id → textContent（getElementById で触った要素）
//   classes   … 要素 id → className
//   logs      … ログ欄（#log）に insertBefore された行の textContent
//   buttons   … querySelectorAll('button') が返す配列（disabled を見る）
//   timers    … setTimeout の記録 [{fn, delay}]（既定では実行しない。fn() で手動発火）
//   listeners … addEventListener の記録 type → [fn]（document と window で共有）
//
// opts:
//   runner        … google.script.run の実体。オブジェクトか、呼ぶたびに新しい実体を返す関数
//                   （withSuccessHandler / withFailureHandler / web* をチェーンできること）
//   buttons       … ボタン配列の初期値（既定 2 個）
//   setTimeout    … 差し替え（既定は state.timers に積むだけ）
//   clearTimeout  … 差し替え
//   stubFetchers  … true（既定）なら renderTable / refreshChangedWorks / maybeFetchProgress /
//                   maybeFetchSizes を空関数にして、render() が状態行とログだけを扱うようにする
//   hidden        … document.hidden の初期値
const fs   = require('fs');
const vm   = require('vm');
const path = require('path');

const INDEX_HTML = path.join(__dirname, '..', '..', 'kaku_scraping', 'src', 'index.html');

function extractScript() {
  const html = fs.readFileSync(INDEX_HTML, 'utf8');
  const m = html.match(/<script>([\s\S]*)<\/script>/);
  if (!m) throw new Error('index.html に <script> が見つかりません');
  return m[1];
}

function createUiSandbox(opts = {}) {
  const state = {
    texts: {}, classes: {}, logs: [],
    buttons: opts.buttons || [{ disabled: false }, { disabled: false }],
    timers: [], listeners: {},
  };
  const elements = {};

  function element(id) {
    if (elements[id]) return elements[id];
    const el = {
      id, value: '', childNodes: [], firstChild: null, lastChild: null, style: {}, disabled: false, checked: false,
      insertBefore(c) { if (id === 'log') state.logs.push(c.textContent); },
      removeChild() {}, appendChild() {},
      addEventListener(type, fn) { (state.listeners[type] = state.listeners[type] || []).push(fn); },
    };
    Object.defineProperty(el, 'textContent', { get: () => state.texts[id] || '', set: v => { state.texts[id] = v; } });
    Object.defineProperty(el, 'className',   { get: () => state.classes[id] || '', set: v => { state.classes[id] = v; } });
    elements[id] = el;
    return el;
  }

  const document = {
    hidden: !!opts.hidden,
    getElementById: element,
    querySelectorAll: () => state.buttons,
    addEventListener(type, fn) { (state.listeners[type] = state.listeners[type] || []).push(fn); },
    createElement: () => {
      const el = { appendChild() {}, classList: { add() {} }, style: {}, addEventListener() {} };
      let t = ''; Object.defineProperty(el, 'textContent', { get: () => t, set: v => { t = v; } });
      return el;
    },
  };

  const runner = opts.runner;
  const sandbox = {
    console, document,
    window: { addEventListener: document.addEventListener },
    google: { script: { get run() { return (typeof runner === 'function') ? runner() : runner; } } },
    setTimeout: opts.setTimeout || ((fn, delay) => { state.timers.push({ fn, delay }); return state.timers.length; }),
    clearTimeout: opts.clearTimeout || (() => {}),
    confirm: () => true, alert: () => {},
    Number, Object, Date, JSON, Math, String, Array,
  };
  vm.createContext(sandbox);
  vm.runInContext(extractScript(), sandbox, { filename: 'index.html' });

  if (opts.stubFetchers !== false) {
    sandbox.renderTable = () => {};
    sandbox.refreshChangedWorks = () => {};
    sandbox.maybeFetchProgress = () => {};
    sandbox.maybeFetchSizes = () => {};
  }

  const g = code => vm.runInContext(code, sandbox);
  const render = s => vm.runInContext(`render(${JSON.stringify(s)})`, sandbox);
  return { sandbox, state, g, render };
}

// 何を呼んでもチェーンでき、実際には何も返さない google.script.run（描画だけ試すとき用）
function inertRunner() {
  const r = new Proxy({}, { get: () => () => r });
  return r;
}

module.exports = { createUiSandbox, extractScript, inertRunner, INDEX_HTML };
