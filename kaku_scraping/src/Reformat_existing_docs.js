// ==========================================
// 現在の書式設定を既存ドキュメントに適用する簡易スクリプト
//   本文テキストは一切読まない（段落の位置・見出し種別だけを取得）ので、
//   巨大ドキュメントでもメモリ安全。構造（段落分け・見出し）は変更せず、
//   フォント・行間・段落余白・見出しの太字だけを当て直す。
//
//   ※ kakuyomu_to_docs.gs とは独立したファイルです。
//     このプロジェクトの appsscript.json（Docs API 有効化済み）を流用するなら
//     同じプロジェクトに追加してください。別プロジェクトで使う場合は、
//     エディタの「サービス」から Docs API（userSymbol: Docs）を追加してください。
//
// ■ 実行する関数
//   reformatOneDoc()    … 下の TARGET_DOC_IDS の1件目だけ試す（動作確認用）。
//   reformatAllDocs()   … TARGET_DOC_IDS を順番にすべて適用。
//   previewLegacyEpisodeHeadings() … 下の「旧形式の話見出し → HEADING_4」の対象件数をログに出すだけ（書き換えない）。
//   convertLegacyEpisodeHeadings() … TARGET_DOC_IDS の各ドキュメントで、旧形式の話見出し（HEADING_3）を HEADING_4 に揃える。
//   findTocStartForDoc() … TARGET_DOC_IDS の 1 件目の先頭に残っている話が、作品の目次で何番目かをログに出す
//                           （目次順で取り直すときの「開始話数」を調べる用。本体 Kakuyomu_to_docs.js / WebApp.js の関数を使う）。
// ==========================================

// ここに対象ドキュメントのIDを列挙（URLの /d/ と /edit の間の文字列）
//   ※ 実行のたびに書き換える一時的な設定なので、使い終わったら空に戻すこと
//     （前回の対象が残っていると、意図しないドキュメントを書き換えてしまう）。
const TARGET_DOC_IDS = [
  // '1AbcDEfgHIjkLMnoPQrsTUvwXYz0000000000001',
  // '1AbcDEfgHIjkLMnoPQrsTUvwXYz0000000000002',
  '10cM5yAQkhxHpK00AQdVMm7PFp8I7hQ0796tLGf1diY4', // 四十歳の元社畜、異世界の宿屋で飯を作る（2）… 話見出しの統一用（2026-11）。済んだら消す
];

// 現在の書式設定（kakuyomu_to_docs.gs と同じ値に揃えてあります。変更する場合はここを編集）
const RF_FONT_FAMILY            = 'BIZ UDGothic'; // 本文フォント
const RF_LINE_SPACING_PCT       = 100;             // 行間（100=通常1.0倍）
const RF_BODY_FONT_SIZE_PT      = 11;              // 本文サイズ（段落余白の行換算に使用）
const RF_PARA_SPACE_BELOW_LINES = 0.5;             // 段落後の余白（行数）

function reformatOneDoc() {
  if (TARGET_DOC_IDS.length === 0) {
    Logger.log('TARGET_DOC_IDS が空です。対象ドキュメントIDを記入してください。');
    return;
  }
  reformatDoc(TARGET_DOC_IDS[0]);
}

function reformatAllDocs() {
  if (TARGET_DOC_IDS.length === 0) {
    Logger.log('TARGET_DOC_IDS が空です。対象ドキュメントIDを記入してください。');
    return;
  }
  TARGET_DOC_IDS.forEach((id, i) => {
    Logger.log(`[${i + 1}/${TARGET_DOC_IDS.length}] ${id} を整形中...`);
    try {
      reformatDoc(id);
    } catch(e) {
      Logger.log(`エラー（スキップ）: ${id} / ${e}`);
    }
  });
  Logger.log('全ドキュメントの整形が完了しました。');
}

