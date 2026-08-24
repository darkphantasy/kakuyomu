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
// ==========================================

// ここに対象ドキュメントのIDを列挙（URLの /d/ と /edit の間の文字列）
const TARGET_DOC_IDS = [
  // '1AbcDEfgHIjkLMnoPQrsTUvwXYz0000000000001',
  // '1AbcDEfgHIjkLMnoPQrsTUvwXYz0000000000002',
  '1Lqv-z8KdVs6LuQNNeC5e98rOOUKlkMrxssdZKzbNmNU'
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
  const headings = []; // HEADING_2 / HEADING_3 の段落（タイトル・話見出し）
  for (const el of content) {
    const start = end; // 直前要素の終端＝この要素の開始位置
    if (typeof el.endIndex === 'number' && el.endIndex > end) end = el.endIndex;
    if (!el.paragraph) continue;
    const ns = el.paragraph.paragraphStyle && el.paragraph.paragraphStyle.namedStyleType;
    if ((ns === 'HEADING_2' || ns === 'HEADING_3') && typeof el.endIndex === 'number') {
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