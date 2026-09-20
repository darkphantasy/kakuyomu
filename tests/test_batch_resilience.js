// batchStartNext: 続き取得・初回取得の準備中に例外が起きても、その1件をスキップして
//   キューの残りを処理し続けること（トリガー実行が丸ごと落ちて詰まるのを防ぐ）。
//   選択登録（mode:'seed'）は既に try/catch されているので、それ以外の mode:'cont'/'fetch' を確認する。
const { createGasSandbox, registerWork } = require('./harness/gas-mock');
const { check, section, finish } = require('./harness/check');

section('mode:cont の1件が例外を投げても、キューの残りは処理される');
{
  const htmlByUrl = {};
  registerWork(htmlByUrl, '200', '例外になる作品', 5);
  registerWork(htmlByUrl, '300', '正常な作品', 8); // 記録5話→8話で新着あり

  const { g, state } = createGasSandbox({
    htmlByUrl,
    fetch: (url) => {
      if (url === 'https://kakuyomu.jp/works/200') throw new Error('模擬ネットワークエラー');
      return undefined; // それ以外は通常どおり htmlByUrl から返す
    },
  });
  const props = state.props;
  Object.assign(props, {
    RESUME_200: JSON.stringify({ title: '例外になる作品', url: 'https://kakuyomu.jp/works/200', total: 5, lastEpisodeId: '104', docIds: ['d'] }),
    RESUME_300: JSON.stringify({ title: '正常な作品', url: 'https://kakuyomu.jp/works/300', total: 5, lastEpisodeId: '104', docIds: ['d'] }),
    BATCH_MODE: '1',
    BATCH_QUEUE: JSON.stringify([{ workId: '200', mode: 'cont' }, { workId: '300', mode: 'cont' }]),
    BATCH_TOTAL: '2', BATCH_FETCHED: '0', BATCH_KIND: 'cont',
    PHASE: 'BATCH_NEXT',
  });

  let threw = null;
  try { g('continuesFetch()'); } catch (e) { threw = String(e); }
  check('continuesFetch 自体は例外にならない（丸ごと落ちてトリガーが途絶えない）', threw, null);
  // モックはネットワーク待ちが無いので、200 をスキップした後 300 の取得までこの1呼び出しで完走する。
  check('例外になった 200 はスキップされ、300 は正しく完了する（8話・ドキュメント1冊）',
    [props.PHASE, JSON.parse(props.RESUME_300).total, state.createdDocs],
    ['DONE', 8, 1]);
  check('結果は「確認 2 作品・新着あり 1 作品」（200 は確認扱いのままカウントされる）',
    props.BATCH_RESULT.indexOf('確認 2 作品・新着あり 1 作品') >= 0, true);
}

section('mode:fetch の1件が例外を投げても、キューの残りは処理される');
{
  const htmlByUrl = {};
  registerWork(htmlByUrl, '500', '正常な新規作品', 4);

  const { g, state } = createGasSandbox({
    htmlByUrl,
    fetch: (url) => {
      if (url === 'https://kakuyomu.jp/works/400') throw new Error('模擬ネットワークエラー');
      return undefined;
    },
  });
  const props = state.props;
  Object.assign(props, {
    BATCH_MODE: '1',
    BATCH_QUEUE: JSON.stringify([
      { url: 'https://kakuyomu.jp/works/400', mode: 'fetch' },
      { url: 'https://kakuyomu.jp/works/500', mode: 'fetch' },
    ]),
    BATCH_TOTAL: '2', BATCH_FETCHED: '0', BATCH_KIND: 'cont',
    PHASE: 'BATCH_NEXT',
  });

  let threw = null;
  try { g('continuesFetch()'); } catch (e) { threw = String(e); }
  check('continuesFetch 自体は例外にならない', threw, null);
  check('例外になった 400 はスキップされ、500 は正しく完了する（4話・ドキュメント1冊）',
    [props.PHASE, state.createdDocs], ['DONE', 1]);
}

finish();
