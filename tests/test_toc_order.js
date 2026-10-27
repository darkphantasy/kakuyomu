// 目次順の取得（カクヨムの新規作品）：推敲で話が入れ替わったり途中に挿入されたりしても、
// 手直し無しで取りこぼし・重複が起きないこと。
//   ・取得順・通し番号は目次（tableOfContentsV2）の順
//   ・取得済みの話 ID を __kakuyomu_seen_<workId>.json に持ち、続き取得は「目次にあって未取得の話」をすべて取る
//   ・入れ替えだけなら取り直さない／挿入された話は末尾に追記（番号は目次上の位置）
//   ・一覧が無い・足りないときは「最後に取った話まで」を取得済みとみなす（重複させない）
//   ・保存済みの作品（印なし）・なろう・既存ドキュメントを紐付けた登録は従来どおり
// 模擬 HTML の作品名・章名は架空。話 N の ID は 100+N-1、公開日時は N の順。
const { createGasSandbox, registerWork, registerNarouWork } = require('./harness/gas-mock');
const { check, section, finish } = require('./harness/check');

const URL = 'https://kakuyomu.jp/works/777';
const id = no => String(100 + no - 1);
const seenOf = state => JSON.parse(state.files['__kakuyomu_seen_777.json'] || 'null');
// BUILD で挿入された話の見出し（「第N話 [NNN]」）を順に
const titlesOf = state => state.insertedTexts.join('\n').split('\n').filter(l => /\[\d{3}\]$/.test(l));

section('初回取得: 目次の順に取り、通し番号も目次上の位置');
// 目次: 第一章 = 話3・話1、第二章 = 話2・話4（公開日時順とは違う並び）
let html = {};
registerWork(html, '777', '目次順作品', 4, { toc: [
  { chapter: '第一章', eps: [3, 1] }, { chapter: '第二章', eps: [2, 4] },
] });
const { g, state } = createGasSandbox({ htmlByUrl: html });
g(`webStartFetch("${URL}", "", "")`);
g('webKick()');
check('完了する', state.props.PHASE, 'DONE');
check('話は目次の順で、番号は目次上の位置', titlesOf(state), ['第3話 [001]', '第1話 [002]', '第2話 [003]', '第4話 [004]']);
const rec1 = JSON.parse(state.props.RESUME_777);
check('記録に目次順の印と取得済み件数', [rec1.order, rec1.seenCount, rec1.total, rec1.lastEpisodeId], ['toc', 4, 4, id(4)]);
check('取得済み一覧はドキュメントに書いた順', seenOf(state), [id(3), id(1), id(2), id(4)]);
check('取得済み一覧はバッファの掃除で消えない', '__kakuyomu_seen_777.json' in state.files, true);

section('推敲で入れ替えただけ（新しい話なし）なら、取り直さない');
registerWork(html, '777', '目次順作品', 4, { toc: [
  { chapter: '第一章', eps: [1, 3] }, { chapter: '第二章', eps: [4, 2] },
] });
const r2 = g(`webStartContinuation("${URL}")`);
check('新着なし（ok:false）で、取得は始まらない', [r2.ok, state.props.PHASE], [false, 'DONE']);

section('途中に挿入された話と末尾の新話を、両方とも取る（挿入された話はドキュメント末尾に追記）');
// 話5 を第一章の途中に挿入、話6 を第二章の末尾に追加
registerWork(html, '777', '目次順作品', 6, { toc: [
  { chapter: '第一章', eps: [1, 5, 3] }, { chapter: '第二章', eps: [4, 2, 6] },
] });
state.insertedTexts.length = 0;
const r3 = g(`webStartContinuation("${URL}")`);
check('開始する', r3.ok, true);
check('取るのは未取得の 2 話だけ（目次上の位置 2 と 6）', JSON.parse(state.props.EPISODES).map(e => [e.id, e.no]), [[id(5), 2], [id(6), 6]]);
check('フッターの「今回追記」用に飛び飛びの番号をまとめる', state.props.CONT_RANGES, '2、6');
check('挿入された話には、その話の章（第一章）の見出しを付ける（末尾は第二章が続いているため）',
  JSON.parse(state.props.EPISODES).map(e => e.ch || null), ['第一章', '第二章']);
g('webKick()');
check('完了する', state.props.PHASE, 'DONE');
check('追記された話（重複なし）', titlesOf(state), ['第5話 [002]', '第6話 [006]']);
check('フッターに「今回追記: 2、6 話」', state.insertedTexts.join('').indexOf('今回追記: 2、6 話') >= 0, true);
check('取得済み一覧に追記した順で足される', seenOf(state), [id(3), id(1), id(2), id(4), id(5), id(6)]);
check('記録の件数も更新', JSON.parse(state.props.RESUME_777).seenCount, 6);

