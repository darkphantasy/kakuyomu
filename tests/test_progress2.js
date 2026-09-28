// webGetReadingProgress の返り値変更（{progress, sizes}）を再検証する
const fs = require('fs');
const vm = require('vm');

let drive = {};
let exportCalls = 0;
let CacheService_store = new Map();

const sandbox = {
  console,
  Logger: { log: () => {} },
  ScriptApp: { getOAuthToken: () => 'tok' },
  DriveApp: {
    getFileById(id) {
      const f = drive[id];
      if (!f) throw new Error('not found');
      return {
        isTrashed: () => !!f.trashed,
        // size を明示した場合はそれを返す（Google ドキュメントは書き込み直後もサイズが古いまま、の再現用）
        getSize: () => (f.size != null ? f.size : Buffer.byteLength(f.text, 'utf8')),
        getLastUpdated: () => new Date(f.updated != null ? f.updated : Date.now() - 3600 * 1000),
      };
    },
  },
  UrlFetchApp: {
    fetch(url, opts) {
      exportCalls++;
      const id = url.match(/files\/([^/]+)\/export/)[1];
      const f = drive[id];
      const buf = Buffer.from(f.text, 'utf8');
      const m = opts.headers.Range.match(/bytes=0-(\d+)/);
      const end = Number(m[1]);
      const body = buf.subarray(0, end + 1);
      return { getResponseCode: () => (buf.length > end + 1 ? 206 : 200), getContentText: () => body.toString('utf8') };
    },
  },
  CacheService: {
    getScriptCache() {
      return {
        get: k => (CacheService_store.has(k) ? CacheService_store.get(k) : null),
        put: (k, v) => CacheService_store.set(k, v),
        getAll: () => ({}), removeAll: ks => ks.forEach(k => CacheService_store.delete(k)),
      };
    },
  },
};

const src = fs.readFileSync('kaku_scraping/src/WebApp.js', 'utf8');
vm.createContext(sandbox);
vm.runInContext(src + '\nthis.webGetReadingProgress = webGetReadingProgress; this.invalidateProgressCache_ = invalidateProgressCache_;', sandbox);
const webGetReadingProgress = sandbox.webGetReadingProgress;

const body = n => 'あ'.repeat(n) + '\n';
function doc(episodes, opts) {
  opts = opts || {};
  let t = opts.noTitle ? '' : '作品タイトル\n';
  if (opts.leadBody) t += body(opts.leadBody);
  episodes.forEach(e => { t += `第${e}話 [${String(e).padStart(3, '0')}]\n` + body(opts.len || 3000); });
  return t;
}

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log((ok ? '  OK   ' : '  FAIL ') + name + (ok ? '' : `\n         期待: ${JSON.stringify(expected)}\n         実際: ${JSON.stringify(actual)}`));
  ok ? pass++ : fail++;
}
function reset() { CacheService_store.clear(); exportCalls = 0; drive = {}; }

console.log('\n■ 返り値の形が {progress, sizes} になっている');
reset();
drive = { d1: { text: doc([42, 43]) } };
const res1 = webGetReadingProgress({ w1: ['d1'] });
check('progress に話数が入る', res1.progress, { w1: 42 });
check('sizes に判定に使ったドキュメントのサイズが入る', res1.sizes, { d1: Buffer.byteLength(doc([42, 43]), 'utf8') });

console.log('\n■ 複数分冊：見出しが見つかった時点で走査終了 → 後続の分冊のサイズは含まれない');
reset();
drive = { d1: { text: doc([10, 11]) }, d2: { text: doc([50, 51]) } };
const res2 = webGetReadingProgress({ w1: ['d1', 'd2'] });
check('先頭分冊で見つかるので d2 のサイズは含まれない', res2, { progress: { w1: 10 }, sizes: { d1: Buffer.byteLength(doc([10, 11]), 'utf8') } });

console.log('\n■ 削除済み分冊もスキップしつつサイズ0を記録');
reset();
drive = { d1: { text: doc([1]), trashed: true }, d2: { text: doc([120, 121]) } };
const res3 = webGetReadingProgress({ w1: ['d1', 'd2'] });
check('削除済み分冊は size:0、後続分冊のサイズも含まれる',
  res3, { progress: { w1: 120 }, sizes: { d1: 0, d2: Buffer.byteLength(doc([120, 121]), 'utf8') } });

const defaultFetch = sandbox.UrlFetchApp.fetch;
console.log('\n■ 判定不能でも、それまでに開いたドキュメントのサイズは返す');
reset();
drive = { d1: { text: doc([1]), trashed: true }, d2: { text: doc([5]), httpError: 500 } };
sandbox.UrlFetchApp.fetch = function (url) {
  const id = url.match(/files\/([^/]+)\/export/)[1];
  const f = drive[id];
  if (f && f.httpError) return { getResponseCode: () => f.httpError, getContentText: () => '' };
  return { getResponseCode: () => 200, getContentText: () => f.text };
};
const res4 = webGetReadingProgress({ w1: ['d1', 'd2'] });
check('progress は返らないが、開けた範囲のサイズ（d1=削除済み, d2=取得失敗でもサイズ自体は既知）は返る',
  res4, { progress: {}, sizes: { d1: 0, d2: Buffer.byteLength(doc([5]), 'utf8') } });

console.log('\n■ 追記後もドライブ上のサイズが古いままでも、古い「最新」を返さない');
// Google ドキュメントは Docs API で書き込んだ直後、getSize() が古い値のまま残ることがある。
// サイズだけをキャッシュの鍵にしていた頃は、追記前の「見出し無し（=最新）」が返り続けた。
reset();
sandbox.UrlFetchApp.fetch = defaultFetch;
const T0 = Date.now() - 3 * 3600 * 1000;
drive = { d1: { text: doc([]), size: 100, updated: T0 } };      // 全部読み終えて見出しが残っていない
check('追記前は「最新」', webGetReadingProgress({ w1: ['d1'] }).progress, { w1: 'latest' });
check('古い（更新から時間が経った）結果はキャッシュされる', exportCalls, 1);
webGetReadingProgress({ w1: ['d1'] });
check('同じ状態ならキャッシュを使い export しない', exportCalls, 1);
drive.d1 = { text: doc([12, 13]), size: 100, updated: Date.now() - 1000 }; // 追記。サイズは据え置きのまま
check('最終更新が変わればサイズが同じでも読み直して新しい話数を返す',
  webGetReadingProgress({ w1: ['d1'] }).progress, { w1: 12 });
check('読み直している', exportCalls, 2);

console.log('\n■ 更新直後の判定結果はキャッシュしない（ドキュメント側の反映待ちで古い中身が返る窓を固定しない）');
webGetReadingProgress({ w1: ['d1'] });
check('更新直後の作品は毎回読み直す', exportCalls, 3);

console.log('\n■ finishRun 用の invalidateProgressCache_ でキャッシュを明示的に消せる');
reset();
drive = { d1: { text: doc([]), size: 100, updated: T0 } };
webGetReadingProgress({ w1: ['d1'] });
check('キャッシュが入っている', CacheService_store.size, 1);
sandbox.invalidateProgressCache_(['d1']);
check('invalidateProgressCache_ で消える', CacheService_store.size, 0);
webGetReadingProgress({ w1: ['d1'] });
check('消した後は読み直す', exportCalls, 2);

console.log(`\n合計: ${pass} 件成功 / ${fail} 件失敗\n`);
process.exit(fail ? 1 : 0);
