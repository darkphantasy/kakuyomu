// ==========================================
// カクヨム 小説取得 → Googleドキュメント保存
// 【改修版】2026-06
//   - FETCHING：全話を取得してバッファファイルに蓄積
//   - BUILD：Docs API で挿入しながら見出し・太字・フォントを同一バッチで適用。
//     ドキュメントを読み返さないのでメモリ安全。MAX_DOC_CHARS を大きく取れる＝少ファイル。
//     整形を別フェーズで全段落再走査しないので高速。
//   - ■ は挿入前に除去（後から消さない）→ 位置は加算のみで正確
//   - フォント M PLUS 1 Code を全文適用
//   - タイムアウトで取得件数を自動制御（無料Gmail 6分前提）
//   - 完了時にバッファ残骸を一括掃除
//   - 続き取得：記録の末尾 cursor から既存ドキュメントへ追記（無ければ作成／上限超過で新冊）
//   - 一括続き取得：索引（＝全記録）の全作品を順に続き取得
//   - 取得記録フッターを末尾に付与（追記時も末尾に新しいフッターを追加）
//   - 保存先はスクリプトと同じフォルダ。索引ファイルを自動生成・更新
//
// ■ 実行する関数
//   startFetch            … 初回。全話を取得して保存。
//   startContinuation     … 続き取得（KAKUYOMU_URL の作品）。
//   startContinuationAll  … 索引の全作品を順に続き取得（一括）。
//   seedResumeRecord      … 既存作品の現在地を記録（既存ドキュメントIDも登録可）。
//   checkResume           … 続き取得記録の確認。
//   listResumeRecords     … 保存済み全作品の記録を一覧表示。
//   rebuildIndex          … 索引ファイルを今すぐ再生成。
//   checkProgress         … 実行中の進捗確認。
//   resetAll              … 途中状態のリセット（記録・索引は残す）。
//
// ※ 事前準備：エディタの「サービス」から「Docs API」を追加すること
//    （userSymbol: Docs / version: v1）。挿入・整形に使用。
// ==========================================

const KAKUYOMU_URL         = 'https://kakuyomu.jp/works/2912051597833856051'; // ← 変更
const EPISODES_PER_BUFFER  = 50;               // 1バッファファイルあたりのエピソード数
const MAX_DOC_CHARS        = 900000;           // 1ドキュメントの最大文字数（読み返さない挿入方式なので大きくできる）
const TIMEOUT_THRESHOLD_MS = 5 * 60 * 1000;    // タイムアウト判定（6分上限に対し1分マージン）
const RETRIGGER_DELAY_MS   = 30 * 1000;        // 再トリガー間隔（GASの都合で実際は最大1分前後の揺れあり）
const FETCH_SLEEP_MS       = 500;              // 1話取得ごとの待機（相手サーバーへの礼儀）
const START_EPISODE        = 1;                // 取得開始話数（1始まり）
const FONT_FAMILY          = 'M PLUS 1 Code';  // 最終ドキュメントに適用するフォント
const HEADER_GUARD_CHARS   = 4096;             // 新ドキュメントへこぼす判定の下限（ヘッダのみでこぼさない）

const PHASE_FETCHING = 'FETCHING';
const PHASE_BUILD    = 'BUILD';
const PHASE_BATCH_NEXT = 'BATCH_NEXT';
const PHASE_DONE     = 'DONE';

const INDEX_DOC_NAME = '【索引】カクヨム取得作品';

// runの途中経過に使うプロパティキー（完了時にこれだけ消す。記録・索引IDは残す）
const RUN_STATE_KEYS = [
  'WORK_ID', 'TITLE', 'SOURCE_URL', 'EPISODE_TOTAL', 'LAST_EPISODE_ID',
  'EPISODES', 'NEXT_INDEX', 'PHASE', 'BUF_COUNT', 'DOC_IDS',
  'CONTINUATION', 'CONT_FROM', 'CONT_TO', 'CONT_LAST_CURSOR',
  'BUILD_BUF_INDEX', 'BUILD_CURSOR', 'BUILD_DOC_ID', 'BUILD_DOC_PART',
  'BUILD_FOOTER_DONE',
];

// ==========================================
// 保存先フォルダ（スクリプトと同じ親フォルダ）
//   実行ごとに1回だけ解決してキャッシュする。
// ==========================================
var _cachedFolderId = null;
function getTargetFolderId() {
  if (_cachedFolderId) return _cachedFolderId;
  try {
    const scriptFile = DriveApp.getFileById(ScriptApp.getScriptId());
    const parents = scriptFile.getParents();
    _cachedFolderId = parents.hasNext()
      ? parents.next().getId()
      : DriveApp.getRootFolder().getId();
  } catch(e) {
    Logger.log('スクリプトのフォルダ解決に失敗。ルートに保存します: ' + e);
    _cachedFolderId = DriveApp.getRootFolder().getId();
  }
  return _cachedFolderId;
}

// ==========================================
// 続き取得の記録（作品ごとに保存。run状態とは別管理）
//   RESUME_<workId> に { title, url, total, lastEpisodeId, docIds, updatedAt } を保存。
// ==========================================
function resumeKey(workId) {
  return `RESUME_${workId}`;
}

function getResumeRecord(workId) {
  const raw = PropertiesService.getScriptProperties().getProperty(resumeKey(workId));
  if (!raw) return null;
  try { return JSON.parse(raw); } catch(e) { return null; }
}

function saveResumeRecord(workId, rec) {
  PropertiesService.getScriptProperties().setProperty(resumeKey(workId), JSON.stringify(rec));
}

function clearRunState(props) {
  RUN_STATE_KEYS.forEach(k => props.deleteProperty(k));
}

// 取得記録フッターの行を生成（初回・追記で共通）
function buildFooterLines(props) {
  const title = props.getProperty('TITLE')        || '';
  const url   = props.getProperty('SOURCE_URL')   || '';
  const total = props.getProperty('EPISODE_TOTAL') || '';
  const stamp = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm');
  const lines = [
    '────────────────',
    '【取得記録】',
    `タイトル: ${title}`,
    `URL: ${url}`,
    `話数: ${total} 話（取得時点の総話数）`,
  ];
  if (props.getProperty('CONTINUATION') === '1') {
    lines.push(`今回追記: ${props.getProperty('CONT_FROM')}〜${props.getProperty('CONT_TO')} 話`);
  }
  lines.push(`取得日時: ${stamp}`);
  return lines;
}

