---
name: release
description: 変更を main にコミット・push し、GitHub Actions の deploy.yml（clasp push）を起動して結果を確認し、ユーザーへ日本語で報告するまでの定型手順。kaku_scraping/src を変えた作業の締めに使う。
---

# 反映（コミット → push → deploy.yml → 報告）

前提: `/verify`（`npm test`）が通っていること。コードのロジック変更は事前に承認済みであること。

## 手順

1. **最新を取り込む**: `git fetch origin main` して `git rev-list HEAD..origin/main --count` が 0 か確認する。
   0 でなければ（`sync-from-gas.yml` が GAS 側の編集を取り込んでいることがある）`git rebase origin/main` してから `npm test` をやり直す。
2. **コミット**（`main` に直接）: 日本語で「何を・なぜ」。1 行目は変更の要旨、本文に原因と変更点を箇条書き。
   モデル名は書かない。末尾に会話で指示された attribution 行（Co-Authored-By / Claude-Session）を付ける。
   `.claude/` と `tests/` は clasp の `rootDir`（`kaku_scraping/src`）の外なので GAS には同期されない。
3. **push**: `git push -u origin main`。ネットワーク失敗のみ 2s/4s/8s/16s で最大 4 回再試行。
4. **deploy.yml を起動**（`kaku_scraping/src` を変えたときは必須。ドキュメントやテストだけなら不要）:
   `mcp__github__actions_run_trigger` を `method: run_workflow`, `owner: darkphantasy`, `repo: kakuyomu`, `workflow_id: deploy.yml`, `ref: main` で呼ぶ。
   ツールが未ロードなら `ToolSearch` の `select:mcp__github__actions_run_trigger,mcp__github__actions_list,mcp__github__get_job_logs` で読み込む。
5. **結果を確認**: 30〜60 秒待ってから `mcp__github__actions_list` を `method: list_workflow_runs`, `resource_id: deploy.yml`, `perPage: 1` で呼び、
   `head_sha` が push したコミットで `conclusion: success` であることを見る。失敗なら `mcp__github__get_job_logs`（`run_id`, `failed_only: true`, `return_content: true`）で原因を読む。
   よくある失敗: `.clasprc.json` の形式が clasp のバージョンと食い違う（`access_token` の undefined）。これはリポジトリ側では直せないのでユーザーに伝える。
   待つときは foreground の `sleep` は使えないので、`run_in_background` の Bash で `sleep 50` して通知を待つ。
6. **報告**（日本語・簡潔に）: 次の 3 点を見出し付きで。
   - **何を変えたか** … 不具合の原因と対処。触っていない部分（取得ロジック本体など）も一言。
   - **どう検証したか** … `npm test` の本数と件数、追加したテストが何を確かめるか。「GAS 実機は未確認」と明記。
   - **確認してほしいこと** … `/dev` を再読み込みして何をどう操作し、何が見えれば成功か。失敗したときに教えてほしい情報（`checkProgress` の値、ログ欄の文言など）。

## やらないこと

- Pull Request は作らない（`main` 直コミット運用）。
- `clasp deploy`（デプロイ版数の更新）はしない。運用は `/dev` URL。
- マニフェスト（`appsscript.json`）を変えた場合は、再認可が必要になる旨を報告に必ず含める。
