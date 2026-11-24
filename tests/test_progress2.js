// webGetReadingProgress（次話の判定）を検証する。
//   2026-11 の高速化: ① 保存先フォルダの一覧（Drive API files.list）でサイズ・最終更新をまとめて知る
//   （取れなければ 1 冊ずつ DriveApp で見る従来の方法）② 覚えている判定は getAll で 1 回
//   ③ 本文の先頭は fetchAll で並行に読む ④ cachedOnly なら本文を読まず、読む必要がある作品を pending で返す
const fs = require('fs');
const vm = require('vm');

let drive = {};
let exportCalls = 0;
let fetchAllCalls = [];   // fetchAll に渡された冊（docId）の組
let listCalls = 0;
let driveAppOpens = 0;    // DriveApp.getFileById の回数
let folderListing = null; // null=一覧の問い合わせが失敗する / 配列=フォルダにある docId
let CacheService_store = new Map();
const OLD_UPDATE = Date.now() - 3600 * 1000; // 既定の最終更新（1 時間前＝キャッシュしてよい古さ。呼び出しごとに変わらない）
const MODIFIED = f => new Date(f.updated != null ? f.updated : OLD_UPDATE);
const SIZE = f => (f.size != null ? f.size : Buffer.byteLength(f.text, 'utf8'));
function exportResponse(url, opts) {
  exportCalls++;
  const id = url.match(/files\/([^/]+)\/export/)[1];
  const f = drive[id];
  if (f && f.httpError) return { getResponseCode: () => f.httpError, getContentText: () => '' };
  const buf = Buffer.from(f.text, 'utf8');
  const m = opts.headers.Range.match(/bytes=0-(\d+)/);
  const end = Number(m[1]);
  const body = buf.subarray(0, end + 1);
  return { getResponseCode: () => (buf.length > end + 1 ? 206 : 200), getContentText: () => body.toString('utf8') };
}

