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
import { occurrenceId, localWallLabel } from './zonedSchedule.js';

export const NOTIF_ROUTES = {
  meds: '#/meds', water: '#/metric/water', pressure: '#/metric/pressure',
  weight: '#/metric/weight', tests: '#/tests', visits: '#/visits',
};

/* Только внутренние маршруты приложения (для notificationclick → postMessage) */
export const isSafeRoute = (r) => typeof r === 'string' && /^#\/[\w\-/]*$/.test(r) && r.length <= 80;

/* Проверка правил: одно срабатывание → одно уведомление.
   storage: { getNotifications(), updateNotification(id, patch) }
   show(rule, fireAt, occId): показать уведомление; permission(): 'granted' | …
   occurrences: { has(id), mark(id, via) } — общий с SW журнал показанного:
     срабатывание, уже пришедшее push'ем, локально не показывается.
   deferMs(rule): пока фоновый push — основной канал, локальный показ
     откладывается на это время (ждём push), затем — запасной показ. */
export function createNotifier({ storage, show, permission, now = () => new Date(), onError = () => {}, occurrences = null, deferMs = null }) {
  let running = null;
  async function run() {
    if (permission() !== 'granted') return [];
    const t = now();
    const fired = [];
    const wait = deferMs ? await deferMs() : 0;
    for (const rule of await storage.getNotifications()) {
      const due = dueFire(rule, t);
      if (!due) continue;
      const occ = occurrenceId(rule.id, localWallLabel(due));
      if (occurrences && await occurrences.has(occ)) {
        await storage.updateNotification(rule.id, { lastFiredAt: due.toISOString() }); // уже показано push'ем
        continue;
      }
      if (wait && t - due < wait) continue; // серверный push ещё может прийти
      /* сначала фиксируем срабатывание — повторная/параллельная проверка его уже не покажет */
      await storage.updateNotification(rule.id, { lastFiredAt: due.toISOString() });
      if (occurrences) await occurrences.mark(occ, 'local');
      fired.push(rule.id);
      try { await show(rule, due, occ); } catch (err) { onError(err, rule); }
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
   env: { supported, permission, standalone, ios, swActive, pushSupported, subscribed,
          background?: { backend: 'ok'|'error'|'absent'|'offline'|'legacy', primaryHost?, enabled, subscription: 'active'|'none'|'lost',
                         syncError, pending, lastSyncAt, lastPushAt } }
   level: 'ok' | 'warn' | 'bad'. Никогда не обещает доставку, которой нет. */
const fmtStamp = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
};

export function backgroundActive(bg) {
  return !!(bg && bg.backend === 'ok' && bg.enabled && bg.subscription === 'active' && !bg.syncError && !bg.pending);
}

export function describeNotifyState(env) {
  const bg = env.background || null;
  const active = backgroundActive(bg);
  const items = [];
  let status;
  const legacy = !!(bg && bg.backend === 'legacy');
  if (legacy) {
    status = { level: 'warn', title: 'Резервная версия LexLife', detail: `Фоновые уведомления работают только в основной версии${bg.primaryHost ? ` (${bg.primaryHost})` : ''}. Здесь напоминания проверяются, только пока это приложение открыто, и могут повторить уведомления основной версии.` };
  } else if (!env.supported) {
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
  } else if (active) {
    status = { level: 'ok', title: 'Фоновые уведомления активны', detail: 'Напоминания приходят с сервера LexLife, даже когда приложение закрыто. Проверьте кнопкой «Проверить фоновый push».' };
  } else if (bg && bg.enabled && bg.syncError) {
    status = { level: 'warn', title: 'Не удалось синхронизировать фоновые уведомления', detail: 'Изменения сохранены на устройстве и будут отправлены на сервер, когда появится сеть. До этого фоновые напоминания могут приходить по старому расписанию.' };
  } else if (bg && bg.enabled && bg.subscription === 'lost') {
    status = { level: 'warn', title: 'Push-подписка потеряна', detail: 'iPhone сбросил подписку. Нажмите «Включить фоновые уведомления» ещё раз.' };
  } else {
    status = { level: 'ok', title: 'Уведомления разрешены', detail: 'Проверьте доставку кнопкой «Проверить локальное уведомление».' };
  }
  const perm = !env.supported ? 'не поддерживается' : env.permission === 'granted' ? 'разрешено' : env.permission === 'denied' ? 'запрещено' : 'не запрошено';
  items.push({ label: 'Режим', value: env.standalone ? 'установленное приложение' : 'вкладка браузера' });
  items.push({ label: 'Системное разрешение', value: perm });
  items.push({ label: 'Service Worker', value: env.swActive ? 'активен' : 'не активен' });
  items.push({ label: 'Push-подписка', value: !env.pushSupported ? 'не поддерживается' : env.subscribed ? 'активна' : 'отсутствует' });
  const backend = !bg ? 'не проверен' : bg.backend === 'ok' ? 'доступен' : bg.backend === 'absent' ? 'нет на этом адресе' : bg.backend === 'legacy' ? 'не используется (резервная версия)' : bg.backend === 'offline' ? 'нет сети' : 'ошибка';
  items.push({ label: 'Сервер уведомлений', value: backend });
  items.push({ label: 'Фоновая доставка', value: active ? 'активна' : 'неактивна' });
  if (bg && bg.enabled) {
    items.push({ label: 'Последняя синхронизация', value: bg.pending ? `${fmtStamp(bg.lastSyncAt)} · есть неотправленные изменения` : fmtStamp(bg.lastSyncAt) });
    items.push({ label: 'Последний серверный push', value: fmtStamp(bg.lastPushAt) });
  }
  const limit = active
    ? 'Пока LexLife открыт, приложение подстраховывает: если серверный push не пришёл в течение 2 минут, напоминание покажется локально (не дважды).'
    : legacy
      ? 'Это резервная копия на старом адресе: сервер уведомлений здесь не используется, данные не синхронизируются с основной версией.'
      : bg && bg.backend === 'absent'
      ? 'По этому адресу фоновые уведомления не работают: напоминания проверяются самим приложением и приходят, только пока LexLife открыт на экране.'
      : 'Без фоновой доставки напоминания проверяются самим приложением: когда LexLife свёрнут, экран заблокирован или приложение закрыто, iPhone останавливает его код — напоминание не придёт (если открыть приложение в течение 10 минут после назначенного времени, оно покажется с опозданием).';
  return { status, items, limit, active };
}
