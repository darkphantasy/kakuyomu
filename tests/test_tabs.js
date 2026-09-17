// index.html: 「一覧」「候補から選んで登録」のタブ切り替え
const { createUiSandbox, inertRunner } = require('./harness/dom-mock');
const { check, section, finish } = require('./harness/check');

const { g, state } = createUiSandbox({ runner: inertRunner() });

section('初期状態は「一覧」タブ');
g('renderTabs()');
check('一覧パネルは表示', g("$('tabPanel-works').hidden"), false);
check('候補パネルは隠す', g("$('tabPanel-seed').hidden"), true);
check('一覧タブに active クラスが付く', state.tabButtons[0].className, 'tab-btn active');
check('候補タブには付かない', state.tabButtons[1].className, 'tab-btn');

section('setActiveTab("seed") で切り替わる');
g('setActiveTab("seed")');
check('候補パネルが表示される', g("$('tabPanel-seed').hidden"), false);
check('一覧パネルは隠れる', g("$('tabPanel-works').hidden"), true);
check('候補タブに active クラスが付く', state.tabButtons[1].className, 'tab-btn active');
check('一覧タブからは外れる', state.tabButtons[0].className, 'tab-btn');

section('元に戻せる');
g('setActiveTab("works")');
check('一覧パネルが表示される', g("$('tabPanel-works').hidden"), false);

finish();
