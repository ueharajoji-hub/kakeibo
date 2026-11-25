// ============================================================
// repo.js — データへの入口はここだけ
//
// 画面側は SQL を直接書かない。プライベート明細の除外を
// 一箇所に閉じ込めて「グラフだけフィルタ漏れしていた」を防ぐ。
//
// includePrivate === true  … 個人モード（全部見える）
// includePrivate === false … 共有モード（プライベートは完全に非表示）
// ============================================================
(function () {
  'use strict';

  var db = null; // init 後に KB.db を掴む

  // ---------- 日付（すべてローカル日付の 'YYYY-MM-DD'） ----------

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function toLocalDate(d) {
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  function today() { return toLocalDate(new Date()); }

  // 'YYYY-MM-DD' を「その日の正午」の Date にする。
  // 正午にしておけば夏時間や端末の時刻ずれで日付が前後しない。
  function parseDate(s) {
    var p = s.split('-');
    return new Date(+p[0], +p[1] - 1, +p[2], 12, 0, 0);
  }

  function addDays(s, n) {
    var d = parseDate(s);
    d.setDate(d.getDate() + n);
    return toLocalDate(d);
  }

  function weekStartDow() {
    var v = db.getSetting('week_start_dow');
    return v === null ? 1 : parseInt(v, 10);
  }

  // その日が含まれる週の開始日
  function weekStartOf(dateStr) {
    var dow = weekStartDow();
    var back = (parseDate(dateStr).getDay() - dow + 7) % 7;
    return addDays(dateStr, -back);
  }

  function currentWeekStart() { return weekStartOf(today()); }

  function weekEndOf(weekStart) { return addDays(weekStart, 6); }

  function formatWeek(weekStart) {
    var s = parseDate(weekStart);
    var e = parseDate(weekEndOf(weekStart));
    return (s.getMonth() + 1) + '/' + s.getDate() + ' - ' + (e.getMonth() + 1) + '/' + e.getDate();
  }

  // 今日が週の何日目か（1..7）。「今日使える額」の計算に使う。
  function dayIndexInWeek(weekStart) {
    var diff = Math.round((parseDate(today()) - parseDate(weekStart)) / 86400000);
    return Math.min(7, Math.max(1, diff + 1));
  }

  // ---------- カテゴリ ----------

  function categories(kind, includeHidden) {
    return db.all(
      "SELECT * FROM categories WHERE kind = ?" +
      (includeHidden ? "" : " AND is_hidden = 0") +
      " ORDER BY sort_order, id", [kind]);
  }

  // 共有モードでは「既定でプライベート」なカテゴリ自体を出さない。
  // 予算の一覧に嗜好品が並んでいたら隠す意味がないため。
  function visibleCategories(kind, includePrivate) {
    return db.all(
      "SELECT * FROM categories WHERE kind = ? AND is_hidden = 0" +
      (includePrivate ? "" : " AND is_private_default = 0") +
      " ORDER BY sort_order, id", [kind]);
  }

  function visibleExpenseCategories(includePrivate) {
    return visibleCategories('expense', includePrivate);
  }

  function addCategory(name, kind) {
    kind = kind === 'income' ? 'income' : 'expense';
    var row = db.one(
      "SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM categories WHERE kind = ?", [kind]);
    db.run("INSERT INTO categories (name, kind, sort_order) VALUES (?, ?, ?)",
           [name, kind, row.n]);
    // 入力画面から足したときに、そのまま選べるよう id を返す
    return db.one("SELECT last_insert_rowid() AS id").id;
  }

  function renameCategory(id, name) {
    db.run("UPDATE categories SET name = ? WHERE id = ?", [name, id]);
  }

  function setCategoryHidden(id, hidden) {
    db.run("UPDATE categories SET is_hidden = ? WHERE id = ?", [hidden ? 1 : 0, id]);
  }

  function setCategoryPrivateDefault(id, isPrivate) {
    db.run("UPDATE categories SET is_private_default = ? WHERE id = ?", [isPrivate ? 1 : 0, id]);
  }

  function setDefaultBudget(id, yen) {
    db.run("UPDATE categories SET default_weekly_budget_yen = ? WHERE id = ?",
           [Math.round(yen), id]);
  }

  // ---------- 明細 ----------

  // 収入に満足度は付けない。画面が何を渡しても、カテゴリの種類で決める。
  function addEntry(e) {
    var cat = db.one("SELECT kind FROM categories WHERE id = ?", [e.category_id]);
    var satisfaction = (cat && cat.kind === 'income') ? null : (e.satisfaction || 'ok');
    db.run(
      "INSERT INTO entries (date, amount_yen, category_id, memo, satisfaction, is_private, created_at)" +
      " VALUES (?, ?, ?, ?, ?, ?, ?)",
      [e.date, Math.round(e.amount_yen), e.category_id, e.memo || null,
       satisfaction, e.is_private ? 1 : 0, new Date().toISOString()]);
  }

  function deleteEntry(id) {
    db.run("DELETE FROM entries WHERE id = ?", [id]);
  }

  var ENTRY_COLS =
    "SELECT e.id, e.date, e.amount_yen, e.memo, e.satisfaction, e.is_private," +
    " c.name AS category_name, c.kind AS kind";

  // 共有モードでは、プライベート印の明細と
  // 既定プライベートなカテゴリの明細をまとめて外す。
  function privateClause(includePrivate) {
    return includePrivate ? "" : " AND e.is_private = 0 AND c.is_private_default = 0";
  }

  function recentEntries(limit, includePrivate) {
    return db.all(
      ENTRY_COLS + " FROM entries e JOIN categories c ON c.id = e.category_id" +
      " WHERE 1 = 1" + privateClause(includePrivate) +
      " ORDER BY e.date DESC, e.id DESC LIMIT ?", [limit]);
  }

  function entriesInWeek(weekStart, includePrivate) {
    return db.all(
      ENTRY_COLS + " FROM entries e JOIN categories c ON c.id = e.category_id" +
      " WHERE e.date BETWEEN ? AND ?" + privateClause(includePrivate) +
      " ORDER BY e.date DESC, e.id DESC", [weekStart, weekEndOf(weekStart)]);
  }

  // 期間内の収入の合計。支出と予算の計算には混ぜない。
  function incomeTotal(from, to, includePrivate) {
    return db.one(
      "SELECT COALESCE(SUM(e.amount_yen), 0) AS total, COUNT(*) AS n" +
      " FROM entries e JOIN categories c ON c.id = e.category_id" +
      " WHERE c.kind = 'income' AND e.date BETWEEN ? AND ?" +
      privateClause(includePrivate),
      [from, to]);
  }

  function weekIncome(weekStart, includePrivate) {
    return incomeTotal(weekStart, weekEndOf(weekStart), includePrivate);
  }

  // ---------- 週予算 ----------

  // その週の予算をまだ固定していなければ、既定値から作って固定する。
  // 一度固定すれば、あとで既定値を変えても過去の週は動かない。
  function ensureWeekBudgets(weekStart) {
    if (weekStart > currentWeekStart()) return; // 未来の週はまだ固定しない
    var row = db.one("SELECT COUNT(*) AS n FROM week_budgets WHERE week_start = ?", [weekStart]);
    if (row.n > 0) return;
    db.run(
      "INSERT INTO week_budgets (week_start, category_id, amount_yen)" +
      " SELECT ?, id, default_weekly_budget_yen FROM categories" +
      " WHERE kind = 'expense' AND is_hidden = 0", [weekStart]);
  }

  function setWeekBudget(weekStart, categoryId, yen) {
    db.run(
      "INSERT INTO week_budgets (week_start, category_id, amount_yen) VALUES (?, ?, ?)" +
      " ON CONFLICT(week_start, category_id) DO UPDATE SET amount_yen = excluded.amount_yen",
      [weekStart, categoryId, Math.round(yen)]);
  }

  // カテゴリごとの予算と実績。画面の棒グラフはこれだけで描ける。
  function weekBudgetRows(weekStart, includePrivate) {
    ensureWeekBudgets(weekStart);
    var privEntry = includePrivate ? "" : " AND e.is_private = 0";
    return db.all(
      "SELECT c.id, c.name, c.is_private_default," +
      " COALESCE(b.amount_yen, c.default_weekly_budget_yen) AS budget," +
      " COALESCE((SELECT SUM(e.amount_yen) FROM entries e" +
      "   WHERE e.category_id = c.id AND e.date BETWEEN :s AND :e" + privEntry + "), 0) AS spent" +
      " FROM categories c" +
      " LEFT JOIN week_budgets b ON b.category_id = c.id AND b.week_start = :s" +
      " WHERE c.kind = 'expense' AND c.is_hidden = 0" +
      (includePrivate ? "" : " AND c.is_private_default = 0") +
      " ORDER BY c.sort_order, c.id",
      { ':s': weekStart, ':e': weekEndOf(weekStart) });
  }

  function weekTotals(weekStart, includePrivate) {
    var rows = weekBudgetRows(weekStart, includePrivate);
    var budget = 0, spent = 0;
    rows.forEach(function (r) { budget += r.budget; spent += r.spent; });
    return { budget: budget, spent: spent, rows: rows };
  }

  // ---------- 月 ----------

  function monthOf(dateStr) { return dateStr.slice(0, 7); } // 'YYYY-MM-DD' → 'YYYY-MM'

  function currentMonth() { return monthOf(today()); }

  function monthRange(month) { // 'YYYY-MM' → { from, to, days }
    var days = new Date(+month.slice(0, 4), +month.slice(5, 7), 0).getDate();
    return { from: month + '-01', to: month + '-' + pad2(days), days: days };
  }

  function shiftMonth(month, n) {
    var d = new Date(+month.slice(0, 4), +month.slice(5, 7) - 1 + n, 1);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1);
  }

  function formatMonth(month) {
    return (+month.slice(0, 4)) + '年' + (+month.slice(5, 7)) + '月';
  }

  // 月予算は週予算から自動で出す：週予算 × その月の日数 ÷ 7。
  // ×4 だと5週ある月で少なく出るので、日数で按分する。
  // 週予算と違いスナップショットは取らず、今の既定値から毎回計算する。
  function monthlyBudgetYen(weeklyYen, daysInMonth) {
    return Math.round(weeklyYen * daysInMonth / 7);
  }

  function entriesInMonth(month, includePrivate) {
    var r = monthRange(month);
    return db.all(
      ENTRY_COLS + " FROM entries e JOIN categories c ON c.id = e.category_id" +
      " WHERE e.date BETWEEN ? AND ?" + privateClause(includePrivate) +
      " ORDER BY e.date DESC, e.id DESC", [r.from, r.to]);
  }

  function monthBudgetRows(month, includePrivate) {
    var r = monthRange(month);
    var privEntry = includePrivate ? "" : " AND e.is_private = 0";
    var rows = db.all(
      "SELECT c.id, c.name, c.is_private_default," +
      " c.default_weekly_budget_yen AS weekly," +
      " COALESCE((SELECT SUM(e.amount_yen) FROM entries e" +
      "   WHERE e.category_id = c.id AND e.date BETWEEN :s AND :e" + privEntry + "), 0) AS spent" +
      " FROM categories c" +
      " WHERE c.kind = 'expense' AND c.is_hidden = 0" +
      (includePrivate ? "" : " AND c.is_private_default = 0") +
      " ORDER BY c.sort_order, c.id",
      { ':s': r.from, ':e': r.to });
    return rows.map(function (row) {
      return {
        id: row.id, name: row.name, is_private_default: row.is_private_default,
        budget: monthlyBudgetYen(row.weekly, r.days), spent: row.spent
      };
    });
  }

  function monthTotals(month, includePrivate) {
    var rows = monthBudgetRows(month, includePrivate);
    var budget = 0, spent = 0;
    rows.forEach(function (r) { budget += r.budget; spent += r.spent; });
    return { budget: budget, spent: spent, rows: rows };
  }

  function monthIncome(month, includePrivate) {
    var r = monthRange(month);
    return incomeTotal(r.from, r.to, includePrivate);
  }

  // 自分で「無駄だった」と付けた出費の合計。振り返りで一番効く数字。
  function wasteTotal(weekStart, includePrivate) {
    return db.one(
      "SELECT COALESCE(SUM(e.amount_yen), 0) AS total, COUNT(*) AS n" +
      " FROM entries e JOIN categories c ON c.id = e.category_id" +
      " WHERE e.satisfaction = 'waste' AND e.date BETWEEN ? AND ?" +
      privateClause(includePrivate),
      [weekStart, weekEndOf(weekStart)]);
  }

  // ---------- 振り返り ----------

  function getReview(weekStart) {
    return db.one("SELECT * FROM weekly_reviews WHERE week_start = ?", [weekStart]);
  }

  function saveReview(weekStart, rating, goodNote, nextNote) {
    db.run(
      "INSERT INTO weekly_reviews (week_start, rating, good_note, next_note, created_at)" +
      " VALUES (?, ?, ?, ?, ?)" +
      " ON CONFLICT(week_start) DO UPDATE SET" +
      " rating = excluded.rating, good_note = excluded.good_note, next_note = excluded.next_note",
      [weekStart, rating, goodNote, nextNote, new Date().toISOString()]);
  }

  function reviewHistory(limit) {
    return db.all("SELECT * FROM weekly_reviews ORDER BY week_start DESC LIMIT ?", [limit]);
  }

  // 先週の記録があるのに振り返りが未記入なら、その週の開始日を返す
  function pendingReviewWeek() {
    var prev = addDays(currentWeekStart(), -7);
    var has = db.one("SELECT 1 AS x FROM entries WHERE date BETWEEN ? AND ? LIMIT 1",
                     [prev, weekEndOf(prev)]);
    if (!has) return null;
    return getReview(prev) ? null : prev;
  }

  KB.repo = {
    init: function () { db = KB.db; },

    // 日付
    today: today,
    addDays: addDays,
    weekStartOf: weekStartOf,
    currentWeekStart: currentWeekStart,
    weekEndOf: weekEndOf,
    formatWeek: formatWeek,
    dayIndexInWeek: dayIndexInWeek,
    weekStartDow: weekStartDow,

    // カテゴリ
    categories: categories,
    visibleCategories: visibleCategories,
    visibleExpenseCategories: visibleExpenseCategories,
    addCategory: addCategory,
    renameCategory: renameCategory,
    setCategoryHidden: setCategoryHidden,
    setCategoryPrivateDefault: setCategoryPrivateDefault,
    setDefaultBudget: setDefaultBudget,

    // 明細
    addEntry: addEntry,
    deleteEntry: deleteEntry,
    recentEntries: recentEntries,
    entriesInWeek: entriesInWeek,
    incomeTotal: incomeTotal,
    weekIncome: weekIncome,

    // 月
    monthOf: monthOf,
    currentMonth: currentMonth,
    monthRange: monthRange,
    shiftMonth: shiftMonth,
    formatMonth: formatMonth,
    monthlyBudgetYen: monthlyBudgetYen,
    entriesInMonth: entriesInMonth,
    monthBudgetRows: monthBudgetRows,
    monthTotals: monthTotals,
    monthIncome: monthIncome,

    // 予算
    setWeekBudget: setWeekBudget,
    weekBudgetRows: weekBudgetRows,
    weekTotals: weekTotals,
    wasteTotal: wasteTotal,

    // 振り返り
    getReview: getReview,
    saveReview: saveReview,
    reviewHistory: reviewHistory,
    pendingReviewWeek: pendingReviewWeek
  };
})();
