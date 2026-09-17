# カクヨム → Google ドキュメント保存パイプライン

Google Apps Script (GAS) 製。カクヨムの小説を全話取得し、整形済みの Google ドキュメントとして保存する。続き取得・一括更新・索引スプレッドシート生成・Web UI まで含む。会話・報告・コミットメッセージは日本語。

## 作業の型(最初に読む)

1. **相談か実装かを見分ける**。分析・提案・意見を求められている段階では実装しない。コードのロジックを変えるときは事前承認が要る(ドキュメント・テスト・承認済み方針内の軽微な修正は不要)。
2. 着手前に `git fetch origin main`。ブランチは `main` 直コミット。
3. 編集後は `/verify`(`npm test`)。新しい挙動には `tests/` に回帰テストを足す。
4. 締めは `/release`(コミット → push → `deploy.yml` → 結果確認 → 日本語で報告)。
5. 迷ったら「戻してはいけない設計判断」を先に読む。過去に OOM・画面停止・二重問い合わせで失敗した経路が書いてある。

会話が長くなって要約されても、正のデータはこのファイルとコードとテストにある。要約内の記憶より、ファイルを読み直す方を信じる。

## ファイル構成

`kaku_scraping/src/` が GAS プロジェクト(KAKU_SCRAPING)の実体で、clasp で同期している。GAS は同一プロジェクト内の全ファイルを 1 つのグローバルスコープで実行するため、ファイル間の import/export は無い。

- `Kakuyomu_to_docs.js` … 本体。取得・整形パイプライン、続き取得、キュー、索引シート
- `WebApp.js` … Web アプリのサーバー側。`doGet` と、クライアントから `google.script.run` で呼ばれる `web*` 関数群
- `index.html` … Web UI 本体(単一ファイル。CSS/JS 込み)。`.claspignore` が `!*.html` を許可しているので同期対象
- `appsscript.json` … マニフェスト(Docs API 有効化・OAuth スコープ・`webapp` 設定)
- `Reformat_existing_docs.js` … 独立ツール。既存ドキュメントに現在の書式だけを再適用する。`TARGET_DOC_IDS` は使うたびに書き、使い終わったら空に戻す

`kaku_scraping/tools/` は `rootDir`(`src`)の外なので GAS には同期されない。ブラウザ側で使う補助スクリプト置き場。

- `extract_antenna_list.js` … カクヨムの閲覧履歴・未読あり一覧のページでブラウザのコンソールに貼り付けて実行し、作品一覧(URL・タイトル・未読話数・全話数)を JSON で抽出する(選択登録で使う)。Web UI の「候補から選んで登録」カードにあるブックマークレット(`index.html` の `kakuyomuExtractCandidates_()`)と同じロジック。ロジックを変えたら両方直す

## 用語

