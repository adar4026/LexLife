/* =========================================================
   notifier.js — локальная доставка напоминаний и честный статус системы.

   ВАЖНО (ограничение платформы): локальная доставка — это проверка расписания
   кодом страницы. Она работает, только пока JavaScript LexLife реально
   выполняется (приложение открыто на экране). В фоне, на заблокированном
   экране и при закрытом PWA iOS замораживает/выгружает страницу — таймер не
   идёт, и ни один механизм браузера не разбудит его в нужный момент
   (Notification Triggers / Periodic Background Sync в Safari нет).
   Доставка при закрытом приложении возможна только через Web Push с сервера.
   ========================================================= */

import { dueFire } from './notifySchedule.js';

export const NOTIF_ROUTES = {
  meds: '#/meds', water: '#/metric/water', pressure: '#/metric/pressure',
  weight: '#/metric/weight', tests: '#/tests', visits: '#/visits',
};

/* Только внутренние маршруты приложения (для notificationclick → postMessage) */
export const isSafeRoute = (r) => typeof r === 'string' && /^#\/[\w\-/]*$/.test(r) && r.length <= 80;

/* Проверка правил: одно срабатывание → одно уведомление.
   storage: { getNotifications(), updateNotification(id, patch) }
   show(rule, fireAt): показать уведомление; permission(): 'granted' | …   */
export function createNotifier({ storage, show, permission, now = () => new Date(), onError = () => {} }) {
  let running = null;
  async function run() {
    if (permission() !== 'granted') return [];
    const t = now();
    const fired = [];
    for (const rule of await storage.getNotifications()) {
      const due = dueFire(rule, t);
      if (!due) continue;
      /* сначала фиксируем срабатывание — повторная/параллельная проверка его уже не покажет */
      await storage.updateNotification(rule.id, { lastFiredAt: due.toISOString() });
      fired.push(rule.id);
      try { await show(rule, due); } catch (err) { onError(err, rule); }
    }
    return fired;
  }
  return {
    /* параллельные вызовы (таймер + возврат в приложение) склеиваются в один проход */
    check() {
      if (!running) running = run().finally(() => { running = null; });
      return running;
    },
  };
}

/* Патч правила при включении/изменении: прошедшие моменты не «догоняются»
   мгновенно, следующее срабатывание — строго по новому расписанию. */
export const armPatch = (patch = {}, now = new Date()) => ({ ...patch, lastFiredAt: now.toISOString() });

/* Напоминания о воде на экране «Вода» = правило water центра уведомлений */
export const waterRulePatch = (hyd) => ({
  repeat: 'interval',
  intervalMinutes: Number(hyd.slotMinutes) || 120,
  startTime: hyd.wakeStart || '07:00',
  endTime: hyd.wakeEnd || '23:00',
});

/* Реальное состояние системы уведомлений → тексты для экрана.
   env: { supported, permission, standalone, ios, swActive, pushSupported, subscribed }
   level: 'ok' | 'warn' | 'bad'. Никогда не обещает «работают», если доставки нет. */
export function describeNotifyState(env) {
  const items = [];
  let status;
  if (!env.supported) {
    status = env.ios && !env.standalone
      ? { level: 'bad', title: 'В Safari уведомления недоступны', detail: 'На iPhone уведомления работают только в установленном приложении: Поделиться → «На экран „Домой“», затем открывайте LexLife с иконки.' }
      : { level: 'bad', title: 'PWA не поддерживает системные уведомления в данном режиме', detail: env.ios ? 'Нужна iOS 16.4 или новее и запуск LexLife с экрана «Домой».' : 'Этот браузер не поддерживает Notification API.' };
  } else if (env.permission === 'denied') {
    status = env.ios
      ? { level: 'bad', title: 'Уведомления запрещены в настройках iPhone', detail: 'Настройки → Уведомления → LexLife → «Допуск уведомлений». Из приложения разрешение повторно запросить нельзя.' }
      : { level: 'bad', title: 'Уведомления запрещены', detail: 'Разрешите уведомления для этого сайта в настройках браузера.' };
  } else if (env.permission !== 'granted') {
    status = { level: 'warn', title: 'Разрешение не предоставлено', detail: 'Нажмите «Разрешить» — система спросит один раз.', ask: true };
  } else if (!env.swActive) {
    status = { level: 'warn', title: 'Уведомления разрешены, но Service Worker не активен', detail: 'Перезапустите приложение. Без Service Worker iPhone не покажет уведомление.' };
  } else {
    status = { level: 'ok', title: 'Уведомления разрешены', detail: 'Проверьте доставку кнопкой «Отправить тестовое уведомление».' };
  }
  items.push({ label: 'Режим', value: env.standalone ? 'установленное приложение' : 'вкладка браузера' });
  items.push({ label: 'Service Worker', value: env.swActive ? 'активен' : 'не активен' });
  items.push({ label: 'Доставка', value: 'только пока LexLife открыт на экране' });
  items.push({ label: 'Push-сервер', value: !env.pushSupported ? 'не поддерживается' : env.subscribed ? 'подписка есть' : 'не подключён' });
  const limit = 'Напоминания проверяются самим приложением. Когда LexLife свёрнут, экран заблокирован или приложение закрыто, iPhone останавливает его код — напоминание не придёт (если открыть приложение в течение 10 минут после назначенного времени, оно покажется с опозданием). Для доставки при закрытом приложении нужен push-сервер.';
  return { status, items, limit };
}
