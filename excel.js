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

const STATUS_LABEL = { recruit: 'Рекрут', fighter: 'Боец' };
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * calc — функции расчёта из app.js: expectedFor, paidAmount, memberDebt, attendanceStats, displayName, feeFor, treasuryBalance.
 */
export async function exportXlsx(state, calc) {
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
    ['Позывной', 'Имя', 'Статус', 'Доступ', 'ВК', 'День рождения', 'В команде с', 'Ушёл', 'Платит с', 'Освобождён', 'Долг', 'Посещаемость, %'],
    ...members.map((m) => [
      m.callsign, m.name, STATUS_LABEL[m.status] || 'Боец', m.admin ? 'Админ' : m.login ? 'Участник' : '',
      m.vk, m.birthday, m.from, m.left || '', m.feeFrom || '', m.exempt ? 'да' : '',
      calc.memberDebt(m).debt, calc.attendanceStats(m).pct ?? '',
    ]),
  ], [14, 22, 10, 10, 18, 14, 12, 10, 10, 11, 10, 15]);

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

  add('Имущество', [
    ['Название', 'Кол-во', 'У кого', 'Заметка'],
    ...state.gear.map((g) => [g.name, g.qty, g.holderId ? nick(g.holderId) : 'склад', g.note || '']),
  ], [26, 8, 16, 30]);

  XLSX.writeFile(wb, `${state.settings.teamName || 'team'}-${todayISO()}.xlsx`);
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

/** Дата операции: Date, серийная дата, «07.10.2026», «2026-10-07». */
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

/** Сумма из ячейки. «+», «да», «✓» означают полный взнос. */
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

