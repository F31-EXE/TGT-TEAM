'use strict';

/* ================= Storage ================= */

const STORAGE_KEY = 'tgt-team-v1';

const defaultState = () => ({
  settings: { teamName: 'TGT Team', fee: 1000, currency: '₽', startBalance: 0 },
  members: [],   // {id, name, callsign, phone, role, from:'YYYY-MM', left:'YYYY-MM'|null, exempt:bool}
  fees: {},      // {'YYYY-MM': amount} — взнос, зафиксированный за месяц
  payments: {},  // {'YYYY-MM': {memberId: amount}}
  expenses: [],  // {id, date, title, amount, category, kind:'out'|'in'}
  events: [],    // {id, date, title, place, notes, attendance:{memberId:'yes'|'maybe'|'no'}}
  gear: [],      // {id, name, qty, holderId, note}
});

let state = load();

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return Object.assign(defaultState(), JSON.parse(raw));
  } catch (e) { /* ignore */ }
  return defaultState();
}

function save() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) { toast('Не удалось сохранить'); }
}

/* ================= Helpers ================= */

const $ = (sel, root = document) => root.querySelector(sel);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => `${Math.round(n).toLocaleString('ru-RU')}\u00a0${state.settings.currency}`;

const MONTHS = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
const MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

const monthKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
const todayISO = () => { const d = new Date(); return `${monthKey(d)}-${String(d.getDate()).padStart(2, '0')}`; };
const shiftMonth = (key, delta) => { const [y, m] = key.split('-').map(Number); return monthKey(new Date(y, m - 1 + delta, 1)); };
const monthLabel = (key) => { const [y, m] = key.split('-').map(Number); return `${MONTHS[m - 1]} ${y}`; };
const dateLabel = (iso) => { const [y, m, d] = iso.split('-').map(Number); return `${d} ${MONTHS_GEN[m - 1]} ${y}`; };

const displayName = (m) => m ? (m.callsign ? `${m.callsign} (${m.name})` : m.name) : '—';
const shortName = (m) => m ? (m.callsign || m.name) : '—';
const memberById = (id) => state.members.find((m) => m.id === id);
const byName = (a, b) => shortName(a).localeCompare(shortName(b), 'ru');

/* ================= Finance logic ================= */

const feeFor = (month) => state.fees[month] ?? state.settings.fee;
const isActiveIn = (m, month) => m.from <= month && (!m.left || month < m.left);
const activeMembers = (month) => state.members.filter((m) => isActiveIn(m, month)).sort(byName);
const paidAmount = (memberId, month) => (state.payments[month] || {})[memberId] || 0;
const expectedFor = (m, month) => (m.exempt ? 0 : feeFor(month));

function setPayment(memberId, month, amount) {
  if (!state.fees[month]) state.fees[month] = state.settings.fee; // фиксируем размер взноса за месяц
  const bucket = state.payments[month] || (state.payments[month] = {});
  if (amount > 0) bucket[memberId] = amount; else delete bucket[memberId];
  save();
}

/** Долг участника по всем прошедшим месяцам до `untilMonth` включительно. */
function memberDebt(m, untilMonth = monthKey()) {
  let debt = 0;
  const debtMonths = [];
  for (let k = m.from; k <= untilMonth; k = shiftMonth(k, 1)) {
    if (!isActiveIn(m, k)) continue;
    const diff = expectedFor(m, k) - paidAmount(m.id, k);
    if (diff > 0) { debt += diff; debtMonths.push(k); }
  }
  return { debt, debtMonths };
}

function monthSummary(month) {
  const members = activeMembers(month);
  let expected = 0, collected = 0;
  const paid = [], partial = [], unpaid = [];
  for (const m of members) {
    const exp = expectedFor(m, month);
    const got = paidAmount(m.id, month);
    expected += exp;
    collected += got;
    if (exp === 0 || got >= exp) paid.push(m);
    else if (got > 0) partial.push(m);
    else unpaid.push(m);
  }
  return { members, expected, collected, paid, partial, unpaid };
}

function treasuryBalance() {
  let total = Number(state.settings.startBalance) || 0;
  for (const month of Object.keys(state.payments)) {
    for (const v of Object.values(state.payments[month])) total += v;
  }
  for (const e of state.expenses) total += e.kind === 'in' ? e.amount : -e.amount;
  return total;
}

/* ================= UI infrastructure ================= */

const ui = { tab: 'dues', month: monthKey(), eventsFilter: 'upcoming' };

