# カクヨム → Google ドキュメント保存パイプライン

Google Apps Script (GAS) 製。カクヨムの小説を全話取得し、整形済みの Google ドキュメントとして保存する。続き取得・一括更新・索引スプレッドシート生成・Web UI まで含む。会話・報告・コミットメッセージは日本語。

## ファイル構成

`kaku_scraping/src/` が GAS プロジェクト(KAKU_SCRAPING)の実体で、clasp で同期している。GAS は同一プロジェクト内の全ファイルを 1 つのグローバルスコープで実行するため、ファイル間の import/export は無い。

- `Kakuyomu_to_docs.js` … 本体。取得・整形パイプライン、続き取得、キュー、索引シート
- `WebApp.js` … Web アプリのサーバー側。`doGet` と、クライアントから `google.script.run` で呼ばれる `web*` 関数群
- `index.html` … Web UI 本体(単一ファイル。CSS/JS 込み)。`.claspignore` が `!*.html` を許可しているので同期対象
- `appsscript.json` … マニフェスト(Docs API 有効化・OAuth スコープ・`webapp` 設定)
- `Reformat_existing_docs.js` … 独立ツール。既存ドキュメントに現在の書式だけを再適用する。`TARGET_DOC_IDS` は使うたびに書き、使い終わったら空に戻す

## 用語

- **記録** … Script Properties の `RESUME_<workId>`。作品ごとの永続状態(正のデータ)。索引シートはここから生成される表示物
- **run** … 1 回の取得実行(FETCHING→BUILD→完了)。状態は `RUN_STATE_KEYS` のプロパティ群
- **一括続き取得** … 全記録をキューに積んで 1 作品ずつ続き取得すること
- **話数** … 作品の総話数(記録の `total`)。**次話** … 読み残しの最前線の話番号(Web UI の列。後述)

## 実行環境と制約(最重要)

- **無料 Gmail アカウント**の GAS。実行時間上限 6 分。`TIMEOUT_THRESHOLD_MS`(5 分)で自主中断し、時間駆動トリガー(`ensureTriggerAfter`、既定 `RETRIGGER_DELAY_MS`=30 秒。**発火には最大 1 分前後の揺れ**)で再開する多段実行方式。時間が残っていれば同一実行枠でフェーズを直結する。
- **メモリ制約が最大の敵**。1 ドキュメント最大 90 万字・数万段落。以下は全て OOM で失敗済みの経路。**絶対に戻さない**:
  - `DocumentApp.openById()` で巨大ドキュメントを開いて段落走査(約 1.7 万段落で OOM)
  - `Docs.Documents.get` で本文テキストを含む取得(`elements(textRun(content))` を fields に含めると OOM)
  - Drive テキストエクスポート全文と段落を突き合わせる方式(エクスポートは非空段落の後に空行を足すため行数と段落数が 1:1.5 でズレ、対応付け不能)
- 安全な読み出しは**構造のみ・テキストを含まない軽量取得**だけ: `Docs.Documents.get(id, {fields:'body.content(endIndex)'})`(`getDocEndCursor`)、および段落位置+見出し種別のみ(`Reformat_existing_docs.js`)。OOM の原因は「要素ごとの JS オブジェクト生成が数万個」であり、**単一の文字列**として受け取る Drive エクスポート(次話判定)は別物。
- 書き込みは**読み返さない挿入方式(BUILD)**: 挿入と整形(見出し/太字/フォント/行間/余白)を同一 `batchUpdate` で適用。インデックスは「挿入位置 + 文字オフセット」の加算のみ(■ は挿入前に除去。削除リクエストは出さない)。
- Docs API のインデックスは **UTF-16 コード単位**(JS の `.length` と一致)。cursor 加算はこれが前提。
- **ユーザーは読了した内容をドキュメント先頭側から削除して上書き保存する運用**。保存済み cursor は信用せず、追記位置・再開位置は**毎回 `getDocEndCursor` で実ファイルの終端を読み直す**。この前提を崩さない。
- Apps Script の `replaceText` は RE2 のため `\uXXXX` 表記が使えない。■ 除去は文字位置ベース。通常の JS 正規表現は問題ない。
- `DriveApp.getFilesByName` / `searchFiles` はドライブ全体検索で遅い。**必ずフォルダ限定**(`findFileInFolder` / `getTargetFolder().searchFiles`)。フォルダは `getTargetFolder()`(キャッシュ済み)を使い、`DriveApp.getFolderById(getTargetFolderId())` を直接呼ばない。
- 保存先は**スクリプトファイル自身の親フォルダ**(`getTargetFolderId()`)。索引・バッファ・成果物・索引スプレッドシートはすべてここ(Drive 上のみの実行時生成物。リポジトリには無い)。
- **`FETCH_PARALLEL`(3)と `FETCH_SLEEP_MS`(500ms)は相手サーバーへの礼儀として決めた値。速度目的で上げない**(パイプラインの所要時間を支配しているのはここだが、意図的に据え置く)。

