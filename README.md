# kakuyomu (Google Apps Script)

カクヨムの小説を取得して Google ドキュメントに保存する Google Apps Script (GAS) を、[clasp](https://github.com/google/clasp) を使って GitHub でバージョン管理するリポジトリです。

## 収録プロジェクト

| ディレクトリ | GASプロジェクト | 内容 |
| --- | --- | --- |
| [`kaku_scraping/`](kaku_scraping/) | KAKU_SCRAPING | カクヨム小説取得 → Googleドキュメント保存(2026-06 改修版)。続き取得・索引スプレッドシート対応 |

`kaku_scraping/.clasp.json` に GAS のスクリプト ID が設定済みで、`src/` 以下が実際のコードです。

> 旧版の KAKU2 は取り込み後に削除しました。必要であれば Git 履歴(コミット `464525f`)から参照できます。

## 機能一覧

### 小説の取得・保存

- **初回取得**(`startFetch`): カクヨムの作品 URL(`KAKUYOMU_URL`)から全話を取得し、書式を整えた Google ドキュメントとして保存する
- **続き取得**(`startContinuation`): 前回保存した続きから、追加された話だけを差分取得して既存ドキュメントに追記する
- **一括続き取得**(`startContinuationAll`): 保存済みの全作品をまとめて続き取得する。新着が無い作品は自動でスキップ
- **続き取得の一覧への追加**(`seedResumeRecord`): 別経路で保存済みの作品を、続き取得の対象として登録する(既存ドキュメントIDの紐付けも可)
- **続き取得の一覧からの削除**(`clearResumeRecord`): 特定の作品を続き取得の対象から外す。取得済みドキュメント自体は削除されない。実行すると索引スプレッドシートも合わせて更新される
- **索引シートとの差分同期**(`syncResumeRecordsFromSheet`): 索引スプレッドシートの行を正として一覧を同期する。行を追加すれば追加、行を削除すれば削除として反映される(推奨。詳細は下記)

### 進捗・記録の確認

- **進捗確認**(`checkProgress`): 実行中の取得・保存処理の進み具合を確認する
- **続き取得記録の確認**(`checkResume`) / **全記録の一覧表示**(`listResumeRecords`): 作品ごとの取得状況(最終話・保存先ドキュメント等)を確認する

### 索引・復旧

- **索引スプレッドシートの自動生成・更新**: 保存先フォルダに、作品タイトル・話数・最終更新日時・各ドキュメントへのリンクをまとめた一覧シートを自動生成する
- **索引の手動再生成**(`rebuildIndex`): 索引シートを今すぐ最新の記録から作り直す
- **記録の復元**(`rebuildRecordsFromSheet`): 索引シートの内容から続き取得の記録を復元する(スクリプトの作り替え後などの復旧用)

#### 続き取得の一覧をスプレッドシートで管理する(推奨)

続き取得の一覧は Script Properties(`RESUME_<作品ID>`)が正のデータで、索引スプレッドシートはそこから毎回生成される一覧表示です。ただし `syncResumeRecordsFromSheet` を使うと、**スプレッドシートの行を編集するだけで一覧への追加・削除ができます**:

- **追加したいとき**: 索引シートに新しい行を作り、タイトル(A列)と作品の URL(E列「元URL」)を入力して `syncResumeRecordsFromSheet` を実行する。カクヨムから現在地を自動取得して記録される(既にファイル列に `=HYPERLINK()` で既存ドキュメントへのリンクがあれば、それも追記先として引き継がれる)
- **削除したいとき**: 索引シートからその作品の行を削除して `syncResumeRecordsFromSheet` を実行する(記録のみ削除。取得済みドキュメント自体は消えない)
- 追加・削除のどちらでもない、**既に一覧にある作品の行**は変更しても無視される(`lastEpisodeId` 等の内部状態を保持するため)。次に `updateIndexSpreadsheet` が走ると、タイトル等は記録側の値に戻る

### 実行の自動継続・安全策

- Google Apps Script の実行時間上限(6分)に対し、5分で自主的に中断してトリガーで自動再開する多段実行方式。時間が残っていれば複数の処理(取得→保存、作品→次の作品)を同一実行内で連続処理する
- 巨大なドキュメント(1作品最大 90万字)でもメモリ不足を起こさない、安全な読み書き方式を採用
- ドキュメントが `MAX_DOC_CHARS` を超える場合は自動で分冊
- **途中状態のリセット**(`resetAll`): 記録・索引は残したまま、実行中の一時状態だけをリセットする

### 書式の整形

- 見出し(作品名・話タイトル)、本文の字下げ(会話文は字下げしない)、フォント・行間・段落間隔を自動で整える
- **既存ドキュメントへの書式再適用**(`kaku_scraping/src/Reformat_existing_docs.js`): 内容はそのままに、現在の書式ルールだけを既存ドキュメントへ再適用する独立ツール

> 詳しい制約・設計判断(メモリ制約への対応方針や書式仕様の詳細など)は [`CLAUDE.md`](CLAUDE.md) を参照してください。

## 運用の流れ

普段の編集は今までどおり **GAS のオンラインエディタ**で行えます。バージョン管理は自動で行われます:

```
GASオンラインエディタで編集
        ↓ (毎日 6:00 JST に自動実行)
GitHub Actions が clasp pull → 変更があれば自動コミット
        ↓
GitHub に履歴が積み上がる(いつでも過去の版に戻れる)
```

- 取り込みを今すぐ実行したいときは、GitHub の **Actions タブ →「Sync from Google Apps Script」→ Run workflow**
- 逆に GitHub 側でコードを直したときは、**Actions タブ → 「Deploy to Google Apps Script」→ Run workflow** で GAS に反映(誤上書き防止のため手動実行のみ)

## 初回セットアップ(1回だけ)

自動同期を動かすには、GAS にアクセスするための認証情報を GitHub に登録する必要があります。

### 1. Apps Script API を有効化

GAS を使っている Google アカウントで https://script.google.com/home/usersettings を開き、「Google Apps Script API」を **オン** にする。

### 2. clasp にログインして認証情報を取得

**方法A: ブラウザだけで完結(Google Cloud Shell、おすすめ)**

PCへのインストールは不要です。

1. GAS と同じ Google アカウントで https://shell.cloud.google.com を開く(初回は利用規約に同意)
2. 画面下のターミナルで次を実行:

   ```bash
   npm install -g @google/clasp@3.3.0
   clasp --version
   clasp login
   ```

   `clasp --version` の出力が `3.3.0` になっていることを確認すること。環境によっては別バージョンの clasp が既に入っていて `npm install` の指定が反映されないことがある(実際に一度これが原因で同期が失敗した)。表示されたバージョンが異なる場合は、[3. 認証情報を GitHub Secrets に登録](#3-認証情報を-github-secrets-に登録)の後にある注意書きに従い、ワークフロー側のバージョンもそれに合わせて修正すること。

3. 表示された URL を新しいタブで開き、Google アカウントで認証を許可する
4. 認証後、「このサイトにアクセスできません(localhost で接続が拒否されました)」というページになるが、**これは想定どおり**。認証コードはこのページの URL に含まれているので、アドレスバーの URL 全体(`http://localhost:数字/?code=...`)をコピーする
5. Cloud Shell のターミナルで「+」を押して**新しいタブ**を開き、コピーした URL を引用符で囲んで実行:

   ```bash
   curl "http://localhost:数字/?code=...(コピーしたURL全体)"
   ```

6. 元のターミナルタブに戻り、ログイン完了のメッセージ(`Authorization successful.` 等)が出ていることを確認する
7. 認証情報の中身を確認する:

   ```bash
   cat ~/.clasprc.json
   ```

   出力に `"access_token"` という文字列が実際に含まれているか目で確認する(空・不完全なファイルのまま Secret に登録すると、同期が `Cannot read properties of undefined (reading 'access_token')` エラーで失敗する)
8. 念のため、その場で動作確認する:

   ```bash
   cd /tmp && git clone --depth 1 https://github.com/darkphantasy/kakuyomu.git test-clasp
   cd test-clasp/kaku_scraping && clasp pull
   ```

   ファイルが正常に取得できれば OK。確認後 `test-clasp` フォルダは削除して構わない
9. 問題なければ `cat ~/.clasprc.json` の中身をコピーする

**方法B: 手元のPCで実行**

Node.js(v18以上)が入っているPCで:

```bash
npm install -g @google/clasp@3.3.0
clasp --version   # 3.3.0 になっていることを確認
clasp login       # ブラウザが開くので Google アカウントで認証

cat ~/.clasprc.json          # macOS / Linux
type %USERPROFILE%\.clasprc.json   # Windows
```

### 3. 認証情報を GitHub Secrets に登録

GitHub リポジトリの **Settings → Secrets and variables → Actions → New repository secret** で、名前を `CLASPRC_JSON`、値に上記の中身を貼り付けて保存。

> **注意**: `.clasprc.json` は Google アカウントの認証トークンです。Secret 以外の場所(コードやコミット、チャット)には絶対に貼らないでください。トークンが失効して同期が認証エラーで失敗するようになったら、`clasp login` し直して Secret を更新してください。
>
> 同期が `Cannot read properties of undefined (reading 'access_token')` で失敗する場合、考えられる原因は次の2つです。
> 1. Secret に登録した認証情報が不完全(上記の手順7・8の確認を行ってから Secret を登録し直す)
> 2. **ログイン時の clasp バージョンと、`.github/workflows/*.yml` の `Install clasp` ステップで入れているバージョンが食い違っている**(`.clasprc.json` の形式はメジャーバージョン間で互換性が無い)。ログイン時に `clasp --version` で確認したバージョンと、ワークフローの `npm install -g @google/clasp@x.x.x` の指定を必ず一致させること。

## ローカルで開発したい場合(任意)

```bash
git clone <このリポジトリ>
cd kakuyomu
npm install
npx clasp login

npm run pull     # GAS → ローカル
npm run push     # ローカル → GAS
npm run open     # ブラウザで GAS エディタを開く
```

## Claude Code でコードを修正する場合

このプロジェクトの設計判断・制約(OOM を避ける読み出し方法、cursor の扱い、書式仕様など)は [`CLAUDE.md`](CLAUDE.md) にまとめてあります。Claude Code はこのファイルを自動で読み込むため、修正を依頼する際に毎回説明し直す必要はありません。

開発ループ:

1. Claude Code に修正を依頼する
2. 編集後、構文チェックを実行(`node --check kaku_scraping/src/Kakuyomu_to_docs.js`)
3. ブランチに commit・push → PR を作成 → 差分を確認して `main` にマージ
4. マージ後、GitHub の **Actions タブ → 「Deploy to Google Apps Script」→ Run workflow** で GAS に反映
5. GAS エディタで対象関数(`startFetch` 等)を実行し、実行ログを確認
6. 問題があればログを Claude Code に貼って次の修正へ

GAS エディタ側で直接編集した内容は `sync-from-gas.yml` が毎日自動で `main` に取り込むため、Claude Code で作業を始める前に `git pull` して最新化しておくこと。

## ディレクトリ構成

```
.
├── kaku_scraping/
│   ├── .clasp.json           # スクリプトID設定
│   └── src/
│       ├── appsscript.json   # GASマニフェスト
│       ├── Kakuyomu_to_docs.js
│       └── Reformat_existing_docs.js
└── .github/workflows/
    ├── sync-from-gas.yml     # GAS → GitHub 自動同期(毎日)
    └── deploy.yml            # GitHub → GAS 反映(手動)
```