// ==========================================
// 1ドキュメントに現在の書式を適用する。
//   段落の位置・見出し種別のみ取得（本文テキストは取らない＝低メモリ）。
// ==========================================
function reformatDoc(docId) {
  // startIndex は取得しない（巨大ドキュメントで要素数が多いとOOMするため）。
  //   各要素の開始位置は、内容が連続している前提で直前要素の終端から復元する。
  const doc = Docs.Documents.get(docId, {
    fields: 'body.content(endIndex,paragraph.paragraphStyle.namedStyleType)'
  });
  const content = (doc.body && doc.body.content) || [];

  let end = 1; // ドキュメント本文の先頭インデックス
  const headings = []; // HEADING_2〜4 の段落（文書タイトル・章見出し・話見出し。話見出しは以前は HEADING_3）
  for (const el of content) {
    const start = end; // 直前要素の終端＝この要素の開始位置
    if (typeof el.endIndex === 'number' && el.endIndex > end) end = el.endIndex;
    if (!el.paragraph) continue;
    const ns = el.paragraph.paragraphStyle && el.paragraph.paragraphStyle.namedStyleType;
    if ((ns === 'HEADING_2' || ns === 'HEADING_3' || ns === 'HEADING_4') && typeof el.endIndex === 'number') {
      headings.push({ start: start, end: el.endIndex - 1 });
    }
  }
  if (end <= 1) { Logger.log(`空のドキュメント: ${docId}`); return; }

  const reqs = [];

  // 全体：行間＋段落後の余白＋フォント（標準ウェイト）
  reqs.push({
    updateParagraphStyle: {
      range: { startIndex: 1, endIndex: end - 1 },
      paragraphStyle: {
        lineSpacing: RF_LINE_SPACING_PCT,
        spaceBelow:  { magnitude: RF_BODY_FONT_SIZE_PT * RF_PARA_SPACE_BELOW_LINES, unit: 'PT' },
      },
      fields: 'lineSpacing,spaceBelow',
    }
  });
  reqs.push({
    updateTextStyle: {
      range: { startIndex: 1, endIndex: end - 1 },
      textStyle: { weightedFontFamily: { fontFamily: RF_FONT_FAMILY } },
      fields: 'weightedFontFamily',
    }
  });

  // 見出し：太字＋フォントウェイト700で上書き（全体フォント適用の後に効かせる）
  for (const h of headings) {
    reqs.push({
      updateTextStyle: {
        range: { startIndex: h.start, endIndex: h.end },
        textStyle: { bold: true, weightedFontFamily: { fontFamily: RF_FONT_FAMILY, weight: 700 } },
        fields: 'bold,weightedFontFamily',
      }
    });
  }

  const CHUNK = 500;
  for (let i = 0; i < reqs.length; i += CHUNK) {
    Docs.Documents.batchUpdate({ requests: reqs.slice(i, i + CHUNK) }, docId);
  }

  Logger.log(`整形完了: ${docId}（見出し ${headings.length} 件）`);
}

// ==========================================
// 旧形式の話見出し（HEADING_3）を新形式（HEADING_4）に揃える（2026-11）
//   2026-10 に話の見出しを HEADING_3 → HEADING_4 に変え、章の見出し（HEADING_3）を入れるようにした。
//   保存済みのドキュメントに続き取得で追記すると、前半が「話 = H3」、後半が「章 = H3・話 = H4」で混在し、
//   アウトラインの階層が途中で変わる。前半の話見出しを H4 に下げて揃える（テキストは変えない）。
//
//   判定（本文テキストは Docs API で読まない）:
//     ・新形式の部分（最初の H4 以降）の H3 はすべて章 → 触らない
//     ・最初の H4 より前の H3 は旧形式の話。ただし追記の境目に章の見出しが入っていれば、その直前の 1 件だけは章
//     ・どちらかは「話の見出しの総数」で決める。総数は Drive のテキストエクスポート（単一の文字列）で
//       行末が [NNN] の行を数える（次話判定と同じ考え方。段落ごとのオブジェクトは作らない）
//     ・数が合わなければ何もせずログだけ出す（誤って章を話に変えないため）
// ==========================================
function previewLegacyEpisodeHeadings() {
  if (TARGET_DOC_IDS.length === 0) { Logger.log('TARGET_DOC_IDS が空です。対象ドキュメントIDを記入してください。'); return; }
  TARGET_DOC_IDS.forEach(id => planLegacyEpisodeHeadings_(id, true));
}