section('取得済み一覧が消えていたら、最後に取った話までを取得済みとみなす（重複させない）');
delete state.files['__kakuyomu_seen_777.json'];
registerWork(html, '777', '目次順作品', 7, { toc: [
  { chapter: '第一章', eps: [1, 5, 3] }, { chapter: '第二章', eps: [4, 2, 6, 7] },
] });
const r4 = g(`webStartContinuation("${URL}")`);
check('新しく末尾に増えた話7 だけを取る', [r4.ok, JSON.parse(state.props.EPISODES).map(e => e.id)], [true, [id(7)]]);
check('一覧は補って作り直される', seenOf(state).length, 6);
g('webKick()');

section('一覧の件数が記録より少ない（保存に失敗していた）ときも同じく補う');
state.files['__kakuyomu_seen_777.json'] = JSON.stringify([id(1)]);
const r5 = g(`webStartContinuation("${URL}")`);
check('取得済みの話を取り直さない（新着なし）', r5.ok, false);
check('補った一覧は最後に取った話（7）まで', seenOf(state).length, 7);

section('保存済みの作品（目次順の印なし）は従来どおり：公開日時順・最後に取った話より後ろ');
const legacy = {};
registerWork(legacy, '888', '保存済み作品', 4, { toc: [{ chapter: '一', eps: [4, 3, 2, 1] }] });
const L = createGasSandbox({ htmlByUrl: legacy });
L.state.props.RESUME_888 = JSON.stringify({ title: '保存済み作品', url: 'https://kakuyomu.jp/works/888', total: 2,
  lastEpisodeId: id(2), docIds: [], lastCursor: 0, updatedAt: '2026-09-01 10:00' });
L.g('webStartContinuation("https://kakuyomu.jp/works/888")');
check('公開日時順で、話2 の後ろ（話3・話4）を取る', JSON.parse(L.state.props.EPISODES).map(e => [e.id, e.no]), [[id(3), 3], [id(4), 4]]);
L.g('webKick()');
check('記録に印は付かず、一覧ファイルも作らない', [JSON.parse(L.state.props.RESUME_888).order, '__kakuyomu_seen_888.json' in L.state.files], [undefined, false]);

section('初回取得を途中の話から始めたら、それより前は取得済み（読み飛ばし）として扱う');
const mid = {};
registerWork(mid, '999', '途中から', 4, { toc: [{ chapter: '一', eps: [4, 3, 2, 1] }] });
const M = createGasSandbox({ htmlByUrl: mid });
M.g('webStartFetch("https://kakuyomu.jp/works/999", "3", "")');
check('目次上の 3 番目から（話2・話1）を取る', JSON.parse(M.state.props.EPISODES).map(e => [e.id, e.no]), [[id(2), 3], [id(1), 4]]);
M.g('webKick()');
check('一覧には読み飛ばした話4・話3 も入る（続き取得で取り直さない）', JSON.parse(M.state.files['__kakuyomu_seen_999.json']), [id(4), id(3), id(2), id(1)]);

section('選択登録（既存ドキュメントなし）も目次順：開始話数より前を取得済みとして一覧を作る');
const sd = {};
registerWork(sd, '555', '登録作品', 5, { toc: [{ chapter: '一', eps: [5, 4, 3, 2, 1] }] });
const S = createGasSandbox({ htmlByUrl: sd });
S.g('webSeedSelected([{ url: "https://kakuyomu.jp/works/555", readCount: 2 }])');
S.g('webKick()');
const srec = JSON.parse(S.state.props.RESUME_555);
check('記録に印・件数、最後に読んだ話は目次の 2 番目', [srec.order, srec.seenCount, srec.total, srec.lastEpisodeId], ['toc', 2, 2, id(4)]);
check('一覧は目次の先頭 2 話', JSON.parse(S.state.files['__kakuyomu_seen_555.json']), [id(5), id(4)]);
S.g('webStartContinuation("https://kakuyomu.jp/works/555")');
check('続き取得は目次の 3 番目から', JSON.parse(S.state.props.EPISODES).map(e => e.no), [3, 4, 5]);

section('既存ドキュメントを紐付けて一覧に追加した作品は従来どおり（そのドキュメントの並びに合わせる）');
S.state.docs.DOCX = { end: 50 };
S.g('webSeedResumeRecord("https://kakuyomu.jp/works/555", "DOCX", true)');
check('印は付かない', JSON.parse(S.state.props.RESUME_555).order, undefined);

section('なろうは対象外（従来どおり）');
const nr = {};
registerNarouWork(nr, 'n1234ab', 'なろう作品', 3);
const N = createGasSandbox({ htmlByUrl: nr });
N.g('webStartFetch("https://ncode.syosetu.com/n1234ab/", "", "")');
N.g('webKick()');
check('印は付かず、一覧ファイルも作らない', [JSON.parse(N.state.props.RESUME_n1234ab).order, Object.keys(N.state.files).some(f => f.indexOf('__kakuyomu_seen_') === 0)], [undefined, false]);

section('番号のまとめ方');
check('連続は「〜」、飛び飛びは「、」', g('formatEpisodeRanges_([2, 5, 6, 7, 10])'), '2、5〜7、10');

finish();