- **記録** … Script Properties の `RESUME_<workId>`。作品ごとの永続状態(正のデータ)。索引シートはここから生成される表示物
- **run** … 1 回の取得実行(FETCHING→BUILD→完了)。状態は `RUN_STATE_KEYS` のプロパティ群
- **一括続き取得** … 全記録をキューに積んで 1 作品ずつ続き取得すること
- **選択登録** … カクヨムの閲覧履歴・未読あり一覧から選んだ作品をまとめて一覧に追加すること(後述)
- **話数** … 作品の総話数(記録の `total`)。**次話** … 読み残しの最前線の話番号(Web UI の列。後述)
- **フェーズ機械** … Script Property `PHASE`(FETCHING / BUILD / BATCH_NEXT / DONE)で進行段階を表し、`continuesFetch()` が現在の `PHASE` に応じた処理へ振り分ける仕組み。ユーザーとの会話では「状態機械」ではなくこの語を使う
- **蹴り(kick)** … Web UI が開始直後に `webKick()` を呼び、トリガーの発火を待たずに 1 枠目を走らせること(後述)

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
- **一括続き取得**(`startContinuationAll` / `webStartContinuationAll`): 全記録をキューに積み 1 作品ずつ完走→次へ。新着なしはスキップ。記録が 1 件も無ければ索引シートから復元(`rebuildRecordsFromSheet`)してから回す。**開始側は `startBatch_` でキュー・`BATCH_TOTAL`・`PHASE_BATCH_NEXT` を立てて即座に返すだけ**で、新着確認(目次取得)はしない。確認〜取得は `continuesFetch` の `BATCH_NEXT` 分岐が `batchStartNext(props, startTime)` で行う。返り値は 3 値: `BATCH_STARTED`(新着ありの作品で run 状態をセット済み→そのまま `runFetchPhase`)/ `BATCH_EXHAUSTED`(キューを使い切った→`finishBatch_` して DONE)/ `BATCH_DEFERRED`(確認の途中で `TIMEOUT_THRESHOLD_MS` 超過。トリガー張り直し済みで `PHASE` は `BATCH_NEXT` のまま。次の実行枠で続きから確認)。キューは 1 作品取り出すごとに保存するので、中断してもやり直しにならない。`finishBatch_` は結果 1 行(`一括続き取得 完了（HH:MM）: 確認 N 作品・新着あり M 作品`。選択登録ぶんがあれば末尾に`・登録 K 作品`を足す)を `BATCH_RESULT` に残し、`BATCH_MODE/KIND/QUEUE/TOTAL/FETCHED/SEEDED` を消す。
- **選択登録**(`webSeedSelected`): カクヨムの閲覧履歴・未読あり一覧(`kaku_scraping/tools/extract_antenna_list.js` をブラウザのコンソールで実行して抽出)から選んだ作品をまとめて一覧に追加する。**一括続き取得と全く同じキュー(`BATCH_QUEUE`/`PHASE_BATCH_NEXT`/`batchStartNext`)を、要素の `mode:'seed'` で使い回す**(新しい状態機械を作らない)。`batchStartNext` は `mode:'seed'` のエントリを見つけると `seedResumeRecordAt_(url, [], readCount)` で目次だけ取得して記録を保存し(本文取得はしない)、run 状態はセットせず次のキュー項目へ進む(`fetch`/`cont` と違い `BATCH_STARTED` を返さない)。`readCount`(そこまでは取得済みとして記録する話数。カクヨム側の「全話数 − 未読話数」)を渡すと既読分を続き取得の対象から外せる。索引シートの更新は 1 件ごとではなく `finishBatch_` で 1 回だけ行う。`startBatch_` の第 3 引数 `kind`(`'cont'`(既定) / `'seed'`)は `BATCH_KIND` に入り、Web UI の進捗文言だけに使う。
- **自動キューイング**: run は単一スロットで同時実行不可。`startFetch` / `startContinuation` / `startContinuationAll` / `webSeedSelected` は実行中なら**エラーにせず `enqueueWork_` または `pushBatchQueue_` でキュー末尾に積む**(`BATCH_MODE='1'` を立て、`BATCH_TOTAL` も積んだ件数だけ増やす)。完了時は `finishRun` のバッチ分岐が次を取り出す。キュー要素は `{url, mode:'fetch'|'cont'|'seed', startEpisode?, endEpisode?, readCount?}`。旧形式(workId 文字列)も `normalizeQueueEntry_` が続き取得として受理する。`prepareFetch` / `prepareContinuation` は run 状態をセットして true を返すだけで、起動(`continuesFetch` かトリガー)は呼び出し側が行う。
- **完了処理**(`finishRun`): バッファ掃除 → 記録保存 → サイズキャッシュ無効化 → 索引シート再生成 → run 状態クリア → バッチなら次へ(残り 60 秒以上なら同一枠で `batchStartNext` を直結、足りなければトリガーに回す。直結の結果が `BATCH_DEFERRED` ならそのまま return、`BATCH_EXHAUSTED` なら `finishBatch_` して DONE)。**`clearRunState` で `PHASE` が消えるので、バッチを続ける場合は `batchStartNext` を呼ぶ前に必ず `PHASE_BATCH_NEXT` を立てる**(下記の再発防止を参照)。
- **索引シート**(`updateIndexSpreadsheet`): 全記録から毎回再生成。列は「短縮作品名 / 作品タイトル / 話数 / ファイル数 / 最終更新 / 元URL / ファイル1..N」。短縮作品名は表示専用で、復元(`parseIndexSheetRow_`)には使わない。**列を増減させたら必ず `parseIndexSheetRow_` の列番号も直す**。並び順は `compareWorksForDisplay_`(索引・Web UI 共通。最終更新降順 → タイトル → 作品ID。`updatedAt` は分単位なので同値が普通に起き、タイブレークが無いと行が入れ替わる)。ID は `INDEX_SHEET_ID`、タブ名は `INDEX_SHEET_TAB_NAME`。索引シートは**記録の復旧手段**(`rebuildRecordsFromSheet` / `syncResumeRecordsFromSheet`)でもあるので廃止しない。
- **ファイル名短縮**(`shortenTitleForFileName_`): `createBuildDoc` が Drive の**ファイル名にのみ**使う。本文見出し・記録・索引・フッターは常に正タイトル。ルールベース: ①「本題 〜サブタイトル〜」を除去(`〜` U+301C と `～` U+FF5E は別コードポイント。両対応)、②`【】［］（）` の注記を除去、③ `SHORT_FILENAME_MAX_LEN`(30)超なら読点区切り、無ければ機械的トリミング+「…」。既知の制約(不自然な切れ方・一意性低下)は許容済み。ON/OFF は Script Property `SHORT_FILENAME`(既定 ON)。

