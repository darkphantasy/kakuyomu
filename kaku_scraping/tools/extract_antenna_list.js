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
//        https://kakuyomu.jp/my/reading_histories                       （閲覧履歴）
//        https://kakuyomu.jp/my/antenna/works?serial_status=all         （未読あり。フォロー中のみ）
//      どちらも同じ widget-antennaList 系のマークアップを使っているため、このスクリプトは
//      どちらのページでもそのまま動く。
//   2. 開発者ツール（F12 など）のコンソールタブにこのファイルの中身を貼り付けて実行する。
//   3. ダイアログに表示された JSON を全選択・コピーし、カクヨム取得コンソールの
//      「候補から選んで登録」欄に貼り付けて「読み込み」を押す。
//   4. 一覧はページ送り（?page=2 など）されている場合があるので、必要なページごとに
//      繰り返し実行して貼り付ける（貼り付けは作品ID単位で重複しないよう自動でまとめられる）。
//
// 抽出できる情報:
//   url    … 作品ページの URL
//   title  … 作品タイトル
//   unread … 未読話数（カクヨム側の表示をそのまま使う。無ければ null）
//   total  … 全話数（連載中/完結済の話数。無ければ null）
(function () {
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
      var mu = t.match(/未読(\d+)話/);
      if (mu) unread = Number(mu[1]);
      var mt = t.match(/(?:連載中|完結済)([\d,]+)話/);
      if (mt) total = Number(mt[1].replace(/,/g, ''));
    });

    items.push({
      url:   'https://kakuyomu.jp/works/' + m[1],
      title: titleEl.textContent.trim(),
      unread: unread,
      total:  total,
    });
  });

  var json = JSON.stringify(items);
  window.prompt(
    items.length + ' 件見つかりました。全選択（Ctrl+A / Cmd+A）してコピーし、' +
    'カクヨム取得コンソールの「候補から選んで登録」欄に貼り付けてください。',
    json
  );
})();