// ==========================================
// ① 最初に1回だけ手動実行
// ==========================================
function startFetch() {
  const workId = extractWorkId(KAKUYOMU_URL);
  if (!workId) { Logger.log('作品IDの取得失敗'); return; }

  Logger.log(`作品ID: ${workId}`);

  const topHtml = fetchHtml(KAKUYOMU_URL);
  if (!topHtml) return;

  const nextData    = extractNextData(topHtml);
  const title       = extractTitle(topHtml, nextData, workId);
  const allEpisodes = collectAllEpisodes(topHtml, nextData, workId);

  Logger.log(`タイトル: ${title}`);
  Logger.log(`全エピソード数: ${allEpisodes.length}`);

  if (allEpisodes.length === 0) {
    Logger.log('エピソードが見つかりません。__NEXT_DATA__ を確認します。');
    if (nextData) Logger.log(JSON.stringify(nextData).substring(0, 3000));
    return;
  }

  const startIndex = Math.max(0, Math.min(START_EPISODE - 1, allEpisodes.length - 1));
  const episodes   = allEpisodes.slice(startIndex);

  Logger.log(`取得開始: ${startIndex + 1} 話目〜 (${episodes.length} 件)`);

  const props = PropertiesService.getScriptProperties();
  clearRunState(props); // 前回の途中状態が残っていれば消す（記録RESUMEは残す）
  props.setProperties({
    WORK_ID:         workId,
    TITLE:           title,
    SOURCE_URL:      KAKUYOMU_URL,
    EPISODE_TOTAL:   String(allEpisodes.length),          // 取得時点の作品総話数
    LAST_EPISODE_ID: allEpisodes[allEpisodes.length - 1].id, // 続き取得の照合用
    EPISODES:        JSON.stringify(episodes),
    NEXT_INDEX:      '0',
    PHASE:           PHASE_FETCHING,
  });

  Logger.log('取得フェーズ開始');
  continuesFetch();
}

// ==========================================
// ①' 続き取得モード（記録の次の話から差分取得）
//   記録が無い場合は seedResumeRecord か startFetch を案内する。
// ==========================================
function startContinuation() {
  if (prepareContinuation(KAKUYOMU_URL)) continuesFetch();
}

// 索引（＝全 RESUME 記録）の全作品を、1作品ずつ順番に続き取得する。
//   1作品を完全に取り切ってから次へ進む（finishRun がキューを進める）。
//   新着が無い作品は飛ばす。
function startContinuationAll() {
  const props = PropertiesService.getScriptProperties();

  // 実行中（run状態あり）なら多重起動を避ける
  if (props.getProperty('PHASE') && props.getProperty('PHASE') !== PHASE_DONE) {
    Logger.log('別の取得が進行中です。完了後に実行してください（checkProgress で確認）。');
    return;
  }

  const all  = props.getProperties();
  const keys = Object.keys(all).filter(k => k.indexOf('RESUME_') === 0);
  if (keys.length === 0) { Logger.log('続き取得記録がありません。'); return; }

  const queue = keys.map(k => k.replace('RESUME_', ''));   // workId の配列
  props.setProperties({ BATCH_MODE: '1', BATCH_QUEUE: JSON.stringify(queue) });
  Logger.log(`一括続き取得：${queue.length} 作品を順に処理します。`);

  if (!batchStartNext(props)) {
    props.deleteProperty('BATCH_MODE');
    props.deleteProperty('BATCH_QUEUE');
    Logger.log('一括続き取得：新着のある作品はありませんでした。');
    return;
  }
  continuesFetch(); // 先頭作品をすぐ開始
}

// バッチキューから次の作品を取り出し、続き取得の準備をする。
//   新着があり run 状態をセットできたら true（PHASE=FETCHING）。
//   キューを使い切ったら false。トリガー管理は呼び出し側が行う。
function batchStartNext(props) {
  let queue = JSON.parse(props.getProperty('BATCH_QUEUE') || '[]');
  while (queue.length > 0) {
    const workId = queue.shift();
    props.setProperty('BATCH_QUEUE', JSON.stringify(queue));

    const rec = getResumeRecord(workId);
    if (!rec || !rec.url) { Logger.log(`URL記録なし、スキップ: ${workId}`); continue; }

    Logger.log(`▼ 次の作品: ${rec.title || workId}`);
    if (prepareContinuation(rec.url)) return true; // 新着あり → 次回 FETCHING
    // 新着なし → 次の作品へ
  }
  return false;
}

// 続き取得の準備（URL指定）。run 状態をセットしたら true、新着なし/失敗なら false。
//   ※ 実際の取得開始（continuesFetch / トリガー）は呼び出し側が行う。
function prepareContinuation(url) {
  const workId = extractWorkId(url);
  if (!workId) { Logger.log('作品IDの取得失敗: ' + url); return false; }

  const rec = getResumeRecord(workId);
  if (!rec) {
    Logger.log('続き取得の記録がありません: ' + url);
    Logger.log('・初めてなら startFetch、既存なら seedResumeRecord を先に実行してください。');
    return false;
  }
  Logger.log(`記録: ${rec.total} 話まで取得済み（${rec.updatedAt}）`);

  const topHtml = fetchHtml(url);
  if (!topHtml) return false;
  const nextData    = extractNextData(topHtml);
  const title       = extractTitle(topHtml, nextData, workId);
  const allEpisodes = collectAllEpisodes(topHtml, nextData, workId);
  if (allEpisodes.length === 0) { Logger.log('エピソードが見つかりません。'); return false; }

  // 起点の決定：末尾エピソードIDが現在の一覧にあればその次から。
  // 無ければ（削除・並び替え等）記録の話数を起点にフォールバック。
  let startIndex;
  if (rec.lastEpisodeId) {
    const idx = allEpisodes.findIndex(e => e.id === rec.lastEpisodeId);
    startIndex = (idx >= 0) ? idx + 1 : (rec.total || 0);
  } else {
    startIndex = rec.total || 0;
  }
  startIndex = Math.max(0, Math.min(startIndex, allEpisodes.length));

  if (startIndex >= allEpisodes.length) {
    Logger.log(`新着なし。現在 ${allEpisodes.length} 話 / 記録 ${rec.total} 話。`);
    return false;
  }

  const episodes = allEpisodes.slice(startIndex);
  Logger.log(`続き取得: ${startIndex + 1} 〜 ${allEpisodes.length} 話 (${episodes.length} 件)`);

  const props = PropertiesService.getScriptProperties();
  clearRunState(props); // BATCH_MODE/BATCH_QUEUE は RUN_STATE_KEYS 外なので保持される
  props.setProperties({
    WORK_ID:         workId,
    TITLE:           title,
    SOURCE_URL:      url,
    EPISODE_TOTAL:   String(allEpisodes.length),
    LAST_EPISODE_ID: allEpisodes[allEpisodes.length - 1].id,
    EPISODES:        JSON.stringify(episodes),
    NEXT_INDEX:      '0',
    PHASE:           PHASE_FETCHING,
    CONTINUATION:    '1',
    CONT_FROM:       String(startIndex + 1),
    CONT_TO:         String(allEpisodes.length),
    DOC_IDS:         JSON.stringify(rec.docIds || []),   // 追記対象の既存ドキュメント
    CONT_LAST_CURSOR: String(rec.lastCursor || 0),       // 末尾ドキュメントの追記起点
  });
  Logger.log('続き取得フェーズ準備完了');
  return true;
}

