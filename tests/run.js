#!/usr/bin/env node
// 検証の入口（npm test）。
//   1. kaku_scraping/src の .js を node --check、index.html は <script> 部を抜き出して node --check
//   2. tests/test_*.js を 1 本ずつ実行し、「合計: X 件成功 / Y 件失敗」の行を集計する
//   失敗があれば exit 1。個別に見るときは `node tests/test_xxx.js`。
//
//   使い方: node tests/run.js [絞り込み文字列...]
//     引数を渡すと、ファイル名にその文字列を含むテストだけ実行する（構文チェックは常に行う）。
const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { spawnSync } = require('child_process');

const ROOT    = path.join(__dirname, '..');
const SRC_DIR = path.join(ROOT, 'kaku_scraping', 'src');
const filters = process.argv.slice(2);

let failed = 0;

function nodeCheck(file, label) {
  const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (r.status === 0) {
    console.log(`  OK   構文 ${label}`);
  } else {
    failed++;
    console.log(`  FAIL 構文 ${label}\n${r.stderr}`);
  }
}

console.log('■ 構文チェック');
fs.readdirSync(SRC_DIR).filter(f => f.endsWith('.js')).sort().forEach(f => nodeCheck(path.join(SRC_DIR, f), f));
{
  const html = fs.readFileSync(path.join(SRC_DIR, 'index.html'), 'utf8');
  const m = html.match(/<script>([\s\S]*)<\/script>/);
  if (!m) { failed++; console.log('  FAIL index.html に <script> が見つかりません'); }
  else {
    const tmp = path.join(os.tmpdir(), `kakuyomu_index_script_${process.pid}.js`);
    fs.writeFileSync(tmp, m[1]);
    nodeCheck(tmp, 'index.html <script>');
    fs.unlinkSync(tmp);
  }
}

console.log('\n■ 模擬実行');
const tests = fs.readdirSync(__dirname)
  .filter(f => /^test_.*\.js$/.test(f))
  .filter(f => filters.length === 0 || filters.some(s => f.indexOf(s) >= 0))
  .sort();

let totalPass = 0, totalFail = 0;
tests.forEach(f => {
  const r = spawnSync(process.execPath, [path.join(__dirname, f)], { cwd: ROOT, encoding: 'utf8', timeout: 120 * 1000 });
  const out = (r.stdout || '') + (r.stderr || '');
  const m = out.match(/合計: (\d+) 件成功 \/ (\d+) 件失敗/);
  const pass = m ? Number(m[1]) : 0;
  const fail = m ? Number(m[2]) : 0;
  const ok = r.status === 0 && m && fail === 0;
  totalPass += pass; totalFail += fail;
  if (ok) {
    console.log(`  OK   ${f.padEnd(32)} ${pass} 件`);
  } else {
    failed++;
    console.log(`  FAIL ${f.padEnd(32)} ${m ? `${pass} 件成功 / ${fail} 件失敗` : '集計行なし'}（exit ${r.status}）`);
    console.log(out.split('\n').filter(l => /FAIL|期待|実際|Error|at /.test(l)).map(l => '         ' + l).join('\n'));
  }
});

console.log(`\n合計: テスト ${tests.length} 本 / 検査 ${totalPass} 件成功 / ${totalFail} 件失敗${failed ? `（問題 ${failed} 件）` : ''}\n`);
process.exit(failed ? 1 : 0);