## アーキテクチャ

フェーズ機械 `FETCHING → BUILD → (BATCH_NEXT →) DONE`。ディスパッチャは `continuesFetch()`(LockService で多重実行防止)。

- **FETCHING**(`runFetchPhase`): 目次から全話 URL を集め、`UrlFetchApp.fetchAll` で `FETCH_PARALLEL` 件ずつ取得。`EPISODES_PER_BUFFER`(50)話ごとにバッファ `__kakuyomu_buf_<workId>_NNNN.txt` へ書き出す。タイトル行は `■ <話タイトル> [通し番号]`(最低 3 桁ゼロ詰め、4 桁以上は自動拡張。`ep.no` に絶対話数)。
- **BUILD**(`runBuildPhase`): バッファごとに `parseBufferForBuild` で ■ 除去・空行除去・字下げ正規化したクリーンテキストと見出し位置を作り、`insertCleanIntoDoc` が 1 回の `batchUpdate` で挿入+整形。`parsed.clean` は先頭・末尾に改行を持たないので、**同一ドキュメント内でバッファをまたぐ時は `needSep`(Script Property `BUILD_NEED_SEP`、タイムアウト再開をまたいで永続)で区切りの `\n` を 1 つ補う**(無いと前バッファ末尾と次の見出しが同一段落に連結する)。`MAX_DOC_CHARS`(90 万)超過で新規分冊(`HEADER_GUARD_CHARS` でヘッダのみ分冊の無限ループを防止)。最後にフッター(取得記録)を挿入。再開時は必ず実終端を読み直す。
- **続き取得**(`prepareContinuation`): 記録の `lastEpisodeId` を現目次と照合して差分だけ取得(無ければ話数フォールバック)。既存末尾ドキュメントへ追記。追記境界に `\n\n` を先に挿入する。
- **一括続き取得**(`startContinuationAll`): 全記録をキューに積み 1 作品ずつ完走→次へ。新着なしはスキップ。記録が 1 件も無ければ索引シートから復元(`rebuildRecordsFromSheet`)してから回す。
- **自動キューイング**: run は単一スロットで同時実行不可。`startFetch` / `startContinuation` / `startContinuationAll` は実行中なら**エラーにせず `enqueueWork_` でキュー末尾に積む**(`BATCH_MODE='1'` も立てる)。完了時は `finishRun` のバッチ分岐が次を取り出す。キュー要素は `{url, mode:'fetch'|'cont', startEpisode?, endEpisode?}`。旧形式(workId 文字列)も `normalizeQueueEntry_` が続き取得として受理する。`prepareFetch` / `prepareContinuation` は run 状態をセットして true を返すだけで、起動(`continuesFetch` かトリガー)は呼び出し側が行う。
- **完了処理**(`finishRun`): バッファ掃除 → 記録保存 → サイズキャッシュ無効化 → 索引シート再生成 → run 状態クリア → バッチなら次へ(残り 60 秒以上なら同一枠で直結、足りなければトリガーに回す)。**`clearRunState` で `PHASE` が消えるので、バッチを続ける場合は `batchStartNext` を呼ぶ前に必ず `PHASE_BATCH_NEXT` を立てる**(下記の再発防止を参照)。
- **索引シート**(`updateIndexSpreadsheet`): 全記録から毎回再生成。列は「短縮作品名 / 作品タイトル / 話数 / ファイル数 / 最終更新 / 元URL / ファイル1..N」。短縮作品名は表示専用で、復元(`parseIndexSheetRow_`)には使わない。**列を増減させたら必ず `parseIndexSheetRow_` の列番号も直す**。並び順は `compareWorksForDisplay_`(索引・Web UI 共通。最終更新降順 → タイトル → 作品ID。`updatedAt` は分単位なので同値が普通に起き、タイブレークが無いと行が入れ替わる)。ID は `INDEX_SHEET_ID`、タブ名は `INDEX_SHEET_TAB_NAME`。索引シートは**記録の復旧手段**(`rebuildRecordsFromSheet` / `syncResumeRecordsFromSheet`)でもあるので廃止しない。
- **ファイル名短縮**(`shortenTitleForFileName_`): `createBuildDoc` が Drive の**ファイル名にのみ**使う。本文見出し・記録・索引・フッターは常に正タイトル。ルールベース: ①「本題 〜サブタイトル〜」を除去(`〜` U+301C と `～` U+FF5E は別コードポイント。両対応)、②`【】［］（）` の注記を除去、③ `SHORT_FILENAME_MAX_LEN`(30)超なら読点区切り、無ければ機械的トリミング+「…」。既知の制約(不自然な切れ方・一意性低下)は許容済み。ON/OFF は Script Property `SHORT_FILENAME`(既定 ON)。

