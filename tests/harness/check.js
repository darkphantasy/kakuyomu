// テスト共通のアサーションと集計。
//   check(name, actual, expected) … JSON 化して比較し、OK/FAIL を 1 行出す
//   section(title)                … 見出し行
//   finish()                      … 「合計: X 件成功 / Y 件失敗」を出して exit code を決める
//                                    （tests/run.js はこの行を読んで集計する。書式を変えない）
let pass = 0;
let fail = 0;

function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log((ok ? '  OK   ' : '  FAIL ') + name +
    (ok ? '' : `\n         期待: ${JSON.stringify(expected)}\n         実際: ${JSON.stringify(actual)}`));
  ok ? pass++ : fail++;
  return ok;
}

function section(title) {
  console.log('\n■ ' + title);
}

function finish() {
  console.log(`\n合計: ${pass} 件成功 / ${fail} 件失敗\n`);
  process.exit(fail ? 1 : 0);
}

module.exports = { check, section, finish };
