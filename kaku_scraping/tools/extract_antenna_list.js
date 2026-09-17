// カクヨムの「閲覧履歴」または「未読あり」ページから作品一覧を抽出するツール。
// GAS には同期されない（clasp の rootDir は kaku_scraping/src）。認証はブラウザの
// ログイン状態をそのまま使うだけで、この端末側にも Web アプリ側にも保存しない。
//
// 同じロジックを index.html の kakuyomuExtractCandidates_() にも置き、ブックマークレット
// （「候補から選んで登録」カードのドラッグ用リンク）として使えるようにしている。
// ロジックを変えたら両方直すこと。こちらはコンソールに直接貼り付けたい場合用。
//
// 使い方:
//   1. ログイン状態のブラウザで以下のいずれかを開く
//        https://kakuyomu.jp/my/antenna/reading_histories                （閲覧履歴）
//        https://kakuyomu.jp/my/antenna/works?serial_status=all         （未読あり。フォロー中のみ）
//      どちらも同じ widget-antennaList 系のマークアップを使っているため、このスクリプトは
//      どちらのページでもそのまま動く。
//   2. 開発者ツール（F12 など）のコンソールタブにこのファイルの中身を貼り付けて実行する。
//   3. 新しいタブが開き、抽出結果の JSON が全選択された状態のテキストエリアが出る。
//      コピーして、カクヨム取得コンソールの「候補から選んで登録」欄に貼り付けて「読み込み」を押す。
//   4. 一覧はページ送り（?page=2 など）されている場合があるので、必要なページごとに
//      繰り返し実行して貼り付ける（貼り付けは作品ID単位で重複しないよう自動でまとめられる）。
//
// 抽出できる情報:
//   url    … 作品ページの URL
//   title  … 作品タイトル
//   unread … 未読話数（カクヨム側の表示をそのまま使う。無ければ null）
//   total  … 全話数（連載中/完結済の話数。無ければ null）
(function () {
  try {
    var items = [];
    document.querySelectorAll('.widget-antennaList-item').forEach(function (li) {
      var link = li.querySelector('.widget-antennaList-workInfo');
      var titleEl = li.querySelector('.widget-antennaList-title');
      if (!link || !titleEl) return;

      var href = link.getAttribute('href') || '';
      var m = href.match(/\/works\/(\d+)/);
      if (!m) return;

      var unread = null;
      var total = null;
      li.querySelectorAll('.widget-antennaList-event li').forEach(function (ev) {
        var t = ev.textContent || '';
        var mu = t.match(/未読\s*(\d+)\s*話/);
        if (mu) unread = Number(mu[1]);
        var mt = t.match(/(?:連載中|完結済)\s*([\d,]+)\s*話/);
        if (mt) total = Number(mt[1].replace(/,/g, ''));
      });

      items.push({
        url:   'https://kakuyomu.jp/works/' + m[1],
        title: titleEl.textContent.trim(),
        unread: unread,
        total:  total,
      });
    });

    if (items.length === 0) {
      alert('作品が見つかりませんでした。カクヨムの閲覧履歴・未読あり一覧のページで実行してください。');
    } else {
      // window.prompt() は使わない。長い文字列だと環境によって表示・コピーの途中で
      // 切れることがあり、貼り付け先で JSON.parse に失敗する（原因が分かりにくい）。
      // 新しいタブに <textarea> を出して全選択した状態で渡す。
      var json = JSON.stringify(items);
      var w = window.open('', '_blank');
      if (!w) {
        window.prompt(
          items.length + ' 件見つかりました（ポップアップがブロックされたため代替表示）。' +
          '全選択（Ctrl+A / Cmd+A）してコピーしてください。',
          json
        );
      } else {
        w.document.title = 'カクヨム抽出結果';
        var p = w.document.createElement('p');
        p.textContent = items.length + ' 件見つかりました。下のテキストは全選択済みです。' +
          'コピー（Ctrl+C / Cmd+C）して、カクヨム取得コンソールの「候補から選んで登録」欄に貼り付けてください。';
        var ta = w.document.createElement('textarea');
        ta.value = json;
        ta.readOnly = true;
        ta.style.width = '100%';
        ta.style.height = '80vh';
        ta.style.boxSizing = 'border-box';
        ta.style.fontFamily = 'monospace';
        w.document.body.appendChild(p);
        w.document.body.appendChild(ta);
        ta.focus();
        ta.select();
      }
    }
  } catch (e) {
    alert('抽出に失敗しました。この内容を報告してください:\n' + (e && e.message ? e.message : e));
  }
})();
