// ==========================================
// 操作パネル（索引とは別のスプレッドシート）
//   スクリプトを直接編集せず、パラメータをセルに入力してメニューから実行できるようにする。
//   誤操作防止のため、チェックボックス等の onEdit 発火ではなく、
//   カスタムメニューのクリック（明示操作）でのみ実行される。
//
//   setupControlPanel を一度だけ実行するとファイルが作成され、
//   以後そのファイルを開くとメニュー「カクヨム操作」が表示される。
//
//   Kakuyomu_to_docs.js と同一 GAS プロジェクト内のファイルであり、
//   GAS は複数ファイルを1つのグローバルスコープとして実行するため、
//   import/export は不要（Kakuyomu_to_docs.js 側の関数・定数をそのまま参照できる）。
//   逆に finishRun（Kakuyomu_to_docs.js）は完了通知のため writePanelStatus_ を
//   直接呼んでおり、コア側からこのファイルへの依存が一部ある点に注意。
// ==========================================

const CONTROL_PANEL_FILE_NAME  = '【操作パネル】カクヨム取得コンソール';
const CONTROL_PANEL_SHEET_NAME = '操作パネル';
const PANEL_CELL_URL           = 'B4'; // 作品URL
const PANEL_CELL_START_EPISODE = 'B5'; // 開始話数（初回取得のみ）
const PANEL_CELL_END_EPISODE   = 'B6'; // 終了話数（初回取得のみ）
const PANEL_CELL_DOC_IDS       = 'B7'; // 既存ドキュメントID（追加時のみ・カンマ区切り）
const PANEL_CELL_STATUS        = 'B12'; // 実行結果の書き戻し先

// 操作パネルのスプレッドシートを開く（見つからなければ null）。
//   findOrLocateSpreadsheet_ は Kakuyomu_to_docs.js 側で定義（索引シートと共通のヘルパー）。
function findControlPanelSheet_() {
  return findOrLocateSpreadsheet_('CONTROL_PANEL_SHEET_ID', CONTROL_PANEL_FILE_NAME);
}

// 操作パネルを作成/更新する（初回のみ実行。レイアウトを直した時の再実行も可）。
function setupControlPanel() {
  let ss = findControlPanelSheet_();
  if (!ss) {
    ss = SpreadsheetApp.create(CONTROL_PANEL_FILE_NAME);
    try { DriveApp.getFileById(ss.getId()).moveTo(DriveApp.getFolderById(getTargetFolderId())); }
    catch(e) { Logger.log('操作パネルのフォルダ移動失敗: ' + e); }
    PropertiesService.getScriptProperties().setProperty('CONTROL_PANEL_SHEET_ID', ss.getId());
  }

  const sheet = ss.getSheets()[0];
  sheet.setName(CONTROL_PANEL_SHEET_NAME);
  sheet.clear();

  const rows = [
    ['カクヨム取得コンソール', ''],
    ['', ''],
    ['パラメータ', ''],
    ['作品URL', ''],
    ['開始話数（初回取得のみ・空欄=1）', ''],
    ['終了話数（初回取得のみ・空欄=無制限）', ''],
    ['既存ドキュメントID（任意・追加時のみ・カンマ区切り）', ''],
    ['', ''],
    ['実行は上部メニュー「カクヨム操作」から行ってください。', ''],
    ['', ''],
    ['ステータス', ''],
    ['最終実行', '(未実行)'],
  ];
  sheet.getRange(1, 1, rows.length, 2).setValues(rows);
  sheet.getRange(1, 1).setFontWeight('bold').setFontSize(14);
  sheet.getRange(3, 1).setFontWeight('bold');
  sheet.getRange(11, 1).setFontWeight('bold');
  sheet.getRange(PANEL_CELL_STATUS).setWrap(true);
  sheet.setColumnWidth(1, 360);
  sheet.setColumnWidth(2, 420);

  // 同じハンドラの古いトリガーが残っていれば削除してから登録し直す（重複実行防止）
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'onPanelOpen') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('onPanelOpen').forSpreadsheet(ss.getId()).onOpen().create();

  Logger.log(`操作パネルを作成/更新しました: ${ss.getUrl()}`);
  Logger.log('このファイルを開き直すと「カクヨム操作」メニューが表示されます。');
}

