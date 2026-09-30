// ============================================================
// db.js — SQLite(sql.js) を IndexedDB に永続化する層
//
// 書き込みのたびに DB 全体を Uint8Array に書き出して保存する。
// 家計簿は行数が少ないので、この単純な方法で十分速い。
// ============================================================
var KB = window.KB || {};

(function () {
  'use strict';

  var SQLJS_BASE = 'https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.3/';
  var IDB_NAME   = 'kakeibo-db';
  var IDB_STORE  = 'files';
  var IDB_KEY    = 'main.sqlite';
  var SCHEMA_VERSION = 1;

  var db = null;
  var saveTimer = null;

  // ---------- IndexedDB（DBファイルの置き場所） ----------

  function openIdb() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = function () {
        req.result.createObjectStore(IDB_STORE);
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  function idbGet(key) {
    return openIdb().then(function (idb) {
      return new Promise(function (resolve, reject) {
        var tx = idb.transaction(IDB_STORE, 'readonly');
        var req = tx.objectStore(IDB_STORE).get(key);
        req.onsuccess = function () { resolve(req.result || null); };
        req.onerror = function () { reject(req.error); };
      });
    });
  }

  function idbPut(key, value) {
    return openIdb().then(function (idb) {
      return new Promise(function (resolve, reject) {
        var tx = idb.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).put(value, key);
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }

  // ---------- スキーマ ----------

  var SCHEMA = [
    "CREATE TABLE IF NOT EXISTS categories (" +
    "  id INTEGER PRIMARY KEY AUTOINCREMENT," +
    "  name TEXT NOT NULL," +
    "  kind TEXT NOT NULL CHECK (kind IN ('expense','income'))," +
    "  sort_order INTEGER NOT NULL DEFAULT 0," +
    "  is_hidden INTEGER NOT NULL DEFAULT 0," +            // 削除の代わり
    "  is_private_default INTEGER NOT NULL DEFAULT 0," +   // 既定でプライベート
    "  default_weekly_budget_yen INTEGER NOT NULL DEFAULT 0" +
    ")",

    "CREATE TABLE IF NOT EXISTS entries (" +
    "  id INTEGER PRIMARY KEY AUTOINCREMENT," +
    "  date TEXT NOT NULL," +                    // 'YYYY-MM-DD' ローカル日付
    "  amount_yen INTEGER NOT NULL," +           // 円・整数
    "  category_id INTEGER NOT NULL REFERENCES categories(id)," +
    "  memo TEXT," +
    "  satisfaction TEXT CHECK (satisfaction IN ('good','ok','waste'))," +
    "  is_private INTEGER NOT NULL DEFAULT 0," +
    "  created_at TEXT NOT NULL" +
    ")",
    "CREATE INDEX IF NOT EXISTS idx_entries_date ON entries(date)",

    // 週ごとのスナップショット。既定予算を変えても過去週は動かない。
    "CREATE TABLE IF NOT EXISTS week_budgets (" +
    "  week_start TEXT NOT NULL," +
    "  category_id INTEGER NOT NULL REFERENCES categories(id)," +
    "  amount_yen INTEGER NOT NULL," +
    "  PRIMARY KEY (week_start, category_id)" +
    ")",

    "CREATE TABLE IF NOT EXISTS weekly_reviews (" +
    "  week_start TEXT PRIMARY KEY," +
    "  rating INTEGER," +
    "  good_note TEXT," +
    "  next_note TEXT," +
    "  created_at TEXT NOT NULL" +
    ")",

    "CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)"
  ];

  // name, private既定, 既定の週予算
  var SEED_EXPENSE = [
    ['食費',   0, 6000],
    ['外食',   0, 2000],
    ['日用品', 0, 1500],
    ['交通費', 0, 1000],
    ['交際費', 0, 2000],
    ['趣味',   0, 2000],
    ['嗜好品', 1, 3000],
    ['医療',   0, 0],
    ['通信',   0, 0],
    ['その他', 0, 1000]
  ];
  var SEED_INCOME = ['給与', 'その他収入'];

  function migrate() {
    SCHEMA.forEach(function (sql) { db.run(sql); });

    var ver = getSetting('schema_version');
    if (ver === null) {
      seed();
      setSetting('schema_version', String(SCHEMA_VERSION));
    }
    // 将来のマイグレーションはここに版ごとに足す
  }

  function seed() {
    SEED_EXPENSE.forEach(function (c, i) {
      db.run(
        "INSERT INTO categories (name, kind, sort_order, is_private_default, default_weekly_budget_yen)" +
        " VALUES (?, 'expense', ?, ?, ?)",
        [c[0], i, c[1], c[2]]
      );
    });
    SEED_INCOME.forEach(function (name, i) {
      db.run(
        "INSERT INTO categories (name, kind, sort_order) VALUES (?, 'income', ?)",
        [name, 100 + i]
      );
    });
    setSetting('week_start_dow', '1');   // 月曜はじまり
  }

  // ---------- クエリのヘルパ ----------

  // SELECT の結果をオブジェクトの配列で返す
  function all(sql, params) {
    var stmt = db.prepare(sql);
    if (params) stmt.bind(params);
    var rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
  }

  function one(sql, params) {
    var rows = all(sql, params);
    return rows.length ? rows[0] : null;
  }

  function run(sql, params) {
    db.run(sql, params || []);
    scheduleSave();
  }

  function getSetting(key) {
    var row = one("SELECT value FROM settings WHERE key = ?", [key]);
    return row ? row.value : null;
  }

  function setSetting(key, value) {
    db.run("INSERT INTO settings (key, value) VALUES (?, ?)" +
           " ON CONFLICT(key) DO UPDATE SET value = excluded.value", [key, String(value)]);
    scheduleSave();
  }

  // ---------- 保存 ----------

  function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 300);
  }

  function saveNow() {
    saveTimer = null;
    if (!db) return Promise.resolve();
    var bytes = db.export();
    return idbPut(IDB_KEY, bytes).catch(function (err) {
      console.error('保存に失敗しました', err);
      alert('データの保存に失敗しました。設定画面から書き出してバックアップを取ってください。');
    });
  }

  // ---------- 起動・入出力 ----------

  function init() {
    return initSqlJs({ locateFile: function (f) { return SQLJS_BASE + f; } })
      .then(function (SQL) {
        return idbGet(IDB_KEY).then(function (bytes) {
          db = bytes ? new SQL.Database(new Uint8Array(bytes)) : new SQL.Database();
          db.run('PRAGMA foreign_keys = ON');
          migrate();
          return saveNow();
        });
      });
  }

  function exportBytes() { return db.export(); }

  function importBytes(bytes) {
    return initSqlJs({ locateFile: function (f) { return SQLJS_BASE + f; } })
      .then(function (SQL) {
        var fresh = new SQL.Database(new Uint8Array(bytes));
        // 家計簿のDBかどうかだけ確かめる
        fresh.exec("SELECT 1 FROM entries LIMIT 1");
        if (db) db.close();
        db = fresh;
        db.run('PRAGMA foreign_keys = ON');
        migrate();
        return saveNow();
      });
  }

  KB.db = {
    init: init,
    all: all,
    one: one,
    run: run,
    getSetting: getSetting,
    setSetting: setSetting,
    saveNow: saveNow,
    exportBytes: exportBytes,
    importBytes: importBytes
  };
  window.KB = KB;
})();