// ==========================================
// 続き取得の現在地を記録する（ブートストラップ用）
//   「現在の全話を取得済み」とみなして記録する。記録が無い既存作品に対し、
//   再取得せず続き取得を始められるようにするための一度きりの関数。
//   ※ 既存ドキュメントが現時点より前なら、続きに既読分が混じる可能性あり。
// ==========================================
function seedResumeRecord() {
  const workId = extractWorkId(KAKUYOMU_URL);
  if (!workId) { Logger.log('作品IDの取得失敗'); return; }

  // 既にある取得済みドキュメントのIDをここに入れると、続き取得時に
  // そのドキュメント（末尾のもの）へ追記します。空なら続き取得時に新規作成します。
  const existingDocIds = [
    // '1AbCdEf...既存ドキュメントID...',
  ];

  const topHtml = fetchHtml(KAKUYOMU_URL);
  if (!topHtml) return;
  const nextData    = extractNextData(topHtml);
  const title       = extractTitle(topHtml, nextData, workId);
  const allEpisodes = collectAllEpisodes(topHtml, nextData, workId);
  if (allEpisodes.length === 0) { Logger.log('エピソードが見つかりません。'); return; }

  saveResumeRecord(workId, {
    title:         title,
    url:           KAKUYOMU_URL,
    total:         allEpisodes.length,
    lastEpisodeId: allEpisodes[allEpisodes.length - 1].id,
    docIds:        existingDocIds,
    updatedAt:     Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm'),
  });
  Logger.log(`現在地を記録しました:「${title}」${allEpisodes.length} 話 / 既存ドキュメント ${existingDocIds.length} 件`);
  Logger.log('以降は startContinuation で続きだけ取得できます。');
  try { updateIndexFile(); } catch(e) { Logger.log('索引更新エラー: ' + e); }
}

// 索引ファイルを今すぐ再生成（手動）
function rebuildIndex() {
  updateIndexFile();
}

// 続き取得記録の確認（KAKUYOMU_URL の作品）
function checkResume() {
  const workId = extractWorkId(KAKUYOMU_URL);
  if (!workId) { Logger.log('作品IDの取得失敗'); return; }
  const rec = getResumeRecord(workId);
  if (!rec) { Logger.log('この作品の続き取得記録はありません。'); return; }
  Logger.log(JSON.stringify(rec, null, 2));
}

// 保存済みの全作品の続き取得記録を一覧表示（作品をまたいで残っていることの確認用）
function listResumeRecords() {
  const all  = PropertiesService.getScriptProperties().getProperties();
  const keys = Object.keys(all).filter(k => k.indexOf('RESUME_') === 0);
  if (keys.length === 0) { Logger.log('続き取得記録はありません。'); return; }

  Logger.log(`続き取得記録: ${keys.length} 作品`);
  keys.forEach(k => {
    let r; try { r = JSON.parse(all[k]); } catch(e) { r = {}; }
    Logger.log(`- [${k.replace('RESUME_', '')}] ${r.title || ''} : ${r.total || '?'} 話 (${r.updatedAt || ''})`);
  });
}

// 続き取得記録の削除（KAKUYOMU_URL の作品）
function clearResumeRecord() {
  const workId = extractWorkId(KAKUYOMU_URL);
  if (!workId) return;
  PropertiesService.getScriptProperties().deleteProperty(resumeKey(workId));
  Logger.log('この作品の続き取得記録を削除しました。');
}

// ==========================================
// ② 継続実行（トリガーから自動呼び出し）
// ==========================================
function continuesFetch() {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(10 * 1000);
  } catch(e) {
    Logger.log('別の実行が進行中のためスキップします。');
    return;
  }

  const startTime = Date.now();

  try {
    const props = PropertiesService.getScriptProperties();
    const phase = props.getProperty('PHASE');

    if (phase === PHASE_FETCHING) {
      runFetchPhase(props, startTime);
    } else if (phase === PHASE_BUILD) {
      runBuildPhase(props, startTime);
    } else if (phase === PHASE_BATCH_NEXT) {
      // 一括続き取得：次の作品を準備して取得開始（新しい実行枠で時間に余裕を持って）
      if (batchStartNext(props)) {
        runFetchPhase(props, startTime);
      } else {
        props.deleteProperty('BATCH_MODE');
        props.deleteProperty('BATCH_QUEUE');
        props.setProperty('PHASE', PHASE_DONE);
        deleteTrigger();
        Logger.log('一括続き取得：全作品完了。');
      }
    } else if (phase === PHASE_DONE) {
      Logger.log('既に完了済みです。トリガーを削除します。');
      deleteTrigger();
      clearRunState(props);
    } else {
      Logger.log('進捗データなし。トリガーを削除します。');
      deleteTrigger();
    }
  } finally {
    lock.releaseLock();
  }
}

