# カクヨム → Google ドキュメント保存パイプライン

Google Apps Script (GAS) 製。カクヨムの小説を全話取得し、整形済みの Google ドキュメントとして保存する。続き取得・一括更新・索引スプレッドシート生成まで自動化している。

## ファイル構成

このリポジトリでは `kaku_scraping/src/` 以下に GAS プロジェクト(KAKU_SCRAPING)を clasp で同期している。

- `kaku_scraping/src/Kakuyomu_to_docs.js` … 本体。取得・整形パイプライン、続き取得、索引管理
- `kaku_scraping/src/ControlPanel.js` … 操作パネル(別スプレッドシート)関連。GAS は同一プロジェクト内の複数ファイルを1つのグローバルスコープとして実行するため import/export は不要で、`Kakuyomu_to_docs.js` 側の関数・定数をそのまま参照できる。逆に `finishRun`(`Kakuyomu_to_docs.js`)は完了通知のため `writePanelStatus_` を直接呼んでおり、コア側からこのファイルへの依存が一部ある
- `kaku_scraping/src/WebApp.js` … Web アプリ(取得インターフェース)。`doGet` と、クライアントから `google.script.run` で呼ばれる `web*` 関数群
- `kaku_scraping/src/index.html` … Web UI 本体(単一ファイル。CSS/JS 込み)。`.claspignore` は `!*.html` を許可済みなので clasp で同期される
- `kaku_scraping/src/appsscript.json` … マニフェスト(Docs API 有効化・OAuthスコープ・`webapp` 設定)
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
- 保存先は**スクリプトファイル自身の親フォルダ**(`getTargetFolderId()`)。索引・バッファ・成果物すべてここに置く前提。復元系(`rebuildRecordsFromSheet`)もこのフォルダを探す。索引スプレッドシートと操作パネル(後述)もこのフォルダに作成される(=リポジトリには存在しない、Drive上のみの実行時生成物)。

## アーキテクチャ

フェーズ機械: `FETCHING → BUILD → (BATCH_NEXT →) DONE`。ディスパッチャは `continuesFetch()`(LockService で多重実行防止)。各フェーズはタイムアウト間際で状態を Script Properties に保存し `ensureTriggerAfter()`(30秒後トリガー)で再開する。**時間が残っていれば同一実行枠でフェーズを直結**する(FETCHING完了→即BUILD、一括の作品完了→残り60秒以上なら即次の作品)。