## Web UI(唯一の操作インターフェース)

操作パネル(スプレッドシート版)は廃止済み。`doGet` が `index.html` を返し、クライアントは `google.script.run` で `WebApp.js` の `web*` 関数を呼ぶ。**取得ロジック本体には手を入れず**、既存部品の組み合わせで実装する。

- **即応起動**: `webStart*` は run 状態をセットして `ensureTriggerAfter(WEB_KICKOFF_DELAY_MS)` で短い遅延のトリガーを張り、即座に返す。実処理はトリガー実行が担う(開始まで最大 1 分前後の揺れ)。
- **デプロイ**: `deploy.yml` は `clasp push` のみでデプロイ版数を更新しない。**テストデプロイの `/dev` URL は常に最新コード**で動くので、この運用では `/dev` を使う。`/exec` を使うには `clasp deploy` の追加が要る。マニフェストの `webapp` 設定と `HtmlService` は追加スコープ不要(再認可不要)。
- **XSS**: 作品タイトル等の外部由来テキストは必ず `textContent` で描画する。`innerHTML` に流し込まない。
- **ポーリングは取得操作を実行している間だけ**(`scheduleNextRefresh`): `webGetState` の応答で `running.active` が true の間だけ `POLL_MS`(7 秒)後の次回を予約する自走方式。**待機中は次回を予約せず完全に止まる**。再開のきっかけはボタン操作(`call()` 成功時の `refresh()`)・「今すぐ更新」・ページ再読み込み。失敗時は状態不明なので `POLL_MS` 後に 1 回再試行。Web UI の外(GAS エディタ)から開始した run には、リロードかボタン操作まで気づかない(許容済み)。
- **バックグラウンドタブ対策**(`visibilitychange`): ブラウザは非表示タブのタイマーを間引くため、実行中に離席すると完了に気づけないまま止まる。**タブが隠れた瞬間に `running.active` だった場合だけ**、再表示時に `refresh()` を 1 回実行して追いつく。待機中のタブ切り替えでは何も起きない(無条件に `refresh()` すると、離席中に完了した作品の次話・サイズ問い合わせがタブを見せるたびにまとめて走る)。
- **並び替え・絞り込みはクライアント側だけで完結**(`renderTable` / `compareWorks`)。設定は `view` に保持し自動更新で失われない。同値時はタイトル・作品IDでタイブレーク。`total` は文字列で来るので `Number()` してから比較する。「未読のみ表示」(`#unreadOnly`)は `readingEp[workId] === 'latest'` の作品を除外するだけで、判定中(未取得)の作品は除外しない。

### ドキュメントサイズ表示(参考値)

- `webGetDocSizes(docIds)` は `webGetState` とは別経路。クライアントは `docSizes`(docId→バイト数)を持ち、`hasOwnProperty` で「未取得」と「0 バイト判明」を区別する。**サイズ 0 は削除済み・アクセス不可**の意味で、その docId のリンクは出さない。分冊番号は `docIds` 配列の位置で採番するので、途中の分冊が消えても番号はズレない。
- サーバーは `CacheService`(`DOC_SIZE_CACHE_SEC`=1 時間)に加え、**`finishRun` が該当 docId のキャッシュを `invalidateDocSizeCache_` で明示的に消す**。これが無いと取得完了直後に古い値が返る。
- 更新のトリガーは 2 つ。`maybeFetchSizes`(未取得の docId をまとめて取得。主に再読込時)と `refreshChangedWorks`(作品ごとの `updatedAt` を `knownUpdatedAt` と比較し、**変化した作品の全 docId** を取り直す)。

### 次話表示