// ==========================================
// 取得フェーズ（バッファ単位でまとめ書き）
// ==========================================
function runFetchPhase(props, startTime) {
  const token    = ScriptApp.getOAuthToken();
  const workId   = props.getProperty('WORK_ID');
  const episodes = JSON.parse(props.getProperty('EPISODES') || '[]');
  let nextIndex  = parseInt(props.getProperty('NEXT_INDEX') || '0');

  if (!workId || episodes.length === 0) {
    Logger.log('進捗データなし。トリガーを削除します。');
    deleteTrigger();
    return;
  }

  // 現在の nextIndex が属するバッファ単位で処理する。
  // 1話ごとに読み書きせず、当該バッファに対して「既存読み込み1回＋書き込み1回」に集約。
  while (nextIndex < episodes.length) {
    const bufIdx   = Math.floor(nextIndex / EPISODES_PER_BUFFER);
    const bufStart = bufIdx * EPISODES_PER_BUFFER;
    const bufEnd   = Math.min(bufStart + EPISODES_PER_BUFFER, episodes.length);
    const fileName = `__kakuyomu_buf_${workId}_${String(bufIdx).padStart(4, '0')}.txt`;

    // 既存バッファ（=このバッファの [bufStart, nextIndex) ぶん）を1回だけ読む
    let existing   = '';
    const existing0 = DriveApp.getFilesByName(fileName);
    if (existing0.hasNext()) {
      existing = existing0.next().getBlob().getDataAsString('UTF-8');
    }

    let appended = '';
    let i = nextIndex;
    let timedOut = false;

    for (; i < bufEnd; i++) {
      if (Date.now() - startTime > TIMEOUT_THRESHOLD_MS) { timedOut = true; break; }

      const ep = episodes[i];
      Logger.log(`取得中 (${i + 1}/${episodes.length}): ${ep.title}`);

      const epHtml = fetchHtml(ep.url);
      let epText = '（本文取得失敗）';
      if (epHtml) {
        const epNextData = extractNextData(epHtml);
        epText = epNextData
          ? extractEpisodeTextFromNextData(epNextData)
          : extractEpisodeTextFromHtml(epHtml);
      } else {
        Logger.log(`スキップ: ${ep.url}`);
      }

      appended += `\n\n■ ${ep.title}\n\n${epText}`;
      Utilities.sleep(FETCH_SLEEP_MS);
    }

    // このバッファ分をまとめて1回だけ書き込み
    if (appended) {
      writeBuffer(token, fileName, existing + appended);
    }
    nextIndex = i;
    props.setProperty('NEXT_INDEX', String(nextIndex));
    Logger.log(`バッファ ${bufIdx} 書込: 〜${nextIndex}/${episodes.length} 話`);

    if (timedOut) {
      Logger.log(`⏳ タイムアウト。次回は ${nextIndex + 1} 番目から再開。`);
      ensureTriggerAfter();
      return;
    }
  }

  const bufCount = Math.ceil(episodes.length / EPISODES_PER_BUFFER);
  const isCont   = props.getProperty('CONTINUATION') === '1';

  Logger.log('全エピソード取得完了。書き込み（挿入整形）フェーズへ移行します。');
  props.setProperties({
    PHASE:           PHASE_BUILD,
    BUF_COUNT:       String(bufCount),
    BUILD_BUF_INDEX: '0',
    BUILD_FOOTER_DONE: '',
  });
  if (!isCont) {
    props.setProperty('DOC_IDS', '[]'); // 続き取得時は startContinuation がセット済み
  }
  ensureTriggerAfter();
}

// ==========================================
// 書き込みフェーズ（Docs API で挿入しながら整形：BUILD）
//   ドキュメントを一切読み返さない。各バッファを1回の batchUpdate で
//   「挿入＋見出し＋太字＋フォント」まとめて適用する。
//   ■ は挿入前に取り除いて入れる（後から削除しない）ので、位置は
//   「挿入位置(cursor)＋文字オフセット」で正確（インデックスは加算のみ）。
//   cursor は Docs の挿入インデックス（= 末尾の手前）。挿入長ぶん加算する。
// ==========================================
function runBuildPhase(props, startTime) {
  const workId   = props.getProperty('WORK_ID');
  const title    = props.getProperty('TITLE');
  const bufCount = parseInt(props.getProperty('BUF_COUNT') || '0');
  const isCont   = props.getProperty('CONTINUATION') === '1';
  let bufIndex   = parseInt(props.getProperty('BUILD_BUF_INDEX') || '0');
  let cursor     = parseInt(props.getProperty('BUILD_CURSOR') || '0');
  let docId      = props.getProperty('BUILD_DOC_ID') || '';
  let docPart    = parseInt(props.getProperty('BUILD_DOC_PART') || '0');
  let docIds     = JSON.parse(props.getProperty('DOC_IDS') || '[]');

  const contLabel = isCont
    ? `（続き ${props.getProperty('CONT_FROM')}〜${props.getProperty('CONT_TO')}話）`
    : '';

  // 初回エントリ：対象ドキュメントと cursor を用意
  if (!docId) {
    if (isCont && docIds.length > 0) {
      const lastId     = docIds[docIds.length - 1];
      const lastCursor = parseInt(props.getProperty('CONT_LAST_CURSOR') || '0');
      if (lastCursor > 0 && docFileUsable(lastId) &&
          (lastCursor - 1) < MAX_DOC_CHARS) {
        docId   = lastId;          // 既存末尾ドキュメントへ追記
        cursor  = lastCursor;
        docPart = docIds.length - 1;
      }
    }
    if (!docId) {                  // 新規ドキュメント（ヘッダ＝見出し2）
      docPart = docIds.length;
      const created = createBuildDoc(title, docPart, contLabel);
      docId  = created.docId;
      cursor = created.cursor;
      docIds.push(docId);
    }
    persistBuild(props, bufIndex, cursor, docId, docPart, docIds);
  }

  Logger.log(`書き込みフェーズ: バッファ ${bufIndex + 1}/${bufCount} / cursor ${cursor}`);

  while (bufIndex < bufCount) {
    if (Date.now() - startTime > TIMEOUT_THRESHOLD_MS) {
      persistBuild(props, bufIndex, cursor, docId, docPart, docIds);
      ensureTriggerAfter();
      return;
    }

    const fileName = `__kakuyomu_buf_${workId}_${String(bufIndex).padStart(4, '0')}.txt`;
    const files = DriveApp.getFilesByName(fileName);
    if (!files.hasNext()) {
      Logger.log(`バッファ無し: ${fileName} スキップ`);
      bufIndex++;
      persistBuild(props, bufIndex, cursor, docId, docPart, docIds);
      continue;
    }
    const bufFile    = files.next();
    const bufContent = bufFile.getBlob().getDataAsString('UTF-8');
    const parsed     = parseBufferForBuild(bufContent);

    // 上限超過なら新ドキュメントへこぼす（バッファ先頭で判定）
    if ((cursor - 1) + parsed.clean.length > MAX_DOC_CHARS &&
        (cursor - 1) > HEADER_GUARD_CHARS) {
      docPart = docIds.length;
      const created = createBuildDoc(title, docPart, contLabel);
      docId  = created.docId;
      cursor = created.cursor;
      docIds.push(docId);
      persistBuild(props, bufIndex, cursor, docId, docPart, docIds);
      Logger.log(`上限到達。新ドキュメントへ（${docIds.length} 冊目）`);
    }

    insertCleanIntoDoc(docId, cursor, parsed);
    cursor += parsed.clean.length;

    try { bufFile.setTrashed(true); } catch(e) { Logger.log('バッファ削除失敗: ' + e); }
    bufIndex++;
    persistBuild(props, bufIndex, cursor, docId, docPart, docIds);
    Logger.log(`バッファ ${bufIndex}/${bufCount} 反映（cursor ${cursor}）`);
  }

  // 末尾に取得記録フッターを挿入（未挿入時のみ）
  if (props.getProperty('BUILD_FOOTER_DONE') !== '1') {
    const footer = '\n' + buildFooterLines(props).join('\n');
    insertFooterIntoDoc(docId, cursor, footer);
    cursor += footer.length;
    props.setProperties({ BUILD_FOOTER_DONE: '1', BUILD_CURSOR: String(cursor) });
  }

  finishRun(props, workId, docIds);
}

