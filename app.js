import { store, cloudConfigured, errorText, emptyState, normalizeState } from './store.js';
import {
  uid, esc, monthKey, todayISO, shiftMonth, monthLabel, dateLabel, dayMonthLabel, sinceLabel,
  normLogin, randomPin, vkLink, vkMention,
} from './util.js';
import { exportXlsx, analyzeWorkbook } from './excel.js';

/* ================= Состояние ================= */

let state = emptyState();
let me; // undefined — загрузка; null — не вошёл; {noAccess}; {admin, memberId}
const ui = { tab: 'dues', month: monthKey(), eventsFilter: 'upcoming', membersView: 'list' };

const $ = (sel, root = document) => root.querySelector(sel);
const isAdmin = () => !!me?.admin;
const money = (n) => `${Math.round(n).toLocaleString('ru-RU')} ${state.settings.currency}`;
const appUrl = () => location.origin + location.pathname.replace(/index\.html$/, '');

const displayName = (m) => m ? (m.callsign ? `${m.callsign} (${m.name})` : m.name) : '—';
const shortName = (m) => m ? (m.callsign || m.name) : '—';
const memberById = (id) => state.members.find((m) => m.id === id);
const byName = (a, b) => shortName(a).localeCompare(shortName(b), 'ru');
const myMember = () => (me?.memberId ? memberById(me.memberId) : null);

/* ================= Финансы ================= */

const feeFor = (month) => state.settings.fees?.[month] ?? state.settings.fee;
const isActiveIn = (m, month) => m.from <= month && (!m.left || month < m.left);
const activeMembers = (month) => state.members.filter((m) => isActiveIn(m, month)).sort(byName);
const paidAmount = (memberId, month) => (state.payments[month] || {})[memberId] || 0;
/** Рекрут и освобождённый не платят; принятый в бойцы платит с месяца принятия. */
const paysIn = (m, month) => m.status !== 'recruit' && !m.exempt && (!m.feeFrom || month >= m.feeFrom);
const expectedFor = (m, month) => (paysIn(m, month) ? feeFor(month) : 0);

function memberDebt(m, untilMonth = monthKey()) {
  let debt = 0;
  const debtMonths = [];
  if (!m.from) return { debt, debtMonths };
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
  const payers = [], free = [], paid = [], partial = [], unpaid = [];
  for (const m of members) {
    const exp = expectedFor(m, month);
    const got = paidAmount(m.id, month);
    collected += got;
    if (exp === 0) { free.push(m); continue; }
    payers.push(m);
    expected += exp;
    if (got >= exp) paid.push(m); else if (got > 0) partial.push(m); else unpaid.push(m);
  }
  return { members, payers, free, expected, collected, paid, partial, unpaid };
}

function treasuryBalance() {
  let total = Number(state.settings.startBalance) || 0;
  for (const mo of Object.values(state.payments)) for (const v of Object.values(mo)) total += v;
  for (const e of state.expenses) total += e.kind === 'in' ? e.amount : -e.amount;
  return total;
}

/* ================= Посещаемость ================= */

/** Прошедшие игры, на которые боец отметил «еду», из всех игр, пока он был в команде. */
function attendanceStats(m) {
  const today = todayISO();
  const past = state.events.filter((e) => e.date < today && isActiveIn(m, e.date.slice(0, 7)));
  const yes = past.filter((e) => e.attendance?.[m.id] === 'yes').length;
  const no = past.filter((e) => e.attendance?.[m.id] === 'no').length;
  return { yes, no, total: past.length, pct: past.length ? Math.round((yes / past.length) * 100) : null };
}

/* ================= Дни рождения ================= */

function nextBirthday(m) {
  if (!m.birthday) return null;
  const [y, mo, d] = m.birthday.split('-').map(Number);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let next = new Date(today.getFullYear(), mo - 1, d);
  if (next < today) next = new Date(today.getFullYear() + 1, mo - 1, d);
  const days = Math.round((next - today) / 864e5);
  return { days, age: next.getFullYear() - y, date: next };
}

function upcomingBirthdays(withinDays) {
  return state.members
    .filter((m) => !m.left || m.left > monthKey())
    .map((m) => ({ m, b: nextBirthday(m) }))
    .filter((x) => x.b && x.b.days <= withinDays)
    .sort((a, b) => a.b.days - b.b.days);
}

const daysWord = (n) => (n % 10 === 1 && n % 100 !== 11 ? 'день' : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? 'дня' : 'дней');
const yearsWord = (n) => (n % 10 === 1 && n % 100 !== 11 ? 'год' : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? 'года' : 'лет');
const whenText = (days) => (days === 0 ? 'сегодня' : days === 1 ? 'завтра' : `через ${days} ${daysWord(days)}`);

