// ==========================================
// 小説家になろう（ncode.syosetu.com）対応
//   取得・整形・続き取得・キュー・索引などのパイプラインはサイト共通で、ここにあるのは
//   なろう固有の「目次（タイトル・全話一覧）の取得」と「1話ぶんの本文の抽出」だけ。
//   振り分けは Kakuyomu_to_docs.js 側（loadWorkCatalog_ / extractEpisodeText_）が
//   作品ID の形で行う（カクヨムは数字、なろうは Nコード n1234ab）。サイト判別の部品
//   （extractWorkId / isNarouWorkId_ / narouWorkUrl_ / NAROU_BASE_URL）も向こう側にある。
//   R18（novel18.syosetu.com：ノクターン・ムーンライト等）は年齢確認 Cookie が要るため対象外
//   （extractWorkId が ncode.syosetu.com しか認識しない）。
//
//   ページ構造（2026-10 時点の実物で確認）:
//   ・目次 https://ncode.syosetu.com/<ncode>/?p=N … 1ページ 100 話。
//       作品タイトル <h1 class="p-novel__title">、各話 <a href="/<ncode>/<話番号>/" class="p-eplist__subtitle">話タイトル</a>、
//       ページ送り <a href="/<ncode>/?p=11" class="c-pager__item c-pager__item--last">（最終ページ番号）。
//   ・本文 https://ncode.syosetu.com/<ncode>/<話番号>/ … <div class="p-novel__body"> の中に
//       前書き <div class="js-novel-text p-novel__text p-novel__text--preface">、
//       本文   <div class="js-novel-text p-novel__text">、
//       後書き <div class="js-novel-text p-novel__text p-novel__text--afterword">。各段落は <p id="L1">…</p>。
//       ルビは <ruby>漢字<rp>（</rp><rt>かな</rt><rp>）</rp></ruby> なので、タグ除去で「漢字（かな）」になる。
//   ・短編（目次が無く、作品ページに本文が直接ある）は、作品タイトルを話タイトルとする1話として扱う。
//
//   話の ID は話番号（'1', '2', …）。作者が途中の話を削除すると番号が詰まるため、続き取得の
//   照合（lastEpisodeId）がずれることがある（記録の話数でのフォールバックに任せる。既知の割り切り）。
// ==========================================

const NAROU_TOC_MAX_PAGES  = 300;            // 目次ページ数の上限（暴走防止。1ページ100話）
const NAROU_SHORT_STORY_ID = 'short';        // 短編の1話ぶんの ID
const NAROU_PART_SEPARATOR = '────────────'; // 前書き・本文・後書きの間に入れる区切り線

// 目次（全ページ）を読んで { title, episodes, nextData:null } を返す。
//   1ページでも取れなければ null（途中までの一覧で続き取得の起点を誤らないよう、部分的には返さない）。
function loadNarouCatalog_(ncode) {
  const topUrl  = narouWorkUrl_(ncode);
  const topHtml = fetchHtml(topUrl);
  if (!topHtml) return null;

  const title = extractNarouTitle_(topHtml);
  let episodes = extractNarouEpisodes_(topHtml, ncode);

  if (episodes.length === 0) {
    // 短編：目次が無く、作品ページに本文が直接ある
    if (/class="[^"]*\bp-novel__body\b/.test(topHtml)) {
      return { nextData: null, title: title, episodes: [{ id: NAROU_SHORT_STORY_ID, title: title, url: topUrl }] };
    }
    return { nextData: null, title: title, episodes: [] };
  }

  const lastPage = Math.min(extractNarouLastPage_(topHtml, ncode), NAROU_TOC_MAX_PAGES);
  const seen = {};
  episodes.forEach(e => { seen[e.id] = true; });
  for (let page = 2; page <= lastPage; page++) {
    Utilities.sleep(TOC_PAGE_SLEEP_MS);
    const html = fetchHtml(`${topUrl}?p=${page}`);
    if (!html) { Logger.log(`なろう目次の取得に失敗（${page} / ${lastPage} ページ）`); return null; }
    let added = 0;
    extractNarouEpisodes_(html, ncode).forEach(e => {
      if (seen[e.id]) return;
      seen[e.id] = true;
      episodes.push(e);
      added++;
    });
    Logger.log(`なろう目次 ${page} / ${lastPage} ページ: ${added} 件追加`);
  }
  return { nextData: null, title: title, episodes: episodes };
}

// 作品タイトル（<h1 class="p-novel__title"> → og:title → <title>）
function extractNarouTitle_(html) {
  const h1 = html.match(/<h1[^>]*class="[^"]*\bp-novel__title\b[^"]*"[^>]*>([\s\S]*?)<\/h1>/);
  if (h1) { const t = stripHtmlTags(h1[1]); if (t) return t; }
  const og = html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/);
  if (og) { const t = stripHtmlTags(og[1]); if (t) return t; }
  const tt = html.match(/<title[^>]*>([^<]+)<\/title>/);
  if (tt) { const t = stripHtmlTags(tt[1]); if (t) return t; }
  return '不明なタイトル';
}

// 目次1ページぶんの話一覧（ページ内の出現順 = 話番号順）
function extractNarouEpisodes_(html, ncode) {
  const episodes = [];
  const re = new RegExp(`<a[^>]+href="/${ncode}/(\\d+)/"[^>]*class="[^"]*\\bp-eplist__subtitle\\b[^"]*"[^>]*>([\\s\\S]*?)</a>`, 'g');
  let m;
  while ((m = re.exec(html)) !== null) {
    episodes.push({
      id:    m[1],
      title: stripHtmlTags(m[2]) || `第${m[1]}話`,
      url:   `${NAROU_BASE_URL}/${ncode}/${m[1]}/`,
    });
  }
  return episodes;
}

// 目次の最終ページ番号（「最後へ」のリンク。無ければ1ページだけ）
function extractNarouLastPage_(html, ncode) {
  const m = html.match(new RegExp(`<a[^>]+href="/${ncode}/\\?p=(\\d+)"[^>]*class="[^"]*\\bc-pager__item--last\\b`));
  return m ? Math.max(1, Number(m[1])) : 1;
}

// 1話ぶんの本文。前書き・後書きがあれば区切り線を挟んで前後に置く。
//   本文が見つからなければ '（本文取得失敗）'（カクヨム側と同じ表記）。
function extractNarouEpisodeText_(html) {
  const parts = { preface: '', body: '', afterword: '' };
  const re = /<div[^>]+class="js-novel-text p-novel__text(?: p-novel__text--(preface|afterword))?"[^>]*>([\s\S]*?)<\/div>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const key  = m[1] || 'body';
    const text = stripHtmlTags(m[2]);
    if (text) parts[key] = parts[key] ? parts[key] + '\n' + text : text;
  }
  if (!parts.body) return '（本文取得失敗）';
  return [parts.preface, parts.body, parts.afterword]
    .filter(t => t)
    .join(`\n\n${NAROU_PART_SEPARATOR}\n\n`);
}
