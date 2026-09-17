---
name: verify
description: kaku_scraping/src を編集したあとの検証手順。構文チェックと Node vm の模擬実行（npm test）を回し、新しい挙動には tests/harness を使った回帰テストを足す。コードを変えたら必ずコミット前に使う。
---

# 検証（構文チェック + 模擬実行）

GAS はローカルで実行できないので、検証は次の 2 段で行う。

## 1. 一括実行

```bash
npm test                      # 構文チェック + tests/test_*.js 全部
node tests/run.js batch kick  # ファイル名に batch / kick を含むテストだけ（構文チェックは常に走る）
node tests/test_e2e_pipeline.js   # 1 本だけ詳しく見る
```

`tests/run.js` は各テストの「合計: X 件成功 / Y 件失敗」行を集計し、失敗があれば exit 1 になる。
FAIL 行と「期待 / 実際」を読んで、**テストの期待値が古いのか、コードの退行なのか**を必ず切り分ける
（ログ行に時刻が付く、`total` が文字列で来る、といった器の都合で落ちることが多い）。

## 2. 新しい挙動にはテストを足す

`tests/harness/` を使って `tests/test_<題材>.js` を書く。既存の同種テストを 1 本読んでから真似る。

- **サーバー側（フェーズ機械・web\* 関数）** … `tests/harness/gas-mock.js`
  ```js
  const { createGasSandbox, registerWork } = require('./harness/gas-mock');
  const { check, section, finish } = require('./harness/check');
  const htmlByUrl = registerWork({}, '777', 'テスト作品', 3);   // 目次 + 3 話ぶんの HTML
  const { g, state } = createGasSandbox({ htmlByUrl });
  g('webStartFetch("https://kakuyomu.jp/works/777")');
  check('PHASE', state.props.PHASE, 'FETCHING');
  g('continuesFetch()');                                       // トリガー実行の代わり
  finish();
  ```
  `state.props`（Script Properties）・`state.triggers`・`state.docs`・`state.files` を直接読み書きできる。
  Drive export の Range 応答など特殊な HTTP は `createGasSandbox({ fetch: (url, opt) => ... })` で差し込む。
- **クライアント側（index.html）** … `tests/harness/dom-mock.js`
  ```js
  const { createUiSandbox } = require('./harness/dom-mock');
  const { g, state, render } = createUiSandbox({ runner });   // runner = google.script.run の実体
  render({ works: [], running: { active: true, phase: 'BATCH_NEXT', batchNext: true, batchTotal: 22, batchDone: 3 }, queueCount: 0, shortFilename: true, lastBatchResult: '' });
  check('状態行', state.texts.runText, '新着を確認中… 3 / 22 作品');
  ```
  `state.logs`（ログ欄）・`state.buttons[i].disabled`・`state.timers`（setTimeout の記録。`fn()` で手動発火）を見る。
  `google.script.run` は `runner` に渡したオブジェクト（または呼ぶたびに新しい実体を返す関数）。
  `withSuccessHandler` / `withFailureHandler` / `web*` をチェーンできるように作る。

テストは **設計判断の再発防止** として残す。CLAUDE.md の「戻してはいけない設計判断」に対応する検証が
どのファイルにあるかを把握しておく：

| 設計判断 | テスト |
|---|---|
| `batchStartNext` 前に `PHASE` を空にしない（画面が待機中で止まる） | `test_active_gap.js` |
| 一括の新着確認をリクエスト内でやらない・k / N の進捗・結果 1 行 | `test_batch_phase.js`, `test_batch_ui.js`, `test_e2e_pipeline.js` |
| 選択登録も同じキュー(`mode:'seed'`)を使い、目次取得をリクエスト内でやらない | `test_seed_selected.js`, `test_seed_ui.js` |
| 開始直後の 1 枠目をクライアントが蹴る（kick） | `test_kick_ui.js`, `test_e2e_pipeline.js` |
| `refresh()` は予約を `render()` より先に | `test_poll_resilience.js` |
| 実行中だけポーリング・待機中は止める | `test_active_only_poll.js` |
| タブ復帰時は隠れた瞬間に実行中だった時だけ `refresh()` | `test_visibility_refresh.js` |
| 次話判定（先頭 2 万字・Range・サイズ付きキャッシュ）と dedup | `test_progress2.js`, `test_ui_progress2.js` |
| 未読のみ表示は 'latest' だけ除外 | `test_unread_filter.js` |
| 可読性リファクタ後の各部品の等価性 | `test_core_refactor.js` |
| 抽出ブックマークレットの未読・全話数の正規表現は空白の有無を問わない | `test_seed_extract.js` |
| 「一覧」「候補から選んで登録」タブの切り替え・自動更新で戻らない | `test_tabs.js` |

## 3. 使い捨ての実験

一度きりの確認（挙動の当たりを付ける、値を眺める）はスクラッチ領域に置いてリポジトリに入れない。
残す価値があると分かった時点で `tests/` に移す。
