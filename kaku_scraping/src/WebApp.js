// ==========================================
// Web アプリ（取得インターフェース）
//   doGet で index.html を返し、クライアント側から google.script.run で
//   下記の web* 関数を呼ぶ。取得ロジック本体には手を入れず、既存の部品
//   （isRunActive_ / enqueueWork_ / prepareFetch / prepareContinuation /
//   batchStartNext / ensureTriggerAfter）を組み合わせている。
//
//   起動は「run 状態をセット → 短い遅延でトリガーを張る」だけにして即座に返す。
//   実際の取得はトリガー実行（continuesFetch）が担うため、ボタンは待たされない。
//
// ■ デプロイ手順（初回のみ）
//   GAS エディタ右上「デプロイ」→「新しいデプロイ」→ 種類「ウェブアプリ」
//     実行するユーザー: 自分 ／ アクセスできるユーザー: 自分のみ
//   ※ 本番URL(/exec)はデプロイ版数に固定されるため、コード更新のたびに
//     デプロイし直す必要がある。「テストデプロイ」の /dev URL は常に最新
//     コードで動くので、clasp push だけで反映したい場合はそちらを使う。
//
//   操作パネル（ControlPanel.js のスプレッドシート）とは併存可能。
// ==========================================

const WEB_KICKOFF_DELAY_MS = 1000; // Web UI から起動する際のトリガー遅延