- **FETCHING** (`runFetchPhase`): 目次から全話 URL を集め、`UrlFetchApp.fetchAll` で **FETCH_PARALLEL=3 件ずつ並列取得**(バッチ間 `FETCH_SLEEP_MS=500ms`、礼儀のため増やさない)。50 話ごとにバッファファイル `__kakuyomu_buf_<workId>_NNNN.txt` へ書き出す。タイトル行は `■ <話タイトル> [通し番号]` 形式(番号は最低3桁ゼロ詰め `[001]`、4桁以上は自動拡張。`ep.no` に絶対話数を保持)。
- **BUILD** (`runBuildPhase`): バッファごとに `parseBufferForBuild` で ■ 除去・空行除去・行頭字下げ正規化(後述)を済ませたクリーンテキストと見出し位置を作り、`insertCleanIntoDoc` が 1 回の `batchUpdate` で挿入＋整形。`parsed.clean` は先頭・末尾とも改行を持たないため、**同一ドキュメント内でバッファをまたぐ際は `needSep` フラグ(Script Property `BUILD_NEED_SEP`、タイムアウト再開をまたいで永続)で区切りの `\n` を1つ補う**(無いと前バッファの最終段落と次バッファの見出しが同一段落に連結する。新規ドキュメント作成直後・続き取得の追記直後は既に区切り済みなので `false` にリセット)。`MAX_DOC_CHARS=900000` 超過で新規分冊(`HEADER_GUARD_CHARS` でヘッダのみ分冊の無限ループを防止)。最後にフッター(取得記録)を挿入。**再開時は必ず実終端を読み直して cursor 同期**。
- **続き取得** (`startContinuation` / `prepareContinuation`): `RESUME_<workId>` 記録の `lastEpisodeId` を現目次と照合して差分だけ取得(見つからなければ話数フォールバック)。既存末尾ドキュメントへ追記。追記境界には `\n\n` を先に挿入し前段落との連結を防ぐ。
- **一括続き取得** (`startContinuationAll`): 全 `RESUME_` 記録をキュー(`BATCH_MODE`/`BATCH_QUEUE`)に積み、1 作品ずつ完走→次へ。新着なしはスキップ。**記録が 1 件も無ければ索引シートから復元**(`rebuildRecordsFromSheet`)してから回す。
- **自動キューイング**: run 状態は単一スロット・`continuesFetch` の再開トリガーも 1 本しか持てないため**同時実行は不可**。そこで `startFetch` / `startContinuation` / `startContinuationAll` は先頭で `isRunActive_` を見て、実行中なら**エラーにせず `enqueueWork_` でキュー末尾に積む**(`BATCH_MODE='1'` もここで立てる)。完了時は既存の `finishRun` のバッチ分岐がそのまま次を取り出すので、非バッチで始まった run の後ろにも継ぎ足せる。キュー要素は `{url, mode:'fetch'|'cont', startEpisode?, endEpisode?}`。**旧形式(workId の文字列)も `normalizeQueueEntry_` が続き取得として受理**するので、移行中の残存キューは壊れない。`startFetch` は `prepareFetch`(run 状態をセットして true を返すだけ)と起動部に分割済みで、`batchStartNext` が mode で `prepareFetch` / `prepareContinuation` を出し分ける。
- **索引**: スプレッドシートのみ(Doc 版索引は削除済み)。`updateIndexSpreadsheet` が全記録から再生成。1 作品 1 行、列は「短縮作品名/作品タイトル/話数/ファイル数/最終更新/元URL/ファイル1..N」(N は最大分冊数に合わせ可変、リンクは `=HYPERLINK()`)。**短縮作品名は表示専用**(`shortenTitleForFileName_` で都度算出。ON/OFFトグル `SHORT_FILENAME` に関わらず常に表示)で、記録・復元(`parseIndexSheetRow_`)には使わない。並び順は `compareWorksForDisplay_`(索引・Web UI 共通)で「最終更新の新しい順 → タイトル → 作品ID」。**`updatedAt` は分単位(`'yyyy-MM-dd HH:mm'`)までしか持たない**ため一括続き取得では同値が普通に発生し、タイブレークが無いと順序が `Object.keys(getProperties())` の順(呼び出しごとに変わりうる)任せになって行が入れ替わる。ID は `INDEX_SHEET_ID` プロパティに保持。シート内のタブ名は `INDEX_SHEET_TAB_NAME`(='索引')固定。索引シートを開く処理は `findOrLocateSpreadsheet_(propKey, fileName)` に共通化(`findIndexSheet_` はこのラッパー)。列位置は `parseIndexSheetRow_` に決め打ちで依存しているため、**列を増減させたら必ずこの関数も合わせて直す**。
- **操作パネル**: 索引とは別のスプレッドシート(`CONTROL_PANEL_FILE_NAME`、同じ保存先フォルダに作成)。`setupControlPanel` で作成し、そのファイルに installable な onOpen トリガー(`onPanelOpen`)を登録する。パネルを開くとカスタムメニュー「カクヨム操作」が出る。**実行は必ずメニュークリックのみ**(誤操作防止のため onEdit/チェックボックスは使わない)。パラメータはセル(`PANEL_CELL_*`)から読み取り、各 `panelRunXxx` ハンドラが対応する関数(`startFetch`/`startContinuation`/`seedResumeRecord`/`clearResumeRecord`/`syncResumeRecordsFromSheet`/`rebuildIndex`)を呼び、結果をステータスセル(`PANEL_CELL_STATUS`)に書き戻す(`writePanelStatus_`)。多段実行(`startFetch`/`startContinuation`/`startContinuationAll`)は開始時点のメッセージのみ即時反映し、真の完了は `finishRun` の `PHASE_DONE` セット時に `writePanelStatus_` で改めて通知する。パネル未作成時、`writePanelStatus_` は何もしない(呼び出し元を壊さない)。

