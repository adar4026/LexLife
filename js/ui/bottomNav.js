/* =========================================================
   js/ui/bottomNav.js — нижняя плавающая капсула (Главная · Показатели ·
   Лекарства · Анализы), по образцу LexMoney.
   Один общий индикатор (.tab-bar__indicator) переезжает между равными
   колонками через transform: положение — CSS по --nav-index, геометрия
   не измеряется и верна на любой ширине. Здесь только активный пункт:
   класс, aria-current и индекс. Переходы — обычные ссылки href="#/…"
   (hashchange → render), без перезагрузки страницы.
   ========================================================= */

/* tab — маршрут вкладки ('home' | 'metrics' | 'meds' | 'tests') или null
   (экран вне вкладок: индикатор прячется). Первое появление индикатора —
   без анимации, дальше — плавный переезд (transition в CSS). */
export function setActiveTab(nav, tab) {
  if (!nav) return -1;
  const items = Array.from(nav.querySelectorAll('.tab'));
  const idx = items.findIndex((a) => a.dataset.route === tab);
  items.forEach((a, i) => {
    const on = i === idx;
    a.classList.toggle('is-active', on);
    if (on) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  const ind = nav.querySelector('.tab-bar__indicator');
  if (!ind) return idx;
  if (idx < 0) { ind.classList.remove('is-ready'); return idx; }
  if (!ind.classList.contains('is-ready')) {
    ind.style.transition = 'none';
    nav.style.setProperty('--nav-index', String(idx));
    ind.classList.add('is-ready');
    void ind.offsetWidth; // reflow: transition:none применяется до возврата стилей
    ind.style.transition = '';
    return idx;
  }
  nav.style.setProperty('--nav-index', String(idx));
  return idx;
}