## Web UI(唯一の操作インターフェース)

操作パネル(スプレッドシート版)は廃止済み。`doGet` が `index.html` を返し、クライアントは `google.script.run` で `WebApp.js` の `web*` 関数を呼ぶ。**取得ロジック本体には手を入れず**、既存部品の組み合わせで実装する。

- **即応起動**: `webStart*`(`webSeedSelected` 含む)は run 状態をセットして `ensureTriggerAfter(WEB_KICKOFF_DELAY_MS)` で短い遅延のトリガーを張り、即座に返す。一括続き取得・選択登録も同じで、**新着確認・目次取得をリクエスト内で行わない**(戻してはいけない設計判断を参照)。ただし GAS の `after()` トリガーは指定値に関わらず発火まで 1 分前後かかるので、**1 枠目はクライアントが蹴る**: `webStart*` が実際に開始したとき(キューに積んだだけのときは付けない)は `kick: true` を返し、`call()` の成功ハンドラが**ボタンを無効化しない別リクエスト**で `webKick()`(中身は `continuesFetch()`)を呼ぶ。トリガーは保険としてそのまま張る。両方動いても `LockService` が排他し、後から来た方は読み飛ばすか次のフェーズを拾う。蹴りの失敗はログに出すだけ(トリガーが引き継ぐ)。
- **状態行の文言**(`render`): 待機中 / `PHASE=BATCH_NEXT` の間は `running.batchKind` で分岐(`新着を確認中… k / N 作品` / `作品を登録中… k / N 作品`)/ `実行中: 作品名（PHASE） d / t 話（k / N 作品目）`(一括続き取得の中の 1 作品。単発取得では末尾の括弧が付かない。選択登録は `runFetchPhase` に遷移しないのでこの表示にはならない)。`lastBatchResult`(`BATCH_RESULT`)は**開いている間に値が変わったときだけ**ログ欄に 1 行出す(`seenBatchResult`。開いた時点の値は前回の結果なので出さない)。
- **候補から選んで登録**(「候補から選んで登録」カード): 抽出はブックマークレット(`javascript:` リンク)で行う。`index.html` の `kakuyomuExtractCandidates_()` はカクヨムの閲覧履歴・未読あり一覧のページで動く抽出ロジックそのもので、この画面自身では呼ばない(呼んでも対象要素が無く空の一覧が出るだけで無害)。`buildSeedBookmarklet_()` が `kakuyomuExtractCandidates_.toString()` から `javascript:` リンクを組み立て、ページ読み込み時に `#seedBookmarklet` の `href` と `#seedBookmarkletUrl`(手動でブックマークを作る人が貼り付ける用のテキストエリア)へセットする(手書きで文字列をエスケープしない。`Function.prototype.toString()` が正確なソースを返すことに依存)。ユーザーはこのリンクをブックマークバーへドラッグし、カクヨムのページで押すと**新しいタブが開き、全選択済みの `<textarea>` に JSON(`{url,title,unread,total}[]`)が入った状態**になる(`window.open('', '_blank')` + `document.createElement('textarea')`。`window.prompt` は使わない。長い文字列だと環境によって表示・コピーの途中で切れることがあり、貼り付け先で `JSON.parse` に失敗する不具合があったため。ポップアップがブロックされた場合のみ `window.prompt` にフォールバックする)。**この画面でリンクをクリックしても `javascript:` は実行されない**(GAS の Web アプリは iframe の中で動くため)。クリックを握りつぶすと「押しても何も起きない」状態になって故障と区別が付かないので、`runBookmarkletHere()` が同じ関数をその場で呼んで結果(通常は「0 件」の警告)を見せ、`return false` で遷移だけ止める。抽出関数は全体が try/catch で包まれ、例外時も 0 件時も必ず `alert` を出す(`javascript:` URI の実行エラーは画面のどこにも出ないため)。同じロジックを `kaku_scraping/tools/extract_antenna_list.js` にも重複して置いている(コンソールに直接貼り付けたい場合用。**ロジックを変えたら両方直す**)。出力 JSON をテキストエリアに貼り付けて「読み込み」を押すと、`doParseSeed` が `seedCandidates`(workId → 候補)を**丸ごと置き換える**(積み上げ・マージはしない。画面に出るのは常に直近に読み込んだJSONの内容だけ)。貼り付け欄を空にして「読み込み」を押す、または空配列 `[]` を貼り付けると、置き換え先が0件になるので結果的に候補一覧が空になる(ログの文言だけ「クリアしました」/「取り込める候補がありませんでした」で分けている。複数ページぶんまとめたいときは、貼り付ける側でJSONを結合してから1回で貼り付ける)。**置き換えのたびにチェック状態・開始話数の手動指定もリセットされる**(workId をまたいだ保持はしない)。一覧では未読・全話数・登録済みかどうかに加えて**開始話数**(そこから続き取得を始める話数)の入力欄を表示する。初期値は自動計算(`seedAutoStartEpisode_` = 全話数 − 未読話数 + 1。未読・全話数が不明なら空欄)だが、**そのまま数値を書き換えて任意の話数を指定できる**(`c.startEpisode` に保持。空欄に戻すと自動計算に戻る)。チェックした行だけ「選択した作品を登録」で `webSeedSelected([{url, readCount}])` に渡す。**選択登録は目次を読んで記録を保存するだけで、本文もドキュメントも作らない**(`docIds:[]` のまま保存される)。実際にドキュメントを作るには、登録後に一覧タブで対象作品の「続き取得」(または「一括続き取得」)を別途実行する必要がある。続き取得側は `docIds` が空でも正しく新規ドキュメントを作成する(`resolveBuildTarget_` が「追記できる既存ドキュメントが無い→新規作成」に倒れる。`test_seed_selected.js` の「登録後は続き取得の対象になる」セクションで実地確認済み)。渡す `readCount`(`seedEffectiveReadCount_` が算出。開始話数の手動指定があればそれを優先し、無ければ自動計算値、どちらも無ければ省略してサーバー側で「全話取得済み」扱いにする)。カクヨム側から渡ってくる `title` 等の外部由来テキストも `textContent` で描画する(他の一覧と同じ XSS 対策)。
- **デプロイ**: `deploy.yml` は `clasp push` のみでデプロイ版数を更新しない。**テストデプロイの `/dev` URL は常に最新コード**で動くので、この運用では `/dev` を使う。`/exec` を使うには `clasp deploy` の追加が要る。マニフェストの `webapp` 設定と `HtmlService` は追加スコープ不要(再認可不要)。
- **XSS**: 作品タイトル等の外部由来テキストは必ず `textContent` で描画する。`innerHTML` に流し込まない。
- **ポーリングは取得操作を実行している間だけ**(`scheduleNextRefresh`): `webGetState` の応答で `running.active` が true の間だけ `POLL_MS`(7 秒)後の次回を予約する自走方式。**待機中は次回を予約せず完全に止まる**。再開のきっかけはボタン操作(`call()` 成功時の `refresh()`)・「今すぐ更新」・ページ再読み込み。失敗時は状態不明なので `POLL_MS` 後に 1 回再試行。Web UI の外(GAS エディタ)から開始した run には、リロードかボタン操作まで気づかない(許容済み)。
- **バックグラウンドタブ対策**(`visibilitychange`): ブラウザは非表示タブのタイマーを間引くため、実行中に離席すると完了に気づけないまま止まる。**タブが隠れた瞬間に `running.active` だった場合だけ**、再表示時に `refresh()` を 1 回実行して追いつく。待機中のタブ切り替えでは何も起きない(無条件に `refresh()` すると、離席中に完了した作品の次話・サイズ問い合わせがタブを見せるたびにまとめて走る)。
- **並び替え・絞り込みはクライアント側だけで完結**(`renderTable` / `compareWorks`)。設定は `view` に保持し自動更新で失われない。同値時はタイトル・作品IDでタイブレーク。`total` は文字列で来るので `Number()` してから比較する。「未読のみ表示」(`#unreadOnly`)は `readingEp[workId] === 'latest'` の作品を除外するだけで、判定中(未取得)の作品は除外しない。
- **「一覧」「候補から選んで登録」はタブ切り替え**: 候補一覧が画面下部にあって参照しづらかったため、2枚のカード(`#tabPanel-works` / `#tabPanel-seed`)をタブ化した。`activeTab`(クライアント側変数)を `setActiveTab(tab)` で切り替え、`renderTabs()` が `.tab-btn` の `active` クラス付け替えと対象パネルの `hidden` を同期する。**`render()` からは触らない**(自動更新のたびに選択タブへ戻ると使いにくいため、ポーリングと無関係に保持する)。タブ見出しの件数(`#tabWorksCount` / `#tabSeedCount`)は `renderTable()` / `renderSeedList()` がそれぞれ自分の描画のついでに更新する。状態行・ログ・「取得」「設定・その他」カードはタブの外(常時表示)。

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
- `BATCH_KIND` … 進行中の一括処理の種別(`'cont'`=一括続き取得 / `'seed'`=選択登録)。Web UI の進捗文言の分岐にのみ使う(処理そのものは `mode` がキュー要素ごとに持つので、混在しても実害はない)。
- `BATCH_TOTAL` / `BATCH_FETCHED` / `BATCH_SEEDED` … 一括の進捗。`BATCH_TOTAL` は積んだ作品の総数(表示の分母。`webClearQueue` で取り消した分は減らす)、`BATCH_FETCHED` は新着ありで取得に入った回数、`BATCH_SEEDED` は選択登録で記録を保存できた回数。確認済み件数は保存せず `BATCH_TOTAL − キュー長` で求める(`webGetState` の `batchDone`)。`finishBatch_` / `resetAll` が消す。
- `BATCH_RESULT` … 直近の一括の結果 1 行。消さない(Web UI は開いている間に値が変わったときだけログに出す)。
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
- **検証**(`/verify`): GAS はローカル実行不可。編集後は必ず `npm test`(`tests/run.js`。全 `.js` と `index.html` の `<script>` 部の `node --check` + `tests/test_*.js` の模擬実行)を通す。模擬実行は Node の `vm` に `tests/harness/gas-mock.js`(GAS API)/ `tests/harness/dom-mock.js`(DOM)でソースを読み込む方式。**新しい挙動には `tests/` に回帰テストを足す**(戻してはいけない設計判断との対応表は `.claude/skills/verify/SKILL.md`)。使い捨ての実験だけスクラッチ領域に置く。`tests/` と `.claude/` は clasp の `rootDir` 外なので GAS には同期されない。実機確認はユーザーが `/dev` を再読み込みして行う。
- **反映の手順**(`/release`): コミット → `git push -u origin main` → GitHub Actions `deploy.yml` を `workflow_dispatch` で起動(`clasp push`)→ 実行結果が success であることを確認。`kaku_scraping/src` を変えた push では必ずトリガーする(ドキュメント・テストだけなら不要)。完了後にユーザーへ「何を変えたか・どう検証したか・何を確認してほしいか」を簡潔に報告する。手順の詳細(使う MCP ツール名、失敗時の見方)は `.claude/skills/release/SKILL.md`。
- 削除した定数・関数・フェーズ名は**残存参照を grep で確認**する。コメントも実装と食い違わせない(過去に旧列構成・旧フォント名の記述が残って事故のもとになった)。
- マニフェスト(`appsscript.json`)を変えたら再認可が必要になる旨をユーザーに伝える。