// バッファ本文を、■ を外したクリーンなテキストと見出し位置に分解する。
//   返り値: { clean, titles: [{offset, len}] }（offset/len はクリーン内の位置）
// バッファ本文を、■ を外し空行を除いたクリーンなテキストと見出し位置に分解する。
//   段落間は単一改行のみ（空段落を作らない）。余白の足し込みはしない。
//   返り値: { clean, titles: [{offset, len}] }（offset/len はクリーン内の位置）
function parseBufferForBuild(bufContent) {
  const lines  = bufContent.split('\n');
  let clean    = '';
  const titles = [];
  for (let k = 0; k < lines.length; k++) {
    let line = lines[k];
    const isTitle = (line.indexOf('■') === 0);
    if (isTitle) {
      let cut = 1;
      while (cut < line.length &&
             (line.charAt(cut) === ' ' || line.charAt(cut) === '\u3000')) {
        cut++;
      }
      line = line.substring(cut);
    } else {
      // 本文行：行頭に空白があれば全角1字下げに正規化
      //   （半角スペース等の字下げが半字に見える問題への対処）
      //   空白の無い行＝会話文などは字下げしないまま保つ。
      line = line.replace(/^[ \t\u3000\u00A0]+/, '\u3000');
    }
    if (line.length === 0) continue;          // 空行は段落として作らない
    if (clean.length > 0) clean += '\n';       // 段落間は単一改行
    const offset = clean.length;
    clean += line;
    if (isTitle) titles.push({ offset: offset, len: line.length });
  }
  return { clean: clean, titles: titles };
}

// クリーンテキストを挿入し、見出し3・太字・フォントを同一バッチで適用。
function insertCleanIntoDoc(docId, cursor, parsed) {
  const reqs = [];
  reqs.push({ insertText: { location: { index: cursor }, text: parsed.clean } });

  // 見出し3（段落スタイル）
  for (const t of parsed.titles) {
    const s = cursor + t.offset;
    reqs.push({
      updateParagraphStyle: {
        range: { startIndex: s, endIndex: s + t.len },
        paragraphStyle: { namedStyleType: 'HEADING_3' },
        fields: 'namedStyleType',
      }
    });
  }
  // 挿入範囲全体にフォント（標準ウェイト）
  reqs.push({
    updateTextStyle: {
      range: { startIndex: cursor, endIndex: cursor + parsed.clean.length },
      textStyle: { weightedFontFamily: { fontFamily: FONT_FAMILY } },
      fields: 'weightedFontFamily',
    }
  });
  // 見出しは太字＋ウェイト700で上書き
  for (const t of parsed.titles) {
    const s = cursor + t.offset;
    reqs.push({
      updateTextStyle: {
        range: { startIndex: s, endIndex: s + t.len },
        textStyle: { bold: true, weightedFontFamily: { fontFamily: FONT_FAMILY, weight: 700 } },
        fields: 'bold,weightedFontFamily',
      }
    });
  }
  docsBatch(docId, reqs);
}

// フッターを末尾に挿入（フォントのみ適用）。
function insertFooterIntoDoc(docId, cursor, footer) {
  Docs.Documents.batchUpdate({
    requests: [
      { insertText: { location: { index: cursor }, text: footer } },
      {
        updateTextStyle: {
          range: { startIndex: cursor, endIndex: cursor + footer.length },
          textStyle: { weightedFontFamily: { fontFamily: FONT_FAMILY } },
          fields: 'weightedFontFamily',
        }
      },
    ]
  }, docId);
}

