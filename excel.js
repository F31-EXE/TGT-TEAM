// Синхронизация с Excel: выгрузка всех данных в .xlsx и импорт существующих таблиц.

import { uid, monthKey, isoDate, monthLabel, normLogin, todayISO } from './util.js';

let xlsxPromise;
function loadXLSX() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  xlsxPromise ||= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'vendor/xlsx.full.min.js';
    s.onload = () => resolve(window.XLSX);
    s.onerror = () => { xlsxPromise = null; reject(new Error('Не удалось загрузить модуль Excel')); };
    document.head.appendChild(s);
  });
  return xlsxPromise;
}

/* ============================ Выгрузка ============================ */

const STATUS_LABEL = { recruit: 'Рекрут', fighter: 'Активен', pause: 'Пауза' };
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * calc — функции расчёта из app.js: expectedFor, paidAmount, memberDebt, attendanceStats, displayName, feeFor, treasuryBalance.
 */
export async function exportXlsx(state, save, calc) {
  const XLSX = await loadXLSX();
  const wb = XLSX.utils.book_new();
  const add = (name, rows, widths) => {
    const ws = XLSX.utils.aoa_to_sheet(rows);
    if (widths) ws['!cols'] = widths.map((wch) => ({ wch }));
    XLSX.utils.book_append_sheet(wb, ws, name);
  };
  const members = [...state.members].sort((a, b) => (a.callsign || a.name).localeCompare(b.callsign || b.name, 'ru'));
  const nick = (id) => { const m = state.members.find((x) => x.id === id); return m ? (m.callsign || m.name) : ''; };

  add('Состав', [
    ['Позывной', 'Имя', 'Номер', 'Группа', 'Статус', 'Звание', 'Баллы', 'Баллы за квартал', 'Доступ', 'ВК', 'День рождения', 'В команде с', 'Ушёл', 'Платит с', 'Освобождён', 'Долг', 'Аванс', 'Посещаемость, %'],
    ...members.map((m) => {
      const p = calc.pointsSummary(m);
      const l = calc.memberDebt(m);
      return [
        m.callsign, m.name, m.number || '', `${m.groupLead ? 'К. ' : ''}${m.group || ''}`,
        m.left ? 'Покинул' : STATUS_LABEL[m.status] || 'Активен', p.rank.title, p.total, p.quarter,
        m.admin ? 'Админ' : m.login ? 'Участник' : '',
        m.vk, m.birthday, m.from, m.left || '', m.feeFrom || '', m.exempt ? 'да' : '',
        l.debt, l.prepaid, calc.attendanceStats(m).pct ?? '',
      ];
    }),
  ], [14, 14, 9, 24, 10, 18, 8, 10, 10, 18, 14, 12, 10, 10, 11, 10, 10, 15]);

  // Взносы: строки — бойцы, столбцы — месяцы.
  const months = Object.keys(state.payments);
  for (const m of members) months.push(m.from);
  months.push(monthKey());
  const first = months.filter(Boolean).sort()[0];
  const cols = [];
  for (let k = first; k <= monthKey(); k = shiftMonthLocal(k, 1)) cols.push(k);
  add('Взносы', [
    ['Боец', ...cols.map((k) => cap(monthLabel(k))), 'Долг'],
    ['Размер взноса', ...cols.map((k) => calc.feeFor(k)), ''],
    ...members.map((m) => [
      calc.displayName(m),
      ...cols.map((k) => calc.paidAmount(m.id, k) || (calc.isActiveIn(m, k) && calc.expectedFor(m, k) === 0 ? '—' : '')),
      calc.memberDebt(m).debt,
    ]),
    ['Итого', ...cols.map((k) => members.reduce((a, m) => a + calc.paidAmount(m.id, k), 0)), ''],
  ], [24, ...cols.map(() => 13), 10]);

  add('Казна', [
    ['Дата', 'Тип', 'Описание', 'Категория', 'Сумма'],
    ...[...state.expenses].sort((a, b) => a.date.localeCompare(b.date))
      .map((e) => [e.date, e.kind === 'in' ? 'Поступление' : 'Расход', e.title, e.category, e.kind === 'in' ? e.amount : -e.amount]),
    [],
    ['', '', 'Баланс казны', '', calc.treasuryBalance()],
  ], [12, 13, 30, 16, 12]);

  const att = (e, v) => Object.entries(e.attendance || {}).filter(([, x]) => x === v).map(([id]) => nick(id)).filter(Boolean).join(', ');
  add('Игры', [
    ['Дата', 'Время', 'Название', 'Место', 'Едут', 'Под вопросом', 'Не едут'],
    ...[...state.events].sort((a, b) => a.date.localeCompare(b.date))
      .map((e) => [e.date, e.time || '', e.title, e.place || '', att(e, 'yes'), att(e, 'maybe'), att(e, 'no')]),
  ], [12, 8, 26, 20, 30, 20, 20]);

  add('Посещаемость', [
    ['Боец', 'Был', 'Всего игр', '%'],
    ...members.filter((m) => !m.left).map((m) => { const s = calc.attendanceStats(m); return [calc.displayName(m), s.yes, s.total, s.pct ?? '']; }),
  ], [24, 8, 10, 8]);

  add('Баллы', [
    ['Дата', 'Боец', 'За что', 'Баллы', 'Комментарий'],
    ...members.flatMap((m) => calc.pointsSummary(m).entries.map((e) => [e.date, calc.displayName(m), calc.POINT_CATS[e.cat] || e.cat, e.amount, `${e.note || ''}${e.auto ? ' (авто)' : ''}`]))
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  ], [12, 24, 22, 8, 30]);

  add('Имущество', [
    ['Название', 'Кол-во', 'У кого', 'Заметка'],
    ...state.gear.map((g) => [g.name, g.qty, g.holderId ? nick(g.holderId) : 'склад', g.note || '']),
  ], [26, 8, 16, 30]);

  const data = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
  await save(`${state.settings.teamName || 'team'}-${todayISO()}.xlsx`,
    new Blob([data], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
}

function shiftMonthLocal(key, delta) {
  const [y, m] = key.split('-').map(Number);
  return monthKey(new Date(y, m - 1 + delta, 1));
}

/* ============================ Импорт ============================ */

const MONTH_PREFIX = [
  ['янв', 'jan'], ['фев', 'feb'], ['мар', 'mar'], ['апр', 'apr'], ['мая', 'май', 'may'], ['июн', 'jun'],
  ['июл', 'jul'], ['авг', 'aug'], ['сен', 'sep'], ['окт', 'oct'], ['ноя', 'nov'], ['дек', 'dec'],
];
const ym = (y, m) => (m >= 1 && m <= 12 && y > 2000 && y < 2100 ? `${y}-${String(m).padStart(2, '0')}` : null);
const fullYear = (y) => (y < 100 ? 2000 + y : y);

function dateFromCell(v, XLSX) {
  if (v instanceof Date && !isNaN(v)) return new Date(v.getTime() + 12 * 3600e3); // защита от сдвига часового пояса
  if (typeof v === 'number' && v > 20000 && v < 80000) {
    const d = XLSX.SSF.parse_date_code(v);
    return new Date(d.y, d.m - 1, d.d);
  }
  return null;
}

/** Распознаёт месяц: Date, серийная дата Excel, «2026-10», «10.2026», «Октябрь 2026», «окт.26», «Октябрь». */
export function parseMonth(v, XLSX, fallbackYear) {
  const d = dateFromCell(v, XLSX);
  if (d) return monthKey(d);
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase();
  if (!s || s.length > 24) return null;
  let r;
  if ((r = s.match(/^(\d{4})[-./](\d{1,2})$/))) return ym(+r[1], +r[2]);
  if ((r = s.match(/^(\d{1,2})[-./](\d{4}|\d{2})$/))) return ym(fullYear(+r[2]), +r[1]);
  if ((r = s.match(/^\d{1,2}[-./](\d{1,2})[-./](\d{4}|\d{2})$/))) return ym(fullYear(+r[2]), +r[1]);
  const idx = MONTH_PREFIX.findIndex((ps) => ps.some((p) => s.startsWith(p)));
  if (idx < 0) return null;
  if (!/^[a-zа-яё]+\.?(\s*[-'’]?\s*\d{2,4}\s*(г\.?|года?)?)?$/.test(s)) return null;
  const y = s.match(/(\d{4}|\d{2})/);
  return ym(y ? fullYear(+y[1]) : fallbackYear, idx + 1);
}

/** Дата: Date, серийная дата, «07.10.2026», «2026-10-07». */
function parseDate(v, XLSX) {
  const d = dateFromCell(v, XLSX);
  if (d) return isoDate(d);
  if (typeof v !== 'string') return null;
  const s = v.trim();
  let r;
  if ((r = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) return isoDate(new Date(+r[1], r[2] - 1, +r[3]));
  if ((r = s.match(/^(\d{1,2})[./](\d{1,2})[./](\d{4}|\d{2})$/))) return isoDate(new Date(fullYear(+r[3]), r[2] - 1, +r[1]));
  return null;
}

/** Сумма из ячейки. «+», «да», «✓» означают полный взнос; «-» — пусто (оплачено авансом). */
export function parseAmount(v, fullFee) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (typeof v === 'boolean') return v ? fullFee : 0;
  const s = String(v ?? '').trim().toLowerCase();
  if (!s) return 0;
  const digits = s.replace(/[\s ₽руб.р$€]/g, '').replace(',', '.');
  if (/^-?\d+(\.\d+)?$/.test(digits)) return Number(digits);
  if (/^(\+|да|v|✓|✔|☑|x|х|оплач|опл|сдал|внес|есть|ok|ок|yes)/.test(s)) return fullFee;
  return 0;
}
const num = (v) => (typeof v === 'number' ? v : parseAmount(v, 0));
const isBlank = (v) => v === '' || v === null || v === undefined;

const H = {
  callsign: /позывн|^команда$/,
  name: /^(фио|ф\.?\s?и\.?\s?о?|имя|участник|боец|игрок|член|кто)/,
  surname: /фамили/,
  number: /^(номер|№|tgt)/,
  group: /групп|отделен|подразд/,
  vk: /(^|\s)(вк|vk)(\s|$)|вконтакт|vk\.com|ссылк/,
  birthday: /рожд|^д\.?\s?р\.?$|^др$/,
  status: /статус|звание|ранг|роль/,
  from: /вступ|в команде|с какого|принят/,
  amount: /сумм|размер|руб|₽/,
  date: /^дата/,
  month: /месяц|период|за месяц/,
  title: /описан|назначен|статья|наимен|комментар|примечан|позиция/,
  category: /категор|тип расход/,
  kind: /^тип|вид|приход\s*\/\s*расход/,
  income: /приход|поступ|доход/,
  outcome: /расход|трат|списан/,
};

function findHeaderRow(rows, XLSX) {
  let best = -1, bestScore = 0;
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const r = rows[i] || [];
    let score = 0;
    for (const c of r) {
      if (parseMonth(c, XLSX, 2000)) score += 2;
      else if (typeof c === 'string' && Object.values(H).some((re) => re.test(c.trim().toLowerCase()))) score += 3;
    }
    if (score > bestScore) { bestScore = score; best = i; }
  }
  return bestScore >= 3 ? best : -1;
}

const isTotalRow = (s) => /^(итог|всего|сумма|total|собрано|баланс|размер взноса|банк)/i.test(String(s || '').trim());

/** Строки казны под таблицей взносов: остаток, проценты, доп. приход, расход. */
const TREASURY_ROWS = [
  ['start', /прошл\S*\s+период|остаток|на начало|начальн/i],
  ['interest', /процент/i],
  ['income', /доп\S*\.?\s*приход|прочие поступ|поступлен|доход|спонсор/i],
  ['outcome', /^расход/i],
  ['skip', /банк|итого|баланс|всего|^сумма/i],
];

const STATUS_MAP = [
  ['left', /покинул|уш[её]л|выбыл|исключ|бывш/],
  ['pause', /пауз|отпуск|заморож|перерыв/],
  ['recruit', /рекрут|кандидат|новобран|стаж[её]р|испыт/],
  ['fighter', /актив|боец|основ|член|ветеран/],
];

/* ---------- CSV ---------- */

function parseCsv(text, sep) {
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c;
    } else if (c === '"') q = true;
    else if (c === sep) { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

const csvCell = (v) => {
  const t = v.trim();
  const n = t.replace(/[\s ]/g, '');
  return /^-?\d+([.,]\d+)?$/.test(n) ? Number(n.replace(',', '.')) : t;
};

async function readBook(file, XLSX) {
  if (/\.(csv|txt)$/i.test(file.name)) {
    const buf = await file.arrayBuffer();
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch (e) { text = new TextDecoder('windows-1251').decode(buf); }
    text = text.replace(/^﻿/, '');
    const sample = text.slice(0, 2000);
    const count = (ch) => sample.split(ch).length;
    const sep = [';', '\t', ','].sort((a, b) => count(b) - count(a))[0];
    const wb = XLSX.utils.book_new();
    const name = file.name.replace(/\.\w+$/, '').replace(/[:\\/?*[\]]/g, ' ').slice(0, 31) || 'CSV';
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(parseCsv(text, sep).map((r) => r.map(csvCell))), name);
    return wb;
  }
  return XLSX.read(await file.arrayBuffer(), { cellDates: true });
}

/**
 * Разбирает книгу Excel или CSV и строит план изменений, не меняя данные.
 * Возвращает {plan, report[], summary}; plan передаётся в store.importBulk.
 */
export async function analyzeWorkbook(file, state) {
  const XLSX = await loadXLSX();
  const wb = await readBook(file, XLSX);
  const report = [];
  const plan = { members: [], payments: {}, fees: {}, expenses: [], points: [], settings: {} };
  const now = monthKey();
  const hasExpenseSheet = wb.SheetNames.some((n) => /расход/i.test(n));

  // Индекс участников по позывному и имени (включая создаваемых при импорте).
  const pool = state.members.map((m) => ({ ...m }));
  const touched = new Map();
  const presence = new Map(); // memberId → месяцы, где в таблице взносов есть хоть что-то (сумма, 0 или «-»)
  let byKey;
  const reindex = () => {
    byKey = new Map();
    for (const m of pool) {
      if (m.callsign) byKey.set(normLogin(m.callsign), m);
      if (m.name && !byKey.has(normLogin(m.name))) byKey.set(normLogin(m.name), m);
      if (m.callsign && m.name) byKey.set(normLogin(`${m.callsign} (${m.name})`), m);
    }
  };
  reindex();
  const findMember = (text) => {
    const t = normLogin(text);
    if (!t) return null;
    if (byKey.has(t)) return byKey.get(t);
    const paren = t.match(/^(.+?)\s*\((.+)\)$/);
    if (paren) return byKey.get(paren[1].trim()) || byKey.get(paren[2].trim()) || null;
    const parts = t.split(' ');
    if (parts.length === 2) return byKey.get(`${parts[1]} ${parts[0]}`) || null; // «Петров Иван» ↔ «Иван Петров»
    return null;
  };
  const upsert = (m, patch) => {
    let target = m;
    if (!target) {
      target = { id: uid(), name: '', callsign: '', number: '', group: '', groupLead: false, vk: '', birthday: '', status: 'fighter', pauses: [], feeFrom: null, from: now, left: null, exempt: false, pointsBase: 0, admin: false };
      pool.push(target);
    }
    for (const [k, v] of Object.entries(patch)) if (v !== undefined && v !== '' && v !== null) target[k] = v;
    touched.set(target.id, target);
    reindex();
    return target;
  };
  const isNew = (m) => !state.members.some((x) => x.id === m.id);
  const existingOps = new Set(state.expenses.map((e) => `${e.date}|${normLogin(e.title)}|${e.amount}`));
  const addOp = (op) => {
    const key = `${op.date}|${normLogin(op.title)}|${op.amount}`;
    if (existingOps.has(key)) return false;
    existingOps.add(key);
    plan.expenses.push({ id: uid(), category: '', ...op });
    return true;
  };
  const pendingLeft = [];

  for (const sheetName of wb.SheetNames) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, raw: true, defval: '' });

    // Текст ежемесячного напоминания о взносах (например, на листе «Инструкция»).
    if (!plan.settings.reminderText) {
      const cell = rows.flat().find((c) => typeof c === 'string' && /напомина\S*.*взнос/i.test(c));
      if (cell) { plan.settings.reminderText = cell.trim(); report.push(`Лист «${sheetName}»: найден текст напоминания о взносах`); }
    }

    // Балльная система: «Позывной | Игры | Походы | Вклад | Штрафы | … | Звание».
    if (rows.slice(0, 10).some((r) => r.some((c) => /балл/i.test(c)) && r.some((c) => /звани/i.test(c)) && r.some((c) => /позывн/i.test(c)))) {
      report.push(parsePointsSheet(sheetName, rows));
      continue;
    }

    const hi = findHeaderRow(rows, XLSX);
    if (hi < 0) { report.push(`Лист «${sheetName}»: не распознан, пропущен`); continue; }
    if (/посещ|^игры|имущ|справоч|^баллы$/i.test(sheetName)) { report.push(`Лист «${sheetName}»: справочный, пропущен`); continue; }
    const header = rows[hi];
    const body = rows.slice(hi + 1).filter((r) => r.some((c) => !isBlank(c)));
    const hl = header.map((h) => (typeof h === 'string' ? h.trim().toLowerCase() : ''));
    const col = (re) => hl.findIndex((h) => re.test(h));

    let year = new Date().getFullYear();
    const monthCols = [];
    header.forEach((h, i) => {
      const k = parseMonth(h, XLSX, year);
      if (k) { monthCols.push([i, k]); year = Number(k.slice(0, 4)); }
    });

    // 1) Таблица «строки × месяцы»: взносы бойцов (или позиции расходов на листе «Расходы»).
    if (monthCols.length >= 2) {
      let nameCol = col(H.callsign);
      if (nameCol < 0) nameCol = col(H.name);
      if (nameCol < 0) nameCol = header.findIndex((_, i) => !monthCols.some(([c]) => c === i));
      const nameCol2 = col(H.name) !== nameCol ? col(H.name) : -1;
      const expensesSheet = /расход/i.test(sheetName);

      if (expensesSheet) {
        let count = 0;
        for (const r of body) {
          const label = String(r[nameCol] ?? '').trim();
          if (!label || isTotalRow(label) || /^позиция$/i.test(label)) continue;
          for (const [c, k] of monthCols) {
            const a = num(r[c]);
            if (a > 0 && addOp({ date: `${k}-01`, title: label, amount: a, kind: 'out', category: 'Расходы' })) count++;
          }
        }
        report.push(`Лист «${sheetName}»: расходы — ${count} операций`);
        continue;
      }

      const feeRow = body.find((r) => /^(размер\s+взноса|сумма\s+взноса|взнос)\s*:?$/i.test(String(r[nameCol] || '').trim()));
      if (feeRow) for (const [c, k] of monthCols) { const v = num(feeRow[c]); if (v > 0) plan.fees[k] = v; }

      const amounts = [];
      const dataMonths = new Set();
      let count = 0, created = 0, ops = 0, afterTotal = false;
      for (const r of body) {
        const text = String(r[nameCol] ?? '').trim();
        if (!text) continue;
        const tr = TREASURY_ROWS.find(([, re]) => re.test(text));
        if (tr || isTotalRow(text)) {
          const kind = tr ? tr[0] : 'skip';
          if (/^итог/i.test(text)) afterTotal = true;
          if (kind === 'start' && plan.settings.startBalance === undefined) {
            const first = monthCols.map(([c]) => num(r[c])).find((v) => v !== 0);
            if (first !== undefined) { plan.settings.startBalance = Math.round(first * 100) / 100; ops++; }
          }
          if (kind === 'interest' || kind === 'income' || (kind === 'outcome' && !hasExpenseSheet)) {
            for (const [c, k] of monthCols) {
              const a = Math.round(num(r[c]) * 100) / 100;
              if (a <= 0 || k > now) continue;
              const op = kind === 'interest' ? { title: 'Проценты по вкладу', category: 'Проценты', kind: 'in' }
                : kind === 'income' ? { title: 'Доп. приход', category: 'Поступления', kind: 'in' }
                : { title: 'Расход за месяц', category: 'Расходы', kind: 'out' };
              if (addOp({ ...op, date: `${k}-01`, amount: a })) ops++;
            }
          }
          continue;
        }
        if (afterTotal) continue;
        const cells = monthCols.map(([c, k]) => [k, r[c]]);
        const present = cells.filter(([, v]) => !isBlank(v)).map(([k]) => k);
        const paid = cells.map(([k, v]) => [k, parseAmount(v, plan.fees[k] ?? state.settings.fees?.[k] ?? state.settings.fee)]).filter(([, a]) => a > 0);
        let m = findMember(text) || (nameCol2 >= 0 ? findMember(r[nameCol2]) : null);
        if (!m) {
          if (!present.length) continue;
          const paren = text.match(/^(.+?)\s*\((.+)\)$/);
          m = upsert(null, paren ? { callsign: paren[1], name: paren[2], from: present[0] }
            : { callsign: text, name: nameCol2 >= 0 ? String(r[nameCol2] || '') : '', from: present[0] });
          created++;
        } else if (present[0] && present[0] < m.from) {
          upsert(m, { from: present[0] });
        }
        presence.set(m.id, [...(presence.get(m.id) || []), ...present]);
        present.forEach((k) => dataMonths.add(k));
        for (const [k, a] of paid) {
          (plan.payments[k] ||= {})[m.id] = a;
          amounts.push(a);
          count++;
        }
      }
      // Размер взноса — самая частая сумма оплаты (например, 300 ₽).
      if (!feeRow && amounts.length) {
        const freq = {};
        amounts.forEach((a) => { freq[a] = (freq[a] || 0) + 1; });
        const fee = Number(Object.entries(freq).sort((a, b) => b[1] - a[1])[0][0]);
        plan.settings.fee = fee;
        for (const k of dataMonths) if (k <= now && !(k in plan.fees)) plan.fees[k] = fee;
      }
      report.push(`Лист «${sheetName}»: взносы по месяцам — ${count} оплат${created ? `, новых бойцов: ${created}` : ''}${ops ? `, записей казны: ${ops}` : ''}`);
      continue;
    }

    const cName = col(H.name), cCall = col(H.callsign), cAmount = col(H.amount);
    const cDate = col(H.date), cMonth = col(H.month);

    // 2) Построчный список оплат: «Боец | Месяц | Сумма».
    if ((cName >= 0 || cCall >= 0) && cAmount >= 0 && (cMonth >= 0 || cDate >= 0)) {
      let count = 0;
      for (const r of body) {
        const text = String(r[cCall >= 0 ? cCall : cName] ?? '').trim();
        if (!text || isTotalRow(text)) continue;
        const k = parseMonth(r[cMonth >= 0 ? cMonth : cDate], XLSX, new Date().getFullYear()) || (cDate >= 0 && parseDate(r[cDate], XLSX)?.slice(0, 7));
        const a = parseAmount(r[cAmount], state.settings.fee);
        if (!k || a <= 0) continue;
        const m = findMember(text) || (cCall >= 0 && cName >= 0 ? findMember(r[cName]) : null)
          || upsert(null, { name: cName >= 0 ? String(r[cName]) : '', callsign: cCall >= 0 ? text : String(r[cName]), from: k });
        const bucket = (plan.payments[k] ||= {});
        bucket[m.id] = (bucket[m.id] || 0) + a;
        count++;
      }
      report.push(`Лист «${sheetName}»: список оплат — ${count} записей`);
      continue;
    }

    // 3) Состав.
    if (cName >= 0 || cCall >= 0) {
      const cSur = col(H.surname), cVk = col(H.vk), cBd = col(H.birthday), cSt = col(H.status), cFrom = col(H.from);
      const cNum = col(H.number), cGroup = col(H.group);
      let added = 0, updated = 0;
      for (const r of body) {
        let call = cCall >= 0 ? String(r[cCall] ?? '').trim() : '';
        let name = cName >= 0 ? String(r[cName] ?? '').trim() : '';
        const paren = !call && name.match(/^(.+?)\s*\((.+)\)$/);
        if (paren) { call = paren[1].trim(); name = paren[2].trim(); }
        if (cSur >= 0 && r[cSur]) name = `${name} ${String(r[cSur]).trim()}`.trim();
        if ((!call && !name) || isTotalRow(call || name)) continue;
        const st = cSt >= 0 ? String(r[cSt] ?? '').toLowerCase() : '';
        const status = (STATUS_MAP.find(([, re]) => re.test(st)) || [''])[0];
        const numberCell = cNum >= 0 ? String(r[cNum] ?? '').trim() : '';
        // Имена повторяются (две «Саши»), поэтому при известном позывном ищем только по нему.
        const m = call ? findMember(call) : findMember(name);
        const patch = {
          callsign: call || name, name: call ? name : '',
          number: /\D/.test(numberCell) && /\d/.test(numberCell) ? numberCell.toUpperCase() : '', // «1, 2, 3» — просто нумерация строк
          group: cGroup >= 0 ? String(r[cGroup] ?? '').replace(/^К\.\s*/, '').trim() : '',
          groupLead: cGroup >= 0 && /^К\./.test(String(r[cGroup] ?? '').trim()) ? true : undefined,
          vk: cVk >= 0 ? String(r[cVk] ?? '').trim() : '',
          birthday: cBd >= 0 ? parseDate(r[cBd], XLSX) || '' : '',
          from: cFrom >= 0 ? parseMonth(r[cFrom], XLSX, new Date().getFullYear()) || parseDate(r[cFrom], XLSX)?.slice(0, 7) || '' : '',
        };
        if (status === 'recruit' || status === 'fighter') patch.status = status;
        if (status === 'pause' && !(m && m.status === 'pause')) { patch.status = 'pause'; patch.pauses = [...(m?.pauses || []), { from: now, to: null }]; }
        const target = upsert(m, patch);
        if (status === 'left') pendingLeft.push(target);
        else if (status && target.left) target.left = null;
        if (m) updated++; else added++;
      }
      report.push(`Лист «${sheetName}»: состав — новых ${added}, обновлено ${updated}`);
      continue;
    }

    // 4) Казна списком: дата, описание, сумма (или «Приход» / «Расход»).
    const cTitle = col(H.title), cCat = col(H.category), cKind = col(H.kind);
    const cIn = col(H.income), cOut = col(H.outcome);
    if (cDate >= 0 && (cAmount >= 0 || cIn >= 0 || cOut >= 0)) {
      let count = 0;
      for (const r of body) {
        const date = parseDate(r[cDate], XLSX);
        if (!date) continue;
        let amount = 0, kind = 'out';
        if (cAmount >= 0 && cAmount !== cIn && cAmount !== cOut) {
          amount = num(r[cAmount]);
          const kindText = cKind >= 0 ? String(r[cKind] ?? '').toLowerCase() : '';
          if (H.income.test(kindText)) kind = 'in';
          if (amount < 0) { kind = 'out'; amount = -amount; }
        } else {
          const inc = cIn >= 0 ? num(r[cIn]) : 0;
          const out = cOut >= 0 ? num(r[cOut]) : 0;
          if (inc > 0) { amount = inc; kind = 'in'; } else { amount = Math.abs(out); kind = 'out'; }
        }
        if (!amount) continue;
        const title = String((cTitle >= 0 ? r[cTitle] : '') || (cCat >= 0 ? r[cCat] : '') || 'Без описания').trim();
        if (isTotalRow(title)) continue;
        if (addOp({ date, title, amount, kind, category: cCat >= 0 && cCat !== cTitle ? String(r[cCat] ?? '').trim() : '' })) count++;
      }
      report.push(`Лист «${sheetName}»: казна — ${count} новых операций`);
      continue;
    }

    report.push(`Лист «${sheetName}»: не распознан, пропущен`);
  }

  // «Покинул»: уход — месяц после последней записи в таблице взносов (или текущий, если записей нет).
  for (const m of pendingLeft) {
    const months = (presence.get(m.id) || []).filter((k) => k <= now).sort();
    const left = months.length ? shiftMonthLocal(months[months.length - 1], 1) : now;
    m.left = left > now ? now : left;
    if (m.from > m.left) m.from = m.left;
    touched.set(m.id, m);
  }

  /* ---------- Балльная система ---------- */
  function parsePointsSheet(sheetName, rows) {
    const title = rows.slice(0, 3).flat().map(String).join(' ');
    const period = title.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})\s*[-–—]\s*(\d{1,2})\.(\d{1,2})\.(\d{4})/);
    const periodEnd = period ? isoDate(new Date(+period[6], period[5] - 1, +period[4])) : todayISO();
    const periodText = period ? `${period[1]}.${period[2]}.${period[3]}–${period[4]}.${period[5]}.${period[6]}` : '';
    const min = title.match(/минимум\s*(\d+)/i);
    if (min) plan.settings.pointsMin = Number(min[1]);

    const hi = rows.findIndex((r) => r.some((c) => /позывн/i.test(c)));
    const hl = rows[hi].map((h) => String(h).toLowerCase());
    const col = (re) => hl.findIndex((h) => re.test(h));
    const cols = {
      name: col(/позывн/), game: col(/игр/), training: col(/поход|трениров/), contribution: col(/вклад/),
      discipline: col(/дисципл/), safety: col(/\bтб\b|безопасн/), quarter: col(/квартал/), total: col(/общ/), past: col(/прошедш/),
    };
    const existing = new Set(state.points.map((p) => `${p.memberId}|${p.cat}|${p.date}|${p.amount}`));
    let fighters = 0, entries = 0;
    for (let i = hi + 1; i < rows.length; i++) {
      const r = rows[i];
      if (!r.some((c) => !isBlank(c))) break; // таблица бойцов закончилась
      const raw = String(r[cols.name] ?? '').trim();
      const mm = raw.match(/^([^()]+?)\s*\(([^()]*)\)\s*(.*)$/);
      const callsign = (mm ? mm[1] : raw).trim();
      if (!callsign || callsign.startsWith('(')) continue;
      const numberText = mm && /\d/.test(mm[2]) ? mm[2].trim().toUpperCase() : '';
      const rest = mm ? mm[3] : '';
      const groupLead = /К\./.test(rest);
      let group = rest.replace(/К\./g, '').replace(/[()]/g, '').trim();
      group = group ? group.charAt(0).toUpperCase() + group.slice(1) : '';
      const past = cols.past >= 0 && !isBlank(r[cols.past]) ? num(r[cols.past]) : num(r[cols.total]) - num(r[cols.quarter]);
      const m = upsert(findMember(callsign), { callsign, number: numberText, group, groupLead, pointsBase: past });
      fighters++;
      for (const cat of ['game', 'training', 'contribution', 'discipline', 'safety']) {
        if (cols[cat] < 0) continue;
        let v = num(r[cols[cat]]);
        if (!v) continue;
        if (cat === 'discipline' || cat === 'safety') v = -Math.abs(v);
        const key = `${m.id}|${cat}|${periodEnd}|${v}`;
        if (existing.has(key)) continue;
        existing.add(key);
        plan.points.push({ id: uid(), memberId: m.id, date: periodEnd, cat, amount: v, note: `Импорт ${periodText}`.trim() });
        entries++;
      }
    }

    // Таблица званий: «Кол-во баллов | Звание».
    let ranks = 0;
    for (let i = 0; i < rows.length; i++) {
      const c = rows[i].findIndex((v, j) => /^кол-?во\s+баллов$/i.test(String(v).trim()) && /звани/i.test(String(rows[i][j + 1] ?? '')));
      if (c < 0) continue;
      const list = [];
      for (let j = i + 1; j < rows.length; j++) {
        const v = rows[j][c], t = String(rows[j][c + 1] ?? '').trim();
        if (isBlank(v) || !t) break;
        if (!list.some((x) => x.min === num(v))) list.push({ min: num(v), title: t });
      }
      if (list.length) { plan.settings.ranks = list.sort((a, b) => a.min - b.min); ranks = list.length; }
      break;
    }
    return `Лист «${sheetName}»: баллы — бойцов ${fighters}, начислений за квартал ${entries}${ranks ? `, званий ${ranks}` : ''}${min ? `, минимум ${min[1]} баллов` : ''}`;
  }

  plan.members = [...touched.values()];
  if (!Object.keys(plan.settings).length) delete plan.settings;
  const newMembers = plan.members.filter(isNew);
  const payCount = Object.values(plan.payments).reduce((a, m) => a + Object.keys(m).length, 0);
  return {
    plan,
    report,
    summary: {
      newMembers: newMembers.length, updatedMembers: plan.members.length - newMembers.length,
      payments: payCount, expenses: plan.expenses.length, fees: Object.keys(plan.fees).length, points: plan.points.length,
      settings: plan.settings || {},
    },
  };
}
