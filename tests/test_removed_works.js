// 削除済みリスト（REMOVED_<workId>）: 一覧から削除した作品を覚えておき、
// 再取得・再登録の前に確認を出す。確認すれば続行でき、再登録・再取得の完了で自動的に外れる。
const { createGasSandbox, registerWork } = require('./harness/gas-mock');
const { check, section, finish } = require('./harness/check');

let htmlByUrl = {};
registerWork(htmlByUrl, '111', '読了した作品', 5);
registerWork(htmlByUrl, '222', '別の作品', 3);
registerWork(htmlByUrl, '333', '一覧にある作品', 2);
const { g, state } = createGasSandbox({ htmlByUrl });
const props = state.props;
const URL1 = 'https://kakuyomu.jp/works/111';

const rec = (title, url, total) => JSON.stringify({ title, url, total, lastEpisodeId: '', docIds: ['DOCX'], lastCursor: 0, updatedAt: '2026-09-01 10:00' });
props.RESUME_111 = rec('読了した作品', URL1, 4);
props.RESUME_333 = rec('一覧にある作品', 'https://kakuyomu.jp/works/333', 2);

section('一覧から削除すると削除済みリストに移る');
const del = g(`webClearResumeRecord("${URL1}")`);
check('削除は成功する', del.ok, true);
check('一覧の記録は消える', 'RESUME_111' in props, false);
const removed = JSON.parse(props.REMOVED_111 || '{}');
check('削除済みに タイトル・URL・削除時点の話数・docIds・削除日時 が残る',
  [removed.title, removed.url, removed.total, removed.docIds, removed.removedAt],
  ['読了した作品', URL1, 4, ['DOCX'], '2026-09-11 12:00']);

section('webGetState で削除済みの一覧が返る（一覧側には出ない）');
const st = g('webGetState()');
check('removed に1件', st.removed.map(r => [r.workId, r.title, r.total, r.removedAt]), [['111', '読了した作品', 4, '2026-09-11 12:00']]);
check('works には出ない', st.works.map(w => w.workId), ['333']);

section('索引スプレッドシートの「削除済み」タブに出る');
const rows = state.sheetRows['削除済み'];
check('ヘッダー', rows && rows[0], ['短縮作品名', '作品タイトル', '削除時点の話数', '削除日時', '元URL']);
check('削除した作品が1行', rows && rows.slice(1).map(r => [r[1], r[2], r[3], r[4]]),
  [['読了した作品', 4, '2026-09-11 12:00', `=HYPERLINK("${URL1}","開く")`]]);
check('索引タブ本体には載らない', state.sheetRows['索引'].slice(1).map(r => r[1]), ['一覧にある作品']);

section('初回取得：確認なしでは始めず、確認文を返す');
const f1 = g(`webStartFetch("${URL1}", "", "")`);
check('needConfirm で返り、ok:false・kick なし', [f1.ok, f1.needConfirm, f1.kick], [false, true, undefined]);
check('取得は始まらない（PHASE・トリガー・キューなし）', [props.PHASE, state.triggers, props.BATCH_QUEUE], [undefined, [], undefined]);
check('確認文にタイトルと削除時点の話数', f1.message.indexOf('「読了した作品」（2026-09-11 12:00 に削除・4 話まで取得済み）') >= 0, true);
check('開始話数が未指定なら、続きの話数（5）を案内する', f1.message.indexOf('開始話数に 5 を指定') >= 0, true);
const f2 = g(`webStartFetch("${URL1}", "3", "")`);
check('開始話数を指定していればそれを示す', f2.message.indexOf('開始話数は 3 話目が指定されています（削除時点の続きは 5 話目）') >= 0, true);

