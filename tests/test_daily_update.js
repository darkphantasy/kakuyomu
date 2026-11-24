// 毎日の自動更新（毎朝 08:42 JST に一括続き取得）。
//   ・ON で毎日トリガー（dailyUpdateWake）を 8 時台の前半に張る（GAS の毎日トリガーは ±15 分の幅があるため）
//   ・起きたら 08:42 までの残りで一回きりのトリガー（dailyUpdateRun）を張る。過ぎていればその場で実行
//   ・取得処理のトリガー削除（deleteTrigger / ensureTriggerAfter）では消えない
//   ・OFF で両方消す。Web UI に ON/OFF・時刻・前回の開始時刻を出す
const { createGasSandbox, registerWork } = require('./harness/gas-mock');
const { createUiSandbox, inertRunner } = require('./harness/dom-mock');
const { check, section, finish } = require('./harness/check');

const jstMs = (y, mo, d, h, mi) => Date.UTC(y, mo - 1, d, h - 9, mi); // JST の日時 → UTC ミリ秒

const html = {};
registerWork(html, '777', '自動更新の作品', 3);
const { g, state } = createGasSandbox({ htmlByUrl: html });
const props = state.props;
const count = h => state.triggers.filter(t => t === h).length;

section('ON: 毎日トリガーを 8 時台の前半（実行時刻より前）に張る');
const on = g('webToggleDailyUpdate()');
check('ON にした旨（時刻つき）', [on.ok, on.message.indexOf('08:42') >= 0], [true, true]);
check('毎日トリガーが 1 本・設定は 毎日 / 8 時 / 15 分ごろ / 東京', [count('dailyUpdateWake'), state.triggerLog.slice(-1)[0]],
  [1, { handler: 'dailyUpdateWake', everyDays: 1, atHour: 8, nearMinute: 15, tz: 'Asia/Tokyo' }]);
check('webGetState に ON と時刻', g('webGetState()').daily, { enabled: true, time: '08:42', lastRun: '' });
g('enableDailyUpdate()');
check('もう一度 ON にしても二重に張らない', count('dailyUpdateWake'), 1);

section('起きたら 08:42 までの残りで一回きりのトリガーを張る');
g(`scheduleDailyRun_(${jstMs(2026, 11, 17, 8, 12)})`);
check('30 分後の一回きりのトリガー', [count('dailyUpdateRun'), state.triggerLog.slice(-1)[0]], [1, { handler: 'dailyUpdateRun', after: 30 * 60 * 1000 }]);
check('まだ取得は始まっていない', props.PHASE, undefined);
g(`scheduleDailyRun_(${jstMs(2026, 11, 17, 8, 20)})`);
check('張り直しても一回きりのトリガーは 1 本', [count('dailyUpdateRun'), state.triggerLog.slice(-1)[0].after], [1, 22 * 60 * 1000]);

section('取得処理のトリガー削除では、毎日の分は消えない');
g('ensureTriggerAfter(1000)');
g('deleteTrigger()');
check('毎日トリガー・一回きりのトリガーは残る', [count('dailyUpdateWake'), count('dailyUpdateRun'), count('continuesFetch')], [1, 1, 0]);

section('実行時刻: 一括続き取得を始め、一回きりのトリガーを片付ける');
props.RESUME_777 = JSON.stringify({ title: '自動更新の作品', url: 'https://kakuyomu.jp/works/777', total: 2,
  lastEpisodeId: '101', docIds: [], lastCursor: 0, updatedAt: '2026-11-16 08:42' });
g('dailyUpdateRun()');
check('一回きりのトリガーは消え、毎日トリガーは残る', [count('dailyUpdateRun'), count('dailyUpdateWake')], [0, 1]);
check('前回の開始時刻を残す', props.DAILY_LAST_RUN, '2026-09-11 12:00');
check('一括続き取得が走り、新着（3 話目）を取って完了する', [props.PHASE, JSON.parse(props.RESUME_777).total, props.BATCH_RESULT.indexOf('新着あり 1 作品') >= 0], ['DONE', 3, true]);

section('起きたのが実行時刻を過ぎていたら、その場で実行する');
props.PHASE = 'FETCHING'; // 取得中 → 一括続き取得は順番待ちに積むだけ
g(`scheduleDailyRun_(${jstMs(2026, 11, 17, 8, 45)})`);
check('トリガーを張らずに実行し、取得中なので順番待ちに積む', [count('dailyUpdateRun'), JSON.parse(props.BATCH_QUEUE).length], [0, 1]);
delete props.BATCH_QUEUE; delete props.BATCH_MODE; delete props.BATCH_TOTAL; props.PHASE = 'DONE';

section('日付の境目: JST の日付で判定する（UTC では前日の 23:30 = JST 08:30）');
g(`scheduleDailyRun_(${jstMs(2026, 11, 18, 8, 30)})`);
check('12 分後', state.triggerLog.slice(-1)[0].after, 12 * 60 * 1000);

section('OFF: 毎日トリガーも張りかけの一回きりのトリガーも消す');
const off = g('webToggleDailyUpdate()');
check('OFF にした旨', [off.ok, off.message.indexOf('OFF') >= 0], [true, true]);
check('両方とも消える・表示も OFF', [count('dailyUpdateWake'), count('dailyUpdateRun'), g('webGetState()').daily.enabled], [0, 0, false]);

section('webGetState は索引シートへのリンクも同梱する（画面を開いたときの別の問い合わせを省くため）');
props.INDEX_SHEET_ID = 'SHEET1';
check('links.indexUrl', g('webGetState()').links, { indexUrl: 'https://docs.google.com/spreadsheets/d/SHEET1' });

section('Web UI: ON/OFF・時刻・前回の開始時刻を出す');
const ui = createUiSandbox({ runner: inertRunner() });
const base = { works: [], running: { active: false }, queueCount: 0, shortFilename: true, lastBatchResult: '' };
ui.render(Object.assign({}, base, { daily: { enabled: true, time: '08:42', lastRun: '2026-11-17 08:42' } }));
check('ON・時刻・前回', [ui.state.texts.dailyState, ui.state.texts.dailyTime, ui.state.texts.dailyLast], ['ON', '08:42', '前回の自動更新: 2026-11-17 08:42 開始']);
ui.render(base);
check('daily の無い応答でも落ちず OFF・前回なし', [ui.state.texts.dailyState, ui.state.texts.dailyLast], ['OFF', '']);

finish();
