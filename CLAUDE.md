# カクヨム → Google ドキュメント保存パイプライン

Google Apps Script (GAS) 製。カクヨムの小説を全話取得し、整形済みの Google ドキュメントとして保存する。続き取得・一括更新・索引スプレッドシート生成まで自動化している。

## ファイル構成

このリポジトリでは `kaku_scraping/src/` 以下に GAS プロジェクト(KAKU_SCRAPING)を clasp で同期している。

- `kaku_scraping/src/Kakuyomu_to_docs.js` … 本体(単一ファイル)
- `kaku_scraping/src/appsscript.json` … マニフェスト(Docs API 有効化・OAuthスコープ)
- `kaku_scraping/src/Reformat_existing_docs.js` … 独立ツール。既存ドキュメントに現在の書式だけを再適用する

## 実行環境と制約(最重要)

- **無料 Gmail アカウント**の GAS。実行時間上限 6 分。`TIMEOUT_THRESHOLD_MS = 5分` で自主中断し、時間駆動トリガーで再開する多段実行方式。
- **メモリ制約が最大の敵**。本作品は 1 ドキュメント最大 90 万字・数万段落になる。以下は全て OOM で失敗済みの経路なので**絶対に戻さないこと**:
  - `DocumentApp.openById()` で巨大ドキュメントを開いて段落走査(~1.7万段落で OOM)
  - `Docs.Documents.get` で**本文テキストを含む**取得(fields に `elements(textRun(content))` を含めると OOM)
  - Drive テキストエクスポートで全文取得して段落と突き合わせる方式(エクスポートは非空段落の後に空行を足すため、段落数と行数が 1:1.5 でズレて対応付け不能。29080 段落 → 43620 行の実績)
- **安全な読み出しは「終端インデックスのみ」の軽量取得だけ**: `Docs.Documents.get(docId, {fields:'body.content(endIndex)'})`(`getDocEndCursor` が該当)。段落位置＋見出し種別のみ(`Reformat_existing_docs.js` の方式)もテキストを含まないので安全。
- 書き込みは**読み返さない挿入方式(BUILD)**: 挿入テキストと整形(見出し/太字/フォント/行間/余白)を同一 `batchUpdate` で適用。インデックスは「挿入位置 + 文字オフセット」の加算のみで決まる(■ は挿入前に除去し、削除リクエストを出さない)。
- Docs API のインデックスは **UTF-16 コード単位**(JS の `.length` と一致)。cursor 加算はこれを前提にしている。
- **ユーザーは読了した内容をドキュメント先頭側から削除して上書き保存する運用**。そのため保存済み cursor は信用できない。追記位置・再開位置は**毎回 `getDocEndCursor` で実ファイルの終端を読み直す**(実装済み。この前提を崩さない)。
- Apps Script の `replaceText` は RE2 のため `　` 等の `\uXXXX` 表記が使えない("Invalid regular expression pattern")。■ 除去は文字位置ベースで行う。通常の JS 正規表現(`String.replace`)は問題ない。
- `DriveApp.getFilesByName` / `searchFiles` はドライブ全体検索で遅い。**必ずフォルダ限定**(`findFileInFolder` / `getTargetFolder().searchFiles`)を使う。
- 保存先は**スクリプトファイル自身の親フォルダ**(`getTargetFolderId()`)。索引・バッファ・成果物すべてここに置く前提。復元系(`rebuildRecordsFromSheet`)もこのフォルダを探す。

## アーキテクチャ

フェーズ機械: `FETCHING → BUILD → (BATCH_NEXT →) DONE`。ディスパッチャは `continuesFetch()`(LockService で多重実行防止)。各フェーズはタイムアウト間際で状態を Script Properties に保存し `ensureTriggerAfter()`(30秒後トリガー)で再開する。**時間が残っていれば同一実行枠でフェーズを直結**する(FETCHING完了→即BUILD、一括の作品完了→残り60秒以上なら即次の作品)。

- **FETCHING** (`runFetchPhase`): 目次から全話 URL を集め、`UrlFetchApp.fetchAll` で **FETCH_PARALLEL=3 件ずつ並列取得**(バッチ間 `FETCH_SLEEP_MS=500ms`、礼儀のため増やさない)。50 話ごとにバッファファイル `__kakuyomu_buf_<workId>_NNNN.txt` へ書き出す。タイトル行は `■ <話タイトル> [通し番号]` 形式(番号は最低3桁ゼロ詰め `[001]`、4桁以上は自動拡張。`ep.no` に絶対話数を保持)。
- **BUILD** (`runBuildPhase`): バッファごとに `parseBufferForBuild` で ■ 除去・空行除去・行頭字下げ正規化(後述)を済ませたクリーンテキストと見出し位置を作り、`insertCleanIntoDoc` が 1 回の `batchUpdate` で挿入＋整形。`MAX_DOC_CHARS=900000` 超過で新規分冊(`HEADER_GUARD_CHARS` でヘッダのみ分冊の無限ループを防止)。最後にフッター(取得記録)を挿入。**再開時は必ず実終端を読み直して cursor 同期**。
- **続き取得** (`startContinuation` / `prepareContinuation`): `RESUME_<workId>` 記録の `lastEpisodeId` を現目次と照合して差分だけ取得(見つからなければ話数フォールバック)。既存末尾ドキュメントへ追記。追記境界には `\n\n` を先に挿入し前段落との連結を防ぐ。
- **一括続き取得** (`startContinuationAll`): 全 `RESUME_` 記録をキュー(`BATCH_MODE`/`BATCH_QUEUE`)に積み、1 作品ずつ完走→次へ。新着なしはスキップ。**記録が 1 件も無ければ索引シートから復元**(`rebuildRecordsFromSheet`)してから回す。
- **索引**: スプレッドシートのみ(Doc 版索引は削除済み)。`updateIndexSpreadsheet` が全記録から再生成。1 作品 1 行、列は「タイトル/話数/ファイル数/最終更新/元URL/ファイル1..N」(N は最大分冊数に合わせ可変、リンクは `=HYPERLINK()`)。ID は `INDEX_SHEET_ID` プロパティに保持。