function convertLegacyEpisodeHeadings() {
  if (TARGET_DOC_IDS.length === 0) { Logger.log('TARGET_DOC_IDS が空です。対象ドキュメントIDを記入してください。'); return; }
  TARGET_DOC_IDS.forEach((id, i) => {
    Logger.log(`[${i + 1}/${TARGET_DOC_IDS.length}] ${id} の話見出しを揃えます...`);
    try {
      const plan = planLegacyEpisodeHeadings_(id, true);
      if (!plan || plan.targets.length === 0) return;
      const reqs = [];
      plan.targets.forEach(h => {
        reqs.push({
          updateParagraphStyle: {
            range: { startIndex: h.start, endIndex: h.end },
            paragraphStyle: { namedStyleType: 'HEADING_4' },
            fields: 'namedStyleType',
          }
        });
        // 段落スタイルを変えても太字は残るが、念のため見出しの太字（700）を当て直す
        reqs.push({
          updateTextStyle: {
            range: { startIndex: h.start, endIndex: h.end },
            textStyle: { bold: true, weightedFontFamily: { fontFamily: RF_FONT_FAMILY, weight: 700 } },
            fields: 'bold,weightedFontFamily',
          }
        });
      });
      const CHUNK = 500;
      for (let k = 0; k < reqs.length; k += CHUNK) {
        Docs.Documents.batchUpdate({ requests: reqs.slice(k, k + CHUNK) }, id);
      }
      Logger.log(`変換完了: ${id}（HEADING_3 → HEADING_4: ${plan.targets.length} 件）`);
    } catch(e) {
      Logger.log(`エラー（スキップ）: ${id} / ${e}`);
    }
  });
}

// 対象の見出しを決める。数が合わないときは null。
function planLegacyEpisodeHeadings_(docId, log) {
  const doc = Docs.Documents.get(docId, {
    fields: 'body.content(endIndex,paragraph.paragraphStyle.namedStyleType)'
  });
  const content = (doc.body && doc.body.content) || [];
  let end = 1;
  const heads = []; // H3 / H4 を文書順に
  for (const el of content) {
    const start = end;
    if (typeof el.endIndex === 'number' && el.endIndex > end) end = el.endIndex;
    if (!el.paragraph || typeof el.endIndex !== 'number') continue;
    const ns = el.paragraph.paragraphStyle && el.paragraph.paragraphStyle.namedStyleType;
    if (ns === 'HEADING_3' || ns === 'HEADING_4') heads.push({ level: ns === 'HEADING_3' ? 3 : 4, start: start, end: el.endIndex - 1 });
  }

  let firstH4 = heads.findIndex(h => h.level === 4);
  if (firstH4 < 0) firstH4 = heads.length;
  const legacyH3 = heads.slice(0, firstH4);   // ここは H3 だけ
  const h4Count  = heads.filter(h => h.level === 4).length;

  const episodeTotal = countEpisodeTagLines_(docId);
  if (episodeTotal === null) { Logger.log(`本文のエクスポートに失敗したため中止: ${docId}`); return null; }
  const legacyEpisodes = episodeTotal - h4Count;

  let targets;
  if (legacyEpisodes === legacyH3.length) {
    targets = legacyH3;                        // 境目に章の見出しが無い
  } else if (firstH4 < heads.length && legacyEpisodes === legacyH3.length - 1) {
    targets = legacyH3.slice(0, -1);           // 境目の H3 は章の見出し
  } else {
    Logger.log(`見出しの数が合わないため中止: ${docId}（最初の H4 より前の H3 ${legacyH3.length} 件 / H4 ${h4Count} 件 / [NNN] の行 ${episodeTotal} 件）`);
    return null;
  }
  if (log) {
    Logger.log(`${docId}: H3 ${heads.length - h4Count} 件・H4 ${h4Count} 件・[NNN] の行 ${episodeTotal} 件 → HEADING_4 にする旧形式の話見出し ${targets.length} 件` +
      (targets.length < legacyH3.length ? '（境目の章見出し 1 件は残す）' : ''));
  }
  return { targets: targets };
}

