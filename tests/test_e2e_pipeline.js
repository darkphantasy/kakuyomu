// Web UI からの開始 → 蹴り（webKick）／トリガー（continuesFetch）で FETCHING → BUILD → finishRun まで通し、
// 実行時エラー（ReferenceError 等）が出ないこと・状態遷移が正しいことを確認する
const { createGasSandbox, registerWork, workPage, episodePage } = require('./harness/gas-mock');
const { check, section, finish } = require('./harness/check');

const N = 3;
const htmlByUrl = registerWork({}, '777', 'テスト作品', N);
const { g, state } = createGasSandbox({ htmlByUrl });
const props = state.props;

section('Web UI からの初回取得：即応起動でトリガーが張られ、active になる');
const r1 = g('webStartFetch("https://kakuyomu.jp/works/777")');
check('ok で返る', r1.ok, true);
check('kick:true が付く（クライアントが 1 枠目を蹴る）', r1.kick, true);
check('PHASE=FETCHING が同期的にセットされる（画面はこれを見て active と判断）', props.PHASE, 'FETCHING');
check('continuesFetch のトリガーが1本張られる（保険）', state.triggers, ['continuesFetch']);
const st1 = g('webGetState()');
check('webGetState: active:true / 進捗 0/3', [st1.running.active, st1.running.done, st1.running.total, st1.running.phase], [true, 0, 3, 'FETCHING']);
const rq = g('webStartContinuation("https://kakuyomu.jp/works/777")');
check('実行中の追加は順番待ちに積むだけで kick は付かない', [rq.ok, rq.kick, JSON.parse(props.BATCH_QUEUE).length], [true, undefined, 1]);
props.BATCH_QUEUE = '[]'; props.BATCH_TOTAL = '0'; delete props.BATCH_MODE; // 次の検証のため戻す

section('クライアントの蹴り（webKick）で FETCHING → BUILD → 完了まで一気に走る');
let threw = null;
try { g('webKick()'); } catch (e) { threw = String(e); }
check('実行時エラーが出ない', threw, null);
check('バッファは掃除され、ドキュメントが1冊できている', [Object.keys(state.files).length, state.createdDocs], [0, 1]);
check('記録が保存される（3話・docIds 1件）', [JSON.parse(props.RESUME_777).total, JSON.parse(props.RESUME_777).docIds.length], [3, 1]);
check('PHASE=DONE・トリガー削除', [props.PHASE, state.triggers], ['DONE', []]);
const st2 = g('webGetState()');
check('webGetState: active:false・作品一覧に反映', [st2.running.active, st2.works.length, st2.works[0].total], [false, 1, '3']);

section('続き取得（新着1話）：既存ドキュメントへ追記される');
htmlByUrl['https://kakuyomu.jp/works/777'] = workPage('777', 'テスト作品', N + 1);
htmlByUrl[`https://kakuyomu.jp/works/777/episodes/${100 + N}`] = episodePage(N + 1);
const before = state.docs.DOC1.end;
const r2 = g('webStartContinuation("https://kakuyomu.jp/works/777")');
check('ok で返り、CONT_FROM/TO が 4〜4', [r2.ok, props.CONT_FROM, props.CONT_TO], [true, '4', '4']);
threw = null;
try { g('continuesFetch()'); } catch (e) { threw = String(e); }
check('トリガー実行で実行時エラーが出ない', threw, null);
check('新規ドキュメントは作られず DOC1 が伸びている', [state.createdDocs, state.docs.DOC1.end > before], [1, true]);
check('記録が4話に更新', JSON.parse(props.RESUME_777).total, 4);

section('一括続き取得（新着なし）：ボタンは即座に返り、確認はトリガー側で行われる');
const r3 = g('webStartContinuationAll()');
check('確認する旨のメッセージで即座に返り、kick:true が付く', [r3.message.indexOf('順に確認') >= 0, r3.kick], [true, true]);
check('この時点では PHASE=BATCH_NEXT でキューが残っている', [props.PHASE, 'BATCH_QUEUE' in props], ['BATCH_NEXT', true]);
threw = null;
try { g('continuesFetch()'); } catch (e) { threw = String(e); }
check('トリガー実行で実行時エラーが出ない', threw, null);
check('確認完了: PHASE=DONE・BATCH_* は残らない・結果は「新着あり 0」',
  [props.PHASE, 'BATCH_MODE' in props, 'BATCH_QUEUE' in props, props.BATCH_RESULT.indexOf('新着あり 0') >= 0],
  ['DONE', false, false, true]);

finish();
