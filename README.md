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
   clasp login --no-localhost
   ```

3. 表示された URL を新しいタブで開き、Google アカウントで認証を許可すると認証コードが表示されるので、コピーしてターミナルに貼り付けて Enter
4. 認証情報を表示してコピー:

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