function doGet(e) {
  return HtmlService.createHtmlOutputFromFile('index')
    .setTitle('カクヨム取得コンソール')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

// ==========================================
// 画面表示用の現在状態をまとめて返す（定期ポーリングで呼ばれる）
// ==========================================
function webGetState() {
  const props = PropertiesService.getScriptProperties();
  const all   = props.getProperties();

  const works = Object.keys(all)
    .filter(k => k.indexOf('RESUME_') === 0)
    .map(k => {
      let r; try { r = JSON.parse(all[k]); } catch(e) { r = {}; }
      const title = r.title || '(無題)';
      return {
        workId:     k.replace('RESUME_', ''),
        title:      title,
        shortTitle: shortenTitleForFileName_(title),
        url:        r.url || '',
        total:      (r.total != null ? String(r.total) : ''),
        updatedAt:  r.updatedAt || '',
        docIds:     r.docIds || [],
      };
    })
    .sort(compareWorksForDisplay_); // 同分の作品が呼び出しごとに入れ替わらないよう決定的に並べる

  const eps   = JSON.parse(all.EPISODES || '[]');
  const queue = JSON.parse(all.BATCH_QUEUE || '[]');

  return {
    works: works,
    running: {
      active:    isRunActive_(props),
      phase:     all.PHASE || '',
      batchNext: all.PHASE === PHASE_BATCH_NEXT,
      title:     all.TITLE || '',
      done:      Number(all.NEXT_INDEX || 0),
      total:     eps.length,
    },
    queueCount:    queue.length,
    shortFilename: isShortFilenameEnabled_(),
  };
}

// ==========================================
// 取得の開始（即応）。実行中なら順番待ちに積むだけ。
//   mode: 'fetch'（初回取得） / 'cont'（続き取得）
// ==========================================
function webStartWork_(mode, url, startEpisode, endEpisode) {
  const targetUrl = String(url || '').trim();
  if (!targetUrl) return { ok: false, message: '作品URLを入力してください。' };
  if (!extractWorkId(targetUrl)) {
    return { ok: false, message: 'カクヨムの作品URLとして認識できません（https://kakuyomu.jp/works/... の形式）。' };
  }

  const props = PropertiesService.getScriptProperties();
  if (isRunActive_(props)) {
    const n = enqueueWork_(props, {
      url: targetUrl, mode: mode,
      startEpisode: startEpisode, endEpisode: endEpisode,
    });
    return { ok: true, message: `実行中の取得があるため、順番待ちに追加しました（${n} 件目）。` };
  }

  const prepared = (mode === 'fetch')
    ? prepareFetch(targetUrl, startEpisode, endEpisode)
    : prepareContinuation(targetUrl);

  if (!prepared) {
    return {
      ok: false,
      message: (mode === 'fetch')
        ? '開始できませんでした。URLと目次の取得結果を実行ログで確認してください。'
        : '新着はありませんでした（または記録が無い／取得に失敗しました）。',
    };
  }

  ensureTriggerAfter(WEB_KICKOFF_DELAY_MS);
  return { ok: true, message: '取得を開始しました。進捗はこの画面に自動反映されます。' };
}

function webStartFetch(url, startEpisode, endEpisode) {
  return webStartWork_('fetch', url, startEpisode, endEpisode);
}

function webStartContinuation(url) {
  return webStartWork_('cont', url);
}

// 一覧の全作品を順に続き取得（即応）。実行中なら順番待ちの末尾に積む。
function webStartContinuationAll() {
  const props = PropertiesService.getScriptProperties();
  const keys  = Object.keys(props.getProperties()).filter(k => k.indexOf('RESUME_') === 0);
  if (keys.length === 0) return { ok: false, message: '続き取得できる作品がありません。' };

  const entries = keys.map(k => ({ workId: k.replace('RESUME_', ''), mode: 'cont' }));

  if (isRunActive_(props)) {
    const queue = JSON.parse(props.getProperty('BATCH_QUEUE') || '[]');
    props.setProperties({
      BATCH_MODE:  '1',
      BATCH_QUEUE: JSON.stringify(queue.concat(entries)),
    });
    return { ok: true, message: `実行中のため、${entries.length} 作品を順番待ちに追加しました。` };
  }

  props.setProperties({ BATCH_MODE: '1', BATCH_QUEUE: JSON.stringify(entries) });
  if (!batchStartNext(props)) {
    props.deleteProperty('BATCH_MODE');
    props.deleteProperty('BATCH_QUEUE');
    return { ok: true, message: '新着のある作品はありませんでした。' };
  }

  ensureTriggerAfter(WEB_KICKOFF_DELAY_MS);
  return { ok: true, message: `一括続き取得を開始しました（${entries.length} 作品を確認）。` };
}

// ==========================================
// 一覧の管理・その他操作
// ==========================================
function webSeedResumeRecord(url, docIdsText) {
  const targetUrl = String(url || '').trim();
  if (!targetUrl) return { ok: false, message: '作品URLを入力してください。' };
  if (!extractWorkId(targetUrl)) return { ok: false, message: 'カクヨムの作品URLとして認識できません。' };

  const docIds = String(docIdsText || '').split(',').map(s => s.trim()).filter(s => s);
  try {
    seedResumeRecord(targetUrl, docIds);
    return { ok: true, message: `一覧に追加しました（既存ドキュメント ${docIds.length} 件を紐付け）。` };
  } catch(e) { return { ok: false, message: 'エラー: ' + e }; }
}

function webClearResumeRecord(url) {
  const targetUrl = String(url || '').trim();
  if (!targetUrl) return { ok: false, message: '作品URLが指定されていません。' };
  try {
    clearResumeRecord(targetUrl);
    return { ok: true, message: '一覧から削除しました（ドキュメント自体は残ります）。' };
  } catch(e) { return { ok: false, message: 'エラー: ' + e }; }
}

function webSyncFromSheet() {
  const props = PropertiesService.getScriptProperties();
  if (isRunActive_(props)) {
    return { ok: false, message: '取得の実行中は同期できません。完了後に実行してください。' };
  }
  try {
    syncResumeRecordsFromSheet();
    return { ok: true, message: '索引シートと差分同期しました（詳細は実行ログ）。' };
  } catch(e) { return { ok: false, message: 'エラー: ' + e }; }
}

function webRebuildIndex() {
  try {
    rebuildIndex();
    return { ok: true, message: '索引シートを再生成しました。' };
  } catch(e) { return { ok: false, message: 'エラー: ' + e }; }
}

function webClearQueue() {
  const props = PropertiesService.getScriptProperties();
  const queue = JSON.parse(props.getProperty('BATCH_QUEUE') || '[]');
  if (queue.length === 0) return { ok: true, message: '順番待ちはありません。' };

  props.setProperty('BATCH_QUEUE', '[]');
  if (!isRunActive_(props)) props.deleteProperty('BATCH_MODE');
  return { ok: true, message: `順番待ち ${queue.length} 件を取り消しました（実行中の取得は継続します）。` };
}

function webToggleShortFilename() {
  const props = PropertiesService.getScriptProperties();
  const next  = isShortFilenameEnabled_() ? '0' : '1';
  props.setProperty('SHORT_FILENAME', next);
  return {
    ok: true,
    message: `ファイル名短縮を${next === '1' ? 'ON' : 'OFF'}にしました（次に作成される新規ドキュメントから反映）。`,
  };
}

// 索引スプレッドシート・操作パネルへのリンク（画面から開けるように）
function webGetLinks() {
  const props = PropertiesService.getScriptProperties();
  const mk = (id) => id ? `https://docs.google.com/spreadsheets/d/${id}` : '';
  return {
    indexUrl: mk(props.getProperty('INDEX_SHEET_ID')),
    panelUrl: mk(props.getProperty('CONTROL_PANEL_SHEET_ID')),
  };
}
