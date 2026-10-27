// 章タイトルの表示（カクヨム・なろう共通）。
//   ・目次から章を読む（カクヨム: tableOfContentsV2 / なろう: p-eplist__chapter-title。ページをまたぐ章は引き継ぐ）
//   ・章の見出しは「直前に出した章と違う章の最初の話」の直前にだけ出す。章なしの話は見出しを出さず、章の続きも途切れさせない
//   ・ドキュメントでは章が HEADING_3、話が HEADING_4（章の無い作品も話は HEADING_4）
//   ・続き取得は、直前までの話から現在の章を割り出す（章の途中からなら見出しを繰り返さない）
// 模擬 HTML は実物と同じ構造で、作品名・章名・本文は架空。
const { createGasSandbox, registerWork, registerNarouWork } = require('./harness/gas-mock');
const { check, section, finish } = require('./harness/check');

// 実行して、挿入されたテキストの見出し（レベル付き）を順に取り出す。
//   BUILD の最初の batchUpdate（本文の挿入＋書式）に含まれる updateParagraphStyle の範囲を、挿入テキストから切り出す。
function headingsOf(state) {
  const out = [];
  state.docRequests.forEach(({ requests }) => {
    const ins = requests.find(r => r.insertText && r.insertText.text.length > 10);
    if (!ins) return;
    const base = ins.insertText.location.index, text = ins.insertText.text;
    requests.forEach(r => {
      const ps = r.updateParagraphStyle;
      if (ps && ps.paragraphStyle.namedStyleType && /^HEADING_[34]$/.test(ps.paragraphStyle.namedStyleType)) {
        out.push([ps.paragraphStyle.namedStyleType, text.slice(ps.range.startIndex - base, ps.range.endIndex - base)]);
      }
    });
  });
  return out;
}

const run = (htmlByUrl, url, startExpr) => {
  const { g, state } = createGasSandbox({ htmlByUrl });
  g(startExpr || `webStartFetch("${url}", "", "")`);
  g('webKick()');
  return { g, state };
};

section('カクヨム: 目次の章を読み、章の見出し（H3）と話の見出し（H4）を入れる');
// 6 話。目次の並び: 章なしの 6 話目（公開日時は最新） → 第一章（1〜3 話） → 第二章（4〜5 話）。
// 新規に取得する作品は目次順なので、章なしの 6 話目が先頭（[001]）になる（test_toc_order.js も参照）。
const kaku = {};
registerWork(kaku, '777', 'カクヨム作品', 6, { toc: [
  { chapter: null, eps: [6] },
  { chapter: '第一章　はじまり', eps: [1, 2, 3] },
  { chapter: '第二章　つづき\t', eps: [4, 5] },
] });
const k = run(kaku, 'https://kakuyomu.jp/works/777');
check('完了する', k.state.props.PHASE, 'DONE');
check('見出しは目次順に 章 H3 → 話 H4（章なしの話は見出しを出さない）',
  headingsOf(k.state).map(h => h.join(' ')),
  ['HEADING_4 第6話 [001]', 'HEADING_3 第一章　はじまり', 'HEADING_4 第1話 [002]', 'HEADING_4 第2話 [003]', 'HEADING_4 第3話 [004]',
   'HEADING_3 第二章　つづき', 'HEADING_4 第4話 [005]', 'HEADING_4 第5話 [006]']);
check('章名は前後の空白・タブを削る（中の全角スペースは残す）', headingsOf(k.state)[5][1], '第二章　つづき');

// 従来どおり公開日時順で取る作品（保存済みの作品）では、章なしの 6 話目が第一章の途中に来ることがある。
// そのときも章の続きを途切れさせず、同じ章の見出しを二重に出さない。
const legacyOrder = [1, 2, 6, 3, 4, 5].map(no => ({ id: String(no), title: '第' + no + '話', url: 'u',
  chapter: no === 6 ? '' : (no <= 3 ? '第一章' : '第二章') }));
check('公開日時順で章なしの話が章の途中に来ても、見出しは各章 1 回ずつ',
  k.g('buildRunEpisodes_(' + JSON.stringify(legacyOrder) + ', 0, 6, true)').map(e => e.ch || null),
  ['第一章', null, null, null, '第二章', null]);
check('run 状態に章名を持たせるのは見出しを出す話だけ（全話に持たせない）',
  JSON.parse(JSON.stringify(k.g('buildRunEpisodes_([{id:"a",title:"t",url:"u",chapter:"X"},{id:"b",title:"t",url:"u",chapter:"X"}], 0, 2, true)'))).map(e => e.ch || null), ['X', null]);

section('章が無い作品: 見出しは話だけで、話は HEADING_4（章の行は入らない）');
const plain = {};
registerWork(plain, '888', '章なし作品', 3);
const p = run(plain, 'https://kakuyomu.jp/works/888');
check('話の見出しが H4 で、章の行（H3）は無い',
  headingsOf(p.state).map(h => h.join(' ')), ['HEADING_4 第1話 [001]', 'HEADING_4 第2話 [002]', 'HEADING_4 第3話 [003]']);

