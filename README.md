# kakuyomu (Google Apps Script)

Google Apps Script (GAS) のコードを [clasp](https://github.com/google/clasp) を使って GitHub でバージョン管理するためのリポジトリです。

## 仕組み

```
GASエディタ  ⇄  ローカル (src/)  ⇄  GitHub
        clasp pull/push        git commit/push
```

- GAS のコードは `src/` ディレクトリに置きます
- `clasp push` でローカル → GAS、`clasp pull` で GAS → ローカルに同期します
- `main` ブランチに push すると GitHub Actions が自動で GAS にデプロイします(設定は後述)

## 初回セットアップ

### 1. 前提条件

- [Node.js](https://nodejs.org/)(v18 以上)がインストールされていること
- GAS を使う Google アカウントで [Apps Script API](https://script.google.com/home/usersettings) を **オン** にしておくこと

### 2. インストールとログイン

```bash
npm install          # clasp をインストール
npx clasp login      # ブラウザが開くので Google アカウントで認証
```

### 3. 既存の GAS プロジェクトと紐づける

GAS エディタで「プロジェクトの設定」→「スクリプト ID」をコピーし、`.clasp.json` を作成します:

```bash
cp .clasp.json.example .clasp.json
# .clasp.json を開いて scriptId を書き換える
```

既存のコードを取り込む場合:

```bash
npx clasp pull       # GAS 側のコードを src/ にダウンロード
git add . && git commit -m "GASから既存コードを取り込み"
```

> 新規プロジェクトから始める場合は `npx clasp create --type standalone --rootDir src` でも作成できます(`.clasp.json` が自動生成されます)。

## 日々の開発フロー

```bash
# 1. ローカルで src/ 以下のコードを編集

# 2. GAS に反映して動作確認
npm run push         # = clasp push

# 3. 問題なければ git にコミット
git add .
git commit -m "変更内容"
git push
```

GAS エディタ側で直接編集してしまった場合は `npm run pull` でローカルに取り込んでからコミットしてください。

### 便利コマンド

| コマンド | 内容 |
| --- | --- |
| `npm run push` | ローカルのコードを GAS に反映 |
| `npm run pull` | GAS のコードをローカルに取得 |
| `npm run open` | ブラウザで GAS エディタを開く |
| `npm run status` | push 対象のファイル一覧を確認 |

## GitHub Actions による自動デプロイ

`main` ブランチの `src/` 配下が更新されると、[.github/workflows/deploy.yml](.github/workflows/deploy.yml) が自動で `clasp push` を実行します。

有効にするには、リポジトリの **Settings → Secrets and variables → Actions** で以下の 2 つの Secret を登録してください:

| Secret 名 | 値 |
| --- | --- |
| `CLASPRC_JSON` | ローカルで `clasp login` した後に生成される `~/.clasprc.json` の中身(macOS/Linux は `cat ~/.clasprc.json`、Windows は `type %USERPROFILE%\.clasprc.json` で表示) |
| `SCRIPT_ID` | GAS のスクリプト ID |

> **注意**: `.clasprc.json` は Google アカウントの認証トークンです。Secret 以外の場所(コードやコミット)には絶対に含めないでください。`.gitignore` で `.clasprc.json` と `.clasp.json` は除外済みです。
>
> トークンは一定期間で失効することがあります。Actions のデプロイが認証エラーで失敗するようになったら、ローカルで `clasp login` し直して Secret を更新してください。

## ディレクトリ構成

```
.
├── src/                  # GAS のコード(ここだけが GAS に同期される)
│   ├── appsscript.json   # GAS のマニフェスト(タイムゾーン・権限など)
│   └── main.js           # スクリプト本体(.js は GAS 側で .gs になる)
├── .clasp.json           # スクリプトIDの設定(各自作成・コミットしない)
├── .clasp.json.example   # ↑のテンプレート
├── .claspignore          # clasp push の対象外設定
└── .github/workflows/    # 自動デプロイ設定
```
