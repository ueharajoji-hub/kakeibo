// db.js / repo.js を実ブラウザなしで動かすテスト。
// sql.js と IndexedDB を node:sqlite で置き換えて、本物のコードを走らせる。
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DIR = path.join(__dirname, '..');

// ---- sql.js 互換シム ----
class FakeDb {
  constructor() { this.h = new DatabaseSync(':memory:'); }
  _bindArgs(params) {
    if (!params) return [];
    if (Array.isArray(params)) return params;
    return [params]; // 名前付きはオブジェクト1個で渡す
  }
  run(sql, params) {
    if (!params || (Array.isArray(params) && !params.length)) { this.h.exec(sql); return; }
    this.h.prepare(sql).run(...this._bindArgs(params));
  }
  exec(sql) { this.h.exec(sql); }
  prepare(sql) {
    const h = this.h, self = this;
    return {
      _p: null, _rows: null, _i: 0,
      bind(params) { this._p = params; },
      step() {
        if (this._rows === null) this._rows = h.prepare(sql).all(...self._bindArgs(this._p));
        return this._i < this._rows.length ? (this._cur = this._rows[this._i++], true) : false;
      },
      getAsObject() { return this._cur; },
      free() {}
    };
  }
  export() { return new Uint8Array([1, 2, 3]); }
  close() { this.h.close(); }
}

// ---- IndexedDB シム（保存先だけ差し替える）----
const store = new Map();
const indexedDB = {
  open() {
    const req = {};
    setTimeout(() => {
      req.result = {
        transaction: () => ({
          objectStore: () => ({
            get: (k) => { const r = {}; setTimeout(() => { r.result = store.get(k); r.onsuccess && r.onsuccess(); }, 0); return r; },
            put: (v, k) => { store.set(k, v); }
          }),
          set oncomplete(fn) { setTimeout(fn, 0); },
          set onerror(fn) {}
        }),
        createObjectStore() {}
      };
      req.onsuccess && req.onsuccess();
    }, 0);
    return req;
  }
};

const sandbox = {
  console, setTimeout, clearTimeout, indexedDB, Date, Math, JSON, Promise,
  Uint8Array, TextEncoder, alert: (m) => console.log('[alert]', m),
  initSqlJs: () => Promise.resolve({ Database: FakeDb })
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

for (const f of ['db.js', 'repo.js']) {
  vm.runInContext(fs.readFileSync(path.join(DIR, f), 'utf8'), sandbox, { filename: f });
}

const KB = sandbox.KB;

let pass = 0, fail = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + '\n       got  ' + JSON.stringify(got) + '\n       want ' + JSON.stringify(want)); }
}