// 新規ドキュメントをフォルダ内に作成し、1行目（タイトル＝見出し2）を入れる。
//   返り値: { docId, cursor }（cursor は次の挿入位置）
function createBuildDoc(title, docPart, contLabel) {
  const base = `【カクヨム】${title}${contLabel}`;
  const name = docPart > 0 ? `${base}（${docPart + 1}）` : base;

  const created = Docs.Documents.create({ title: name });
  const docId   = created.documentId;
  try {
    DriveApp.getFileById(docId).moveTo(DriveApp.getFolderById(getTargetFolderId()));
  } catch(e) { Logger.log('新ドキュメントのフォルダ移動失敗: ' + e); }

  const headerText = name + '\n';
  Docs.Documents.batchUpdate({
    requests: [
      { insertText: { location: { index: 1 }, text: headerText } },
      {
        updateParagraphStyle: {
          range: { startIndex: 1, endIndex: 1 + name.length },
          paragraphStyle: { namedStyleType: 'HEADING_2' },
          fields: 'namedStyleType',
        }
      },
      {
        updateTextStyle: {
          range: { startIndex: 1, endIndex: 1 + name.length },
          textStyle: { bold: true, weightedFontFamily: { fontFamily: FONT_FAMILY, weight: 700 } },
          fields: 'bold,weightedFontFamily',
        }
      },
    ]
  }, docId);

  return { docId: docId, cursor: 1 + headerText.length };
}

function docFileUsable(id) {
  try { return !DriveApp.getFileById(id).isTrashed(); } catch(e) { return false; }
}

function docsBatch(docId, requests) {
  const CHUNK = 500;
  for (let i = 0; i < requests.length; i += CHUNK) {
    Docs.Documents.batchUpdate({ requests: requests.slice(i, i + CHUNK) }, docId);
  }
}

function persistBuild(props, bufIndex, cursor, docId, docPart, docIds) {
  props.setProperties({
    BUILD_BUF_INDEX: String(bufIndex),
    BUILD_CURSOR:    String(cursor),
    BUILD_DOC_ID:    docId,
    BUILD_DOC_PART:  String(docPart),
    DOC_IDS:         JSON.stringify(docIds),
  });
}

// ==========================================
// 完了処理（初回・続き取得で共通）
//   バッファ掃除 → 記録(RESUME)更新 → 索引更新 → run状態クリア。
//   記録には docIds と末尾 cursor を残し、次回の続き取得の追記起点にする。
// ==========================================
function finishRun(props, workId, docIds) {
  if (workId) cleanupBufferFiles(workId);

  const total = props.getProperty('EPISODE_TOTAL');
  if (workId && total) {
    saveResumeRecord(workId, {
      title:         props.getProperty('TITLE')      || '',
      url:           props.getProperty('SOURCE_URL') || '',
      total:         Number(total),
      lastEpisodeId: props.getProperty('LAST_EPISODE_ID') || '',
      docIds:        docIds || [],
      lastCursor:    parseInt(props.getProperty('BUILD_CURSOR') || '0'),
      updatedAt:     Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm'),
    });
    Logger.log(`続き取得記録を更新: ${total} 話 / ${(docIds || []).length} 冊`);
  }

  try { updateIndexFile(); } catch(e) { Logger.log('索引更新エラー: ' + e); }

  const finalDocIds = docIds || [];
  Logger.log('✅ 作品完了！');
  finalDocIds.forEach((id, i) => {
    Logger.log(`ドキュメント ${i + 1}: https://docs.google.com/document/d/${id}`);
  });

  clearRunState(props); // この作品の run 状態のみ消す（RESUME と BATCH_* は保持）

  // 一括続き取得中なら次の作品へ（準備は次回実行枠で行う＝時間に余裕）
  if (props.getProperty('BATCH_MODE') === '1') {
    const queue = JSON.parse(props.getProperty('BATCH_QUEUE') || '[]');
    if (queue.length > 0) {
      props.setProperty('PHASE', PHASE_BATCH_NEXT);
      ensureTriggerAfter();
      Logger.log(`次の作品へ（残り ${queue.length} 作品）。`);
      return;
    }
    props.deleteProperty('BATCH_MODE');
    props.deleteProperty('BATCH_QUEUE');
    Logger.log('一括続き取得：全作品完了。');
  }

  props.setProperty('PHASE', PHASE_DONE);
  deleteTrigger();
  Logger.log('✅ すべて完了！');
}

// ==========================================
// 索引ファイルの更新（フォルダ内に1つ、全作品の一覧）
//   全 RESUME 記録から再生成。IDは INDEX_DOC_ID に保持して同じファイルを更新。
// ==========================================
function updateIndexFile() {
  const props = PropertiesService.getScriptProperties();
  const all   = props.getProperties();
  const keys  = Object.keys(all).filter(k => k.indexOf('RESUME_') === 0);

  let indexId = all['INDEX_DOC_ID'];
  let doc = null;
  if (indexId) {
    try {
      if (!DriveApp.getFileById(indexId).isTrashed()) doc = DocumentApp.openById(indexId);
    } catch(e) { doc = null; }
  }
  if (!doc) {
    doc = DocumentApp.create(INDEX_DOC_NAME);
    try {
      DriveApp.getFileById(doc.getId()).moveTo(DriveApp.getFolderById(getTargetFolderId()));
    } catch(e) { Logger.log('索引のフォルダ移動失敗: ' + e); }
    indexId = doc.getId();
    props.setProperty('INDEX_DOC_ID', indexId);
  }

  const body = doc.getBody();
  body.clear();
  body.appendParagraph(INDEX_DOC_NAME).setHeading(DocumentApp.ParagraphHeading.HEADING1);
  body.appendParagraph(`更新: ${Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm')} / ${keys.length} 作品`);

  const records = keys.map(k => {
    let r; try { r = JSON.parse(all[k]); } catch(e) { r = {}; }
    r._workId = k.replace('RESUME_', '');
    return r;
  }).sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));

  records.forEach(r => {
    body.appendParagraph(r.title || '(無題)').setHeading(DocumentApp.ParagraphHeading.HEADING2);
    body.appendParagraph(`話数: ${r.total != null ? r.total : '?'} 話　更新: ${r.updatedAt || ''}`);
    if (r.url) {
      const up = body.appendParagraph('');
      up.appendText(r.url).setLinkUrl(r.url);
    }
    const docIds = r.docIds || [];
    docIds.forEach((id, i) => {
      const link  = `https://docs.google.com/document/d/${id}`;
      const label = docIds.length > 1 ? `ドキュメント ${i + 1}` : 'ドキュメント';
      const lp = body.appendParagraph('');
      lp.appendText(label).setLinkUrl(link);
    });
    body.appendParagraph('');
  });

  doc.saveAndClose();
  Logger.log(`索引を更新: ${records.length} 作品 → https://docs.google.com/document/d/${indexId}`);
}

