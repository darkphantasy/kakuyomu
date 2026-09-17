// index.html: 一括続き取得の進捗表示と結果ログの検証
const { createUiSandbox, inertRunner } = require('./harness/dom-mock');
const { check, section, finish } = require('./harness/check');

const { g, state, render } = createUiSandbox({ runner: inertRunner() });

const base = { works: [], queueCount: 0, shortFilename: true, lastBatchResult: '' };
const run = r => Object.assign({}, base, {
  running: Object.assign({ active: true, phase: 'FETCHING', batchNext: false, title: 'T', done: 0, total: 0, batchTotal: 0, batchDone: 0 }, r),
});

section('新着確認中の表示');
render(run({ phase: 'BATCH_NEXT', batchNext: true, batchTotal: 22, batchDone: 3 }));
check('「新着を確認中… 3 / 22 作品」', state.texts.runText, '新着を確認中… 3 / 22 作品');
render(run({ phase: 'BATCH_NEXT', batchNext: true, batchTotal: 0, batchDone: 0 }));
check('分母が無い場合は従来の文言', state.texts.runText, '次の作品を準備中…');

section('一括の途中で作品を取得中の表示');
render(run({ phase: 'FETCHING', title: '作品A', done: 2, total: 5, batchTotal: 22, batchDone: 4 }));
check('話数の進捗に「（4 / 22 作品目）」が付く', state.texts.runText, '実行中: 作品A（FETCHING） 2 / 5 話（4 / 22 作品目）');
render(run({ phase: 'FETCHING', title: '作品A', done: 2, total: 5 }));
check('単発の取得では付かない', state.texts.runText, '実行中: 作品A（FETCHING） 2 / 5 話');

section('結果ログ: 開いた時点の値は出さず、変わったときだけ出す');
state.logs.length = 0;
g('seenBatchResult = null;');
const idle = result => Object.assign({}, base, { lastBatchResult: result, running: { active: false } });
render(idle('一括続き取得 完了（11:00）: 確認 22 作品・新着あり 0 作品'));
check('ページを開いた時点の「前回の結果」はログに出さない', state.logs.length, 0);
render(idle('一括続き取得 完了（11:00）: 確認 22 作品・新着あり 0 作品'));
check('同じ値のままなら出さない', state.logs.length, 0);
render(idle('一括続き取得 完了（12:34）: 確認 22 作品・新着あり 2 作品'));
check('値が変わったら1回ログに出す', [state.logs.length, state.logs[0].indexOf('新着あり 2 作品') >= 0], [1, true]);
render(idle('一括続き取得 完了（12:34）: 確認 22 作品・新着あり 2 作品'));
check('その後の同じ値では重ねて出さない', state.logs.length, 1);

finish();
