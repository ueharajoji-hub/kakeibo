// ============================================================
// app.js — 画面。データは KB.repo 経由でしか触らない。
// ============================================================
(function () {
  'use strict';

  var repo = null;
  var db = null;

  var state = {
    mode: 'personal',   // 'personal' | 'shared'
    reviewWeek: null,   // 振り返りタブが見ている週
    tab: 'input',
    kind: 'expense'     // 入力タブで記録しているのが支出か収入か
  };

  function includePrivate() { return state.mode === 'personal'; }

  // ---------- 小物 ----------

  var $ = function (id) { return document.getElementById(id); };

  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function yen(n) {
    var sign = n < 0 ? '-' : '';
    return sign + '¥' + Math.abs(Math.round(n)).toLocaleString('ja-JP');
  }

  function mmdd(dateStr) {
    var p = dateStr.split('-');
    return (+p[1]) + '/' + (+p[2]);
  }

  var SAT_LABEL = { good: 'よかった', ok: '', waste: '無駄' };

  // ---------- モード ----------

  function applyMode() {
    var shared = state.mode === 'shared';
    document.body.classList.toggle('shared', shared);
    var btn = $('mode-btn');
    btn.textContent = shared ? '共有' : '個人';
    btn.title = shared ? 'タップして個人モードに戻る' : 'タップして共有モードにする';
    try { localStorage.setItem('kb-mode', state.mode); } catch (e) { /* 使えなくても動く */ }
  }

  // PIN は覗き見よけ。暗号強度の話ではないので、使える手段で素直にハッシュする。
  function hashPin(pin) {
    if (window.crypto && crypto.subtle && window.isSecureContext) {
      var bytes = new TextEncoder().encode('kakeibo:' + pin);
      return crypto.subtle.digest('SHA-256', bytes).then(function (buf) {
        return Array.prototype.map.call(new Uint8Array(buf), function (b) {
          return ('0' + b.toString(16)).slice(-2);
        }).join('');
      });
    }
    var h = 5381;
    for (var i = 0; i < pin.length; i++) h = ((h * 33) ^ pin.charCodeAt(i)) >>> 0;
    return Promise.resolve('fallback:' + h.toString(16));
  }

  function toggleMode() {
    if (state.mode === 'personal') {
      // 隠す方向は確認なしで即座に
      state.mode = 'shared';
      applyMode();
      renderAll();
      return;
    }
    var stored = db.getSetting('pin_hash');
    if (!stored) {
      state.mode = 'personal';
      applyMode();
      renderAll();
      return;
    }
    var input = prompt('個人モードに戻ります。PIN を入力してください。');
    if (input === null) return;
    hashPin(input).then(function (h) {
      if (h !== stored) { alert('PIN が違います。'); return; }
      state.mode = 'personal';
      applyMode();
      renderAll();
    });
  }

  // ---------- 入力タブ ----------

  function fillCategorySelect() {
    var sel = $('f-category');
    var keep = sel.value;
    var cats = repo.visibleCategories(state.kind, includePrivate());
    sel.innerHTML = cats.map(function (c) {
      return '<option value="' + c.id + '" data-priv="' + c.is_private_default + '">' +
             esc(c.name) + (c.is_private_default ? ' 🔒' : '') + '</option>';
    }).join('');
    if (keep) sel.value = keep;
    // 前の選択肢が消えたとき（共有モードへの切替・支出/収入の切替）は先頭に戻す
    if (!sel.value && sel.options.length) sel.selectedIndex = 0;
    syncPrivateCheckbox();
  }

  // 支出と収入でフォームの中身を切り替える。収入には満足度を付けない。
  function applyKind() {
    var income = state.kind === 'income';
    $('entry-form').classList.toggle('income', income);
    $('f-sat-wrap').hidden = income;
    $('f-submit').textContent = income ? '収入を記録する' : '記録する';
    $('f-category').value = '';
    fillCategorySelect();
  }

  // カテゴリを選んだら、チェックをそのカテゴリの既定値に合わせる。
  // 入力のたびに思い出さなくていいようにするための仕掛け。
  // 外す方向も合わせないと、嗜好品のあとに記録した食費までプライベートになる。
  function syncPrivateCheckbox() {
    var opt = $('f-category').selectedOptions[0];
    if (!opt) return;
    $('f-private').checked = opt.dataset.priv === '1';
  }

  function renderRecent() {
    renderEntryList($('recent'), repo.recentEntries(20, includePrivate()));
  }

  function renderEntryList(ul, rows) {
    if (!rows.length) {
      ul.innerHTML = '<li class="empty">まだ記録がありません</li>';
      return;
    }
    ul.innerHTML = rows.map(function (r) {
      var tags = '';
      if (r.is_private) tags += '<em class="tag priv">🔒</em>';
      if (SAT_LABEL[r.satisfaction]) {
        tags += '<em class="tag ' + r.satisfaction + '">' + SAT_LABEL[r.satisfaction] + '</em>';
      }
      return '<li>' +
        '<span class="d">' + mmdd(r.date) + '</span>' +
        '<span class="c">' + esc(r.category_name) + tags +
          (r.memo ? '<small>' + esc(r.memo) + '</small>' : '') + '</span>' +
        (r.kind === 'income'
          ? '<span class="a income">+' + yen(r.amount_yen) + '</span>'
          : '<span class="a">' + yen(r.amount_yen) + '</span>') +
        '<button class="del" data-id="' + r.id + '" type="button" aria-label="削除">✕</button>' +
        '</li>';
    }).join('');
  }

  function onSubmitEntry(ev) {
    ev.preventDefault();
    var amount = parseInt($('f-amount').value, 10);
    if (!(amount > 0)) { alert('金額を入れてください。'); return; }
    repo.addEntry({
      date: $('f-date').value,
      amount_yen: amount,
      category_id: parseInt($('f-category').value, 10),
      memo: $('f-memo').value.trim(),
      satisfaction: (document.querySelector('input[name="sat"]:checked') || {}).value || 'ok',
      is_private: $('f-private').checked
    });
    $('f-amount').value = '';
    $('f-memo').value = '';
    $('f-amount').focus();
    renderAll();
  }

  // ---------- 今週タブ ----------

  function renderWeek() {
    var ws = repo.currentWeekStart();
    var t = repo.weekTotals(ws, includePrivate());
    var left = t.budget - t.spent;
    var daysLeft = 7 - repo.dayIndexInWeek(ws) + 1;

    $('w-spent').textContent = yen(t.spent);
    $('w-left').textContent = yen(left);
    $('w-left').className = left < 0 ? 'over' : '';
    $('w-perday').textContent = yen(Math.max(0, Math.floor(left / daysLeft)));

    var inc = repo.weekIncome(ws, includePrivate());
    $('w-income').hidden = !inc.n;
    $('w-income').innerHTML = '今週の収入 <b>+' + yen(inc.total) + '</b>（' + inc.n + '件）';

    renderBudgetRows($('budget-list'), t.rows);
    renderEntryList($('week-entries'), repo.entriesInWeek(ws, includePrivate()));
  }

  function renderBudgetRows(ul, rows) {
    if (!rows.length) {
      ul.innerHTML = '<li class="empty">カテゴリがありません</li>';
      return;
    }
    ul.innerHTML = rows.map(function (r) {
      var pct = r.budget > 0 ? Math.min(100, Math.round(r.spent / r.budget * 100)) : (r.spent > 0 ? 100 : 0);
      var over = r.budget > 0 && r.spent > r.budget;
      var warn = !over && r.budget > 0 && r.spent >= r.budget * 0.8;
      var cls = over ? 'over' : (warn ? 'warn' : '');
      return '<li>' +
        '<div class="brow"><span>' + esc(r.name) +
          (r.is_private_default ? ' 🔒' : '') + '</span>' +
          '<span class="' + cls + '">' + yen(r.spent) + ' / ' + yen(r.budget) + '</span></div>' +
        '<div class="bar"><i class="' + cls + '" style="width:' + pct + '%"></i></div>' +
        '</li>';
    }).join('');
  }

  // ---------- 振り返りタブ ----------

  function renderReview() {
    var ws = state.reviewWeek;
    $('rv-label').textContent = repo.formatWeek(ws);

    var t = repo.weekTotals(ws, includePrivate());
    var diff = t.budget - t.spent;
    $('rv-spent').textContent = yen(t.spent);
    $('rv-budget').textContent = yen(t.budget);
    $('rv-diff').textContent = yen(diff);
    $('rv-diff').className = diff < 0 ? 'over' : 'good';

    var w = repo.wasteTotal(ws, includePrivate());
    $('rv-waste').textContent = w.n
      ? '「無駄だった」と付けた出費は ' + w.n + '件・' + yen(w.total) + 'でした。'
      : '「無駄だった」と付けた出費はありません。';

    renderBudgetRows($('rv-list'), t.rows);

    var rev = repo.getReview(ws);
    var radio = document.querySelector('input[name="rating"][value="' + (rev && rev.rating) + '"]');
    Array.prototype.forEach.call(document.querySelectorAll('input[name="rating"]'), function (el) {
      el.checked = false;
    });
    if (radio) radio.checked = true;
    $('rv-good').value = rev ? (rev.good_note || '') : '';
    $('rv-plan').value = rev ? (rev.next_note || '') : '';

    // 未来の週には進ませない
    $('rv-next').disabled = (repo.addDays(ws, 7) > repo.currentWeekStart());

    renderHistory();
  }

  function renderHistory() {
    var rows = repo.reviewHistory(20);
    var ul = $('rv-history');
    if (!rows.length) {
      ul.innerHTML = '<li class="empty">まだ振り返りがありません</li>';
      return;
    }
    ul.innerHTML = rows.map(function (r) {
      return '<li class="rev">' +
        '<span class="d">' + repo.formatWeek(r.week_start) + '</span>' +
        '<span class="c">' + (r.rating ? '評価 ' + r.rating + '/5' : '') +
          (r.good_note ? '<small>' + esc(r.good_note) + '</small>' : '') +
          (r.next_note ? '<small>→ ' + esc(r.next_note) + '</small>' : '') +
        '</span></li>';
    }).join('');
  }

  function onSubmitReview(ev) {
    ev.preventDefault();
    var r = document.querySelector('input[name="rating"]:checked');
    repo.saveReview(state.reviewWeek, r ? parseInt(r.value, 10) : null,
                    $('rv-good').value.trim(), $('rv-plan').value.trim());
    renderReview();
    showBanner('振り返りを保存しました。');
  }

  // ---------- 設定タブ ----------

  function renderSettings() {
    var cats = repo.categories('expense', false);

    $('cat-budget-list').innerHTML = cats.map(function (c) {
      return '<li class="edit"><span>' + esc(c.name) + (c.is_private_default ? ' 🔒' : '') + '</span>' +
        '<input type="number" step="100" min="0" data-cat="' + c.id +
        '" value="' + c.default_weekly_budget_yen + '"></li>';
    }).join('');

    $('cat-list').innerHTML = repo.categories('expense', true).map(categoryRow).join('');
    $('income-cat-list').innerHTML = repo.categories('income', true).map(categoryRow).join('');

    $('set-dow').value = String(repo.weekStartDow());
    $('notify-btn').textContent =
      (window.Notification && Notification.permission === 'granted')
        ? '通知は許可されています' : '通知を許可する';
  }

  function categoryRow(c) {
    return '<li' + (c.is_hidden ? ' class="hidden-cat"' : '') + '>' +
      '<span>' + esc(c.name) + '</span>' +
      '<label class="mini"><input type="checkbox" data-priv="' + c.id + '"' +
        (c.is_private_default ? ' checked' : '') + '> 🔒 既定でプライベート</label>' +
      '<button class="ghost small" data-hide="' + c.id + '" type="button">' +
        (c.is_hidden ? '戻す' : '非表示') + '</button>' +
      '</li>';
  }

  function saveBudgets() {
    var inputs = $('cat-budget-list').querySelectorAll('input[data-cat]');
    Array.prototype.forEach.call(inputs, function (el) {
      repo.setDefaultBudget(parseInt(el.dataset.cat, 10), parseInt(el.value, 10) || 0);
    });
    // 今週の予算はすでに固定されているので、明示的に聞いてから上書きする
    if (confirm('今週の予算にも反映しますか？（いいえ＝来週から）')) {
      var ws = repo.currentWeekStart();
      Array.prototype.forEach.call(inputs, function (el) {
        repo.setWeekBudget(ws, parseInt(el.dataset.cat, 10), parseInt(el.value, 10) || 0);
      });
    }
    renderAll();
    showBanner('週予算を保存しました。');
  }

  // ---------- バックアップ ----------

  function exportDb() {
    var blob = new Blob([KB.db.exportBytes()], { type: 'application/x-sqlite3' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'kakeibo-' + repo.today() + '.sqlite';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  function importDb(file) {
    if (!confirm('いまのデータは読み込むファイルの内容に置き換わります。続けますか？')) return;
    file.arrayBuffer().then(function (buf) {
      return KB.db.importBytes(buf);
    }).then(function () {
      state.reviewWeek = repo.addDays(repo.currentWeekStart(), -7);
      renderAll();
      showBanner('読み込みました。');
    }).catch(function (err) {
      console.error(err);
      alert('このファイルは読み込めませんでした。');
    });
  }

  // ---------- 通知・お知らせ ----------

  var bannerTimer = null;

  function showBanner(text, persist) {
    var b = $('banner');
    b.textContent = text;
    b.hidden = false;
    if (bannerTimer) clearTimeout(bannerTimer);
    if (!persist) bannerTimer = setTimeout(function () { b.hidden = true; }, 3000);
  }

  function checkPendingReview() {
    var week = repo.pendingReviewWeek();
    if (!week) return;
    showBanner('先週（' + repo.formatWeek(week) + '）の振り返りがまだです。', true);
    if (window.Notification && Notification.permission === 'granted') {
      try {
        new Notification('先週の振り返りがまだです', {
          body: repo.formatWeek(week) + ' の予算と実績を見直しましょう'
        });
      } catch (e) { /* 通知が使えない環境では黙って諦める */ }
    }
  }

  function requestNotify() {
    if (!window.Notification) { alert('この環境では通知が使えません。'); return; }
    Notification.requestPermission().then(function (p) {
      $('notify-btn').textContent = p === 'granted' ? '通知は許可されています' : '通知は許可されていません';
    });
  }

  // ---------- タブ ----------

  function switchTab(name) {
    state.tab = name;
    ['input', 'week', 'review', 'settings'].forEach(function (t) {
      $('tab-' + t).hidden = (t !== name);
    });
    Array.prototype.forEach.call(document.querySelectorAll('#tabbar button'), function (b) {
      b.classList.toggle('on', b.dataset.tab === name);
    });
    renderAll();
  }

  function renderAll() {
    $('week-label').textContent = repo.formatWeek(repo.currentWeekStart()) + ' の週';
    fillCategorySelect();
    if (state.tab === 'input') renderRecent();
    if (state.tab === 'week') renderWeek();
    if (state.tab === 'review') renderReview();
    if (state.tab === 'settings') renderSettings();
  }

  // ---------- 配線 ----------

  function wire() {
    $('mode-btn').addEventListener('click', toggleMode);
    $('entry-form').addEventListener('submit', onSubmitEntry);
    $('f-category').addEventListener('change', syncPrivateCheckbox);
    $('f-kind').addEventListener('change', function (ev) {
      state.kind = ev.target.value;
      applyKind();
    });
    $('review-form').addEventListener('submit', onSubmitReview);
    $('save-budgets').addEventListener('click', saveBudgets);
    $('export-btn').addEventListener('click', exportDb);

    $('import-input').addEventListener('change', function () {
      if (this.files[0]) importDb(this.files[0]);
      this.value = '';
    });

    $('notify-btn').addEventListener('click', requestNotify);

    Array.prototype.forEach.call(document.querySelectorAll('#tabbar button'), function (b) {
      b.addEventListener('click', function () { switchTab(b.dataset.tab); });
    });

    $('rv-prev').addEventListener('click', function () {
      state.reviewWeek = repo.addDays(state.reviewWeek, -7);
      renderReview();
    });
    $('rv-next').addEventListener('click', function () {
      var next = repo.addDays(state.reviewWeek, 7);
      if (next > repo.currentWeekStart()) return;
      state.reviewWeek = next;
      renderReview();
    });

    // 明細の削除（一覧はDOMを作り直すのでイベントは親で受ける）
    document.addEventListener('click', function (ev) {
      if (!ev.target || !ev.target.closest) return;
      var del = ev.target.closest('.del');
      if (del) {
        if (confirm('この記録を削除しますか？')) {
          repo.deleteEntry(parseInt(del.dataset.id, 10));
          renderAll();
        }
        return;
      }
      var hide = ev.target.closest('[data-hide]');
      if (hide) {
        var id = parseInt(hide.dataset.hide, 10);
        var isHidden = hide.textContent.trim() === '戻す';
        repo.setCategoryHidden(id, !isHidden);
        renderAll();
      }
    });

    function onPrivDefaultChange(ev) {
      var cb = ev.target.closest('[data-priv]');
      if (!cb) return;
      repo.setCategoryPrivateDefault(parseInt(cb.dataset.priv, 10), cb.checked);
      renderAll();
    }
    $('cat-list').addEventListener('change', onPrivDefaultChange);
    $('income-cat-list').addEventListener('change', onPrivDefaultChange);

    $('cat-form').addEventListener('submit', function (ev) {
      ev.preventDefault();
      var name = $('new-cat').value.trim();
      if (!name) return;
      repo.addCategory(name, 'expense');
      $('new-cat').value = '';
      renderAll();
    });

    $('income-cat-form').addEventListener('submit', function (ev) {
      ev.preventDefault();
      var name = $('new-income-cat').value.trim();
      if (!name) return;
      repo.addCategory(name, 'income');
      $('new-income-cat').value = '';
      renderAll();
    });

    $('set-dow').addEventListener('change', function () {
      db.setSetting('week_start_dow', this.value);
      state.reviewWeek = repo.addDays(repo.currentWeekStart(), -7);
      renderAll();
    });

    $('pin-form').addEventListener('submit', function (ev) {
      ev.preventDefault();
      var pin = $('set-pin').value;
      if (pin.length < 4) { alert('4文字以上にしてください。'); return; }
      hashPin(pin).then(function (h) {
        db.setSetting('pin_hash', h);
        $('set-pin').value = '';
        showBanner('PIN を設定しました。');
      });
    });

    $('clear-pin').addEventListener('click', function () {
      db.setSetting('pin_hash', '');
      showBanner('PIN を解除しました。');
    });

    // 閉じる直前の取りこぼしを防ぐ
    window.addEventListener('pagehide', function () { KB.db.saveNow(); });
  }

  // ---------- 起動 ----------

  function start() {
    db = KB.db;
    KB.repo.init();
    repo = KB.repo;

    try {
      var saved = localStorage.getItem('kb-mode');
      if (saved === 'shared') state.mode = 'shared';
    } catch (e) { /* localStorage が無くても動く */ }

    state.reviewWeek = repo.pendingReviewWeek() || repo.addDays(repo.currentWeekStart(), -7);
    $('f-date').value = repo.today();

    applyMode();
    wire();
    switchTab('input');
    checkPendingReview();
  }

  window.addEventListener('DOMContentLoaded', function () {
    KB.db.init().then(start).catch(function (err) {
      console.error(err);
      document.body.innerHTML =
        '<p style="padding:2rem">データベースを開けませんでした。<br>' +
        'オンラインで一度開くと、以後はオフラインでも動きます。<br><small>' +
        esc(err && err.message) + '</small></p>';
    });

    if ('serviceWorker' in navigator && location.protocol !== 'file:') {
      navigator.serviceWorker.register('sw.js').catch(function () { /* 無くても動く */ });
    }
  });
})();