function birthdaysIcs() {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//TGT Team//RU', 'CALSCALE:GREGORIAN'];
  for (const m of state.members) {
    if (!m.birthday || m.left) continue;
    const d = m.birthday.replace(/-/g, '');
    lines.push('BEGIN:VEVENT', `UID:bd-${m.id}@tgt-team`, `DTSTAMP:${d}T000000Z`, `DTSTART;VALUE=DATE:${d}`,
      'RRULE:FREQ=YEARLY', `SUMMARY:🎂 ДР: ${displayName(m)}`,
      'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-P1D', `DESCRIPTION:Завтра ДР у ${shortName(m)}`, 'END:VALARM', 'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}

/* ================= Инфраструктура интерфейса ================= */

function toast(text) {
  const el = $('#toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { el.hidden = true; }, 2600);
}

/** Запускает действие с базой и показывает ошибку, если оно не прошло. */
async function run(fn, okText) {
  try {
    await fn();
    if (okText) toast(okText);
    return true;
  } catch (e) {
    console.error(e);
    toast(errorText(e));
    return false;
  }
}

async function shareText(text) {
  if (navigator.share) {
    try { await navigator.share({ text }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  try { await navigator.clipboard.writeText(text); toast('Скопировано — вставьте в беседу ВК'); }
  catch (e) { prompt('Скопируйте текст:', text); }
}

function download(name, content, type) {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function pickFile(accept) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.onchange = () => resolve(input.files[0] || null);
    input.click();
  });
}

/** Нижняя шторка. onSubmit(formData, action) может вернуть false, чтобы не закрывать. */
function openSheet(html, { onSubmit, onMount } = {}) {
  const dlg = $('#sheet');
  const form = $('#sheetForm');
  if (dlg.open) dlg.close();
  form.innerHTML = html;
  form.onsubmit = (e) => {
    const btn = e.submitter;
    const action = btn ? btn.value : '';
    if (action === 'cancel') return;
    if (onSubmit) {
      const res = onSubmit(new FormData(form), action);
      if (res === false) { e.preventDefault(); return; }
    }
    render();
  };
  dlg.onclick = (e) => { if (e.target === dlg) dlg.close(); };
  dlg.showModal();
  if (onMount) onMount(form);
}
const later = (fn) => setTimeout(fn, 0);

function render() {
  document.body.classList.toggle('auth', !me || !!me.noAccess);
  const view = $('#view');
  if (me === undefined) { view.innerHTML = '<div class="auth-box muted">Загрузка…</div>'; return; }
  if (cloudConfigured && !me) { view.innerHTML = loginView(); bindLogin(); return; }
  if (me?.noAccess) {
    view.innerHTML = `<div class="auth-box"><div class="logo">×</div><h2>Нет доступа</h2>
      <p class="muted">${esc(me.error || 'Ваш доступ закрыт или ещё не выдан. Обратитесь к администратору команды.')}</p>
      <button class="btn block" id="logoutBtn">Выйти</button></div>`;
    $('#logoutBtn').onclick = () => store.logout();
    return;
  }
  $('#teamName').textContent = state.settings.teamName;
  const bal = treasuryBalance();
  $('#topBalance').innerHTML = `<span class="${bal < 0 ? 'neg' : ''}">${money(bal)}</span>`;
  document.querySelectorAll('#tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.tab === ui.tab));
  view.innerHTML = VIEWS[ui.tab]();
  view.querySelectorAll('[data-act]').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      ACTIONS[el.dataset.act](el.dataset.id, el);
    });
  });
}

/* ================= Вход ================= */

function loginView() {
  return `<div class="auth-box">
    <img src="icons/icon.svg" width="72" height="72" alt="">
    <h2>${esc(state.settings.teamName || 'TGT Team')}</h2>
    <form id="loginForm" class="stack">
      <label class="field">Логин<input name="login" autocomplete="username" autocapitalize="none" required placeholder="позывной"></label>
      <label class="field">PIN-код<input name="pin" type="password" inputmode="numeric" autocomplete="current-password" required placeholder="••••••"></label>
      <button class="btn primary block">Войти</button>
    </form>
    <p class="small muted">Логин и PIN выдаёт администратор команды.</p>
    <a href="#" id="bootstrapLink" class="small muted">Первый запуск: создать команду</a>
  </div>`;
}

function bindLogin() {
  $('#loginForm').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const btn = e.target.querySelector('button');
    btn.disabled = true;
    await run(() => store.login(fd.get('login'), fd.get('pin')));
    btn.disabled = false;
  };
  $('#bootstrapLink').onclick = (e) => { e.preventDefault(); bootstrapForm(); };
}

function bootstrapForm() {
  const pin = randomPin();
  openSheet(`
    <h2>Новая команда</h2>
    <p class="small muted" style="margin:0">Делается один раз. Вы станете первым администратором.</p>
    <label class="field">Название команды<input name="teamName" required value="TGT Team"></label>
    <label class="field">Ежемесячный взнос<input name="fee" type="number" inputmode="numeric" min="0" required value="1000"></label>
    <label class="field">Ваш позывной<input name="callsign" required></label>
    <label class="field">Ваше имя<input name="name" required></label>
    <label class="field">Логин для входа<input name="login" required autocapitalize="none" placeholder="обычно позывной"></label>
    <label class="field">PIN (минимум 6 цифр) — запомните его<input name="pin" inputmode="numeric" pattern="\\d{6,}" required value="${pin}"></label>
    <div class="row">
      <button class="btn" value="cancel" formnovalidate>Отмена</button>
      <button class="btn primary" value="save">Создать</button>
    </div>`, {
    onSubmit(fd) {
      const data = Object.fromEntries(fd);
      data.fee = Number(data.fee) || 0;
      run(() => store.bootstrap(data), 'Команда создана');
    },
  });
}

/* ================= Экраны ================= */

const VIEWS = {
  dues() {
    const month = ui.month;
    const s = monthSummary(month);
    const pct = s.expected ? Math.min(100, Math.round((s.collected / s.expected) * 100)) : 0;
    const admin = isAdmin();

    const row = (m) => {
      const exp = expectedFor(m, month);
      const got = paidAmount(m.id, month);
      const cls = got >= exp ? 'paid' : got > 0 ? 'partial' : '';
      const mark = cls === 'paid' ? '✓' : cls === 'partial' ? '½' : '';
      const { debt } = memberDebt(m, shiftMonth(month, -1));
      const sub = [
        cls === 'partial' ? `<span class="chip">внёс ${money(got)} из ${money(exp)}</span>` : '',
        debt > 0 ? `<span class="chip bad">долг ${money(debt)}</span>` : '',
      ].join('');
      const mine = m.id === me?.memberId ? ' mine' : '';
      return `<li class="${mine}" data-act="${admin ? 'editPayment' : 'openMember'}" data-id="${m.id}">
        ${admin ? `<button type="button" class="check ${cls}" data-act="togglePaid" data-id="${m.id}" aria-label="Отметить оплату">${mark}</button>`
          : `<span class="check ${cls}">${mark}</span>`}
        <div class="grow"><div class="name">${esc(displayName(m))}</div><div class="sub">${sub}</div></div>
        <div class="amt ${got ? 'pos' : 'muted'}">${got ? money(got) : '—'}</div>
      </li>`;
    };

    return `
      ${birthdayBanner()}
      ${myStatusCard()}
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
      <div class="small muted">Внесли ${s.paid.length} из ${s.payers.length} · взнос ${money(feeFor(month))}
        ${admin ? '<a href="#" data-act="editMonthFee" class="muted">изменить</a>' : ''}</div>
      <div class="progress"><div style="width:${pct}%"></div></div>
      ${s.payers.length ? `<ul class="list">${s.payers.map(row).join('')}</ul>`
        : `<div class="list empty">В этом месяце нет плательщиков.${admin ? '<br><br><button class="btn primary" data-act="addMember">Добавить бойца</button>' : ''}</div>`}
      ${s.free.length ? `<h3>Без взноса · ${s.free.length}</h3><ul class="list">${s.free.map((m) => `
        <li data-act="openMember" data-id="${m.id}">
          <div class="grow"><div class="name">${esc(displayName(m))}</div></div>
          ${m.status === 'recruit' ? '<span class="chip accent">рекрут</span>' : '<span class="chip">освобождён</span>'}
          ${paidAmount(m.id, month) ? `<div class="amt pos">${money(paidAmount(m.id, month))}</div>` : ''}
        </li>`).join('')}</ul>` : ''}
      <div class="row" style="margin-top:12px">
        <button class="btn" data-act="shareDues">» Отчёт в ВК</button>
        ${admin ? '<button class="btn" data-act="remindDebtors">! Должникам</button>' : ''}
      </div>`;
  },

  members() {
    const list = ui.membersView === 'list';
    return `
      <div class="seg">
        <button class="${list ? 'active' : ''}" data-act="membersView" data-id="list">Состав</button>
        <button class="${list ? '' : 'active'}" data-act="membersView" data-id="stats">Посещаемость</button>
      </div>
      ${list ? rosterView() : attendanceView()}
      ${isAdmin() && list ? '<button class="fab" data-act="addMember" aria-label="Добавить">+</button>' : ''}`;
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
    const admin = isAdmin();

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
        <li class="static"><div class="grow"><div class="name">${esc(c)}</div>
        <div class="progress" style="margin:6px 0 0"><div style="width:${Math.round((v / out) * 100)}%"></div></div></div>
        <div class="amt">${money(v)}</div></li>`).join('')}</ul>` : ''}
      <h3>Операции</h3>
      ${list.length ? `<ul class="list">${list.map((e) => `
        <li ${admin ? `data-act="editExpense" data-id="${e.id}"` : 'class="static"'}>
          <div class="grow"><div class="name">${esc(e.title)}</div><div class="sub">${dateLabel(e.date)}${e.category ? ` · ${esc(e.category)}` : ''}</div></div>
          <div class="amt ${e.kind === 'in' ? 'pos' : 'neg'}">${e.kind === 'in' ? '+' : '−'}${money(e.amount)}</div>
        </li>`).join('')}</ul>` : '<div class="list empty">Операций пока нет. Аренда полигона, пиротехника, шевроны — всё сюда.</div>'}
      ${admin ? '<button class="fab" data-act="addExpense" aria-label="Добавить операцию">+</button>' : ''}`;
  },

  events() {
    const today = todayISO();
    const upcoming = ui.eventsFilter === 'upcoming';
    const list = state.events
      .filter((e) => (upcoming ? e.date >= today : e.date < today))
      .sort((a, b) => (upcoming ? a.date.localeCompare(b.date) : b.date.localeCompare(a.date)));
    const counts = (e) => {
      const c = { yes: 0, maybe: 0, no: 0 };
      for (const v of Object.values(e.attendance || {})) if (v in c) c[v]++;
      return c;
    };
    const myMark = (e) => ({ yes: '[+] еду', maybe: '[?] думаю', no: '[×] не еду' }[e.attendance?.[me?.memberId]] || '');
    return `
      <div class="seg">
        <button class="${upcoming ? 'active' : ''}" data-act="eventsFilter" data-id="upcoming">Предстоящие</button>
        <button class="${upcoming ? '' : 'active'}" data-act="eventsFilter" data-id="past">Прошедшие</button>
      </div>
      ${list.length ? `<ul class="list">${list.map((e) => {
        const c = counts(e);
        const mark = myMark(e);
        return `<li data-act="openEvent" data-id="${e.id}">
          <div class="grow"><div class="name">${esc(e.title)}</div>
          <div class="sub">${dateLabel(e.date)}${e.time ? `, ${esc(e.time)}` : ''}${e.place ? ` · ${esc(e.place)}` : ''}</div>
          ${me?.memberId ? `<div class="sub">${mark ? `Вы: ${mark}` : upcoming ? '<span class="chip accent">отметьтесь</span>' : ''}</div>` : ''}</div>
          <div class="small" style="text-align:right">+${c.yes}<br><span class="muted">?${c.maybe} ×${c.no}</span></div>
        </li>`;
      }).join('')}</ul>` : `<div class="list empty">${upcoming ? 'Нет запланированных игр и тренировок.' : 'Здесь появятся прошедшие игры.'}</div>`}
      ${isAdmin() ? '<button class="fab" data-act="addEvent" aria-label="Добавить игру">+</button>' : ''}`;
  },

  more() {
    const admin = isAdmin();
    const gear = [...state.gear].sort((a, b) => a.name.localeCompare(b.name, 'ru'));
    const bdays = state.members.filter((m) => m.birthday && !m.left)
      .map((m) => ({ m, b: nextBirthday(m) })).sort((a, b) => a.b.days - b.b.days);
    const self = myMember();
    return `
      ${cloudConfigured ? `<div class="card row" style="align-items:center">
        <div class="grow" style="flex:1"><div class="small muted">Вы вошли как</div>
        <b>${esc(self ? displayName(self) : '—')}</b> <span class="chip ${admin ? 'accent' : ''}">${admin ? 'админ' : 'участник'}</span></div>
        <button class="btn" style="flex:none" data-act="logout">Выйти</button></div>` : ''}

      <h3>Дни рождения</h3>
      ${bdays.length ? `<ul class="list">${bdays.map(({ m, b }) => `
        <li data-act="openMember" data-id="${m.id}"><div class="grow"><div class="name">${esc(displayName(m))}</div>
        <div class="sub">${dayMonthLabel(m.birthday)} · исполнится ${b.age} ${yearsWord(b.age)}</div></div>
        <span class="chip ${b.days <= 7 ? 'accent' : ''}">${whenText(b.days)}</span></li>`).join('')}</ul>
        <button class="btn block" style="margin-top:8px" data-act="exportIcs">+ Добавить все ДР в календарь телефона</button>`
        : `<div class="list empty">Укажите даты рождения в карточках бойцов — приложение напомнит заранее.</div>`}

      <h3>Командное имущество</h3>
      ${gear.length ? `<ul class="list">${gear.map((g) => `
        <li ${admin ? `data-act="editGear" data-id="${g.id}"` : 'class="static"'}>
          <div class="grow"><div class="name">${esc(g.name)}${g.qty > 1 ? ` <span class="chip">×${g.qty}</span>` : ''}</div>
          <div class="sub">${g.holderId ? `у ${esc(shortName(memberById(g.holderId)))}` : 'на складе'}${g.note ? ` · ${esc(g.note)}` : ''}</div></div>
        </li>`).join('')}</ul>` : '<div class="list empty">Рации, палатки, флаги, аптечки — учитывайте, у кого что на руках.</div>'}
      ${admin ? '<button class="btn block" style="margin-top:8px" data-act="addGear">+ Добавить имущество</button>' : ''}

      <h3>Excel</h3>
      <div class="card">
        <p class="small muted" style="margin-top:0">Выгрузка всех данных в таблицу: состав, взносы по месяцам, казна, игры, посещаемость.
        ${admin ? 'Импорт понимает ваши таблицы: список бойцов, взносы «боец × месяцы» (суммы или «+»), операции казны.' : ''}</p>
        <div class="row">
          <button class="btn" data-act="exportExcel">⬇️ Выгрузить .xlsx</button>
          ${admin ? '<button class="btn" data-act="importExcel">⬆️ Загрузить из Excel</button>' : ''}
        </div>
      </div>

      ${admin ? `<h3>Администрирование</h3>
      <div class="card">
        <div class="row"><button class="btn" data-act="editSettings">Команда и взнос</button></div>
        <p class="small muted">Резервная копия (JSON)${cloudConfigured ? ' — перенос данных с телефона в общую базу' : ''}:</p>
        <div class="row">
          <button class="btn" data-act="exportData">⬇️ Копия</button>
          <button class="btn" data-act="importData">⬆️ Загрузить</button>
        </div>
        ${!cloudConfigured ? '<div class="row" style="margin-top:8px"><button class="btn danger" data-act="resetData">Стереть всё</button></div>' : ''}
      </div>` : ''}
      ${!cloudConfigured ? '<p class="small muted">! Локальный режим: данные только на этом телефоне. Общая база подключается по инструкции в README.</p>' : ''}
      <p class="small muted" style="text-align:center">TGT Team · v2.0</p>`;
  },
};

function birthdayBanner() {
  const list = upcomingBirthdays(14);
  if (!list.length) return '';
  return `<div class="banner">${list.map(({ m, b }) => `
    <div class="row" style="align-items:center;flex-wrap:nowrap">
      <div style="flex:1">▸ <b>${esc(shortName(m))}</b> — ${b.days === 0 ? `сегодня ДР, ${b.age} ${yearsWord(b.age)}!` : `ДР ${whenText(b.days)} (${dayMonthLabel(m.birthday)})`}</div>
      ${b.days <= 1 ? `<button class="btn small-btn" data-act="congrats" data-id="${m.id}">Поздравить</button>` : ''}
    </div>`).join('')}</div>`;
}

function myStatusCard() {
  const m = myMember();
  if (!m || isAdmin()) return '';
  if (m.status === 'recruit') return '<div class="card"><b>Вы рекрут</b><div class="small muted">Рекруты не платят взносы. После принятия в бойцы взнос начнёт начисляться.</div></div>';
  const { debt, debtMonths } = memberDebt(m);
  return `<div class="card ${debt ? 'card-bad' : 'card-ok'}">
    ${debt ? `<b>Ваш долг: ${money(debt)}</b><div class="small muted">${debtMonths.map(monthLabel).join(', ')}</div>`
      : '<b>Все взносы оплачены</b>'}
  </div>`;
}

function rosterView() {
  const now = monthKey();
  const current = state.members.filter((m) => !m.left || m.left > now);
  const fighters = current.filter((m) => m.status !== 'recruit').sort(byName);
  const recruits = current.filter((m) => m.status === 'recruit').sort(byName);
  const former = state.members.filter((m) => m.left && m.left <= now).sort(byName);
  const admin = isAdmin();
  const item = (m) => {
    const { debt } = memberDebt(m);
    const b = nextBirthday(m);
    return `<li data-act="openMember" data-id="${m.id}">
      <div class="grow">
        <div class="name">${esc(displayName(m))}${m.admin ? '<span class="chip accent">админ</span>' : ''}${b && b.days <= 7 ? ' <span class="chip">ДР</span>' : ''}</div>
        <div class="sub">${sinceLabel(m.from)}${m.vk ? ` · ВК ${esc(vkMention(m.vk))}` : ''}${m.exempt ? ' · освобождён' : ''}</div>
      </div>
      ${m.status === 'recruit'
        ? (admin && !m.left ? `<button class="btn small-btn" data-act="promote" data-id="${m.id}">★ В бойцы</button>` : '<span class="chip accent">рекрут</span>')
        : debt > 0 ? `<span class="chip bad">−${money(debt)}</span>` : '<span class="chip ok">ок</span>'}
    </li>`;
  };
  if (!state.members.length) return `<div class="list empty">Пока никого нет.${admin ? ' Нажмите «+», чтобы добавить бойца, или загрузите состав из Excel на вкладке «Ещё».' : ''}</div>`;
  return `
    <h3 style="margin-top:0">Бойцы · ${fighters.length}</h3>
    ${fighters.length ? `<ul class="list">${fighters.map(item).join('')}</ul>` : '<div class="list empty">Нет бойцов</div>'}
    ${recruits.length ? `<h3>Рекруты · ${recruits.length}</h3><ul class="list">${recruits.map(item).join('')}</ul>` : ''}
    ${former.length ? `<h3>Бывшие участники</h3><ul class="list">${former.map(item).join('')}</ul>` : ''}`;
}

function attendanceView() {
  const now = monthKey();
  const rows = state.members.filter((m) => !m.left || m.left > now)
    .map((m) => ({ m, s: attendanceStats(m) }))
    .sort((a, b) => (b.s.pct ?? -1) - (a.s.pct ?? -1) || b.s.yes - a.s.yes || byName(a.m, b.m));
  const totalPast = state.events.filter((e) => e.date < todayISO()).length;
  if (!totalPast) return '<div class="list empty">Статистика появится после первых прошедших игр. Посещение считается по отметкам «[+] еду».</div>';
  const withPct = rows.filter((r) => r.s.pct !== null);
  const avg = withPct.length ? Math.round(withPct.reduce((a, r) => a + r.s.pct, 0) / withPct.length) : 0;
  return `
    <div class="stats" style="grid-template-columns:1fr 1fr">
      <div class="stat"><div class="v">${totalPast}</div><div class="l">прошедших игр</div></div>
      <div class="stat ok"><div class="v">${avg}%</div><div class="l">средняя посещаемость</div></div>
    </div>
    <ul class="list">${rows.map(({ m, s }, i) => `
      <li data-act="openMember" data-id="${m.id}">
        <div class="rank">${s.pct !== null && i < 3 && s.yes ? `#${i + 1}` : ''}</div>
        <div class="grow"><div class="name">${esc(shortName(m))}${m.status === 'recruit' ? '<span class="chip accent">рекрут</span>' : ''}</div>
          <div class="progress" style="margin:6px 0 0"><div style="width:${s.pct ?? 0}%"></div></div></div>
        <div class="amt" style="text-align:right">${s.pct === null ? '—' : `${s.pct}%`}<div class="sub">${s.yes} из ${s.total}</div></div>
      </li>`).join('')}</ul>
    <p class="small muted">Посещение считается по отметке «[+] еду» на прошедших играх. Админ может поправить отметки задним числом.</p>`;
}

/* ================= Карточки и формы ================= */

function memberCard(m) {
  const admin = isAdmin();
  const { debt, debtMonths } = memberDebt(m);
  const s = attendanceStats(m);
  const b = nextBirthday(m);
  const lastGames = state.events.filter((e) => e.date < todayISO() && e.attendance?.[m.id] === 'yes')
    .sort((a, b2) => b2.date.localeCompare(a.date)).slice(0, 5);
  openSheet(`
    <h2>${esc(displayName(m))}</h2>
    <div class="row" style="gap:4px">
      <span class="chip ${m.status === 'recruit' ? 'accent' : 'ok'}">${m.status === 'recruit' ? 'рекрут' : 'боец'}</span>
      ${m.admin ? '<span class="chip accent">админ</span>' : ''}
      ${m.exempt ? '<span class="chip">освобождён от взносов</span>' : ''}
      ${m.left ? '<span class="chip bad">покинул команду</span>' : ''}
    </div>
    <div class="kv">
      <div>В команде</div><div>${sinceLabel(m.from)}${m.left ? ` по ${monthLabel(shiftMonth(m.left, -1))}` : ''}</div>
      ${m.feeFrom ? `<div>Боец с</div><div>${monthLabel(m.feeFrom)}</div>` : ''}
      ${m.vk ? `<div>ВКонтакте</div><div><a href="${esc(vkLink(m.vk))}" target="_blank" rel="noopener">${esc(vkMention(m.vk))}</a></div>` : ''}
      ${m.birthday ? `<div>День рождения</div><div>${dateLabel(m.birthday)}${b ? ` · ${whenText(b.days)}` : ''}</div>` : ''}
      <div>Взносы</div><div>${m.status === 'recruit' ? 'не платит (рекрут)' : debt ? `<b class="neg">долг ${money(debt)}</b> <span class="small muted">(${debtMonths.map(monthLabel).join(', ')})</span>` : '<span class="pos">оплачено</span>'}</div>
      <div>Посещаемость</div><div>${s.pct === null ? 'игр ещё не было' : `<b>${s.pct}%</b> — ${s.yes} из ${s.total} игр`}</div>
    </div>
    ${lastGames.length ? `<div class="small muted">Последние игры: ${lastGames.map((e) => `${esc(e.title)} (${dayMonthLabel(e.date)})`).join(', ')}</div>` : ''}
    <div class="row">
      ${admin && m.status === 'recruit' && !m.left ? '<button class="btn" value="promote">★ Принять в бойцы</button>' : ''}
      ${admin ? '<button class="btn" value="edit">Изменить</button>' : ''}
      <button class="btn primary" value="close">Готово</button>
    </div>`, {
    onSubmit(fd, action) {
      if (action === 'edit') later(() => memberForm(m));
      if (action === 'promote') later(() => ACTIONS.promote(m.id));
    },
  });
}

function memberForm(m) {
  const isNew = !m;
  m = m || { name: '', callsign: '', vk: '', birthday: '', status: 'recruit', from: monthKey(), left: null, exempt: false };
  const accessBlock = !isNew && cloudConfigured ? `
    <div class="card" style="margin:0">
      <div class="small muted">Доступ в приложение</div>
      ${m.uid ? `<div>Логин: <b>${esc(m.login)}</b> · ${m.admin ? 'администратор' : 'участник'}</div>
        <div class="row" style="margin-top:8px">
          <button class="btn" value="access" formnovalidate>Сменить PIN</button>
          <button class="btn" value="toggleAdmin" formnovalidate>${m.admin ? 'Снять админа' : 'Сделать админом'}</button>
          <button class="btn danger" value="revoke" formnovalidate>Закрыть доступ</button>
        </div>`
        : '<div class="row" style="margin-top:8px"><button class="btn" value="access" formnovalidate>» Выдать логин и PIN</button></div>'}
    </div>` : '';
  openSheet(`
    <h2>${isNew ? 'Новый участник' : 'Редактировать'}</h2>
    <label class="field">Позывной<input name="callsign" value="${esc(m.callsign)}" placeholder="Гром"></label>
    <label class="field">Имя *<input name="name" required value="${esc(m.name)}" placeholder="Иван Петров"></label>
    <label class="field">Статус<select name="status">
      <option value="recruit" ${m.status === 'recruit' ? 'selected' : ''}>Рекрут — без взносов</option>
      <option value="fighter" ${m.status !== 'recruit' ? 'selected' : ''}>Боец — платит взносы</option>
    </select></label>
    <label class="field">ВКонтакте<input name="vk" value="${esc(m.vk)}" placeholder="id123456 или короткое имя" autocapitalize="none"></label>
    <label class="field">День рождения<input type="date" name="birthday" value="${esc(m.birthday)}"></label>
    <label class="field">В команде с месяца<input type="month" name="from" required value="${m.from}"></label>
    ${!isNew && m.status !== 'recruit' ? `<label class="field">Платит взносы с месяца<input type="month" name="feeFrom" value="${m.feeFrom || ''}"></label>` : ''}
    <label class="toggle"><input type="checkbox" name="exempt" ${m.exempt ? 'checked' : ''}> Освобождён от взносов</label>
    ${!isNew ? `<label class="toggle"><input type="checkbox" name="gone" ${m.left ? 'checked' : ''}> Покинул команду</label>
      <label class="field">Последний месяц в команде<input type="month" name="last" value="${m.left ? shiftMonth(m.left, -1) : monthKey()}"></label>` : ''}
    ${accessBlock}
    <div class="row">
      ${!isNew ? '<button class="btn danger" value="delete" formnovalidate>Удалить</button>' : ''}
      <button class="btn" value="cancel" formnovalidate>Отмена</button>
      <button class="btn primary" value="save">Сохранить</button>
    </div>`, {
    onSubmit(fd, action) {
      if (action === 'access') { later(() => accessForm(m)); return; }
      if (action === 'toggleAdmin') {
        if (m.admin && me.memberId === m.id && !confirm('Снять права администратора с себя? Вернуть их сможет только другой админ.')) return false;
        run(() => store.setAdmin(m, !m.admin), m.admin ? 'Права админа сняты' : 'Назначен администратором');
        return;
      }
      if (action === 'revoke') {
        if (!confirm(`Закрыть доступ в приложение для ${shortName(m)}?`)) return false;
        run(() => store.revokeAccess(m), 'Доступ закрыт');
        return;
      }
      if (action === 'delete') {
        if (!confirm(`Удалить ${displayName(m)} вместе с историей взносов? Если человек просто ушёл — лучше отметьте «Покинул команду».`)) return false;
        run(() => store.deleteMember(m), 'Удалено');
        return;
      }
      const status = fd.get('status') === 'fighter' ? 'fighter' : 'recruit';
      const from = fd.get('from') || monthKey();
      let feeFrom = fd.has('feeFrom') ? fd.get('feeFrom') || null : m.feeFrom || null;
      if (status === 'fighter' && m.status === 'recruit' && !isNew) feeFrom = monthKey(); // принят в бойцы через форму
      if (status === 'recruit') feeFrom = null;
      const data = {
        id: isNew ? uid() : m.id,
        name: fd.get('name').trim(),
        callsign: fd.get('callsign').trim(),
        vk: fd.get('vk').trim(),
        birthday: fd.get('birthday') || '',
        status,
        from,
        feeFrom,
        exempt: fd.get('exempt') === 'on',
        left: fd.get('gone') === 'on' ? shiftMonth(fd.get('last') || monthKey(), 1) : null,
      };
      if (isNew) Object.assign(data, { admin: false });
      run(() => store.saveItem('members', data), isNew ? 'Участник добавлен' : 'Сохранено');
    },
  });
}

function accessForm(m) {
  const pin = randomPin();
  openSheet(`
    <h2>Доступ: ${esc(shortName(m))}</h2>
    <label class="field">Логин<input name="login" required autocapitalize="none" value="${esc(m.login || m.callsign || m.name)}"></label>
    <label class="field">PIN-код (6+ цифр)<input name="pin" required inputmode="numeric" pattern="\\d{6,}" value="${pin}"></label>
    <label class="toggle"><input type="checkbox" name="admin" ${m.admin ? 'checked' : ''}> Администратор (ведёт учёт)</label>
    ${m.uid ? '<p class="small muted" style="margin:0">Старый PIN перестанет работать.</p>' : ''}
    <div class="row">
      <button class="btn" value="cancel" formnovalidate>Отмена</button>
      <button class="btn primary" value="save">Выдать</button>
    </div>`, {
    onSubmit(fd) {
      const login = fd.get('login').trim();
      const newPin = fd.get('pin').trim();
      const self = m.id === me.memberId;
      run(async () => {
        await store.grantAccess(m, login, newPin, fd.get('admin') === 'on');
        const text = `Доступ в приложение команды ${state.settings.teamName}\n${appUrl()}\nЛогин: ${login}\nPIN: ${newPin}\n\nОткройте ссылку и добавьте приложение на главный экран.`;
        openSheet(`
          <h2>Доступ выдан</h2>
          <div class="card" style="margin:0;white-space:pre-wrap">${esc(text)}</div>
          <p class="small muted" style="margin:0">Отправьте это бойцу в личные сообщения ВК. PIN больше нигде не показывается.</p>
          <div class="row"><button type="button" class="btn" id="sendCreds">» Отправить</button><button class="btn primary" value="close">Готово</button></div>`, {
          onMount(f) { $('#sendCreds', f).onclick = () => shareText(text); },
          onSubmit() { if (self) store.logout(); },
        });
      });
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
      <button type="button" class="btn" id="cardBtn">Карточка</button>
      <button class="btn" value="cancel" formnovalidate>Отмена</button>
      <button class="btn primary" value="save">Сохранить</button>
    </div>`, {
    onMount(form) {
      form.querySelectorAll('[data-fill]').forEach((b) => b.addEventListener('click', () => { form.amount.value = b.dataset.fill; }));
      $('#cardBtn', form).onclick = () => memberCard(m);
    },
    onSubmit(fd, action) {
      const list = [{ month, memberId: m.id, amount: Math.max(0, Number(fd.get('amount')) || 0) }];
      if (action === 'payDebt') for (const k of debtMonths) list.push({ month: k, memberId: m.id, amount: expectedFor(m, k) });
      savePayments(list, action === 'payDebt' ? `Долг ${money(debt)} закрыт` : null);
    },
  });
}

async function savePayments(list, okText) {
  await run(async () => {
    // Фиксируем размер взноса за месяц при первой оплате, чтобы смена взноса не меняла историю.
    for (const month of new Set(list.map((x) => x.month))) {
      if (state.settings.fees?.[month] == null) await store.setMonthFee(month, state.settings.fee);
    }
    await store.setPayments(list);
  }, okText);
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
        run(() => store.deleteItem('expenses', e.id));
        return;
      }
      run(() => store.saveItem('expenses', {
        id: e.id,
        kind: fd.get('kind') === 'in' ? 'in' : 'out',
        amount: Math.abs(Number(fd.get('amount')) || 0),
        title: fd.get('title').trim(),
        category: fd.get('category').trim(),
        date: fd.get('date') || todayISO(),
      }));
    },
  });
}

function eventForm(ev) {
  const isNew = !ev;
  ev = ev || { date: todayISO(), time: '', title: '', place: '', notes: '' };
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
        run(() => store.deleteItem('events', ev.id));
        return;
      }
      const data = { id: ev.id, title: fd.get('title').trim(), date: fd.get('date'), time: fd.get('time'), place: fd.get('place').trim(), notes: fd.get('notes').trim() };
      if (isNew) data.attendance = {};
      run(() => store.saveItem('events', data));
    },
  });
}

function eventCard(ev) {
  const admin = isAdmin();
  const members = activeMembers(ev.date.slice(0, 7)).sort((a, b) => (b.id === me?.memberId) - (a.id === me?.memberId));
  const att = { ...(ev.attendance || {}) };
  const canEdit = (mid) => admin || mid === me?.memberId;
  const rows = members.map((m) => {
    const v = att[m.id];
    const editable = canEdit(m.id);
    return `<li class="static${m.id === me?.memberId ? ' mine' : ''}"><div class="grow"><div class="name">${esc(shortName(m))}${m.id === me?.memberId ? ' <span class="chip accent">вы</span>' : ''}</div></div>
      <div class="att" data-mid="${m.id}">${['yes', 'maybe', 'no'].map((k) => `
        <button type="button" data-v="${k}" class="${v === k ? 'on' : ''}" ${editable ? '' : 'disabled'}>${{ yes: '+', maybe: '?', no: '×' }[k]}</button>`).join('')}
      </div></li>`;
  }).join('');
  openSheet(`
    <h2>${esc(ev.title)}</h2>
    <div class="muted">${dateLabel(ev.date)}${ev.time ? `, ${esc(ev.time)}` : ''}${ev.place ? ` · ${esc(ev.place)}` : ''}</div>
    ${ev.notes ? `<div class="card" style="margin:0;white-space:pre-wrap">${esc(ev.notes)}</div>` : ''}
    <h3 style="margin:4px 0 0">Кто едет</h3>
    ${members.length ? `<ul class="list">${rows}</ul>` : '<div class="muted">Нет участников</div>'}
    <div class="row">
      <button type="button" class="btn" id="shareEvent">» В ВК</button>
      ${admin ? '<button class="btn" value="edit" formnovalidate>Изменить</button>' : ''}
      <button class="btn primary" value="close">Готово</button>
    </div>`, {
    onMount(form) {
      form.querySelectorAll('.att button:not([disabled])').forEach((b) => b.addEventListener('click', async () => {
        const mid = b.parentElement.dataset.mid;
        const prev = att[mid];
        const next = prev === b.dataset.v ? null : b.dataset.v;
        const paint = () => b.parentElement.querySelectorAll('button').forEach((x) => x.classList.toggle('on', att[mid] === x.dataset.v));
        if (next) att[mid] = next; else delete att[mid];
        paint();
        const ok = await run(() => store.setAttendance(ev.id, mid, next));
        if (!ok) { if (prev) att[mid] = prev; else delete att[mid]; paint(); }
      }));
      $('#shareEvent', form).addEventListener('click', () => shareText(eventReport({ ...ev, attendance: att })));
    },
    onSubmit(fd, action) {
      if (action === 'edit') later(() => eventForm(ev));
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
        run(() => store.deleteItem('gear', g.id));
        return;
      }
      run(() => store.saveItem('gear', { id: g.id, name: fd.get('name').trim(), qty: Math.max(1, Number(fd.get('qty')) || 1), holderId: fd.get('holderId'), note: fd.get('note').trim() }));
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
      run(() => store.saveSettings({
        teamName: fd.get('teamName').trim() || 'TGT Team',
        fee: Math.max(0, Number(fd.get('fee')) || 0),
        currency: fd.get('currency').trim() || '₽',
        startBalance: Number(fd.get('startBalance')) || 0,
      }), 'Сохранено');
    },
  });
}

/* ================= Отчёты для ВК ================= */

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
  if (s.partial.length) parts.push('', `🟡 Частично (${s.partial.length}):`, ...s.partial.map((m) => `${line(m)} ${vkMention(m.vk)} — ещё ${money(expectedFor(m, month) - paidAmount(m.id, month))}`.replace('  ', ' ')));
  if (s.unpaid.length) parts.push('', `❌ Не внесли (${s.unpaid.length}):`, ...s.unpaid.map((m) => `${line(m)} ${vkMention(m.vk)}`.trim()));
  return parts.join('\n');
}

function debtorsReport() {
  const debtors = state.members
    .map((m) => ({ m, ...memberDebt(m) }))
    .filter((x) => x.debt > 0)
    .sort((a, b) => b.debt - a.debt);
  if (!debtors.length) return null;
  return [
    `⏰ Напоминание о взносах — ${state.settings.teamName}`,
    '',
    ...debtors.map(({ m, debt, debtMonths }) => `• ${vkMention(m.vk) ? vkMention(m.vk) + ' ' : ''}${displayName(m)} — ${money(debt)} (${debtMonths.map(monthLabel).join(', ')})`),
    '',
    'Просьба закрыть долги до ближайшей игры 🙏',
  ].join('\n');
}

function eventReport(ev) {
  const members = activeMembers(ev.date.slice(0, 7));
  const group = (v) => members.filter((m) => ev.attendance[m.id] === v).map(shortName);
  const unknown = members.filter((m) => !ev.attendance[m.id]);
  const yes = group('yes'), maybe = group('maybe'), no = group('no');
  return [
    `🎯 ${ev.title}`,
    `📅 ${dateLabel(ev.date)}${ev.time ? `, ${ev.time}` : ''}`,
    ev.place ? `📍 ${ev.place}` : null,
    ev.notes ? `\n${ev.notes}` : null,
    '',
    `✅ Едут (${yes.length}): ${yes.join(', ') || '—'}`,
    maybe.length ? `❓ Под вопросом: ${maybe.join(', ')}` : null,
    no.length ? `❌ Не едут: ${no.join(', ')}` : null,
    unknown.length ? `🤷 Не ответили: ${unknown.map((m) => vkMention(m.vk) || shortName(m)).join(', ')}` : null,
    '',
    `Отметиться: ${appUrl()}`,
  ].filter((l) => l !== null).join('\n');
}

/* ================= Действия ================= */

const ACTIONS = {
  prevMonth() { ui.month = shiftMonth(ui.month, -1); render(); },
  nextMonth() { ui.month = shiftMonth(ui.month, 1); render(); },
  togglePaid(id) {
    const m = memberById(id);
    const exp = expectedFor(m, ui.month);
    const got = paidAmount(id, ui.month);
    savePayments([{ month: ui.month, memberId: id, amount: got >= exp && got > 0 ? 0 : exp }]);
  },
  editPayment(id) { paymentForm(memberById(id)); },
  editMonthFee() {
    const v = prompt(`Размер взноса за ${monthLabel(ui.month)}:`, feeFor(ui.month));
    if (v === null) return;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) return toast('Некорректная сумма');
    run(() => store.setMonthFee(ui.month, n));
  },
  shareDues() { shareText(duesReport(ui.month)); },
  remindDebtors() {
    const text = debtorsReport();
    if (!text) return toast('Должников нет');
    shareText(text);
  },
  congrats(id) {
    const m = memberById(id);
    const b = nextBirthday(m);
    shareText(`🎂 ${vkMention(m.vk) || shortName(m)}, с днём рождения${b ? ` и с ${b.age}-летием` : ''}! Ровного ствола, сухих ног и побольше побед! 💪\n— ${state.settings.teamName}`);
  },
  membersView(id) { ui.membersView = id; render(); },
  addMember() { memberForm(); },
  openMember(id) { memberCard(memberById(id)); },
  promote(id) {
    const m = memberById(id);
    if (!confirm(`Принять ${shortName(m)} в бойцы? Взносы начнут начисляться с месяца: ${monthLabel(monthKey())}.`)) return;
    run(() => store.saveItem('members', { id: m.id, status: 'fighter', feeFrom: monthKey() }), `★ ${shortName(m)} теперь боец`);
  },
  addExpense() { expenseForm(); },
  editExpense(id) { expenseForm(state.expenses.find((e) => e.id === id)); },
  eventsFilter(id) { ui.eventsFilter = id; render(); },
  addEvent() { eventForm(); },
  openEvent(id) { eventCard(state.events.find((e) => e.id === id)); },
  addGear() { gearForm(); },
  editGear(id) { gearForm(state.gear.find((g) => g.id === id)); },
  editSettings() { settingsForm(); },
  exportIcs() { download('dni-rozhdeniya.ics', birthdaysIcs(), 'text/calendar'); },
  logout() { store.logout(); },

  exportExcel() {
    run(() => exportXlsx(state, { expectedFor, paidAmount, memberDebt, attendanceStats, displayName, feeFor, isActiveIn, treasuryBalance }));
  },
  async importExcel() {
    const file = await pickFile('.xlsx,.xls,.xlsm,.ods,.csv');
    if (!file) return;
    let res;
    try { res = await analyzeWorkbook(file, state); } catch (e) { console.error(e); return toast('Не удалось прочитать файл'); }
    const { summary: s, report, plan } = res;
    const nothing = !s.newMembers && !s.updatedMembers && !s.payments && !s.expenses && !s.fees;
    openSheet(`
      <h2>Импорт из Excel</h2>
      <div class="small muted">${esc(file.name)}</div>
      <ul class="small" style="margin:0;padding-left:18px">${report.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>
      <div class="card" style="margin:0">
        ${nothing ? 'Нечего загружать — данные не распознаны.' : `Будет загружено:<br>
        новых участников: <b>${s.newMembers}</b>, обновлено: <b>${s.updatedMembers}</b><br>
        оплат: <b>${s.payments}</b>${s.fees ? `, размеров взноса: <b>${s.fees}</b>` : ''}<br>
        операций казны: <b>${s.expenses}</b>`}
      </div>
      ${plan.members.filter((m) => !state.members.some((x) => x.id === m.id)).length ? `<div class="small muted">Новые: ${esc(plan.members.filter((m) => !state.members.some((x) => x.id === m.id)).map(displayName).join(', '))}</div>` : ''}
      <p class="small muted" style="margin:0">Существующие данные не удаляются. Оплаты за совпадающие месяцы заменятся значениями из файла.</p>
      <div class="row">
        <button class="btn" value="cancel" formnovalidate>Отмена</button>
        ${nothing ? '' : '<button class="btn primary" value="save">Загрузить</button>'}
      </div>`, {
      onSubmit() { run(() => store.importBulk(plan), 'Данные из Excel загружены'); },
    });
  },

  exportData() { download(`tgt-team-${todayISO()}.json`, JSON.stringify(state, null, 2), 'application/json'); },
  async importData() {
    const file = await pickFile('application/json,.json');
    if (!file) return;
    let data;
    try {
      data = normalizeState(JSON.parse(await file.text()));
      if (!Array.isArray(data.members)) throw new Error();
    } catch (e) { return toast('Файл не подходит'); }
    if (cloudConfigured) {
      if (!confirm(`Загрузить в общую базу: участников ${data.members.length}, операций ${data.expenses.length}, игр ${data.events.length}? Совпадающие записи обновятся, остальное сохранится.`)) return;
      run(() => store.importBulk({ ...data, fees: data.settings.fees, settings: { teamName: data.settings.teamName, fee: data.settings.fee, currency: data.settings.currency, startBalance: data.settings.startBalance } }), 'Данные перенесены');
    } else {
      if (!confirm('Заменить текущие данные данными из файла?')) return;
      run(() => store.replaceAll(data), 'Данные загружены');
    }
  },
  resetData() {
    if (!confirm('Стереть ВСЕ данные? Сначала сделайте резервную копию!')) return;
    if (prompt('Для подтверждения введите УДАЛИТЬ') !== 'УДАЛИТЬ') return;
    run(() => store.replaceAll(emptyState()));
  },
};

/* ================= Запуск ================= */

$('#tabbar').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-tab]');
  if (!b) return;
  ui.tab = b.dataset.tab;
  render();
  window.scrollTo(0, 0);
});

store.subscribe((s) => { state = s; if (me && !me.noAccess) render(); });
store.start((m) => {
  const wasIn = me && !me.noAccess;
  me = m;
  if (!m || m.noAccess) { const d = $('#sheet'); if (d.open) d.close(); }
  if (!wasIn && m && !m.noAccess) ui.tab = 'dues';
  render();
}).catch((e) => {
  console.error(e);
  $('#view').innerHTML = `<div class="auth-box"><h2>Ошибка запуска</h2><p class="muted">${esc(errorText(e))}</p></div>`;
});

if ('serviceWorker' in navigator && location.protocol !== 'file:' && !new URLSearchParams(location.search).has('emu')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// Для отладки из консоли.
window.__tgt = { store, get state() { return state; }, get me() { return me; }, duesReport, debtorsReport, attendanceStats };