// 行末が [NNN] の行（話の見出し）を数える。Drive のテキストエクスポートを単一の文字列で受け取る。
function countEpisodeTagLines_(docId) {
  const res = UrlFetchApp.fetch(`https://www.googleapis.com/drive/v3/files/${docId}/export?mimeType=text/plain`, {
    headers: { 'Authorization': `Bearer ${ScriptApp.getOAuthToken()}` },
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) { Logger.log(`エクスポート失敗: HTTP ${res.getResponseCode()}`); return null; }
  const m = res.getContentText().match(/\[\d{3,}\][ \t\u3000]*\r?$/gm);
  return m ? m.length : 0;
}


// ==========================================
// 先頭に残っている話が目次の何番目かを調べる（2026-11）
//   公開日時順で保存した作品を目次順で取り直す（Web UI の「取得」で開始話数を指定）ときに使う。
//   目次順の取得では開始話数＝目次上の位置なので、ドキュメントの [NNN]（公開日時順の通し番号）とは一致しない。
//   ドキュメントの先頭は Range 付きの Drive エクスポート（fetchDocHeadText_）で読む（Docs API で本文は読まない）。
// ==========================================
function findTocStartForDoc() {
  if (TARGET_DOC_IDS.length === 0) { Logger.log('TARGET_DOC_IDS が空です。対象ドキュメントIDを記入してください。'); return null; }
  const docId = TARGET_DOC_IDS[0];
  const hit = loadResumeRecords_().find(r => (r.rec.docIds || []).indexOf(docId) >= 0);
  if (!hit) { Logger.log(`このドキュメントを含む記録が一覧にありません: ${docId}`); return null; }

  const head = fetchDocHeadText_(docId);
  const m = head && head.match(EPISODE_TAG_RE);
  if (!m) { Logger.log('ドキュメントの先頭に話の見出し（[NNN]）が見つかりません。'); return null; }
  const headTitle = m[0].replace(/\s*\[\d{3,}\]\s*$/, '').trim();

  const catalog = loadWorkCatalog_(hit.rec.url, hit.workId);
  if (!catalog) { Logger.log('目次を取得できませんでした。'); return null; }
  const eps = orderEpisodesByToc_(catalog.episodes);
  const norm = t => String(t || '').replace(/\s+/g, ' ').trim();
  const idx = eps.findIndex(e => norm(e.title) === norm(headTitle));

  Logger.log(`作品: ${hit.rec.title}\nURL: ${hit.rec.url}\n先頭の話: ${headTitle}（${m[1]}）`);
  if (idx < 0) { Logger.log('目次に同じタイトルの話が見つかりません（作者が改題した可能性）。'); return null; }
  Logger.log(`→ 目次で ${idx + 1} 番目（全 ${eps.length} 話）。Web UI の「取得」の開始話数に ${idx + 1} を入れてください。`);
  for (let k = Math.max(0, idx - 2); k <= Math.min(eps.length - 1, idx + 2); k++) {
    Logger.log(`   ${k + 1}: ${eps[k].title}${k === idx ? '  ← ここから' : ''}`);
  }
  return idx + 1;
}