- **ファイル名短縮**: `createBuildDoc` が新規ドキュメントを作る際、Driveの**ファイル名にのみ**短縮タイトル(`shortenTitleForFileName_`)を使う。**本文のHEADING_2見出し・`RESUME_`記録・索引シート・フッターは常に正タイトル**(引数 `title` そのまま)。ルールベース(AI不使用): ①「本題 〜サブタイトル〜」形式のサブタイトルを除去(`〜`=U+301C波ダッシュ/`～`=U+FF5E全角チルダの表記揺れに両対応。**似た文字だが別コードポイントなので注意**)、②`【】［］（）`で囲まれた注記を除去(文中強調のカッコも区別なく消えるため稀に不自然になるが許容)、③なお `SHORT_FILENAME_MAX_LEN=30` 文字超なら読点区切り、無ければ機械的トリミング+「…」。既知の制約: 読点区切りの結果が接続助詞等で終わり不自然になる場合や、本題部分が短すぎて一意性を欠く場合がある(実データ22件で評価済み・許容の上で採用)。ON/OFFは Script Property `SHORT_FILENAME`(操作パネルの「ファイル名短縮: ON/OFF切り替え」から切替可、デフォルトON)。

- **Web アプリ(取得インターフェース)**: `doGet` が `index.html` を返し、クライアントから `google.script.run` で `WebApp.js` の `web*` 関数を呼ぶ。**取得ロジック本体には手を入れず**、既存部品(`isRunActive_`/`enqueueWork_`/`prepareFetch`/`prepareContinuation`/`batchStartNext`/`ensureTriggerAfter`)の組み合わせで実装している。要点:
  - **即応起動**: `startFetch` 系は最初の5分ぶんを同一実行枠で走らせるため Web からはボタンが待たされる。そこで web 側は「run 状態をセット → `ensureTriggerAfter(WEB_KICKOFF_DELAY_MS)` で短い遅延のトリガーを張る」だけにして即座に返し、実処理はトリガー実行に任せる(`ensureTriggerAfter` は引数省略時 `RETRIGGER_DELAY_MS` で従来通り)。**GAS のトリガー発火には揺れがあるため、実際の開始は最大1分前後遅れることがある**。
  - **デプロイの落とし穴**: `deploy.yml` は `clasp push` のみでデプロイ版数を更新しないため、**本番URL(`/exec`)は古いコードのまま**になる。テストデプロイの **`/dev` URL は常に最新コード**で動くので、この運用では `/dev` を使う前提。`/exec` を使うならワークフローに `clasp deploy` の追加が必要。
  - マニフェストの `webapp`(`executeAs: USER_DEPLOYING` / `access: MYSELF`)は**スコープ追加ではないので再認可は不要**。`HtmlService` 自体も追加スコープ不要。
  - 一覧は行ごとに「続き取得」「削除」ボタンを持つ。作品タイトルは外部由来のため、クライアント側では必ず `textContent` で描画する(`innerHTML` に流し込まない)。
  - **並び替え・絞り込みはクライアント側だけで完結**(`renderTable` / `compareWorks`)。サーバーは呼ばないので7秒ポーリングとは独立して動く。並び替え設定は `view` に保持し、自動更新で再描画されても維持される。第1キーが同値のときはサーバー側と同じくタイトル・作品IDでタイブレークして順序を固定する(同値のたびに行が入れ替わるのを防ぐ)。話数は `total` が文字列で来るため `Number()` してから比較する(文字列比較だと "598" < "84" になる)。
  - **ドキュメントサイズ表示**: 進捗の目安(参考値。実文字数と厳密には一致しない)。`webGetDocSizes(docIds)` は 7 秒ポーリングの `webGetState` には含めない別経路。クライアント側は `docSizes`(docId→バイト数のフラットな連想配列。`hasOwnProperty` で「未取得」と「0バイト判明」を区別する)を持つ。更新のトリガーは2つ:
    - `maybeFetchSizes`: `docSizes` にまだ無い docId(主にページ再読込時)をまとめて取りに行く
    - `refreshChangedWorks`: 作品ごとの `updatedAt` を `knownUpdatedAt`(workId→前回ポーリング時点の値)と比較し、**変化した作品の docId だけ**取り直す。1作品完了するたびにその作品ぶんだけ更新される(一覧から消えた workId の記録もここで掃除する。後述の既読話数もここで一緒に取り直す)。

      **`running.active` の true→false エッジ検出はやめた経緯**: 当初は「実行中→待機中」の遷移だけを見て全件を取り直す設計だったが、一括続き取得は数十分〜数時間かかることがあり、ブラウザがタブをバックグラウンドで間引く(またはポーリングを止める)と、遷移の瞬間そのものを取りこぼし、タブに戻ってきても(次に `active` が `true` にならない限り)二度と検出できなかった。`updatedAt` の差分ベースなら、ポーリングが間引かれていても次に動いた時点で「前回見た値との差分」としてまとめて拾えるため頑健。

    サーバー側は `CacheService`(`DOC_SIZE_CACHE_SEC=3600`、目安の抑制用)に加えて、**`finishRun` が該当作品の docId のキャッシュを `invalidateDocSizeCache_` で明示的に消す**。これが無いと、取得完了直後にクライアントが問い合わせても書き込み前の古いキャッシュ値が返ってしまう(1時間キャッシュは「時間経過での目安」用であって、「書き込み直後の即時反映」はこの明示的な無効化が担っている)。**サイズ0は「削除済み・アクセス不可」の意味**(`DriveApp.getFileById` の例外、または `isTrashed()`)で、その docId のリンクごと表示しない。分冊番号(`(i+1)+'冊目'`)は `docIds` 配列の位置でそのまま採番するため、途中の分冊がゴミ箱に入って表示から消えても後続の番号はズレない(=既存の `createBuildDoc` の `docPart = docIds.length` 採番と同じ考え方)。
  - **既読話数表示**(一覧の「既読」列): ユーザーは読了ぶんをドキュメント**先頭から削除して上書き保存する**運用なので、「先頭に残っている最初の `[NNN]`」が今読んでいる話にあたる。`webGetReadingProgress({workId: [docId,...]})` が判定し、`{workId: 話数 or 'latest'}` を返す(判定できなかった作品は**キーごと返さない**。クライアントは未取得として次回また問い合わせる)。
    - **先頭 `PROGRESS_SCAN_CHARS=20000` 字だけを見る**。1話は概ね2000〜5000字なので、読みかけで見出しごと消えていても次の話の見出しは十分この窓に入る。全文を書き出す必要はない。
    - 取得は `fetchDocHeadText_` が Drive の export エンドポイントを **HTTP `Range` ヘッダ付き**で叩く。GAS には受信を途中で打ち切る手段が無く(ストリーミング不可)、Docs API の `documents.get` にも範囲指定が無いため、転送量を削る手段は Range しかない。**Range が無視されて 200(全文)が返る可能性があるので、その場合は受信後に先頭を切り出して使い、ログに残す**。`ScriptApp.getOAuthToken()` + `UrlFetchApp` の組み合わせは既存の `writeFileContent` と同じで、**スコープ追加・再認可は不要**。
    - **Docs API 経由で本文を読んではいけない**(要素ごとにオブジェクトが大量生成されて OOM する)。ここでテキストを**単一の文字列**として受け取っているから安全、という理解が前提。
    - キャッシュキーに**ファイルサイズを含める**(`progress_<docId>_<size>`)。サイズが変わっていなければ中身も変わっていないので走査結果を使い回せる=**読み進めても追記もされていないドキュメントは二度と読みに行かない**。逆にサイズが変わればキーごと変わるので、`invalidateDocSizeCache_` のような明示的な無効化は不要(TTL は `PROGRESS_CACHE_SEC=21600`＝`CacheService` の上限6時間)。
    - 分冊は `docIds` を古い順に見て、**削除済み(`isTrashed`/例外)と見出しが残っていない分冊は飛ばして次を見る**。どれにも見出しが無ければ `'latest'`(最新話まで既読)。
    - 見出し判定は `EPISODE_TAG_RE = /^.*\[(\d{3,})\]\s*$/m`。**行末に寄せている**のは本文中の `[123]` を拾わないため。
    - 既知の割り切り: ①1話が2万字を超えると窓の外になり誤って「最新」表示になる、②読みかけの話は見出しごと消えているため、表示は実際に読んでいる話より**+1側に寄る**、③読書によるドキュメント削除は `updatedAt` を動かさないので、**読み進めた結果の反映は「ページ再読込時」が担う**(`updatedAt` 差分は取得完了の反映用)。
    - クライアントは `readingEp`(workId→話数 or `'latest'`)を持ち、`PROGRESS_CHUNK=5` 件ずつに分けて問い合わせる(未キャッシュだと1件ごとにドキュメントを読みに行くため、1回の呼び出しが長くなりすぎないように)。
    - **「未読のみ表示」チェックボックス**(`#unreadOnly`): `renderTable` の絞り込みに `readingEp[w.workId] === 'latest'` の除外を追加しただけ(テキスト絞り込みと同じくクライアント側完結)。**未取得(判定中)の作品は除外しない**(`readingEp` にキーが無い間は除外条件に一致しないため自然にそうなる)。「最新」が確定してから初めて消える=判定が届くまで一覧がちらつかない。
  - 操作パネル(`ControlPanel.js`)とは併存可能。同じコア関数を呼ぶだけなので二重管理にはならない。

