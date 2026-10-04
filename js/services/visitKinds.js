/* =========================================================
   visitKinds.js — вид записи в «Врачи и визиты» и её подпись.
   Аддитивные поля визита (схема v8 не меняется, старые версии их не показывают):
   • kind — вид события медицинской истории (визит, процедура, УЗИ/КТ, стоматология…);
   • title — короткое название события, когда врач неизвестен или не главное;
   • time — «ЧЧ:ММ», если время известно.
   Записи без этих полей (обычные визиты) выглядят как раньше: врач · специальность · клиника.
   ========================================================= */

export const VISIT_KINDS = {
  visit: { icon: '🩺', label: 'Визит к врачу' },
  procedure: { icon: '🩹', label: 'Процедура' },
  surgery: { icon: '🏥', label: 'Операция' },
  imaging: { icon: '🩻', label: 'Обследование' },
  dental: { icon: '🦷', label: 'Стоматология' },
  lab: { icon: '🧪', label: 'Сдача анализов' },
  illness: { icon: '🤒', label: 'Заболевание' },
  injury: { icon: '🤕', label: 'Травма' },
  emergency: { icon: '🚑', label: 'Неотложная помощь' },
  referral: { icon: '📝', label: 'Направление' },
  appointment: { icon: '📅', label: 'Запись к врачу' },
  vision: { icon: '👓', label: 'Зрение' },
  medication: { icon: '💊', label: 'Начало приёма' },
};
export const VISIT_KIND_KEYS = Object.keys(VISIT_KINDS);

const txt = (v) => (typeof v === 'string' ? v.trim() : '');
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export const visitIcon = (v) => (VISIT_KINDS[v && v.kind] || VISIT_KINDS.visit).icon;
export const visitKindLabel = (v) => (VISIT_KINDS[v && v.kind] || VISIT_KINDS.visit).label;
export const visitTime = (v) => (v && TIME_RE.test(v.time || '') ? v.time : null);

/* Заголовок строки: название события → врач → «Визит» */
export function visitTitle(v) {
  return txt(v && v.title) || txt(v && v.doctor) || 'Визит';
}

/* Подзаголовок: врач (если заголовок — название события) · специальность · клиника */
export function visitSub(v) {
  if (!v) return '';
  const parts = txt(v.title) ? [txt(v.doctor)] : [];
  parts.push(txt(v.specialty), txt(v.clinic));
  return parts.filter(Boolean).join(' · ');
}

/* Отметка статуса в карточке: «запланирован» / «выполнен» — только для состоявшихся визитов и процедур.
   «Запись к врачу» — не подтверждённый приём; заболевание, направление, начало приёма — не визиты. */
const DONE_KINDS = new Set(['visit', 'procedure', 'surgery', 'imaging', 'dental', 'lab', 'injury', 'emergency', 'vision']);
export function visitStatusChip(v) {
  if (v && v.status === 'planned') return { cls: 'planned', text: 'запланирован' };
  if (!v || !v.kind || DONE_KINDS.has(v.kind)) return { cls: 'done', text: 'выполнен' };
  if (v.kind === 'appointment') return { cls: 'planned', text: 'запись к врачу' };
  return null;
}