KB.db.init().then(() => {
  KB.repo.init();
  const repo = KB.repo, db = KB.db;

  console.log('\n[スキーマとシード]');
  const cats = repo.categories('expense', false);
  check('支出カテゴリが10件', cats.length, 10);
  const tobacco = cats.find(c => c.name === '嗜好品');
  check('嗜好品は既定でプライベート', tobacco.is_private_default, 1);

  console.log('\n[週の境界：月曜はじまり]');
  check('2026-09-30(水)の週頭は9/28', repo.weekStartOf('2026-09-30'), '2026-09-28');
  check('2026-09-28(月)の週頭は自分自身', repo.weekStartOf('2026-09-28'), '2026-09-28');
  check('2026-10-04(日)の週頭は9/28', repo.weekStartOf('2026-10-04'), '2026-09-28');
  check('週末は10/4', repo.weekEndOf('2026-09-28'), '2026-10-04');
  db.setSetting('week_start_dow', '0');
  check('日曜はじまりなら9/30の週頭は9/27', repo.weekStartOf('2026-09-30'), '2026-09-27');
  db.setSetting('week_start_dow', '1');

  console.log('\n[月をまたぐ加算]');
  check('9/30 + 1日', repo.addDays('2026-09-30', 1), '2026-10-01');
  check('1/1 - 1日', repo.addDays('2026-01-01', -1), '2025-12-31');
  check('うるう日', repo.addDays('2028-02-28', 1), '2028-02-29');

  console.log('\n[明細の登録と集計]');
  const ws = '2026-09-28';
  const food = cats.find(c => c.name === '食費');
  repo.addEntry({ date: '2026-09-28', amount_yen: 1200, category_id: food.id, satisfaction: 'ok' });
  repo.addEntry({ date: '2026-09-29', amount_yen: 800, category_id: food.id, satisfaction: 'waste' });
  repo.addEntry({ date: '2026-09-29', amount_yen: 500, category_id: tobacco.id, satisfaction: 'waste', is_private: true });
  // プライベート印は付け忘れたが、カテゴリが既定プライベートな行
  repo.addEntry({ date: '2026-09-30', amount_yen: 600, category_id: tobacco.id, satisfaction: 'ok' });

  const personal = repo.weekTotals(ws, true);
  const shared = repo.weekTotals(ws, false);
  check('個人モードの支出合計 = 3100', personal.spent, 3100);
  check('共有モードの支出合計 = 2000（嗜好品1100が消える）', shared.spent, 2000);
  check('共有モードには嗜好品の行が出ない',
        shared.rows.some(r => r.name === '嗜好品'), false);
  check('個人モードには嗜好品の行が出る',
        personal.rows.find(r => r.name === '嗜好品').spent, 1100);

  console.log('\n[明細リストの漏れ]');
  check('個人モードの明細は4件', repo.entriesInWeek(ws, true).length, 4);
  check('共有モードの明細は2件', repo.entriesInWeek(ws, false).length, 2);
  check('共有モードの最近の記録にも嗜好品は出ない',
        repo.recentEntries(50, false).some(e => e.category_name === '嗜好品'), false);

  console.log('\n[無駄だった出費]');
  check('個人モード：2件 1300円', [repo.wasteTotal(ws, true).n, repo.wasteTotal(ws, true).total], [2, 1300]);
  check('共有モード：1件 800円', [repo.wasteTotal(ws, false).n, repo.wasteTotal(ws, false).total], [1, 800]);

  console.log('\n[収入]');
  const incomeCats = repo.categories('income', false);
  check('収入カテゴリが2件', incomeCats.map(c => c.name), ['給与', 'その他収入']);
  const salary = incomeCats.find(c => c.name === '給与');
  const otherIncome = incomeCats.find(c => c.name === 'その他収入');
  repo.addEntry({ date: '2026-09-30', amount_yen: 200000, category_id: salary.id, satisfaction: 'waste' });
  repo.addEntry({ date: '2026-10-01', amount_yen: 30000, category_id: otherIncome.id, is_private: true });
  check('収入は支出合計に混ざらない（個人 3100 のまま）', repo.weekTotals(ws, true).spent, 3100);
  check('収入は予算行に出ない',
        repo.weekBudgetRows(ws, true).some(r => r.name === '給与'), false);
  check('収入に満足度は付かない（画面が waste を渡しても NULL）',
        db.one('SELECT satisfaction FROM entries WHERE category_id = ?', [salary.id]).satisfaction, null);
  check('無駄集計に収入は入らない', repo.wasteTotal(ws, true).total, 1300);
  check('個人モードの週収入：2件 230000円',
        [repo.weekIncome(ws, true).n, repo.weekIncome(ws, true).total], [2, 230000]);
  check('共有モードの週収入：プライベートの30000が消える',
        [repo.weekIncome(ws, false).n, repo.weekIncome(ws, false).total], [1, 200000]);
  check('明細リストには収入も出る（kind 付き）',
        repo.entriesInWeek(ws, true).filter(e => e.kind === 'income').length, 2);
  check('共有モードの明細からプライベート収入が消える',
        repo.entriesInWeek(ws, false).filter(e => e.kind === 'income').length, 1);
  check('入力欄の収入カテゴリ一覧', repo.visibleCategories('income', true).length, 2);
  repo.addCategory('副業', 'income');
  check('収入カテゴリを追加できる',
        repo.categories('income', false).map(c => c.name), ['給与', 'その他収入', '副業']);
  check('支出カテゴリは増えていない', repo.categories('expense', false).length, 10);

  console.log('\n[予算スナップショット]');
  check('食費の週予算は既定の6000', personal.rows.find(r => r.name === '食費').budget, 6000);
  repo.setDefaultBudget(food.id, 9000);
  check('既定を変えても固定済みの今週は6000のまま',
        repo.weekBudgetRows(ws, true).find(r => r.name === '食費').budget, 6000);
  repo.setWeekBudget(ws, food.id, 7000);
  check('明示的に上書きすれば7000',
        repo.weekBudgetRows(ws, true).find(r => r.name === '食費').budget, 7000);

  console.log('\n[振り返り]');
  repo.saveReview(ws, 4, '外食が多かった', '週2回までにする');
  check('保存できる', repo.getReview(ws).good_note, '外食が多かった');
  repo.saveReview(ws, 5, '書き直した', '同じ');
  check('同じ週は上書きされる', repo.getReview(ws).rating, 5);
  check('履歴は1件', repo.reviewHistory(10).length, 1);

  console.log('\n[カテゴリの非表示]');
  repo.setCategoryHidden(food.id, true);
  check('非表示にすると一覧から消える',
        repo.categories('expense', false).some(c => c.id === food.id), false);
  check('過去の明細は残っている',
        repo.entriesInWeek(ws, true).some(e => e.category_name === '食費'), true);
  repo.setCategoryHidden(food.id, false);

  console.log('\n[未来の週]');
  const future = repo.addDays(repo.currentWeekStart(), 7);
  repo.weekBudgetRows(future, true);
  check('未来の週は予算を固定しない',
        db.one('SELECT COUNT(*) AS n FROM week_budgets WHERE week_start = ?', [future]).n, 0);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}).catch(err => { console.error('起動に失敗:', err); process.exit(1); });