## 戻してはいけない設計判断(過去の不具合の再発防止)

- OOM 経路(上記「実行環境と制約」)。Docs API で本文を読む案は形を変えても却下。
- Web UI の完了検知に `running.active` の true→false エッジ検出を使わない。バックグラウンドタブでは遷移の瞬間を取りこぼして二度と検出できない。**`updatedAt` の差分検出**(`refreshChangedWorks`)が正。
- `refreshChangedWorks` のサイズ取得を次話側の dedup に巻き込まない(上記)。
- 待機中の常時ポーリングを復活させない。`visibilitychange` で無条件に `refresh()` しない。
- **`batchStartNext` を呼ぶ前に `PHASE` を空のままにしない**。この関数は目次取得(ネットワーク・新着無しの作品は読み飛ばすので長い)を伴い、その間 `PHASE` が無いと `isRunActive_` が false → Web UI が「待機中」と判断してポーリングを永久に止める。`finishRun` のバッチ分岐は呼ぶ直前に、開始側(`startContinuationAll` / `webStartContinuationAll`)は `startBatch_` の中で `PHASE_BATCH_NEXT` を立てている(2026-09 の「取得状況が画面更新されない」不具合の原因)。
- **Web リクエストの中で新着確認(目次取得)をしない**。`webStartContinuationAll` が `batchStartNext` を直接呼んでいた頃は、全作品に新着が無いと応答が数分返らず、その間ボタンはグレーアウト・表示は「待機中」のまま止まった。確認は必ず `continuesFetch` の `BATCH_NEXT` 分岐(トリガー実行)で行い、リクエストは `startBatch_` + `ensureTriggerAfter` で即座に返す。
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