## データモデル(Script Properties)

- `RUN_STATE_KEYS` に列挙されたキー … 実行中の一時状態。`clearRunState` で消える。
- `RESUME_<workId>` … 永続記録 `{title,url,total,lastEpisodeId,docIds,lastCursor,updatedAt}`。`lastCursor` は参考値であり**位置決定には使わない**。
- `BATCH_MODE` / `BATCH_QUEUE` … 取得の順番待ちキュー(RUN_STATE_KEYS 外＝作品完了で消えない)。要素は `{url,mode,startEpisode?,endEpisode?}`(旧形式の workId 文字列も受理)。一括続き取得だけでなく、実行中に投げられた単発の取得もここに積まれる。
- `INDEX_SHEET_ID` … 索引スプレッドシートの ID。
- `CONTROL_PANEL_SHEET_ID` … 操作パネルスプレッドシートの ID。
- `SHORT_FILENAME` … Driveのファイル名短縮のON/OFF(`'0'`でOFF、未設定含めそれ以外はON＝デフォルトON)。

## 書式仕様(現行)

- フォント `BIZ UDGothic`(`FONT_FAMILY`)。**等幅・U+3000 を全角幅で描画できることが選定理由**。`M PLUS 1 Code` は U+3000 のグリフ幅が代替されて字下げが半端になるため不採用。Docs は Google Fonts のフォントしか使えない(源暎モノコード・ヒラギノは不可)。
- 行間 1.0(`LINE_SPACING_PCT=100`)、段落後余白 0.5 行(`PARA_SPACE_BELOW_LINES=0.5` × `BODY_FONT_SIZE_PT=11` = 5.5pt)。
- 段落間の空行(空段落)は作らない。原文の空行は除去し段落間は単一改行。
- 字下げ: 行頭に空白がある本文行は**全角1字(U+3000)に正規化**。空白の無い行(会話文等)はそのまま。ユーザーの流儀は「会話文は字下げしない」。
- 見出し: 先頭段落＝HEADING_2(ドキュメント名)、各話タイトル＝HEADING_3、いずれも bold + weight700(全文フォント適用で太字が消えるため明示上書きが必須)。
- エピソード番号: 話タイトル末尾に ` [NNN]`。