## データモデル(Script Properties)

- `RUN_STATE_KEYS` に列挙されたキー … 実行中の一時状態。`clearRunState` で消える。
- `RESUME_<workId>` … 永続記録 `{title,url,total,lastEpisodeId,docIds,lastCursor,updatedAt}`。`lastCursor` は参考値であり**位置決定には使わない**。
- `BATCH_MODE` / `BATCH_QUEUE` … 一括続き取得のキュー(RUN_STATE_KEYS 外＝作品完了で消えない)。
- `INDEX_SHEET_ID` … 索引スプレッドシートの ID。

## 書式仕様(現行)

- フォント `BIZ UDGothic`(`FONT_FAMILY`)。**等幅・U+3000 を全角幅で描画できることが選定理由**。`M PLUS 1 Code` は U+3000 のグリフ幅が代替されて字下げが半端になるため不採用。Docs は Google Fonts のフォントしか使えない(源暎モノコード・ヒラギノは不可)。
- 行間 1.0(`LINE_SPACING_PCT=100`)、段落後余白 0.5 行(`PARA_SPACE_BELOW_LINES=0.5` × `BODY_FONT_SIZE_PT=11` = 5.5pt)。
- 段落間の空行(空段落)は作らない。原文の空行は除去し段落間は単一改行。
- 字下げ: 行頭に空白がある本文行は**全角1字(U+3000)に正規化**。空白の無い行(会話文等)はそのまま。ユーザーの流儀は「会話文は字下げしない」。
- 見出し: 先頭段落＝HEADING_2(ドキュメント名)、各話タイトル＝HEADING_3、いずれも bold + weight700(全文フォント適用で太字が消えるため明示上書きが必須)。
- エピソード番号: 話タイトル末尾に ` [NNN]`。

## 実行する関数(ユーザー向けAPI)

`startFetch` / `startContinuation` / `startContinuationAll` / `seedResumeRecord` / `checkResume` / `listResumeRecords` / `rebuildIndex` / `rebuildRecordsFromSheet` / `checkProgress` / `resetAll`(記録・索引は残し run 状態のみ消す)。デバッグ用に `START_EPISODE` / `END_EPISODE`(0=無制限)で取得範囲を絞れる(初回取得のみ有効)。

## 開発ワークフロー

このリポジトリでは GAS のオンラインエディタでの編集を主とし、毎日 GitHub Actions(`sync-from-gas.yml`)が変更を自動で取り込む運用になっている(詳細は `README.md`)。Claude Code でコードを修正する場合は以下に従うこと。

- 編集後は必ず `node --check` 相当の構文チェックを通す(`.js` はそのまま `node --check kaku_scraping/src/Kakuyomu_to_docs.js` でよい)。
- GAS はローカル実行不可。動作確認は `clasp push`(または PR マージ後に GitHub Actions の「Deploy to Google Apps Script」を手動実行)→ GAS エディタで関数実行 → 実行ログをユーザーが確認、のループ。
- 修正時は削除した定数・関数・フェーズ名の**残存参照を grep で確認**する習慣(過去に PHASE_WRITING 等の残骸で不整合が起きかけた)。
- マニフェスト(`appsscript.json`)変更(スコープ追加等)をしたら再認可が必要になる旨をユーザーに伝える。
- GAS エディタ側で直接編集された内容は `sync-from-gas.yml` が自動でこのリポジトリに取り込む。ローカル/Claude Code 側の編集と競合しないよう、作業前に最新を pull すること。

## 既知の注意・保留事項

- ルビ(振り仮名)は現在の抽出(`stripHtmlTags` 系)で失われている可能性が高い。保持する場合は括弧併記等の折衷が必要(未着手・保留)。
- 実行時 URL 入力(Script Property `KAKUYOMU_URL` 直書きの代替: WebApp の doGet フォーム等)は提案済みだが保留。
- 縦書き HTML 出力(Noto Serif JP)の構想が過去にあった(Docs 出力とは別系統)。
- `INDEX_DOC_ID` プロパティは旧 Doc 索引の残骸(無害・参照なし)。