function toast(text) {
  const el = $('#toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { el.hidden = true; }, 2200);
}

async function shareText(text) {
  if (navigator.share) {
    try { await navigator.share({ text }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  try { await navigator.clipboard.writeText(text); toast('Скопировано — вставьте в чат'); }
  catch (e) { prompt('Скопируйте текст:', text); }
}

/** Открывает нижнюю шторку. `onSubmit(formData)` возвращает false, чтобы не закрывать. */
function openSheet(html, { onSubmit, onMount } = {}) {
  const dlg = $('#sheet');
  const form = $('#sheetForm');
  form.innerHTML = html;
  form.onsubmit = (e) => {
    const btn = e.submitter;
    if (btn && btn.value === 'cancel') return;
    if (onSubmit) {
      const res = onSubmit(new FormData(form), btn ? btn.value : '');
      if (res === false) { e.preventDefault(); return; }
    }
    render();
  };
  dlg.onclick = (e) => { if (e.target === dlg) dlg.close(); };
  dlg.showModal();
  if (onMount) onMount(form);
}

function render() {
  $('#teamName').textContent = state.settings.teamName;
  const bal = treasuryBalance();
  $('#topBalance').innerHTML = `<span class="${bal < 0 ? 'neg' : ''}">${money(bal)}</span>`;
  document.querySelectorAll('#tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.tab === ui.tab));
  const view = $('#view');
  view.innerHTML = VIEWS[ui.tab]();
  view.querySelectorAll('[data-act]').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      ACTIONS[el.dataset.act](el.dataset.id, el);
    });
  });
}

/* ================= Views ================= */

const VIEWS = {
  dues() {
    const month = ui.month;
    const s = monthSummary(month);
    const pct = s.expected ? Math.min(100, Math.round((s.collected / s.expected) * 100)) : 0;
    const rows = s.members.map((m) => {
      const exp = expectedFor(m, month);
      const got = paidAmount(m.id, month);
      const cls = exp === 0 || got >= exp ? 'paid' : got > 0 ? 'partial' : '';
      const mark = cls === 'paid' ? '✓' : cls === 'partial' ? '½' : '';
      const { debt } = memberDebt(m, shiftMonth(month, -1));
      const sub = [
        m.exempt ? '<span class="chip accent">освобождён</span>' : '',
        cls === 'partial' ? `<span class="chip">внёс ${money(got)} из ${money(exp)}</span>` : '',
        debt > 0 ? `<span class="chip bad">долг ${money(debt)}</span>` : '',
      ].join('');
      return `<li data-act="editPayment" data-id="${m.id}">
        <button type="button" class="check ${cls}" data-act="togglePaid" data-id="${m.id}" aria-label="Отметить оплату">${mark}</button>
        <div class="grow"><div class="name">${esc(displayName(m))}</div><div class="sub">${sub}</div></div>
        <div class="amt ${got ? 'pos' : 'muted'}">${got ? money(got) : '—'}</div>
      </li>`;
    }).join('');

    return `
      <div class="month-nav">
        <button class="btn icon" data-act="prevMonth" aria-label="Предыдущий месяц">‹</button>
        <div class="title">${monthLabel(month)}</div>
        <button class="btn icon" data-act="nextMonth" aria-label="Следующий месяц">›</button>
      </div>
      <div class="stats">
        <div class="stat ok"><div class="v">${money(s.collected)}</div><div class="l">собрано</div></div>
        <div class="stat"><div class="v">${money(s.expected)}</div><div class="l">ожидается</div></div>
        <div class="stat bad"><div class="v">${money(Math.max(0, s.expected - s.collected))}</div><div class="l">не хватает</div></div>
      </div>
      <div class="small muted">Внесли ${s.paid.length} из ${s.members.length} · взнос ${money(feeFor(month))} <a href="#" data-act="editMonthFee" class="muted">изменить</a></div>
      <div class="progress"><div style="width:${pct}%"></div></div>
      ${s.members.length
        ? `<ul class="list">${rows}</ul>`
        : `<div class="list empty">В этом месяце нет участников.<br><br><button class="btn primary" data-act="addMember">Добавить участника</button></div>`}
      <div class="row" style="margin-top:12px">
        <button class="btn" data-act="shareDues">📣 Отчёт в чат</button>
        <button class="btn" data-act="remindDebtors">⏰ Должникам</button>
      </div>`;
  },

  members() {
    const now = monthKey();
    const active = state.members.filter((m) => isActiveIn(m, now) || m.from > now).sort(byName);
    const former = state.members.filter((m) => m.left && m.left <= now).sort(byName);
    const item = (m) => {
      const { debt } = memberDebt(m);
      return `<li data-act="editMember" data-id="${m.id}">
        <div class="grow">
          <div class="name">${esc(displayName(m))}${m.role ? `<span class="chip accent">${esc(m.role)}</span>` : ''}</div>
          <div class="sub">с ${monthLabel(m.from)}${m.left ? ` по ${monthLabel(shiftMonth(m.left, -1))}` : ''}${m.phone ? ` · ${esc(m.phone)}` : ''}</div>
        </div>
        ${debt > 0 ? `<span class="chip bad">−${money(debt)}</span>` : '<span class="chip ok">ок</span>'}
      </li>`;
    };
    return `
      <h2>Состав команды · ${active.length}</h2>
      ${active.length ? `<ul class="list">${active.map(item).join('')}</ul>` : '<div class="list empty">Пока никого нет. Нажмите «+», чтобы добавить бойца.</div>'}
      ${former.length ? `<h3>Бывшие участники</h3><ul class="list">${former.map(item).join('')}</ul>` : ''}
      <button class="fab" data-act="addMember" aria-label="Добавить">+</button>`;
  },

  treasury() {
    const bal = treasuryBalance();
    let dues = 0;
    for (const mo of Object.values(state.payments)) for (const v of Object.values(mo)) dues += v;
    const out = state.expenses.filter((e) => e.kind !== 'in').reduce((a, e) => a + e.amount, 0);
    const inc = state.expenses.filter((e) => e.kind === 'in').reduce((a, e) => a + e.amount, 0);
    const list = [...state.expenses].sort((a, b) => b.date.localeCompare(a.date));

    const byCat = {};
    for (const e of state.expenses) if (e.kind !== 'in') byCat[e.category || 'Прочее'] = (byCat[e.category || 'Прочее'] || 0) + e.amount;
    const cats = Object.entries(byCat).sort((a, b) => b[1] - a[1]);

    return `
      <div class="card">
        <div class="muted small">Баланс казны</div>
        <div style="font-size:28px;font-weight:800" class="${bal < 0 ? 'neg' : ''}">${money(bal)}</div>
        <div class="small muted" style="margin-top:6px">
          Старт ${money(state.settings.startBalance || 0)} · взносы <span class="pos">+${money(dues)}</span>
          ${inc ? `· поступления <span class="pos">+${money(inc)}</span>` : ''} · расходы <span class="neg">−${money(out)}</span>
        </div>
      </div>
      ${cats.length ? `<h3>Расходы по категориям</h3><ul class="list">${cats.map(([c, v]) => `
        <li style="cursor:default"><div class="grow"><div class="name">${esc(c)}</div>
        <div class="progress" style="margin:6px 0 0"><div style="width:${Math.round((v / out) * 100)}%"></div></div></div>
        <div class="amt">${money(v)}</div></li>`).join('')}</ul>` : ''}
      <h3>Операции</h3>
      ${list.length ? `<ul class="list">${list.map((e) => `
        <li data-act="editExpense" data-id="${e.id}">
          <div class="grow"><div class="name">${esc(e.title)}</div><div class="sub">${dateLabel(e.date)}${e.category ? ` · ${esc(e.category)}` : ''}</div></div>
          <div class="amt ${e.kind === 'in' ? 'pos' : 'neg'}">${e.kind === 'in' ? '+' : '−'}${money(e.amount)}</div>
        </li>`).join('')}</ul>` : '<div class="list empty">Расходов пока нет. Аренда полигона, пиротехника, шевроны — всё сюда.</div>'}
      <button class="fab" data-act="addExpense" aria-label="Добавить операцию">+</button>`;
  },

  events() {
    const today = todayISO();
    const upcoming = ui.eventsFilter === 'upcoming';
    const list = state.events
      .filter((e) => (upcoming ? e.date >= today : e.date < today))
      .sort((a, b) => (upcoming ? a.date.localeCompare(b.date) : b.date.localeCompare(a.date)));
    const counts = (e) => {
      const c = { yes: 0, maybe: 0, no: 0 };
      for (const v of Object.values(e.attendance || {})) c[v]++;
      return c;
    };
    return `
      <div class="seg">
        <button class="${upcoming ? 'active' : ''}" data-act="eventsFilter" data-id="upcoming">Предстоящие</button>
        <button class="${upcoming ? '' : 'active'}" data-act="eventsFilter" data-id="past">Прошедшие</button>
      </div>
      ${list.length ? `<ul class="list">${list.map((e) => {
        const c = counts(e);
        return `<li data-act="openEvent" data-id="${e.id}">
          <div class="grow"><div class="name">${esc(e.title)}</div>
          <div class="sub">${dateLabel(e.date)}${e.time ? `, ${esc(e.time)}` : ''}${e.place ? ` · ${esc(e.place)}` : ''}</div></div>
          <div class="small" style="text-align:right">✅ ${c.yes}<br><span class="muted">❓ ${c.maybe} ❌ ${c.no}</span></div>
        </li>`;
      }).join('')}</ul>` : `<div class="list empty">${upcoming ? 'Нет запланированных игр и тренировок.' : 'Здесь появятся прошедшие игры.'}</div>`}
      <button class="fab" data-act="addEvent" aria-label="Добавить игру">+</button>`;
  },

  more() {
    const gear = [...state.gear].sort((a, b) => a.name.localeCompare(b.name, 'ru'));
    return `
      <h2>Командное имущество</h2>
      ${gear.length ? `<ul class="list">${gear.map((g) => `
        <li data-act="editGear" data-id="${g.id}">
          <div class="grow"><div class="name">${esc(g.name)}${g.qty > 1 ? ` <span class="chip">×${g.qty}</span>` : ''}</div>
          <div class="sub">${g.holderId ? `у ${esc(shortName(memberById(g.holderId)))}` : 'на складе'}${g.note ? ` · ${esc(g.note)}` : ''}</div></div>
        </li>`).join('')}</ul>` : '<div class="list empty">Рации, палатки, флаги, аптечки — учитывайте, у кого что на руках.</div>'}
      <button class="btn block" style="margin-top:8px" data-act="addGear">+ Добавить имущество</button>

      <h3>Настройки</h3>
      <div class="card"><div class="row">
        <button class="btn" data-act="editSettings">⚙️ Команда и взнос</button>
      </div></div>

      <h3>Данные</h3>
      <div class="card">
        <p class="small muted" style="margin-top:0">Данные хранятся на этом телефоне. Делайте резервную копию и передавайте файл казначею-сменщику.</p>
        <div class="row">
          <button class="btn" data-act="exportData">⬇️ Экспорт</button>
          <button class="btn" data-act="importData">⬆️ Импорт</button>
        </div>
        <div class="row" style="margin-top:8px"><button class="btn danger" data-act="resetData">Стереть всё</button></div>
      </div>
      <p class="small muted" style="text-align:center">TGT Team · v1.0</p>`;
  },
};

/* ================= Forms ================= */

function memberForm(m) {
  const isNew = !m;
  m = m || { name: '', callsign: '', phone: '', role: '', from: monthKey(), left: null, exempt: false };
  openSheet(`
    <h2>${isNew ? 'Новый боец' : 'Участник'}</h2>
    <label class="field">Позывной<input name="callsign" value="${esc(m.callsign)}" placeholder="Гром"></label>
    <label class="field">Имя *<input name="name" required value="${esc(m.name)}" placeholder="Иван Петров"></label>
    <label class="field">Роль<input name="role" value="${esc(m.role)}" placeholder="командир, медик, снайпер…" list="roles"></label>
    <datalist id="roles"><option>Командир</option><option>Зам. командира</option><option>Казначей</option><option>Медик</option><option>Снайпер</option><option>Пулемётчик</option><option>Связист</option><option>Штурмовик</option><option>Новобранец</option></datalist>
    <label class="field">Телефон / Telegram<input name="phone" value="${esc(m.phone)}" placeholder="@nickname"></label>
    <label class="field">В команде с месяца<input type="month" name="from" required value="${m.from}"></label>
    <label class="toggle"><input type="checkbox" name="exempt" ${m.exempt ? 'checked' : ''}> Освобождён от взносов</label>
    ${!isNew ? `<label class="toggle"><input type="checkbox" name="gone" ${m.left ? 'checked' : ''}> Покинул команду</label>
      <label class="field">Последний месяц в команде<input type="month" name="last" value="${m.left ? shiftMonth(m.left, -1) : monthKey()}"></label>` : ''}
    <div class="row">
      ${!isNew ? '<button class="btn danger" value="delete" formnovalidate>Удалить</button>' : ''}
      <button class="btn" value="cancel" formnovalidate>Отмена</button>
      <button class="btn primary" value="save">Сохранить</button>
    </div>`, {
    onSubmit(fd, action) {
      if (action === 'delete') {
        if (!confirm(`Удалить ${displayName(m)} вместе с историей взносов? Если человек просто ушёл — лучше отметьте «Покинул команду».`)) return false;
        state.members = state.members.filter((x) => x.id !== m.id);
        for (const mo of Object.values(state.payments)) delete mo[m.id];
        for (const ev of state.events) if (ev.attendance) delete ev.attendance[m.id];
        for (const g of state.gear) if (g.holderId === m.id) g.holderId = '';
        save();
        return;
      }
      const data = {
        name: fd.get('name').trim(),
        callsign: fd.get('callsign').trim(),
        role: fd.get('role').trim(),
        phone: fd.get('phone').trim(),
        from: fd.get('from') || monthKey(),
        exempt: fd.get('exempt') === 'on',
        left: fd.get('gone') === 'on' ? shiftMonth(fd.get('last') || monthKey(), 1) : null,
      };
      if (isNew) state.members.push({ id: uid(), ...data });
      else Object.assign(m, data);
      save();
      toast(isNew ? 'Боец добавлен' : 'Сохранено');
    },
  });
}

function paymentForm(m) {
  const month = ui.month;
  const exp = expectedFor(m, month);
  const got = paidAmount(m.id, month);
  const { debt, debtMonths } = memberDebt(m, shiftMonth(month, -1));
  openSheet(`
    <h2>${esc(displayName(m))}</h2>
    <div class="muted">${monthLabel(month)} · взнос ${money(exp)}</div>
    <label class="field">Внесено<input type="number" inputmode="numeric" min="0" step="1" name="amount" value="${got || ''}" placeholder="0"></label>
    <div class="row">
      <button type="button" class="btn" data-fill="${exp}">Полностью</button>
      <button type="button" class="btn" data-fill="0">Не внёс</button>
    </div>
    ${debt > 0 ? `<div class="card" style="margin:0"><b class="neg">Долг за прошлые месяцы: ${money(debt)}</b>
      <div class="small muted">${debtMonths.map(monthLabel).join(', ')}</div>
      <button class="btn block" style="margin-top:8px" value="payDebt">Погасить весь долг</button></div>` : ''}
    <div class="row">
      <button class="btn" value="cancel" formnovalidate>Отмена</button>
      <button class="btn primary" value="save">Сохранить</button>
    </div>`, {
    onMount(form) {
      form.querySelectorAll('[data-fill]').forEach((b) => b.addEventListener('click', () => { form.amount.value = b.dataset.fill; }));
    },
    onSubmit(fd, action) {
      if (action === 'payDebt') {
        for (const k of debtMonths) setPayment(m.id, k, expectedFor(m, k));
        toast(`Долг ${money(debt)} закрыт`);
      }
      setPayment(m.id, month, Math.max(0, Number(fd.get('amount')) || 0));
    },
  });
}

function expenseForm(e) {
  const isNew = !e;
  e = e || { date: todayISO(), title: '', amount: '', category: '', kind: 'out' };
  const cats = [...new Set(['Полигон', 'Пиротехника', 'Снаряжение', 'Транспорт', 'Еда', 'Шевроны и форма', 'Ремонт', ...state.expenses.map((x) => x.category).filter(Boolean)])];
  openSheet(`
    <h2>${isNew ? 'Новая операция' : 'Операция'}</h2>
    <div class="seg" style="margin:0">
      <button type="button" data-kind="out" class="${e.kind !== 'in' ? 'active' : ''}">Расход</button>
      <button type="button" data-kind="in" class="${e.kind === 'in' ? 'active' : ''}">Поступление</button>
    </div>
    <input type="hidden" name="kind" value="${e.kind || 'out'}">
    <label class="field">Сумма *<input type="number" inputmode="numeric" min="1" step="1" name="amount" required value="${e.amount}"></label>
    <label class="field">Описание *<input name="title" required value="${esc(e.title)}" placeholder="Аренда полигона"></label>
    <label class="field">Категория<input name="category" value="${esc(e.category)}" list="cats"></label>
    <datalist id="cats">${cats.map((c) => `<option>${esc(c)}</option>`).join('')}</datalist>
    <label class="field">Дата<input type="date" name="date" required value="${e.date}"></label>
    <div class="row">
      ${!isNew ? '<button class="btn danger" value="delete" formnovalidate>Удалить</button>' : ''}
      <button class="btn" value="cancel" formnovalidate>Отмена</button>
      <button class="btn primary" value="save">Сохранить</button>
    </div>`, {
    onMount(form) {
      form.querySelectorAll('[data-kind]').forEach((b) => b.addEventListener('click', () => {
        form.kind.value = b.dataset.kind;
        form.querySelectorAll('[data-kind]').forEach((x) => x.classList.toggle('active', x === b));
      }));
    },
    onSubmit(fd, action) {
      if (action === 'delete') {
        if (!confirm('Удалить операцию?')) return false;
        state.expenses = state.expenses.filter((x) => x.id !== e.id);
      } else {
        const data = {
          kind: fd.get('kind') === 'in' ? 'in' : 'out',
          amount: Math.abs(Number(fd.get('amount')) || 0),
          title: fd.get('title').trim(),
          category: fd.get('category').trim(),
          date: fd.get('date') || todayISO(),
        };
        if (isNew) state.expenses.push({ id: uid(), ...data });
        else Object.assign(e, data);
      }
      save();
    },
  });
}

function eventForm(ev) {
  const isNew = !ev;
  ev = ev || { date: todayISO(), time: '', title: '', place: '', notes: '', attendance: {} };
  openSheet(`
    <h2>${isNew ? 'Новая игра / тренировка' : 'Редактировать'}</h2>
    <label class="field">Название *<input name="title" required value="${esc(ev.title)}" placeholder="Игра «Штурм высоты»" list="evtypes"></label>
    <datalist id="evtypes"><option>Тренировка</option><option>Воскресная игра</option><option>Крупная игра</option><option>Сбор команды</option><option>Выезд</option></datalist>
    <div class="row">
      <label class="field" style="flex:2">Дата<input type="date" name="date" required value="${ev.date}"></label>
      <label class="field" style="flex:1">Время<input type="time" name="time" value="${esc(ev.time)}"></label>
    </div>
    <label class="field">Место<input name="place" value="${esc(ev.place)}" placeholder="Полигон / координаты"></label>
    <label class="field">Заметки<textarea name="notes" placeholder="Сбор в 8:00, взнос за игру, что взять…">${esc(ev.notes)}</textarea></label>
    <div class="row">
      ${!isNew ? '<button class="btn danger" value="delete" formnovalidate>Удалить</button>' : ''}
      <button class="btn" value="cancel" formnovalidate>Отмена</button>
      <button class="btn primary" value="save">Сохранить</button>
    </div>`, {
    onSubmit(fd, action) {
      if (action === 'delete') {
        if (!confirm('Удалить событие?')) return false;
        state.events = state.events.filter((x) => x.id !== ev.id);
      } else {
        const data = {
          title: fd.get('title').trim(), date: fd.get('date'), time: fd.get('time'),
          place: fd.get('place').trim(), notes: fd.get('notes').trim(),
        };
        if (isNew) state.events.push({ id: uid(), attendance: {}, ...data });
        else Object.assign(ev, data);
      }
      save();
    },
  });
}

function eventCard(ev) {
  const members = activeMembers(ev.date.slice(0, 7));
  const renderRows = () => members.map((m) => {
    const v = ev.attendance[m.id];
    return `<li style="cursor:default"><div class="grow"><div class="name">${esc(shortName(m))}</div></div>
      <div class="att" data-mid="${m.id}">
        <button type="button" data-v="yes" class="${v === 'yes' ? 'on' : ''}">✅</button>
        <button type="button" data-v="maybe" class="${v === 'maybe' ? 'on' : ''}">❓</button>
        <button type="button" data-v="no" class="${v === 'no' ? 'on' : ''}">❌</button>
      </div></li>`;
  }).join('');
  openSheet(`
    <h2>${esc(ev.title)}</h2>
    <div class="muted">${dateLabel(ev.date)}${ev.time ? `, ${esc(ev.time)}` : ''}${ev.place ? ` · ${esc(ev.place)}` : ''}</div>
    ${ev.notes ? `<div class="card" style="margin:0;white-space:pre-wrap">${esc(ev.notes)}</div>` : ''}
    <h3 style="margin:4px 0 0">Кто едет</h3>
    ${members.length ? `<ul class="list" id="attList">${renderRows()}</ul>` : '<div class="muted">Нет участников</div>'}
    <div class="row">
      <button type="button" class="btn" id="shareEvent">📣 В чат</button>
      <button class="btn" value="edit" formnovalidate>Изменить</button>
      <button class="btn primary" value="close">Готово</button>
    </div>`, {
    onMount(form) {
      form.querySelectorAll('.att button').forEach((b) => b.addEventListener('click', () => {
        const mid = b.parentElement.dataset.mid;
        if (ev.attendance[mid] === b.dataset.v) delete ev.attendance[mid];
        else ev.attendance[mid] = b.dataset.v;
        save();
        b.parentElement.querySelectorAll('button').forEach((x) => x.classList.toggle('on', ev.attendance[mid] === x.dataset.v));
      }));
      $('#shareEvent', form).addEventListener('click', () => shareText(eventReport(ev)));
    },
    onSubmit(fd, action) {
      if (action === 'edit') setTimeout(() => eventForm(ev), 0);
    },
  });
}

function gearForm(g) {
  const isNew = !g;
  g = g || { name: '', qty: 1, holderId: '', note: '' };
  const opts = activeMembers(monthKey()).map((m) => `<option value="${m.id}" ${g.holderId === m.id ? 'selected' : ''}>${esc(displayName(m))}</option>`).join('');
  openSheet(`
    <h2>${isNew ? 'Новое имущество' : 'Имущество'}</h2>
    <label class="field">Название *<input name="name" required value="${esc(g.name)}" placeholder="Рация Baofeng UV-5R"></label>
    <label class="field">Количество<input type="number" inputmode="numeric" min="1" name="qty" value="${g.qty}"></label>
    <label class="field">У кого на руках<select name="holderId"><option value="">На складе</option>${opts}</select></label>
    <label class="field">Заметка<input name="note" value="${esc(g.note)}" placeholder="состояние, серийный номер…"></label>
    <div class="row">
      ${!isNew ? '<button class="btn danger" value="delete" formnovalidate>Удалить</button>' : ''}
      <button class="btn" value="cancel" formnovalidate>Отмена</button>
      <button class="btn primary" value="save">Сохранить</button>
    </div>`, {
    onSubmit(fd, action) {
      if (action === 'delete') {
        if (!confirm('Удалить запись?')) return false;
        state.gear = state.gear.filter((x) => x.id !== g.id);
      } else {
        const data = { name: fd.get('name').trim(), qty: Math.max(1, Number(fd.get('qty')) || 1), holderId: fd.get('holderId'), note: fd.get('note').trim() };
        if (isNew) state.gear.push({ id: uid(), ...data });
        else Object.assign(g, data);
      }
      save();
    },
  });
}

function settingsForm() {
  const s = state.settings;
  openSheet(`
    <h2>Настройки команды</h2>
    <label class="field">Название команды<input name="teamName" value="${esc(s.teamName)}"></label>
    <label class="field">Ежемесячный взнос по умолчанию<input type="number" inputmode="numeric" min="0" name="fee" value="${s.fee}"></label>
    <label class="field">Валюта<input name="currency" value="${esc(s.currency)}" maxlength="4"></label>
    <label class="field">Начальный остаток казны<input type="number" inputmode="numeric" name="startBalance" value="${s.startBalance || 0}"></label>
    <div class="small muted">Изменение взноса по умолчанию не меняет суммы уже начатых месяцев — их можно поправить на экране «Взносы».</div>
    <div class="row">
      <button class="btn" value="cancel" formnovalidate>Отмена</button>
      <button class="btn primary" value="save">Сохранить</button>
    </div>`, {
    onSubmit(fd) {
      s.teamName = fd.get('teamName').trim() || 'TGT Team';
      s.fee = Math.max(0, Number(fd.get('fee')) || 0);
      s.currency = fd.get('currency').trim() || '₽';
      s.startBalance = Number(fd.get('startBalance')) || 0;
      save();
      toast('Сохранено');
    },
  });
}

/* ================= Reports ================= */

function duesReport(month) {
  const s = monthSummary(month);
  const line = (m) => `• ${displayName(m)}`;
  const parts = [
    `💰 ${state.settings.teamName} — взносы за ${monthLabel(month)}`,
    `Собрано: ${money(s.collected)} из ${money(s.expected)}`,
    `Баланс казны: ${money(treasuryBalance())}`,
    '',
    `✅ Внесли (${s.paid.length}):`, ...s.paid.map(line),
  ];
  if (s.partial.length) parts.push('', `🟡 Частично (${s.partial.length}):`, ...s.partial.map((m) => `${line(m)} — ещё ${money(expectedFor(m, month) - paidAmount(m.id, month))}`));
  if (s.unpaid.length) parts.push('', `❌ Не внесли (${s.unpaid.length}):`, ...s.unpaid.map(line));
  return parts.join('\n');
}

function debtorsReport() {
  const now = monthKey();
  const debtors = state.members
    .map((m) => ({ m, ...memberDebt(m, now) }))
    .filter((x) => x.debt > 0)
    .sort((a, b) => b.debt - a.debt);
  if (!debtors.length) return null;
  return [
    `⏰ Напоминание о взносах — ${state.settings.teamName}`,
    '',
    ...debtors.map(({ m, debt, debtMonths }) => `• ${m.phone && m.phone.startsWith('@') ? m.phone + ' ' : ''}${displayName(m)} — ${money(debt)} (${debtMonths.map(monthLabel).join(', ')})`),
    '',
    'Просьба закрыть долги до ближайшей игры 🙏',
  ].join('\n');
}

function eventReport(ev) {
  const members = activeMembers(ev.date.slice(0, 7));
  const group = (v) => members.filter((m) => ev.attendance[m.id] === v).map(shortName);
  const unknown = members.filter((m) => !ev.attendance[m.id]).map(shortName);
  const yes = group('yes'), maybe = group('maybe'), no = group('no');
  return [
    `🎯 ${ev.title}`,
    `📅 ${dateLabel(ev.date)}${ev.time ? `, ${ev.time}` : ''}`,
    ev.place ? `📍 ${ev.place}` : '',
    ev.notes ? `\n${ev.notes}` : '',
    '',
    `✅ Едут (${yes.length}): ${yes.join(', ') || '—'}`,
    maybe.length ? `❓ Под вопросом: ${maybe.join(', ')}` : '',
    no.length ? `❌ Не едут: ${no.join(', ')}` : '',
    unknown.length ? `🤷 Не ответили: ${unknown.join(', ')}` : '',
  ].filter((l, i, a) => l !== '' || (a[i - 1] !== '' && i > 0)).join('\n');
}

/* ================= Actions ================= */

const ACTIONS = {
  prevMonth() { ui.month = shiftMonth(ui.month, -1); render(); },
  nextMonth() { ui.month = shiftMonth(ui.month, 1); render(); },
  togglePaid(id) {
    const m = memberById(id);
    const exp = expectedFor(m, ui.month);
    const got = paidAmount(id, ui.month);
    setPayment(id, ui.month, got >= exp && got > 0 ? 0 : exp);
    render();
  },
  editPayment(id) { paymentForm(memberById(id)); },
  editMonthFee(_, el) {
    const v = prompt(`Размер взноса за ${monthLabel(ui.month)}:`, feeFor(ui.month));
    if (v === null) return;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) return toast('Некорректная сумма');
    state.fees[ui.month] = n;
    save();
    render();
  },
  shareDues() { shareText(duesReport(ui.month)); },
  remindDebtors() {
    const text = debtorsReport();
    if (!text) return toast('Должников нет 💪');
    shareText(text);
  },
  addMember() { memberForm(); },
  editMember(id) { memberForm(memberById(id)); },
  addExpense() { expenseForm(); },
  editExpense(id) { expenseForm(state.expenses.find((e) => e.id === id)); },
  eventsFilter(id) { ui.eventsFilter = id; render(); },
  addEvent() { eventForm(); },
  openEvent(id) { eventCard(state.events.find((e) => e.id === id)); },
  addGear() { gearForm(); },
  editGear(id) { gearForm(state.gear.find((g) => g.id === id)); },
  editSettings() { settingsForm(); },
  exportData() {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `tgt-team-${todayISO()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  },
  importData() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.onchange = async () => {
      try {
        const data = JSON.parse(await input.files[0].text());
        if (!data || !Array.isArray(data.members)) throw new Error('bad');
        if (!confirm('Заменить текущие данные данными из файла?')) return;
        state = Object.assign(defaultState(), data);
        save();
        render();
        toast('Данные загружены');
      } catch (e) { toast('Файл не подходит'); }
    };
    input.click();
  },
  resetData() {
    if (!confirm('Стереть ВСЕ данные? Сначала сделайте экспорт!')) return;
    if (prompt('Для подтверждения введите УДАЛИТЬ') !== 'УДАЛИТЬ') return;
    state = defaultState();
    save();
    render();
  },
};

/* ================= Boot ================= */

$('#tabbar').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-tab]');
  if (!b) return;
  ui.tab = b.dataset.tab;
  render();
  window.scrollTo(0, 0);
});

render();

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