- 定義: ユーザーは読了分を先頭から削除する運用なので、**先頭に残っている最初の `[NNN]`** が今読んでいる(または次に読む)話。見出しが 1 つも残っていなければ `'latest'`(画面上「最新」= 未読なし)。
- `webGetReadingProgress({workId: [docId,...]})` → `{progress: {workId: 話数|'latest'}, sizes: {docId: バイト数}}`。判定できなかった作品は `progress` にキーを入れない(クライアントは未取得扱いで次回再試行)。`sizes` は判定の過程で開いたドキュメントぶんだけ(見つかった時点で走査を打ち切るため、その後ろの分冊は含まれない)。
- 判定は `fetchDocHeadText_` が Drive export エンドポイントを **HTTP Range 付き**で叩き、先頭 `PROGRESS_SCAN_CHARS`(2 万字)だけを `EPISODE_TAG_RE`(行末アンカー。本文中の `[123]` を拾わない)で探す。Range が無視され 200 が返っても先頭を切り出して使い、ログに残す。認証は既存の `writeFileContent` と同じ `ScriptApp.getOAuthToken()` + `UrlFetchApp`(追加スコープ不要)。
- キャッシュキーに**ファイルサイズを含める**(`progress_<docId>_<size>`)。サイズが同じなら中身も同じなので、明示的な無効化は不要(TTL `PROGRESS_CACHE_SEC`=6 時間)。
- 分冊は古い順に見て、削除済み・見出し無しは飛ばして次へ。全て無ければ `'latest'`。
- クライアントは `readingEp` を持ち、`PROGRESS_CHUNK`(5)件ずつ問い合わせる。
- 既知の割り切り: ① 1 話が 2 万字超だと窓の外で「最新」と誤表示、② 読みかけの話は見出しごと消えているので表示は +1 側に寄る、③ 読書によるドキュメント削除は `updatedAt` を動かさないので、**読み進めた結果の反映はページ再読込時**。

### サイズと次話の問い合わせ順序(dedup)

`render()` は `refreshChangedWorks` → `maybeFetchProgress` → `maybeFetchSizes` の順で呼ぶ。`maybeFetchSizes` は次話問い合わせが進行中(`pendingEpIds`)の作品を除外し、`fetchProgressChunk` が `sizes` を `docSizes` に反映した上で不足分だけ `webGetDocSizes` に回す(同じファイルを二重に開かない)。**ただし `refreshChangedWorks` の `fetchSizes` は dedup 対象にしない**(常に全 docId を明示的に呼ぶ)。次話判定は見出しが見つかった時点で打ち切るため、今回追記された後ろの分冊が `sizes` に含まれず、サイズが更新されない不具合が再発する。

## データモデル(Script Properties)

- `RUN_STATE_KEYS` のキー … 実行中の一時状態。`clearRunState` で消える。
- `RESUME_<workId>` … 記録 `{title,url,total,lastEpisodeId,docIds,lastCursor,updatedAt}`。`lastCursor` は参考値で位置決定には使わない。`updatedAt` は `'yyyy-MM-dd HH:mm'`(分単位)。
- `BATCH_MODE` / `BATCH_QUEUE` … 順番待ちキュー(RUN_STATE_KEYS 外。作品完了で消えない)。
- `INDEX_SHEET_ID` … 索引スプレッドシートの ID。
- `SHORT_FILENAME` … ファイル名短縮の ON/OFF(`'0'` で OFF。未設定は ON)。

## 書式仕様

- フォント `BIZ UDGothic`(`FONT_FAMILY`)。等幅で U+3000 を全角幅で描画できることが選定理由。`M PLUS 1 Code` は U+3000 の幅が崩れるので不採用。Docs は Google Fonts のみ。
- 行間 1.0(`LINE_SPACING_PCT`=100)、段落後余白 0.5 行(`PARA_SPACE_BELOW_LINES` × `BODY_FONT_SIZE_PT`=11pt)。
- 空段落は作らない(原文の空行は除去、段落間は単一改行)。
- 字下げ: 行頭に空白がある本文行は全角 1 字(U+3000)に正規化。空白の無い行(会話文)はそのまま。
- 見出し: 先頭段落 = HEADING_2(ドキュメント名)、各話タイトル = HEADING_3。いずれも bold + weight 700(全文フォント適用で太字が消えるため明示上書きが必須)。話タイトル末尾に ` [NNN]`。

## ユーザー向け関数(GAS エディタから実行可)

`startFetch(url?, startEpisode?, endEpisode?)` / `startContinuation(url?)` / `startContinuationAll` / `seedResumeRecord(url?, existingDocIds?)`(一覧に追加) / `clearResumeRecord(url?)`(一覧から削除。ドキュメントは残る) / `syncResumeRecordsFromSheet`(索引シートの行を正として差分同期。既存作品の記録は触らない) / `rebuildRecordsFromSheet`(索引シートから全面復元。既存記録も上書き) / `checkResume(url?)` / `listResumeRecords` / `rebuildIndex` / `checkProgress` / `resetAll`(run 状態のみ消す)。URL 省略時は `KAKUYOMU_URL` にフォールバック。`START_EPISODE` / `END_EPISODE`(0=無制限)は初回取得のデバッグ用。

