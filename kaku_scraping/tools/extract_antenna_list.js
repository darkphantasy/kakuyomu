// カクヨムの「閲覧履歴」「未読あり」ページ、または小説家になろうの「ブックマーク」ページから
// 作品一覧を抽出するツール。GAS には同期されない（clasp の rootDir は kaku_scraping/src）。
// 認証はブラウザのログイン状態をそのまま使うだけで、この端末側にも Web アプリ側にも保存しない。
//
// 同じロジックを index.html の extractSeedCandidates_() にも置き、ブックマークレット
// （「候補から選んで登録」カードのドラッグ用リンク）として使えるようにしている。
// ロジックを変えたら両方直すこと（下の関数本体は index.html のものと同一）。
// こちらはコンソールに直接貼り付けたい場合用。
//
// 使い方:
//   1. ログイン状態のブラウザで以下のいずれかを開く
//        https://kakuyomu.jp/my/antenna/reading_histories                （カクヨム 閲覧履歴）
//        https://kakuyomu.jp/my/antenna/works?serial_status=all         （カクヨム 未読あり。フォロー中のみ）
//        https://syosetu.com/favnovelmain/list/                         （なろう ブックマーク。カテゴリ・
//                                                                        更新チェック中の一覧でも可）
//   2. 開発者ツール（F12 など）のコンソールタブにこのファイルの中身を貼り付けて実行する。
//   3. 新しいタブが開き、抽出結果の JSON が全選択された状態のテキストエリアが出る。
//      コピーして、取得コンソールの「候補から選んで登録」欄に貼り付けて「読み込み」を押す。
//      なろうはブックマークの残りのページも 1 秒間隔で自動的に読み込む。
//      カクヨムは開いているページの分だけなので、ページ送りされている場合は必要なページごとに
//      実行し、JSON を結合してから 1 回で貼り付ける（読み込みは置き換え式のため）。
//
// 抽出できる情報:
//   url    … 作品ページの URL
//   title  … 作品タイトル
//   unread … 未読話数（サイト側の表示をそのまま使う。無ければ null）
//   total  … 全話数（無ければ null。なろうの短編は 1）
//   siori  … なろうのみ。しおりを挟んだ話（無ければ null）。登録時の開始話数の初期値になる
function extractSeedCandidates_() {
  // 結果の受け渡し（両サイト共通）。window.prompt() は使わない。長い文字列だと環境によって
  // 表示・コピーの途中で切れることがあり、貼り付け先で JSON.parse に失敗する（原因が
  // 分かりにくい）。新しいタブに <textarea> を出して全選択した状態で渡す。
  //   w が null（ポップアップがブロックされた）のときだけ window.prompt にフォールバックする。
  function showResult(items, w, siteLabel, note) {
    var json = JSON.stringify(items);
    if (!w) {
      window.prompt(
        items.length + ' 件見つかりました（ポップアップがブロックされたため代替表示）。' +
        '全選択（Ctrl+A / Cmd+A）してコピーしてください。' + (note || ''),
        json
      );
      return;
    }
    w.document.title = siteLabel + '抽出結果';
    var p = w.document.createElement('p');
    p.textContent = items.length + ' 件見つかりました。下のテキストは全選択済みです。' +
      'コピー（Ctrl+C / Cmd+C）して、取得コンソールの「候補から選んで登録」欄に貼り付けてください。' + (note || '');
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

  // ---- 小説家になろう：ブックマーク一覧（https://syosetu.com/favnovelmain/list/ など） ----
  //   いま開いているページだけでなく、ページ送りされた残りのページも順に読み込む
  //   （ブックマークは 1 ページ 30〜50 件で、全件だと 10 ページ前後になるため）。
  //   読み込みはブラウザのログイン状態のまま同じサイトへ 1 秒間隔で行う。
  //   HTML は文字列のまま正規表現で読む（いま開いているページも、読み込んだ残りのページも
  //   同じ関数で処理できるようにするため）。
  function decodeEntities(s) {
    return String(s || '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&#x([0-9a-f]+);/gi, function (_, h) { return String.fromCharCode(parseInt(h, 16)); })
      .replace(/&#(\d+);/g, function (_, d) { return String.fromCharCode(Number(d)); })
      .replace(/&amp;/g, '&');
  }
  function narouItems(html) {
    var items = [];
    var parts = String(html).split(/<li[^>]*class="[^"]*\bp-up-bookmark-item\b[^"]*"[^>]*>/).slice(1);
    parts.forEach(function (it) {
      var tm = it.match(/class="[^"]*\bp-up-bookmark-item__title\b[^"]*"[^>]*>\s*<a[^>]+href="https?:\/\/ncode\.syosetu\.com\/(n\d+[a-z]+)\/?"[^>]*>([\s\S]*?)<\/a>/i);
      if (!tm) return;
      var ncode = tm[1].toLowerCase();
      var dt = it.match(/data-title="([^"]*)"/); // 一覧の表示は途中で「…」に切られるので、こちらが全文
      var title = dt ? decodeEntities(dt[1])
        : decodeEntities(tm[2].replace(/<span[^>]*>[\s\S]*?<\/span>/g, '').replace(/<[^>]+>/g, '')).trim();
      var mt = it.match(/全\s*([\d,]+)\s*エピソード/);
      var total = mt ? Number(mt[1].replace(/,/g, '')) : (/c-up-label--novel-short/.test(it) ? 1 : null);
      var ms = it.match(/p-icon--siori[^>]*>\s*<\/span>\s*ep\.\s*(\d+)/);
      var mu = it.match(/p-up-bookmark-item__unread-num[^>]*>\s*(\d+)/);
      var unread = mu ? Number(mu[1]) : (/未読はありません/.test(it) ? 0 : null);
      items.push({
        url:    'https://ncode.syosetu.com/' + ncode + '/',
        title:  title.replace(/\s+/g, ' ').trim(),
        unread: unread,
        total:  total,
        siori:  ms ? Number(ms[1]) : null, // しおりを挟んだ話。登録時の開始話数の初期値になる
      });
    });
    return items;
  }
  function narouPageInfo(html) {
    var cur = String(html).match(/c-up-pager__item is-current[^>]*>\s*(\d+)/);
    var lastTag = String(html).match(/<a\s[^>]*title="最後のページ"[^>]*>/);
    var lastHref = lastTag && lastTag[0].match(/href="([^"]+)"/);
    var href = lastHref ? decodeEntities(lastHref[1]) : null;
    var lastP = href && href.match(/[?&]p=(\d+)/);
    return { current: cur ? Number(cur[1]) : 1, last: lastP ? Number(lastP[1]) : 1, lastHref: href };
  }

  try {
    if (/(^|\.)syosetu\.com$/.test(location.hostname || '')) {
      var html0 = document.documentElement.outerHTML;
      var all = narouItems(html0);
      if (all.length === 0) {
        alert('作品が見つかりませんでした。小説家になろうのブックマーク一覧（https://syosetu.com/favnovelmain/list/）で実行してください。');
        return;
      }
      var seen = {};
      all.forEach(function (x) { seen[x.url] = true; });
      var info = narouPageInfo(html0);
      var pages = [];
      for (var pg = 1; pg <= info.last; pg++) if (pg !== info.current) pages.push(pg);

      // 新しいタブはクリックの直後（＝この同期処理の中）で開く。残りのページを読み込んだ後
      // （非同期の後）に開こうとすると、ポップアップとしてブロックされるため。
      var w = window.open('', '_blank');
      var msg = null;
      if (w) {
        w.document.title = 'なろう抽出中…';
        msg = w.document.createElement('p');
        msg.textContent = 'ブックマークを読み込んでいます… 1 / ' + (pages.length + 1) + ' ページ';
        w.document.body.appendChild(msg);
      }
      var failed = [];
      var chain = Promise.resolve();
      pages.forEach(function (p, k) {
        chain = chain
          .then(function () { return new Promise(function (r) { setTimeout(r, 1000); }); })
          .then(function () {
            var u = new URL(info.lastHref, location.href);
            u.searchParams.set('p', String(p));
            return fetch(u.toString(), { credentials: 'same-origin' });
          })
          .then(function (res) {
            if (!res.ok) throw new Error('HTTP ' + res.status);
            return res.text();
          })
          .then(function (h) {
            narouItems(h).forEach(function (x) { if (!seen[x.url]) { seen[x.url] = true; all.push(x); } });
          })
          .catch(function () { failed.push(p); })
          .then(function () {
            if (msg) msg.textContent = 'ブックマークを読み込んでいます… ' + (k + 2) + ' / ' + (pages.length + 1) + ' ページ';
          });
      });
      return chain.then(function () {
        if (msg) msg.textContent = '';
        var note = failed.length
          ? '（' + failed.join('・') + ' ページ目は読み込めませんでした。必要ならそのページを開いて実行し直してください）'
          : '';
        showResult(all, w, 'なろう', note);
      }).catch(function (e) {
        alert('抽出に失敗しました。この内容を報告してください:\n' + (e && e.message ? e.message : e));
      });
    }

    // ---- カクヨム：閲覧履歴・未読あり一覧 ----
    var items = [];
    document.querySelectorAll('.widget-antennaList-item').forEach(function (li) {
      var link = li.querySelector('.widget-antennaList-workInfo');
      var titleEl = li.querySelector('.widget-antennaList-title');
      if (!link || !titleEl) return;
      var href = link.getAttribute('href') || '';
      var m = href.match(/\/works\/(\d+)/);
      if (!m) return;

      var unread = null, total = null;
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
      alert('作品が見つかりませんでした。カクヨムの閲覧履歴・未読あり一覧、または小説家になろうのブックマーク一覧のページで実行してください。');
      return;
    }
    showResult(items, window.open('', '_blank'), 'カクヨム');
  } catch (e) {
    // try/catch で包む理由: ここで例外が起きるとブックマークレットは「クリックしても
    // 何も起きない」ように見える（javascript: URI 実行時のエラーは画面に出ない）。
    // 何が起きたか必ず alert で可視化する。
    alert('抽出に失敗しました。この内容を報告してください:\n' + (e && e.message ? e.message : e));
  }
}

extractSeedCandidates_();
