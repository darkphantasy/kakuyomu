// 小説家になろう（ncode.syosetu.com）対応: 作品ID・目次（ページ送り）・本文（前書き・後書き）・
// 取得〜続き取得の一連の流れが、カクヨムと同じパイプラインに乗ることを確認する。
// 模擬 HTML は実物（2026-10）と同じクラス名・URL 形だけを持つ（tests/harness/gas-mock.js の narou*）。
const { createGasSandbox, registerNarouWork, registerWork, narouEpisodePage } = require('./harness/gas-mock');
const { check, section, finish } = require('./harness/check');

let htmlByUrl = {};
registerNarouWork(htmlByUrl, 'n1234ab', 'なろう作品', 150, { preface: true, afterword: true });
registerWork(htmlByUrl, '777', 'カクヨム作品', 2);
const { g, state } = createGasSandbox({ htmlByUrl });
const props = state.props;
const BASE = 'https://ncode.syosetu.com/n1234ab/';

section('作品ID と URL の正規化');
check('Nコードを取り出す（話のページ・大文字でも小文字に揃える）',
  [g('extractWorkId("https://ncode.syosetu.com/n1234ab/")'), g('extractWorkId("https://ncode.syosetu.com/N1234AB/12/")'), g('extractWorkId("ncode.syosetu.com/n1234ab")')],
  ['n1234ab', 'n1234ab', 'n1234ab']);
check('R18（novel18.syosetu.com）は認識しない', g('extractWorkId("https://novel18.syosetu.com/n1234ab/")'), null);
check('作品情報ページなど Nコード以外のパスは認識しない', g('extractWorkId("https://ncode.syosetu.com/novelview/infotop/ncode/n1234ab/")'), null);
check('カクヨムは従来どおり', g('extractWorkId("https://kakuyomu.jp/works/777")'), '777');
check('なろうの URL は目次の URL に揃える', g('canonicalWorkUrl_("https://ncode.syosetu.com/N1234AB/12/")'), BASE);
check('カクヨムの URL はそのまま', g('canonicalWorkUrl_("https://kakuyomu.jp/works/777?x=1")'), 'https://kakuyomu.jp/works/777?x=1');

section('目次: ページ送りをたどって全話を集める');
const cat = g('loadWorkCatalog_("https://ncode.syosetu.com/n1234ab/5/", "n1234ab")');
check('タイトル', cat.title, 'なろう作品');
check('150 話（100 + 50 の 2 ページ）', cat.episodes.length, 150);
check('ID は話番号・URL は話のページ', [cat.episodes[0].id, cat.episodes[149].id, cat.episodes[149].url], ['1', '150', BASE + '150/']);
check('話タイトルは前後の改行を除き、実体参照を戻す', cat.episodes[0].title, '第1話 & 話');

section('目次の途中のページが取れなければ、部分的な一覧は返さない（続き取得の起点を誤らないため）');
const saved = htmlByUrl[BASE + '?p=2'];
delete htmlByUrl[BASE + '?p=2'];
check('null を返す', g('loadWorkCatalog_("' + BASE + '", "n1234ab")'), null);
htmlByUrl[BASE + '?p=2'] = saved;

section('本文: 前書き・後書きを区切り線で挟む／ルビは括弧書き');
const sep = g('NAROU_PART_SEPARATOR');
const text = g('extractEpisodeText_(' + JSON.stringify(narouEpisodePage(3, { preface: true, afterword: true })) + ', "n1234ab")');
check('前書き → 区切り → 本文 → 区切り → 後書き', text.split('\n\n' + sep + '\n\n').length, 3);
check('前書きが先頭・後書きが末尾', [text.indexOf('前書き3') === 0, text.endsWith('後書き3')], [true, true]);
check('ルビは「漢字（かな）」になり、タグは残らない', [text.indexOf('漢字（かんじ）') >= 0, /<[a-z]/i.test(text)], [true, false]);
const plain = g('extractEpisodeText_(' + JSON.stringify(narouEpisodePage(4)) + ', "n1234ab")');
check('前書き・後書きが無い話には区切り線を入れない', plain.indexOf(sep), -1);
check('本文が無ければ取得失敗の表記', g('extractEpisodeText_("<html></html>", "n1234ab")'), '（本文取得失敗）');

section('短編（目次が無く本文が作品ページにある）は 1 話として扱う');
htmlByUrl['https://ncode.syosetu.com/n9999zz/'] =
  '<html><body><h1 class="p-novel__title">短編作品</h1><div class="p-novel__body"><div class="js-novel-text p-novel__text"><p id="L1">短編の本文</p></div></div></body></html>';
const shortCat = g('loadWorkCatalog_("https://ncode.syosetu.com/n9999zz/", "n9999zz")');
check('1 話・話タイトルは作品タイトル・URL は作品ページ',
  shortCat.episodes.map(e => [e.id, e.title, e.url]), [['short', '短編作品', 'https://ncode.syosetu.com/n9999zz/']]);

section('Web: 話のページの URL から初回取得 → 完走（カクヨムと同じパイプライン）');
const r1 = g('webStartFetch("https://ncode.syosetu.com/N1234AB/7/", "", "")');
check('開始できる', [r1.ok, r1.kick], [true, true]);
check('取得元 URL は目次の URL に揃う', props.SOURCE_URL, BASE);
g('webKick()');
check('完了する', props.PHASE, 'DONE');
const rec = JSON.parse(props.RESUME_n1234ab);
check('記録: 150 話・URL は目次・最後の話の ID', [rec.total, rec.url, rec.lastEpisodeId], [150, BASE, '150']);
const all = state.insertedTexts.join('');
check('本文に前書き・後書きの区切り線とルビが入る', [all.indexOf(sep) >= 0, all.indexOf('漢字（かんじ）') >= 0], [true, true]);
check('話見出しに通し番号 [001]〜[150]', [all.indexOf('第1話 & 話 [001]') >= 0, all.indexOf('第150話 & 話 [150]') >= 0], [true, true]);
check('一覧の表示用に site=narou', g('webGetState()').works.find(w => w.workId === 'n1234ab').site, 'narou');

section('続き取得: 新しく増えた話だけを取る');
registerNarouWork(htmlByUrl, 'n1234ab', 'なろう作品', 152);
const r2 = g('webStartContinuation("' + BASE + '")');
check('151〜152 話が新着', [r2.ok, props.CONT_FROM, props.CONT_TO], [true, '151', '152']);
g('webKick()');
check('記録が 152 話に進む', JSON.parse(props.RESUME_n1234ab).total, 152);

section('URL の入力チェック');
const bad = g('webStartFetch("https://novel18.syosetu.com/n1234ab/", "", "")');
check('R18 は受け付けず、両サイトの形式と R18 対象外を案内する',
  [bad.ok, bad.message.indexOf('ncode.syosetu.com') >= 0, bad.message.indexOf('R18') >= 0], [false, true, true]);

section('削除済みリストも作品単位（話のページの URL でも同じ作品として確認が出る）');
g('webClearResumeRecord("' + BASE + '")');
const again = g('webStartFetch("https://ncode.syosetu.com/n1234ab/3/", "", "")');
check('確認が出る', [again.needConfirm, again.message.indexOf('なろう作品') >= 0], [true, true]);

finish();