## 開発ワークフロー

- **相談と実装を分ける**: ユーザーが分析・提案・意見を求めている段階では実装に進まない。現状・方針・トレードオフを提示し、明示的な許可を得てから着手する。**コードのロジックに関わる変更は事前承認が必要**。ドキュメント更新と、承認済み方針の範囲内の軽微な修正は確認不要。
- **作業前に `git fetch origin main` で最新を取り込む**(`sync-from-gas.yml` が毎日 GAS 側の編集を取り込み、コミットを作ることがある)。ブランチは `main` に直接コミットする運用。
- **検証**: GAS はローカル実行不可。編集後は必ず `node --check`(`.js` はそのまま。`index.html` は `<script>` 部を抜き出して)を通し、ロジックは Node の `vm` で GAS API をモックしたシミュレーションで確認する(スクラッチ領域に置く。リポジトリには入れない)。実機確認はユーザーが `/dev` を再読み込みして行う。
- **反映の手順**: コミット → `git push -u origin main` → GitHub Actions `deploy.yml` を `workflow_dispatch` で起動(`clasp push`)。push のたびに必ずトリガーする。完了後にユーザーへ「何を変えたか・どう検証したか・何を確認してほしいか」を簡潔に報告する。
- 削除した定数・関数・フェーズ名は**残存参照を grep で確認**する。コメントも実装と食い違わせない(過去に旧列構成・旧フォント名の記述が残って事故のもとになった)。
- マニフェスト(`appsscript.json`)を変えたら再認可が必要になる旨をユーザーに伝える。

## 戻してはいけない設計判断(過去の不具合の再発防止)

- OOM 経路(上記「実行環境と制約」)。Docs API で本文を読む案は形を変えても却下。
- Web UI の完了検知に `running.active` の true→false エッジ検出を使わない。バックグラウンドタブでは遷移の瞬間を取りこぼして二度と検出できない。**`updatedAt` の差分検出**(`refreshChangedWorks`)が正。
- `refreshChangedWorks` のサイズ取得を次話側の dedup に巻き込まない(上記)。
- 待機中の常時ポーリングを復活させない。`visibilitychange` で無条件に `refresh()` しない。
- **`batchStartNext` を呼ぶ前に `PHASE` を空のままにしない**。この関数は目次取得(ネットワーク・新着無しの作品は読み飛ばすので長い)を伴い、その間 `PHASE` が無いと `isRunActive_` が false → Web UI が「待機中」と判断してポーリングを永久に止める。`finishRun` のバッチ分岐・`startContinuationAll`・`webStartContinuationAll` の 3 箇所で、呼ぶ直前に `PHASE_BATCH_NEXT` を立てている(2026-09 の「取得状況が画面更新されない」不具合の原因)。
- `refresh()` の成功ハンドラでは**次回の予約を `render()` より先に行う**。逆順にすると描画中の 1 回の例外でポーリングが二度と再開しない。
- `FETCH_PARALLEL` / `FETCH_SLEEP_MS` を速度目的で変えない。
- 索引スプレッドシートを廃止しない(記録の復旧手段)。
- 一括続き取得中に作品ごとの索引再生成をまとめる案(`finishRun` の `updateIndexSpreadsheet` をバッチ末尾に寄せる)は未採用。採用するなら再提案から。

## 既知の注意・保留事項

- ルビ(振り仮名)は現在の抽出(`stripHtmlTags` 系)で失われている可能性が高い。保持するなら括弧併記等の折衷が必要(未着手)。
- 縦書き HTML 出力(Noto Serif JP)の構想が過去にあった(Docs 出力とは別系統)。
- `INDEX_DOC_ID`(旧 Doc 索引)と `CONTROL_PANEL_SHEET_ID`(旧操作パネル)のプロパティは無害な残骸。
- 操作パネル廃止の残置物: Drive 上の「【操作パネル】カクヨム取得コンソール」スプレッドシートと、それに紐づく installable な `onPanelOpen` トリガー。ハンドラ関数が無いため**そのファイルを開くとエラー**になる。トリガーを GAS エディタの「トリガー」画面から削除するか、ファイルごとゴミ箱へ。
- `checkBufferContent()` はどこからも呼ばれないデバッグ用関数(エディタから手動実行する想定で残置)。
