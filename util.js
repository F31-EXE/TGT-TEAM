// Общие функции для дат, денег и форматирования.

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const MONTHS = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
export const MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

export const monthKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
export const isoDate = (d = new Date()) => `${monthKey(d)}-${String(d.getDate()).padStart(2, '0')}`;
export const todayISO = () => isoDate(new Date());
export const shiftMonth = (key, delta) => { const [y, m] = key.split('-').map(Number); return monthKey(new Date(y, m - 1 + delta, 1)); };
export const monthLabel = (key) => { const [y, m] = key.split('-').map(Number); return `${MONTHS[m - 1]} ${y}`; };
/** «с августа 2026» */
export const sinceLabel = (key) => { const [y, m] = key.split('-').map(Number); return `с ${MONTHS_GEN[m - 1]} ${y}`; };
export const dateLabel = (iso) => { const [y, m, d] = iso.split('-').map(Number); return `${d} ${MONTHS_GEN[m - 1]} ${y}`; };
export const dayMonthLabel = (iso) => { const [, m, d] = iso.split('-').map(Number); return `${d} ${MONTHS_GEN[m - 1]}`; };

/** Ключ логина: регистр и лишние пробелы не важны, ё = е. */
export const normLogin = (s) => String(s || '').trim().toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ');

export const randomPin = () => String(Math.floor(Math.random() * 1e6)).padStart(6, '0');

const vkId = (vk) => String(vk || '').trim().replace(/^(https?:\/\/)?(m\.)?vk\.(com|ru)\//i, '').replace(/^@/, '').replace(/\/+$/, '');

/** Ссылка на профиль ВК из «id123», «durov», «@durov», «vk.com/durov» или полной ссылки. */
export function vkLink(vk) {
  const v = vkId(vk);
  return v ? `https://vk.com/${v}` : '';
}

/** Упоминание для беседы ВК: «@durov». */
export function vkMention(vk) {
  const v = vkId(vk);
  return v ? `@${v}` : '';
}