const H = {
  callsign: /позывн/,
  name: /^(фио|ф\.?\s?и\.?\s?о?|имя|участник|боец|игрок|член|кто)/,
  surname: /фамили/,
  vk: /(^|\s)(вк|vk)(\s|$)|вконтакт|vk\.com|ссылк/,
  birthday: /рожд|^д\.?\s?р\.?$|^др$/,
  status: /статус|звание|ранг|роль/,
  from: /вступ|в команде|с какого|принят/,
  amount: /сумм|размер|руб|₽/,
  date: /^дата|^число/,
  month: /месяц|период|за что|за месяц/,
  title: /описан|назначен|статья|за что|наимен|комментар|примечан|что/,
  category: /категор|статья|тип расход/,
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

const isTotalRow = (s) => /^(итог|всего|сумма|total|собрано|баланс|размер взноса)/i.test(String(s || '').trim());

/**
 * Разбирает книгу Excel и строит план изменений, не меняя данные.
 * Возвращает {plan, report[]}; plan передаётся в store.importBulk.
 */
export async function analyzeWorkbook(file, state) {
  const XLSX = await loadXLSX();
  const wb = XLSX.read(await file.arrayBuffer(), { cellDates: true });
  const fee = state.settings.fee;
  const report = [];
  const plan = { members: [], payments: {}, fees: {}, expenses: [] };

  // Индекс участников по позывному и имени (включая создаваемых при импорте).
  const pool = state.members.map((m) => ({ ...m }));
  const touched = new Map();
  const index = () => {
    const map = new Map();
    for (const m of pool) {
      if (m.callsign) map.set(normLogin(m.callsign), m);
      if (m.name) map.set(normLogin(m.name), m);
      if (m.callsign && m.name) map.set(normLogin(`${m.callsign} (${m.name})`), m);
    }
    return map;
  };
  let byKey = index();
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
      target = { id: uid(), name: '', callsign: '', vk: '', birthday: '', status: 'fighter', feeFrom: null, from: monthKey(), left: null, exempt: false, admin: false };
      pool.push(target);
    }
    for (const [k, v] of Object.entries(patch)) if (v !== undefined && v !== '' && v !== null) target[k] = v;
    touched.set(target.id, target);
    byKey = index();
    return target;
  };
  const isNew = (m) => !state.members.some((x) => x.id === m.id);
  const lowerHeader = (h) => (typeof h === 'string' ? h.trim().toLowerCase() : '');

  for (const sheetName of wb.SheetNames) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, raw: true, defval: '' });
    const hi = findHeaderRow(rows, XLSX);
    if (hi < 0) { report.push(`Лист «${sheetName}»: не распознан, пропущен`); continue; }
    const header = rows[hi];
    const body = rows.slice(hi + 1).filter((r) => r.some((c) => c !== '' && c !== null));
    const hl = header.map(lowerHeader);
    const col = (re) => hl.findIndex((h) => re.test(h));

    // Год для заголовков без года («Январь», «Февраль»…): берём из соседних или текущий.
    let year = new Date().getFullYear();
    const monthCols = [];
    header.forEach((h, i) => {
      const k = parseMonth(h, XLSX, year);
      if (k) { monthCols.push([i, k]); year = Number(k.slice(0, 4)); }
    });

    // 1) Таблица «боец × месяцы».
    if (monthCols.length >= 2) {
      let nameCol = col(H.callsign);
      if (nameCol < 0) nameCol = col(H.name);
      if (nameCol < 0) nameCol = header.findIndex((_, i) => !monthCols.some(([c]) => c === i));
      const nameCol2 = col(H.name) !== nameCol ? col(H.name) : -1;
      // Строка «Размер взноса», если есть.
      const feeRow = body.find((r) => /взнос|размер/i.test(String(r[nameCol] || '')));
      if (feeRow) for (const [c, k] of monthCols) { const v = parseAmount(feeRow[c], 0); if (v > 0) plan.fees[k] = v; }
      let count = 0, created = 0;
      for (const r of body) {
        const text = String(r[nameCol] ?? '').trim();
        if (!text || isTotalRow(text)) continue;
        const paid = monthCols.map(([c, k]) => [k, parseAmount(r[c], plan.fees[k] ?? state.settings.fees[k] ?? fee)]).filter(([, a]) => a > 0);
        let m = findMember(text) || (nameCol2 >= 0 ? findMember(r[nameCol2]) : null);
        const firstMonth = paid.map(([k]) => k).sort()[0];
        if (!m) {
          if (!paid.length && monthCols.every(([c]) => r[c] === '' || r[c] == null)) continue;
          const paren = text.match(/^(.+?)\s*\((.+)\)$/);
          m = upsert(null, paren ? { callsign: paren[1], name: paren[2], from: firstMonth || monthCols[0][1] }
            : { name: nameCol2 >= 0 ? String(r[nameCol2] || text) : text, callsign: nameCol2 >= 0 ? text : '', from: firstMonth || monthCols[0][1] });
          created++;
        } else if (firstMonth && firstMonth < m.from) {
          upsert(m, { from: firstMonth });
        }
        for (const [k, a] of paid) {
          (plan.payments[k] ||= {})[m.id] = a;
          count++;
        }
      }
      report.push(`Лист «${sheetName}»: взносы по месяцам (${monthCols.length} мес.) — ${count} оплат${created ? `, новых бойцов: ${created}` : ''}`);
      continue;
    }

    // Служебные листы нашей же выгрузки — только для чтения человеком.
    if (/посещ|^игры|имущ/i.test(sheetName)) { report.push(`Лист «${sheetName}»: справочный, пропущен`); continue; }

    const cName = col(H.name), cCall = col(H.callsign), cAmount = col(H.amount);
    const cDate = col(H.date), cMonth = col(H.month);

    // 2) Построчный список оплат: «Боец | Месяц | Сумма».
    if ((cName >= 0 || cCall >= 0) && cAmount >= 0 && (cMonth >= 0 || cDate >= 0)) {
      let count = 0;
      for (const r of body) {
        const text = String(r[cCall >= 0 ? cCall : cName] ?? '').trim();
        if (!text || isTotalRow(text)) continue;
        const k = parseMonth(r[cMonth >= 0 ? cMonth : cDate], XLSX, new Date().getFullYear()) || (cDate >= 0 && parseDate(r[cDate], XLSX)?.slice(0, 7));
        const a = parseAmount(r[cAmount], fee);
        if (!k || a <= 0) continue;
        const m = findMember(text) || (cCall >= 0 && cName >= 0 ? findMember(r[cName]) : null)
          || upsert(null, { name: String(r[cName >= 0 ? cName : cCall]), callsign: cCall >= 0 ? text : '', from: k });
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
      let added = 0, updated = 0;
      for (const r of body) {
        let call = cCall >= 0 ? String(r[cCall] ?? '').trim() : '';
        let name = cName >= 0 ? String(r[cName] ?? '').trim() : '';
        const paren = !call && name.match(/^(.+?)\s*\((.+)\)$/);
        if (paren) { call = paren[1].trim(); name = paren[2].trim(); }
        if (cSur >= 0 && r[cSur]) name = `${name} ${String(r[cSur]).trim()}`.trim();
        if ((!call && !name) || isTotalRow(call || name)) continue;
        const st = cSt >= 0 ? String(r[cSt] ?? '').toLowerCase() : '';
        const patch = {
          callsign: call, name: name || call,
          vk: cVk >= 0 ? String(r[cVk] ?? '').trim() : '',
          birthday: cBd >= 0 ? parseDate(r[cBd], XLSX) || '' : '',
          from: cFrom >= 0 ? parseMonth(r[cFrom], XLSX, new Date().getFullYear()) || parseDate(r[cFrom], XLSX)?.slice(0, 7) || '' : '',
          status: /рекрут|кандидат|новобран|стаж[её]р|испыт/.test(st) ? 'recruit' : /боец|основ|член|ветеран/.test(st) ? 'fighter' : '',
        };
        const m = findMember(call) || findMember(name);
        upsert(m, patch);
        if (m) updated++; else added++;
      }
      report.push(`Лист «${sheetName}»: состав — новых ${added}, обновлено ${updated}`);
      continue;
    }

    // 4) Казна: дата, описание, сумма (или раздельные столбцы «Приход» / «Расход»).
    const cTitle = col(H.title), cCat = col(H.category), cKind = col(H.kind);
    const cIn = col(H.income), cOut = col(H.outcome);
    if (cDate >= 0 && (cAmount >= 0 || cIn >= 0 || cOut >= 0)) {
      const existing = new Set(state.expenses.map((e) => `${e.date}|${normLogin(e.title)}|${e.amount}`));
      let count = 0;
      for (const r of body) {
        const date = parseDate(r[cDate], XLSX);
        if (!date) continue;
        let amount = 0, kind = 'out';
        if (cAmount >= 0 && cAmount !== cIn && cAmount !== cOut) {
          amount = parseAmount(r[cAmount], 0);
          const kindText = cKind >= 0 ? String(r[cKind] ?? '').toLowerCase() : '';
          if (H.income.test(kindText)) kind = 'in';
          else if (!H.outcome.test(kindText) && amount > 0 && cKind < 0) kind = 'out';
          if (amount < 0) { kind = 'out'; amount = -amount; }
        } else {
          const inc = cIn >= 0 ? parseAmount(r[cIn], 0) : 0;
          const out = cOut >= 0 ? parseAmount(r[cOut], 0) : 0;
          if (inc > 0) { amount = inc; kind = 'in'; } else { amount = Math.abs(out); kind = 'out'; }
        }
        if (!amount) continue;
        const title = String((cTitle >= 0 ? r[cTitle] : '') || (cCat >= 0 ? r[cCat] : '') || 'Без описания').trim();
        if (isTotalRow(title)) continue;
        const key = `${date}|${normLogin(title)}|${amount}`;
        if (existing.has(key)) continue;
        existing.add(key);
        plan.expenses.push({ id: uid(), date, title, amount, kind, category: cCat >= 0 && cCat !== cTitle ? String(r[cCat] ?? '').trim() : '' });
        count++;
      }
      report.push(`Лист «${sheetName}»: казна — ${count} новых операций`);
      continue;
    }

    report.push(`Лист «${sheetName}»: не распознан, пропущен`);
  }

  plan.members = [...touched.values()];
  const newMembers = plan.members.filter(isNew).length;
  const payCount = Object.values(plan.payments).reduce((a, m) => a + Object.keys(m).length, 0);
  return {
    plan,
    report,
    summary: { newMembers, updatedMembers: plan.members.length - newMembers, payments: payCount, expenses: plan.expenses.length, fees: Object.keys(plan.fees).length },
  };
}