// ==========================================
// ファイル内容を上書き（Drive API方式）
// ==========================================
function writeFileContent(token, fileId, content) {
  const url = `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`;
  const res = UrlFetchApp.fetch(url, {
    method:  'PATCH',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type':  'text/plain; charset=utf-8',
    },
    payload:            Utilities.newBlob(content, MimeType.PLAIN_TEXT).getBytes(),
    muteHttpExceptions: true,
  });

  if (res.getResponseCode() !== 200) {
    Logger.log(`writeFileContent エラー: ${res.getResponseCode()} / ${res.getContentText()}`);
  }
}

// 名前指定でバッファを上書き（無ければフォルダ内に新規作成）
function writeBuffer(token, fileName, content) {
  const files = DriveApp.getFilesByName(fileName);
  if (files.hasNext()) {
    writeFileContent(token, files.next().getId(), content);
  } else {
    DriveApp.getFolderById(getTargetFolderId())
      .createFile(fileName, content, MimeType.PLAIN_TEXT);
    Logger.log(`バッファファイル作成: ${fileName}`);
  }
}

// ==========================================
// エピソード一覧収集（ページネーション対応）
// ==========================================
function collectAllEpisodes(topHtml, nextData, workId) {
  if (nextData) {
    const episodes = extractEpisodesFromNextData(nextData, workId);
    if (episodes.length > 0) return fetchPaginatedEpisodes(workId, episodes);
  }
  return fetchEpisodesFromToc(workId);
}

function fetchPaginatedEpisodes(workId, baseEpisodes) {
  const allEpisodes = [...baseEpisodes];
  const seenIds     = new Set(baseEpisodes.map(e => e.id));
  let page = 2;

  while (true) {
    const html = fetchHtml(`https://kakuyomu.jp/works/${workId}?page=${page}`);
    if (!html) break;

    const nd = extractNextData(html);
    if (!nd) break;

    const pageEpisodes = extractEpisodesFromNextData(nd, workId);
    if (pageEpisodes.length === 0) break;

    let added = 0;
    for (const ep of pageEpisodes) {
      if (!seenIds.has(ep.id)) {
        allEpisodes.push(ep);
        seenIds.add(ep.id);
        added++;
      }
    }

    Logger.log(`ページ ${page}: ${added} 件追加`);
    if (added === 0) break;
    page++;
    Utilities.sleep(800);
  }

  return allEpisodes;
}

function fetchEpisodesFromToc(workId) {
  const episodes = [];
  const seenIds  = new Set();
  let page = 1;

  while (true) {
    const url  = page === 1
      ? `https://kakuyomu.jp/works/${workId}`
      : `https://kakuyomu.jp/works/${workId}?page=${page}`;
    const html = fetchHtml(url);
    if (!html) break;

    const re = new RegExp(`href="(/works/${workId}/episodes/(\\d+))"`, 'g');
    let m;
    let found = 0;
    while ((m = re.exec(html)) !== null) {
      const epId = m[2];
      if (!seenIds.has(epId)) {
        const titleMatch = html.slice(m.index, m.index + 300)
          .match(/class="[^"]*titleLabel[^"]*"[^>]*>([^<]+)</);
        episodes.push({
          id:    epId,
          title: titleMatch ? titleMatch[1].trim() : `エピソード ${epId}`,
          url:   `https://kakuyomu.jp${m[1]}`
        });
        seenIds.add(epId);
        found++;
      }
    }

    Logger.log(`TOCページ ${page}: ${found} 件`);
    if (found === 0) break;
    if (!html.includes(`page=${page + 1}`)) break;
    page++;
    Utilities.sleep(800);
  }

  return episodes;
}

// ==========================================
// タイトル取得（5パターン対応）
// ==========================================
function extractTitle(html, nextData, workId) {
  try {
    const apollo = nextData.props.pageProps.__APOLLO_STATE__;
    if (apollo) {
      if (apollo[`Work:${workId}`]?.title) return apollo[`Work:${workId}`].title;
      const wk = Object.keys(apollo).find(k => k.startsWith('Work:') && apollo[k].title);
      if (wk) return apollo[wk].title;
    }
  } catch(e) {}

  try {
    const t = nextData?.props?.pageProps?.work?.title;
    if (t) return t;
  } catch(e) {}

  try {
    const t = nextData?.props?.pageProps?.workTitle;
    if (t) return t;
  } catch(e) {}

  const ogTitle = html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/);
  if (ogTitle) return ogTitle[1].replace(/\s*[|\-－–—]\s*カクヨム.*$/i, '').trim();

  const titleTag = html.match(/<title[^>]*>([^<]+)<\/title>/);
  if (titleTag) return titleTag[1].split(/[|\-－–—]/)[0].trim();

  return '不明なタイトル';
}