section('なろう: 章タイトルは直前の章の最初の話の前に入る。同名でも省略しない（プロローグ）');
const narou = {};
registerNarouWork(narou, 'n1234ab', 'なろう作品', 4, {}, [
  { before: 1, title: '第1話 & 話' }, { before: 2, title: '第1章　出会い' }, { before: 4, title: '第2章' },
]);
// 話のタイトルは模擬 HTML の都合で「第N話 & 話」。1 話目の章名を同じにして、同名でも省略されないことを見る
const n = run(narou, 'https://ncode.syosetu.com/n1234ab/');
check('章 H3 と話 H4 が交互に入る（1 話目は章名と話名が同じでも両方入る）',
  headingsOf(n.state).map(h => h[0] + ' ' + h[1].replace(/ \[\d+\]$/, '')),
  ['HEADING_3 第1話 & 話', 'HEADING_4 第1話 & 話', 'HEADING_3 第1章　出会い', 'HEADING_4 第2話 & 話', 'HEADING_4 第3話 & 話', 'HEADING_3 第2章', 'HEADING_4 第4話 & 話']);

section('なろう: 目次が複数ページで、章がページをまたいでも引き継ぐ（次ページの先頭に章タイトルが無い）');
const big = {};
registerNarouWork(big, 'n5555ee', '長編', 130, {}, [{ before: 1, title: '長い章' }, { before: 120, title: '最後の章' }]);
const cat = createGasSandbox({ htmlByUrl: big }).g('loadWorkCatalog_("https://ncode.syosetu.com/n5555ee/", "n5555ee")');
check('101〜119 話（2 ページ目の先頭）も「長い章」に属する', [cat.episodes[99].chapter, cat.episodes[100].chapter, cat.episodes[118].chapter], ['長い章', '長い章', '長い章']);
check('120 話以降は「最後の章」', [cat.episodes[119].chapter, cat.episodes[129].chapter], ['最後の章', '最後の章']);
const big2 = createGasSandbox({ htmlByUrl: big });
const heads = big2.g('buildRunEpisodes_(' + JSON.stringify(cat.episodes) + ', 0, 130, true)').filter(e => e.ch);
check('見出しを出す話は 1 話目と 120 話目だけ', heads.map(e => [e.no, e.ch]), [[1, '長い章'], [120, '最後の章']]);

section('章の無いなろう作品は、章の行を入れない');
const nplain = {};
registerNarouWork(nplain, 'n7777gg', '章なしなろう', 2);
const np = run(nplain, 'https://ncode.syosetu.com/n7777gg/');
check('H3 は無く、話は H4', headingsOf(np.state).map(h => h[0]), ['HEADING_4', 'HEADING_4']);

section('続き取得: 章の途中からは見出しを繰り返さず、新しい章の最初の話からは見出しを出す');
const cont = {};
registerNarouWork(cont, 'n2020cc', '続き作品', 4, {}, [{ before: 1, title: 'A章' }, { before: 3, title: 'B章' }]);
const c = createGasSandbox({ htmlByUrl: cont });
c.g('webSeedSelected([{ url: "https://ncode.syosetu.com/n2020cc/", readCount: 1 }])');
c.g('webKick()'); // 1 話まで取得済みとして登録（A章の途中）
registerNarouWork(cont, 'n2020cc', '続き作品', 4, {}, [{ before: 1, title: 'A章' }, { before: 3, title: 'B章' }]);
c.g('webStartContinuation("https://ncode.syosetu.com/n2020cc/")');
const queue = JSON.parse(c.state.props.EPISODES);
check('2 話目（A章の途中）には見出しを付けない・3 話目（B章の最初）には付ける', queue.map(e => [e.no, e.ch || null]), [[2, null], [3, 'B章'], [4, null]]);
c.g('webKick()');
check('追記された見出しは B章（H3）だけ', headingsOf(c.state).map(h => h[0] + ' ' + h[1].replace(/ \[\d+\]$/, '')), ['HEADING_4 第2話 & 話', 'HEADING_3 B章', 'HEADING_4 第3話 & 話', 'HEADING_4 第4話 & 話']);

section('初回取得を途中の話から始めたときは、その話が属する章の見出しを最初に出す');
const mid = createGasSandbox({ htmlByUrl: cont });
mid.g('webStartFetch("https://ncode.syosetu.com/n2020cc/", "2", "")');
check('2 話目（A章の途中）の前に A章 を出す', JSON.parse(mid.state.props.EPISODES).map(e => [e.no, e.ch || null]), [[2, 'A章'], [3, 'B章'], [4, null]]);

section('次話判定は見出しレベルにも章の行にも影響されない（行末の [NNN] だけを見る）');
const body = '第一章　はじまり\n第1話 [001]\n本文\n';
check('章の行は拾わず、最初の [NNN] を拾う', k.g('"' + body.replace(/\n/g, '\\n') + '".match(EPISODE_TAG_RE)[1]'), '001');

finish();