## 実行する関数(ユーザー向けAPI)

`startFetch(url?, startEpisode?, endEpisode?)` / `startContinuation(url?)` / `startContinuationAll` / `seedResumeRecord(url?, existingDocIds?)`(続き取得の一覧に追加) / `clearResumeRecord(url?)`(続き取得の一覧から削除。記録のみでドキュメントは残る) / `syncResumeRecordsFromSheet`(索引シートの行を正として一覧を差分同期。行追加=追加・行削除=削除、既存作品の記録は変更しない) / `checkResume(url?)` / `listResumeRecords` / `rebuildIndex` / `rebuildRecordsFromSheet`(索引シートから記録を全面復元。既存記録も上書きする点が syncResumeRecordsFromSheet と異なる) / `checkProgress` / `resetAll`(記録・索引は残し run 状態のみ消す) / `setupControlPanel`(操作パネルの作成・更新。初回のみ実行)。URL引数は省略時 `KAKUYOMU_URL` にフォールバックするので、エディタからの直接実行(引数なし)も従来どおり可能。デバッグ用に `START_EPISODE` / `END_EPISODE`(0=無制限)で取得範囲を絞れる(初回取得のみ有効。`startFetch` の引数でも上書き可)。

操作パネルのメニューハンドラ(`panelRunXxx`、`onPanelOpen`)はパネル経由でのみ呼ばれる内部関数で、ユーザーがエディタから直接実行するものではない。`panelRunClearQueue` は順番待ちのみを取り消し、実行中の run は止めない。