// 操作パネルを開いたときに呼ばれる（installable onOpen トリガー。setupControlPanel が登録）
function onPanelOpen(e) {
  SpreadsheetApp.getUi()
    .createMenu('カクヨム操作')
    .addItem('初回取得を実行', 'panelRunStartFetch')
    .addItem('続き取得を実行', 'panelRunStartContinuation')
    .addItem('一括続き取得を実行', 'panelRunStartContinuationAll')
    .addSeparator()
    .addItem('一覧に追加（現在地を記録）', 'panelRunSeedResumeRecord')
    .addItem('一覧から削除', 'panelRunClearResumeRecord')
    .addItem('索引シートと差分同期', 'panelRunSyncFromSheet')
    .addSeparator()
    .addItem('進捗・順番待ちを確認', 'panelRunCheckProgress')
    .addItem('順番待ちをクリア', 'panelRunClearQueue')
    .addItem('索引を再生成', 'panelRunRebuildIndex')
    .addSeparator()
    .addItem('ファイル名短縮: ON/OFF切り替え', 'panelRunToggleShortFilename')
    .addToUi();
}

// パネルのシートオブジェクトを取得（見つからなければ null）
function getPanelSheet_() {
  const ss = findControlPanelSheet_();
  if (!ss) return null;
  return ss.getSheetByName(CONTROL_PANEL_SHEET_NAME) || ss.getSheets()[0];
}

// パネルのパラメータ欄を読み取る
function getPanelInputs_(sheet) {
  return {
    url:          String(sheet.getRange(PANEL_CELL_URL).getValue() || '').trim(),
    startEpisode: sheet.getRange(PANEL_CELL_START_EPISODE).getValue(),
    endEpisode:   sheet.getRange(PANEL_CELL_END_EPISODE).getValue(),
    docIds:       String(sheet.getRange(PANEL_CELL_DOC_IDS).getValue() || '')
                    .split(',').map(s => s.trim()).filter(s => s),
  };
}

// パネルのステータス欄に結果を書き戻す（パネル未作成時は何もしない）
function writePanelStatus_(message) {
  try {
    const sheet = getPanelSheet_();
    if (!sheet) return;
    const stamp = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss');
    sheet.getRange(PANEL_CELL_STATUS).setValue(`[${stamp}] ${message}`);
  } catch(e) { Logger.log('操作パネルへのステータス書き込み失敗: ' + e); }
}

// 進捗確認の要約（パネル用の簡潔版。詳細は checkProgress の実行ログを参照）
function buildPanelProgressSummary_() {
  const props = PropertiesService.getScriptProperties();
  const all   = props.getProperties();
  const queueLine = describeQueue_(props);

  if (!all.PHASE || all.PHASE === PHASE_DONE) {
    return `実行中の処理はありません。\n${queueLine}`;
  }
  if (all.PHASE === PHASE_BATCH_NEXT) {
    return `1作品完了。次の作品の準備中です（次回トリガーで再開、最大1分程度）。\n${queueLine}`;
  }
  const eps = JSON.parse(all.EPISODES || '[]');
  const running = [
    `実行中: ${all.TITLE || '(不明)'}`,
    `フェーズ: ${all.PHASE}`,
    `進捗: ${all.NEXT_INDEX || '0'} / ${eps.length} 話`,
  ].join(' / ');
  return `${running}\n${queueLine}`;
}

// ---- 以下、パネルのメニューから呼ばれるハンドラ ----

function panelRunStartFetch() {
  const sheet = getPanelSheet_();
  if (!sheet) return;
  const input = getPanelInputs_(sheet);
  if (!input.url) { writePanelStatus_('エラー: 作品URLを入力してください。'); return; }

  const props   = PropertiesService.getScriptProperties();
  const wasBusy = isRunActive_(props);

  const ui = SpreadsheetApp.getUi();
  const res = ui.alert('初回取得の確認',
    `この作品を初回取得します。取得済みの場合は重複保存される可能性があります。\n\n${input.url}\n\n` +
    (wasBusy ? '※ 現在ほかの取得が実行中のため、順番待ちに追加されます。\n\n' : '') +
    '実行しますか？',
    ui.ButtonSet.YES_NO);
  if (res !== ui.Button.YES) { writePanelStatus_('キャンセルしました（初回取得）。'); return; }

  try {
    startFetch(input.url, input.startEpisode, input.endEpisode);
    writePanelStatus_(wasBusy
      ? `実行中の取得があるため、キューに追加しました（順番待ちに入りました）。\n${input.url}\n${describeQueue_(props)}`
      : `初回取得を開始しました。進捗は「進捗確認」から確認してください。\n${input.url}`);
  } catch(e) { writePanelStatus_('エラー: ' + e); }
}

function panelRunStartContinuation() {
  const sheet = getPanelSheet_();
  if (!sheet) return;
  const input = getPanelInputs_(sheet);
  if (!input.url) { writePanelStatus_('エラー: 作品URLを入力してください。'); return; }

  const props = PropertiesService.getScriptProperties();
  const wasBusy = isRunActive_(props);
  try {
    startContinuation(input.url);
    writePanelStatus_(wasBusy
      ? `実行中の取得があるため、キューに追加しました（順番待ちに入りました）。\n${input.url}\n${describeQueue_(props)}`
      : `続き取得を開始しました。進捗は「進捗確認」から確認してください。\n${input.url}`);
  } catch(e) { writePanelStatus_('エラー: ' + e); }
}