const sandbox = {
  console,
  Logger: { log: () => {} },
  ScriptApp: { getOAuthToken: () => 'tok' },
  DriveApp: {
    getFileById(id) {
      driveAppOpens++;
      const f = drive[id];
      if (!f) throw new Error('not found');
      return {
        isTrashed: () => !!f.trashed,
        // size を明示した場合はそれを返す（Google ドキュメントは書き込み直後もサイズが古いまま、の再現用）
        getSize: () => SIZE(f),
        getLastUpdated: () => MODIFIED(f),
      };
    },
  },
  getTargetFolderId: () => 'FOLDER',
  UrlFetchApp: {
    fetch(url, opts) {
      if (/\/drive\/v3\/files\?/.test(url)) {
        listCalls++;
        if (!folderListing) return { getResponseCode: () => 500, getContentText: () => '' };
        const q = decodeURIComponent(url.match(/q=([^&]*)/)[1]);
        if (q.indexOf("'FOLDER' in parents") < 0) throw new Error('フォルダの指定が違う: ' + q);
        const files = folderListing.map(id => ({ id, size: String(SIZE(drive[id])), modifiedTime: MODIFIED(drive[id]).toISOString(), trashed: !!drive[id].trashed }));
        return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ files }) };
      }
      return exportResponse(url, opts);
    },
    fetchAll(reqs) {
      fetchAllCalls.push(reqs.map(r => r.url.match(/files\/([^/]+)\/export/)[1]));
      return reqs.map(r => exportResponse(r.url, r));
    },
  },
  CacheService: {
    getScriptCache() {
      return {
        get: k => (CacheService_store.has(k) ? CacheService_store.get(k) : null),
        put: (k, v) => CacheService_store.set(k, v),
        getAll: ks => { const o = {}; ks.forEach(k => { if (CacheService_store.has(k)) o[k] = CacheService_store.get(k); }); return o; },
        putAll: o => Object.keys(o).forEach(k => CacheService_store.set(k, o[k])),
        removeAll: ks => ks.forEach(k => CacheService_store.delete(k)),
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
function reset() {
  CacheService_store.clear(); exportCalls = 0; drive = {}; fetchAllCalls = []; listCalls = 0; driveAppOpens = 0; folderListing = null;
}
const progressKeys = () => [...CacheService_store.keys()].filter(k => k.indexOf('progress_') === 0);

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
check('（フォルダの一覧が取れないとき）先頭分冊で見つかるので d2 は開かない・サイズも含まれない', res2, { progress: { w1: 10 }, sizes: { d1: Buffer.byteLength(doc([10, 11]), 'utf8') }, pending: [] });

console.log('\n■ 削除済み分冊もスキップしつつサイズ0を記録');
reset();
drive = { d1: { text: doc([1]), trashed: true }, d2: { text: doc([120, 121]) } };
const res3 = webGetReadingProgress({ w1: ['d1', 'd2'] });
check('削除済み分冊は size:0、後続分冊のサイズも含まれる',
  res3, { progress: { w1: 120 }, sizes: { d1: 0, d2: Buffer.byteLength(doc([120, 121]), 'utf8') }, pending: [] });

console.log('\n■ 判定不能でも、それまでに開いたドキュメントのサイズは返す');
reset();
drive = { d1: { text: doc([1]), trashed: true }, d2: { text: doc([5]), httpError: 500 } };
const res4 = webGetReadingProgress({ w1: ['d1', 'd2'] });
check('progress は返らないが、開けた範囲のサイズ（d1=削除済み, d2=取得失敗でもサイズ自体は既知）は返る',
  res4, { progress: {}, sizes: { d1: 0, d2: Buffer.byteLength(doc([5]), 'utf8') }, pending: [] });

console.log('\n■ 追記後もドライブ上のサイズが古いままでも、古い「最新」を返さない');
// Google ドキュメントは Docs API で書き込んだ直後、getSize() が古い値のまま残ることがある。
// サイズだけをキャッシュの鍵にしていた頃は、追記前の「見出し無し（=最新）」が返り続けた。
reset();
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
check('キャッシュが入っている', progressKeys().length, 1);
sandbox.invalidateProgressCache_(['d1']);
check('invalidateProgressCache_ で消える', progressKeys().length, 0);
webGetReadingProgress({ w1: ['d1'] });
check('消した後は読み直す', exportCalls, 2);


console.log('\n■ フォルダの一覧でサイズ・最終更新をまとめて知る（1 冊ずつ開かない）');
reset();
drive = { a1: { text: doc([3]) }, a2: { text: doc([40]) }, b1: { text: doc([]) }, b2: { text: doc([7]), trashed: true }, b3: { text: doc([9]) } };
folderListing = ['a1', 'a2', 'b1', 'b2', 'b3'];
const r5 = webGetReadingProgress({ wa: ['a1', 'a2'], wb: ['b1', 'b2', 'b3'] });
check('判定結果（wb は 1 冊目が読了・2 冊目がゴミ箱 → 3 冊目）', r5.progress, { wa: 3, wb: 9 });
check('一覧の問い合わせは 1 回、DriveApp では 1 冊も開かない', [listCalls, driveAppOpens], [1, 0]);
check('サイズは判定で読まなかった冊（a2）も含めて全冊ぶん返る（ゴミ箱は 0）', Object.keys(r5.sizes).sort().map(k => [k, r5.sizes[k] > 0]),
  [['a1', true], ['a2', true], ['b1', true], ['b2', false], ['b3', true]]);
check('本文の先頭は作品をまたいでまとめて並行に読む（1 回目 a1・b1、2 回目 b3）', fetchAllCalls, [['a1', 'b1'], ['b3']]);

console.log('\n■ フォルダの外のドキュメントだけは 1 冊ずつ開く');
reset();
drive = { in1: { text: doc([5]) }, out1: { text: doc([8]) } };
folderListing = ['in1'];
const r6 = webGetReadingProgress({ wi: ['in1'], wo: ['out1'] });
check('どちらも判定できる', r6.progress, { wi: 5, wo: 8 });
check('開くのはフォルダの外の 1 冊だけ', driveAppOpens, 1);

console.log('\n■ 覚えている判定は使い回し、2 回目は本文を読まない');
reset();
drive = { c1: { text: doc([21]) }, c2: { text: doc([]) }, c3: { text: doc([77]) } };
folderListing = ['c1', 'c2', 'c3'];
webGetReadingProgress({ wc: ['c1'], wd: ['c2', 'c3'] });
const reads1 = exportCalls;
const r7 = webGetReadingProgress({ wc: ['c1'], wd: ['c2', 'c3'] });
check('同じ結果', r7.progress, { wc: 21, wd: 77 });
check('2 回目は本文を 1 冊も読まない', exportCalls - reads1, 0);

console.log('\n■ cachedOnly: 本文を読まずに答え、読む必要がある作品を pending で返す');
reset();
drive = { e1: { text: doc([4]) }, f1: { text: doc([]) }, f2: { text: doc([15]) }, g1: { text: doc([30]) } };
folderListing = ['e1', 'f1', 'f2', 'g1'];
webGetReadingProgress({ we: ['e1'] });            // we だけ覚えている
webGetReadingProgress({ wf: ['f1'] });            // wf は 1 冊目だけ覚えている（読了）
const reads2 = exportCalls;
const r8 = webGetReadingProgress({ we: ['e1'], wf: ['f1', 'f2'], wg: ['g1'] }, true);
check('覚えている作品だけ答える', r8.progress, { we: 4 });
check('残りは pending（wf は 2 冊目が未知）', r8.pending, ['wf', 'wg']);
check('本文は読まない', exportCalls - reads2, 0);
check('サイズは全冊ぶん返る', Object.keys(r8.sizes).sort(), ['e1', 'f1', 'f2', 'g1']);
const r9 = webGetReadingProgress({ wf: ['f1', 'f2'], wg: ['g1'] });
check('pending の作品を改めて問い合わせると判定できる', [r9.progress, r9.pending], [{ wf: 15, wg: 30 }, []]);

console.log('\n■ fetchAll がまとめて失敗しても、1 冊ずつ読み直す');
reset();
drive = { h1: { text: doc([2]) }, h2: { text: doc([6]) } };
folderListing = ['h1', 'h2'];
const savedFetchAll = sandbox.UrlFetchApp.fetchAll;
sandbox.UrlFetchApp.fetchAll = () => { throw new Error('一時的な失敗'); };
check('判定できる', webGetReadingProgress({ w1: ['h1'], w2: ['h2'] }).progress, { w1: 2, w2: 6 });
sandbox.UrlFetchApp.fetchAll = savedFetchAll;

console.log('\n■ 並行に読むのは PROGRESS_FETCH_PARALLEL 冊ずつ');
reset();
const many = {};
for (let i = 1; i <= 12; i++) { drive['m' + i] = { text: doc([i]) }; many['w' + i] = ['m' + i]; }
folderListing = Object.keys(drive);
webGetReadingProgress(many);
check('10 冊 + 2 冊', fetchAllCalls.map(g => g.length), [10, 2]);

console.log(`\n合計: ${pass} 件成功 / ${fail} 件失敗\n`);
process.exit(fail ? 1 : 0);