// ==========================================
// __NEXT_DATA__ 系
// ==========================================
function extractNextData(html) {
  const m = html.match(/<script[^>]+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch(e) { return null; }
}

function extractEpisodesFromNextData(nextData, workId) {
  const episodes = [];
  try {
    const apollo = nextData.props.pageProps.__APOLLO_STATE__;
    if (!apollo) return episodes;

    Object.keys(apollo)
      .filter(k => k.startsWith('Episode:') && apollo[k].title)
      .sort((a, b) => (apollo[a].publishedAt || '').localeCompare(apollo[b].publishedAt || ''))
      .forEach(key => {
        const epId = key.replace('Episode:', '');
        episodes.push({
          id:    epId,
          title: apollo[key].title,
          url:   `https://kakuyomu.jp/works/${workId}/episodes/${epId}`
        });
      });
  } catch(e) { Logger.log('エピソード抽出エラー: ' + e); }
  return episodes;
}

function extractEpisodeTextFromNextData(nextData) {
  try {
    const apollo = nextData.props.pageProps.__APOLLO_STATE__;
    if (apollo) {
      const key = Object.keys(apollo).find(k => k.startsWith('Episode:') && apollo[k].body);
      if (key) return stripHtmlTags(apollo[key].body);
    }
    const body = nextData?.props?.pageProps?.episode?.body;
    if (body) return stripHtmlTags(body);
  } catch(e) {}
  return '（本文取得失敗）';
}

function extractEpisodeTextFromHtml(html) {
  const patterns = [
    /<div[^>]+class="[^"]*widget-episodeBody[^"]*"[^>]*>([\s\S]*?)<\/div>/,
    /<div[^>]+class="[^"]*js-episode-body[^"]*"[^>]*>([\s\S]*?)<\/div>/,
    /<div[^>]+id="episodeBody"[^>]*>([\s\S]*?)<\/div>/,
  ];
  for (const p of patterns) {
    const m = html.match(p);
    if (m) return stripHtmlTags(m[1]);
  }
  return '（本文取得失敗）';
}

// ==========================================
// HTMLタグ除去 + 空行正規化
// ==========================================
function stripHtmlTags(html) {
  let text = html
    .replace(/<p[^>]*>([\s\S]*?)<\/p>/g, '$1\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, '\u3000')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, c) => String.fromCharCode(parseInt(c)));

  text = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
  text = text.replace(/[\uD800-\uDFFF]/g, '');
  text = text.replace(/\uFFFD/g, '');
  text = text.replace(/\n{3,}/g, '\n\n');
  text = text.replace(/^[\u3000\s]+$/gm, '');
  text = text.replace(/\n{3,}/g, '\n\n');

  return text.trim();
}

// ==========================================
// トリガー管理（処理完了後に単発登録）
// ==========================================
function ensureTriggerAfter() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'continuesFetch')
    .forEach(t => ScriptApp.deleteTrigger(t));

  ScriptApp.newTrigger('continuesFetch')
    .timeBased()
    .after(RETRIGGER_DELAY_MS)
    .create();

  Logger.log(`トリガー登録完了（約 ${Math.round(RETRIGGER_DELAY_MS / 1000)} 秒後に実行）`);
}

function deleteTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'continuesFetch')
    .forEach(t => ScriptApp.deleteTrigger(t));
  Logger.log('トリガー削除完了');
}

// ==========================================
// 共通ユーティリティ
// ==========================================
function extractWorkId(url) {
  const m = url.match(/kakuyomu\.jp\/works\/(\d+)/);
  return m ? m[1] : null;
}

function fetchHtml(url) {
  try {
    const res = UrlFetchApp.fetch(url, {
      muteHttpExceptions: true,
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    if (res.getResponseCode() !== 200) {
      Logger.log(`HTTPエラー: ${res.getResponseCode()} (${url})`);
      return null;
    }
    return res.getContentText('UTF-8');
  } catch(e) {
    Logger.log(`取得失敗: ${url} / ${e}`);
    return null;
  }
}

// ==========================================
// デバッグ用
// ==========================================
function checkProgress() {
  const props  = PropertiesService.getScriptProperties();
  const all    = props.getProperties();
  const eps    = JSON.parse(all.EPISODES || '[]');
  const docIds = JSON.parse(all.DOC_IDS  || '[]');
  Logger.log(`タイトル:          ${all.TITLE}`);
  Logger.log(`PHASE:             ${all.PHASE}`);
  Logger.log(`NEXT_INDEX:        ${all.NEXT_INDEX} / ${eps.length}`);
  Logger.log(`BUF_COUNT:         ${all.BUF_COUNT}`);
  Logger.log(`BUILD_BUF_INDEX:   ${all.BUILD_BUF_INDEX} / ${all.BUF_COUNT}`);
  Logger.log(`BUILD_CURSOR:      ${all.BUILD_CURSOR}`);
  Logger.log(`BUILD_DOC_PART:    ${all.BUILD_DOC_PART} （${docIds.length} 冊目）`);
  Logger.log(`BUILD_FOOTER_DONE: ${all.BUILD_FOOTER_DONE}`);
  Logger.log(`DOC_IDS:           ${all.DOC_IDS}`);
  Logger.log(`BATCH_MODE:        ${all.BATCH_MODE}`);
  Logger.log(`BATCH_QUEUE:       ${all.BATCH_QUEUE}`);
}

function checkBufferContent() {
  const props    = PropertiesService.getScriptProperties();
  const workId   = props.getProperty('WORK_ID');
  const fileName = `__kakuyomu_buf_${workId}_0000.txt`;
  const files    = DriveApp.getFilesByName(fileName);
  if (!files.hasNext()) {
    Logger.log(`先頭バッファが見つかりません: ${fileName}`);
    return;
  }
  const file    = files.next();
  const blob    = file.getBlob();
  const content = blob.getDataAsString('UTF-8');

  const nullCount      = (content.match(/\x00/g) || []).length;
  const ctrlCount      = (content.match(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g) || []).length;
  const surrogateCount = (content.match(/[\uD800-\uDFFF]/g) || []).length;

  Logger.log(`NULLバイト数:     ${nullCount}`);
  Logger.log(`制御文字数:       ${ctrlCount}`);
  Logger.log(`不正サロゲート数: ${surrogateCount}`);
  Logger.log(`文字数:           ${content.length}`);
  Logger.log(`バイトサイズ:     ${blob.getBytes().length}`);
  Logger.log(`冒頭プレビュー:   ${content.substring(0, 200)}`);
}

function cleanupBufferFiles(workId) {
  let deleted = 0;

  const epFiles = DriveApp.searchFiles(`title contains '__kakuyomu_buf_${workId}_'`);
  while (epFiles.hasNext()) {
    try { epFiles.next().setTrashed(true); deleted++; } catch(e) {}
  }

  const mergedFiles = DriveApp.searchFiles(`title contains '__kakuyomu_merged_${workId}'`);
  while (mergedFiles.hasNext()) {
    try { mergedFiles.next().setTrashed(true); deleted++; } catch(e) {}
  }

  Logger.log(`バッファファイル削除: ${deleted} 件`);
}

function resetAll() {
  const props  = PropertiesService.getScriptProperties();
  const workId = props.getProperty('WORK_ID');

  deleteTrigger();

  if (workId) {
    cleanupBufferFiles(workId);
  }

  clearRunState(props); // run状態のみ消す。続き取得記録(RESUME)は残す
  props.deleteProperty('BATCH_MODE');
  props.deleteProperty('BATCH_QUEUE');
  Logger.log('リセット完了（途中状態を消去）。startFetch / startContinuation を再実行してください。');
  Logger.log('※ 続き取得記録は保持しています。記録も消すなら clearResumeRecord を実行してください。');
}