# kakuyomu (Google Apps Script)

カクヨムの小説を取得して Google ドキュメントに保存する Google Apps Script (GAS) を、[clasp](https://github.com/google/clasp) を使って GitHub でバージョン管理するリポジトリです。

## 収録プロジェクト

| ディレクトリ | GASプロジェクト | 内容 |
| --- | --- | --- |
| [`kaku_scraping/`](kaku_scraping/) | KAKU_SCRAPING | カクヨム小説取得 → Googleドキュメント保存(2026-06 改修版)。続き取得・索引スプレッドシート対応 |

`kaku_scraping/.clasp.json` に GAS のスクリプト ID が設定済みで、`src/` 以下が実際のコードです。

> 旧版の KAKU2 は取り込み後に削除しました。必要であれば Git 履歴(コミット `464525f`)から参照できます。

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
   npm install -g @google/clasp@2.4.2
   clasp login
   ```

3. 表示された URL を新しいタブで開き、Google アカウントで認証を許可する
4. 認証後、「このサイトにアクセスできません(localhost で接続が拒否されました)」というページになるが、**これは想定どおり**。認証コードはこのページの URL に含まれているので、アドレスバーの URL 全体(`http://localhost:数字/?code=...`)をコピーする
5. Cloud Shell のターミナルで「+」を押して**新しいタブ**を開き、コピーした URL を引用符で囲んで実行:

   ```bash
   curl "http://localhost:数字/?code=...(コピーしたURL全体)"
   ```

6. 元のターミナルタブに戻るとログインが完了しているので、認証情報を表示してコピー:

   ```bash
   cat ~/.clasprc.json
   ```

**方法B: 手元のPCで実行**

Node.js(v18以上)が入っているPCで:

```bash
npm install -g @google/clasp@2.4.2
clasp login    # ブラウザが開くので Google アカウントで認証

cat ~/.clasprc.json          # macOS / Linux
type %USERPROFILE%\.clasprc.json   # Windows
```

### 3. 認証情報を GitHub Secrets に登録

GitHub リポジトリの **Settings → Secrets and variables → Actions → New repository secret** で、名前を `CLASPRC_JSON`、値に上記の中身を貼り付けて保存。

> **注意**: `.clasprc.json` は Google アカウントの認証トークンです。Secret 以外の場所(コードやコミット、チャット)には絶対に貼らないでください。トークンが失効して同期が認証エラーで失敗するようになったら、`clasp login` し直して Secret を更新してください。

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