## 開発ワークフロー

このリポジトリでは GAS のオンラインエディタでの編集を主とし、毎日 GitHub Actions(`sync-from-gas.yml`)が変更を自動で取り込む運用になっている(詳細は `README.md`)。Claude Code でコードを修正する場合は以下に従うこと。

- 編集後は必ず `node --check` 相当の構文チェックを通す(`.js` はそのまま `node --check kaku_scraping/src/Kakuyomu_to_docs.js` でよい)。
- GAS はローカル実行不可。動作確認は `clasp push`(または PR マージ後に GitHub Actions の「Deploy to Google Apps Script」を手動実行)→ GAS エディタで関数実行 → 実行ログをユーザーが確認、のループ。
- 修正時は削除した定数・関数・フェーズ名の**残存参照を grep で確認**する習慣(過去に PHASE_WRITING 等の残骸で不整合が起きかけた)。
- マニフェスト(`appsscript.json`)変更(スコープ追加等)をしたら再認可が必要になる旨をユーザーに伝える。
- ユーザーが分析・提案を求めている(相談段階の)場合は、**即座に実装へ進まない**。まず現状の説明・方針・トレードオフを提示し、実装の許可を得てから着手する。コードのロジックに関わる変更は事前承認が必要(ドキュメント更新や、承認済み方針内の軽微な修正は確認不要)。
- GAS エディタ側で直接編集された内容は `sync-from-gas.yml` が自動でこのリポジトリに取り込む。ローカル/Claude Code 側の編集と競合しないよう、作業前に最新を pull すること。

## 既知の注意・保留事項

- ルビ(振り仮名)は現在の抽出(`stripHtmlTags` 系)で失われている可能性が高い。保持する場合は括弧併記等の折衷が必要(未着手・保留)。
- 実行時 URL 入力の代替(`KAKUYOMU_URL` 直書きをやめる件)は、操作パネルと Web アプリで解消済み。`KAKUYOMU_URL` 定数は引数省略時のフォールバックとしてのみ残っている。
- 縦書き HTML 出力(Noto Serif JP)の構想が過去にあった(Docs 出力とは別系統)。
- `INDEX_DOC_ID` プロパティは旧 Doc 索引の残骸(無害・参照なし)。
