// 選択登録（webSeedSelected）: 閲覧履歴・未読あり一覧から選んだ作品をまとめて一覧に追加する機能。
// 一括続き取得と同じキュー（BATCH_QUEUE / PHASE_BATCH_NEXT）を mode:'seed' で使い回すことを確認する。
const { createGasSandbox, registerWork } = require('./harness/gas-mock');
const { check, section, finish } = require('./harness/check');

let htmlByUrl = {};
registerWork(htmlByUrl, '111', '作品A（既読分あり）', 10); // 全10話・7話まで既読という想定
registerWork(htmlByUrl, '222', '作品B（未読なし）', 3);    // readCount 省略＝全話取得済み扱い
const { g, state } = createGasSandbox({ htmlByUrl });
const props = state.props;

section('即座に返り、目次取得（ネットワーク）は起きない');
const r1 = g(`webSeedSelected([
  { url: "https://kakuyomu.jp/works/111", readCount: 7 },
  { url: "https://kakuyomu.jp/works/222" },
])`);
check('ok:true・kick:true で返る', [r1.ok, r1.kick], [true, true]);
check('PHASE=BATCH_NEXT・BATCH_KIND=seed が同期的にセットされる', [props.PHASE, props.BATCH_KIND], ['BATCH_NEXT', 'seed']);
check('この時点ではまだ記録が保存されていない（目次取得はトリガー側）', props.RESUME_111, undefined);
check('トリガーが1本張られる（保険）', state.triggers, ['continuesFetch']);

const st1 = g('webGetState()');
check('webGetState: active:true・batchKind:seed・進捗 0/2', [st1.running.active, st1.running.batchKind, st1.running.batchDone, st1.running.batchTotal], [true, 'seed', 0, 2]);

section('クライアントの蹴り（webKick）で両方とも登録され、DONE まで進む');
let threw = null;
try { g('webKick()'); } catch (e) { threw = String(e); }
check('実行時エラーが出ない', threw, null);
check('PHASE=DONE・トリガー削除・BATCH_* は残らない',
  [props.PHASE, state.triggers, 'BATCH_QUEUE' in props, 'BATCH_KIND' in props],
  ['DONE', [], false, false]);

const rec111 = JSON.parse(props.RESUME_111);
check('作品A: 7話まで取得済み扱い（既読分をスキップする起点）', [rec111.total, rec111.docIds.length], [7, 0]);
const rec222 = JSON.parse(props.RESUME_222);
check('作品B: readCount 省略時は全話（3話）取得済み扱い', rec222.total, 3);

check('結果メッセージに「登録 2 作品」が残る', props.BATCH_RESULT.indexOf('登録 2 作品') >= 0, true);
check('索引シートが更新される（登録ぶんをまとめて1回）', state.sheetOps.length > 0, true);

section('登録後は続き取得の対象になる（既読分の次から新着扱いで拾える）');
const r2 = g('webStartContinuation("https://kakuyomu.jp/works/111")');
check('続き取得: 8〜10話が新着として検出される', [r2.ok, props.CONT_FROM, props.CONT_TO], [true, '8', '10']);
check('DOC_IDS はまだ空（選択登録では本文もドキュメントも作っていない）', props.DOC_IDS, '[]');

// 選択登録はドキュメントを作らない（目次だけ）ので、既存 docIds が空のまま続き取得に
// 入ったときに、本当にドキュメントが作られるところまで確認する（resolveBuildTarget_ が
// 「追記できる既存ドキュメントが無い→新規作成」に正しく倒れることの実地確認）。
let threw2 = null;
try { g('continuesFetch()'); } catch (e) { threw2 = String(e); }
check('続き取得の実行でエラーにならない', threw2, null);
check('ドキュメントが1冊作られる', state.createdDocs, 1);
const rec111After = JSON.parse(props.RESUME_111);
check('記録: 10話・docIds 1件に更新される', [rec111After.total, rec111After.docIds.length], [10, 1]);

section('無効な URL は無視され、全滅なら ok:false');
const r3 = g('webSeedSelected([{ url: "not-a-url" }, { url: "" }])');
check('登録できる作品が無い旨を返す', [r3.ok, r3.kick], [false, undefined]);

section('実行中に呼ぶと順番待ちに積むだけ（目次取得はしない）');
htmlByUrl = {};
registerWork(htmlByUrl, '333', '作品C', 5);
registerWork(htmlByUrl, '444', '作品D', 4);
const sb2 = createGasSandbox({ htmlByUrl });
sb2.g('webStartFetch("https://kakuyomu.jp/works/333")'); // 実行中状態を作る（PHASE=FETCHING）
const r4 = sb2.g('webSeedSelected([{ url: "https://kakuyomu.jp/works/444" }])');
check('順番待ちに追加した旨を返す（kick は付かない）', [r4.ok, r4.kick], [true, undefined]);
check('PHASE は FETCHING のまま（今動いている作品を止めない）', sb2.state.props.PHASE, 'FETCHING');
check('BATCH_QUEUE に seed エントリが1件積まれる', JSON.parse(sb2.state.props.BATCH_QUEUE).length, 1);

finish();