section('一覧に追加・選択登録も確認を返す');
const s1 = g(`webSeedResumeRecord("${URL1}", "")`);
check('一覧に追加: needConfirm・記録は作られない', [s1.needConfirm, 'RESUME_111' in props], [true, false]);
const b1 = g(`webSeedSelected([{ url: "${URL1}", readCount: 2 }, { url: "https://kakuyomu.jp/works/222" }])`);
check('選択登録: 削除済みが混ざっていれば needConfirm', b1.needConfirm, true);
check('確認文には削除済みの作品だけが並ぶ', [b1.message.indexOf('読了した作品') >= 0, b1.message.indexOf('別の作品') >= 0], [true, false]);
check('確認文に「選択した 2 作品を登録」', b1.message.indexOf('選択した 2 作品を登録しますか？') >= 0, true);
check('選択登録は始まらない', props.PHASE, undefined);
const b2 = g('webSeedSelected([{ url: "https://kakuyomu.jp/works/222" }])');
check('削除済みを含まなければ確認なしで始まる', [b2.ok, b2.kick, b2.needConfirm], [true, true, undefined]);
g('webKick()');
check('選択登録が完了する', [props.PHASE, 'RESUME_222' in props], ['DONE', true]);

section('実行中でも、順番待ちに積む前に確認する');
props.PHASE = 'FETCHING';
const q1 = g(`webStartFetch("${URL1}", "", "")`);
check('needConfirm で返り、キューには積まない', [q1.needConfirm, props.BATCH_QUEUE], [true, undefined]);
const q2 = g(`webStartFetch("${URL1}", "", "", true)`);
check('確認後（confirmed=true）は順番待ちに積む', [q2.ok, JSON.parse(props.BATCH_QUEUE).length], [true, 1]);
props.PHASE = 'DONE'; delete props.BATCH_QUEUE; delete props.BATCH_MODE; delete props.BATCH_TOTAL; state.triggers = [];

section('確認後の初回取得は続行でき、完了すると削除済みリストから外れる');
const c1 = g(`webStartFetch("${URL1}", "5", "", true)`);
check('confirmed=true なら開始する', [c1.ok, c1.kick, props.PHASE], [true, true, 'FETCHING']);
check('取得中はまだ削除済みに残っている', 'REMOVED_111' in props, true);
g('webKick()');
check('取得が完了し一覧に戻る', [props.PHASE, JSON.parse(props.RESUME_111).total], ['DONE', 5]);
check('削除済みリストから自動で外れる', 'REMOVED_111' in props, false);
check('索引の削除済みタブも空になる（ヘッダーのみ）', state.sheetRows['削除済み'].length, 1);

section('確認後の選択登録でも、登録できた作品は削除済みから外れる');
g(`webClearResumeRecord("${URL1}")`);
check('再度削除して削除済みに戻す', 'REMOVED_111' in props, true);
const c2 = g(`webSeedSelected([{ url: "${URL1}", readCount: 4 }], true)`);
check('confirmed=true なら開始する', [c2.ok, c2.kick], [true, true]);
g('webKick()');
check('登録され、削除済みから外れる', [JSON.parse(props.RESUME_111).total, 'REMOVED_111' in props], [4, false]);

section('webForgetRemoved: 削除済みリストから手動で外す');
g(`webClearResumeRecord("${URL1}")`);
const fg = g('webForgetRemoved("111")');
check('外せる', [fg.ok, 'REMOVED_111' in props], [true, false]);
check('以後は確認が出ない', g(`webSeedResumeRecord("${URL1}", "")`).needConfirm, undefined);
check('無いものを外そうとすると ok:false', g('webForgetRemoved("999")').ok, false);

section('索引シートとの同期で行が消えた作品も削除済みに記録する');
// 模擬の索引シートは常に空（getDataRange が []）なので、一覧の全作品が「シートから行が消えた」扱いになる
const before = Object.keys(props).filter(k => k.indexOf('RESUME_') === 0).sort();
g('syncResumeRecordsFromSheet()');
const after = Object.keys(props).filter(k => k.indexOf('REMOVED_') === 0).sort();
check('一覧にあった作品がすべて削除済みに移る', after, before.map(k => k.replace('RESUME_', 'REMOVED_')));

section('GAS エディタから直接実行した場合はログに警告を出すだけで続行する');
state.logs.length = 0;
g(`startFetch("${URL1}")`);
check('警告ログが出る', state.logs.some(l => l.indexOf('以前に一覧から削除した作品です') >= 0), true);
check('取得は続行される（完了して一覧に戻る）', ['RESUME_111' in props, 'REMOVED_111' in props], [true, false]);

finish();