function panelRunStartContinuationAll() {
  const props   = PropertiesService.getScriptProperties();
  const wasBusy = isRunActive_(props);

  const ui = SpreadsheetApp.getUi();
  const res = ui.alert('一括続き取得の確認',
    '続き取得の一覧にある全作品を順番に処理します。\n\n' +
    (wasBusy ? '※ 現在ほかの取得が実行中のため、順番待ちの末尾に追加されます。\n\n' : '') +
    '実行しますか？',
    ui.ButtonSet.YES_NO);
  if (res !== ui.Button.YES) { writePanelStatus_('キャンセルしました（一括続き取得）。'); return; }

  try {
    startContinuationAll();
    writePanelStatus_(wasBusy
      ? `実行中の取得があるため、全作品をキューに追加しました。\n${describeQueue_(props)}`
      : '一括続き取得を開始しました。進捗は「進捗確認」から確認してください。');
  } catch(e) { writePanelStatus_('エラー: ' + e); }
}

function panelRunSeedResumeRecord() {
  const sheet = getPanelSheet_();
  if (!sheet) return;
  const input = getPanelInputs_(sheet);
  if (!input.url) { writePanelStatus_('エラー: 作品URLを入力してください。'); return; }

  try {
    seedResumeRecord(input.url, input.docIds);
    writePanelStatus_(`一覧に追加しました。\n${input.url}`);
  } catch(e) { writePanelStatus_('エラー: ' + e); }
}

function panelRunClearResumeRecord() {
  const sheet = getPanelSheet_();
  if (!sheet) return;
  const input = getPanelInputs_(sheet);
  if (!input.url) { writePanelStatus_('エラー: 作品URLを入力してください。'); return; }

  const ui = SpreadsheetApp.getUi();
  const res = ui.alert('削除の確認',
    `続き取得の一覧からこの作品を外します（取得済みドキュメント自体は削除されません）。\n\n${input.url}\n\n実行しますか？`,
    ui.ButtonSet.YES_NO);
  if (res !== ui.Button.YES) { writePanelStatus_('キャンセルしました（削除）。'); return; }

  try {
    clearResumeRecord(input.url);
    writePanelStatus_(`一覧から削除しました。\n${input.url}`);
  } catch(e) { writePanelStatus_('エラー: ' + e); }
}

function panelRunSyncFromSheet() {
  try {
    syncResumeRecordsFromSheet();
    writePanelStatus_('索引シートと差分同期しました（詳細は実行ログを確認してください）。');
  } catch(e) { writePanelStatus_('エラー: ' + e); }
}

function panelRunCheckProgress() {
  try {
    writePanelStatus_(buildPanelProgressSummary_());
  } catch(e) { writePanelStatus_('エラー: ' + e); }
}

// 順番待ちだけを取り消す（実行中の取得はそのまま続行させる）
function panelRunClearQueue() {
  const props = PropertiesService.getScriptProperties();
  const queue = JSON.parse(props.getProperty('BATCH_QUEUE') || '[]');
  if (queue.length === 0) { writePanelStatus_('順番待ちはありません。'); return; }

  const ui = SpreadsheetApp.getUi();
  const res = ui.alert('順番待ちのクリア',
    `順番待ち ${queue.length} 件を取り消します（実行中の取得はそのまま続行します）。実行しますか？`,
    ui.ButtonSet.YES_NO);
  if (res !== ui.Button.YES) { writePanelStatus_('キャンセルしました（順番待ちのクリア）。'); return; }

  props.setProperty('BATCH_QUEUE', '[]');
  if (!isRunActive_(props)) props.deleteProperty('BATCH_MODE');
  writePanelStatus_(`順番待ち ${queue.length} 件を取り消しました。`);
}

function panelRunRebuildIndex() {
  try {
    rebuildIndex();
    writePanelStatus_('索引を再生成しました。');
  } catch(e) { writePanelStatus_('エラー: ' + e); }
}

// ファイル名短縮（新規ドキュメント作成時、Driveのファイル名にのみ適用）のON/OFFを切り替える。
//   本文見出し・記録・索引には影響しない。デフォルトはON（プロパティ未設定=ON）。
function panelRunToggleShortFilename() {
  try {
    const props = PropertiesService.getScriptProperties();
    const next  = isShortFilenameEnabled_() ? '0' : '1';
    props.setProperty('SHORT_FILENAME', next);
    writePanelStatus_(`ファイル名短縮を${next === '1' ? 'ON' : 'OFF'}にしました。次に作成される新規ドキュメントから反映されます。`);
  } catch(e) { writePanelStatus_('エラー: ' + e); }
}
