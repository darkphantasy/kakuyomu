const fs = require('fs');
const vm = require('vm');

const html = fs.readFileSync('kaku_scraping/src/index.html', 'utf8');
const script = html.match(/<script>([\s\S]*)<\/script>/)[1];

let unreadOnlyChecked = false;
let filterValue = '';
const elements = {
  filter: { value: '' },
  unreadOnly: { checked: false },
  workCount: { textContent: '' },
  works: { textContent: '', appendChild() {}, childNodes: [] },
  worksEmpty: { style: {}, textContent: '' },
};
Object.defineProperty(elements.filter, 'value', { get: () => filterValue, set: v => filterValue = v });
Object.defineProperty(elements.unreadOnly, 'checked', { get: () => unreadOnlyChecked, set: v => unreadOnlyChecked = v });

const sandbox = {
  console,
  document: {
    getElementById: (id) => elements[id] || { value: '', textContent: '', style: {}, appendChild(){} },
    querySelectorAll: () => [],
    addEventListener: () => {},
    createElement: () => ({ appendChild(){}, classList:{add(){}}, style:{} }),
  },
  window: { addEventListener: () => {} },
  google: { script: { run: {} } },
  setInterval: () => 0,
  Object, Number, Date, JSON, Math,
};
vm.createContext(sandbox);
vm.runInContext(script, sandbox);

function setWorks(list) {
  vm.runInContext(`lastState = { works: ${JSON.stringify(list)} };`, sandbox);
}
function setReadingEp(map) {
  vm.runInContext(`readingEp = ${JSON.stringify(map)};`, sandbox);
}

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log((ok ? '  OK   ' : '  FAIL ') + name +
    (ok ? '' : `\n         期待: ${JSON.stringify(expected)}\n         実際: ${JSON.stringify(actual)}`));
  ok ? pass++ : fail++;
}

const mk = (id, title) => ({ workId: id, title: title, shortTitle: title, url: 'u',
  total: '100', updatedAt: '2026-01-01 10:00', docIds: [] });

console.log('\n■ 未読のみ表示フィルタ');
setWorks([mk('w1', 'A'), mk('w2', 'B'), mk('w3', 'C')]);
setReadingEp({ w1: 42, w2: 'latest', w3: undefined }); // w3 は未取得（キー無し）

unreadOnlyChecked = false;
vm.runInContext('renderTable();', sandbox);
check('OFF時は全件表示', vm.runInContext('lastState.works.length', sandbox), 3);

unreadOnlyChecked = true;
vm.runInContext('renderTable();', sandbox);
// list はローカル変数なのでworkCountで件数確認する形に変更
let cnt = elements.workCount.textContent;
check('ON時は latest 確定分を除外（w2のみ除外→2件）', cnt, '（2 / 3 作品）');

console.log('\n■ 未取得（判定中）の作品は消えない');
setReadingEp({ w1: 'latest' }); // w2, w3 は未取得
unreadOnlyChecked = true;
vm.runInContext('renderTable();', sandbox);
check('判定中の作品は除外されない（w1のみ除外→2件）', elements.workCount.textContent, '（2 / 3 作品）');

console.log('\n■ テキスト絞り込みと併用');
filterValue = 'a';
setReadingEp({ w1: 42, w2: 'latest', w3: 5 });
unreadOnlyChecked = true;
vm.runInContext('renderTable();', sandbox);
check('テキスト+未読のみ併用（"A"に一致し既読なもの→w1のみ）', elements.workCount.textContent, '（1 / 3 作品）');
filterValue = '';

console.log('\n■ OFFに戻すと全件表示に戻る');
unreadOnlyChecked = false;
vm.runInContext('renderTable();', sandbox);
check('OFFに戻すと件数表記も消える', elements.workCount.textContent, '（3 作品）');

console.log(`\n合計: ${pass} 件成功 / ${fail} 件失敗\n`);
process.exit(fail ? 1 : 0);
