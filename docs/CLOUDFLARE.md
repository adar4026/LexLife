# LexLife на Cloudflare: Workers + Static Assets + D1 + Cron + Web Push

Статус: **параллельный production развёрнут** (ветка `cloudflare-push`, 2026-10-03) —
`https://lexlife.alexus4026.workers.dev/`. Worker `lexlife`, D1 `lexlife`, cron `* * * * *`, production VAPID
(приватный ключ и subject — только Cloudflare secrets). Данные пользователя не переносились.
GitHub Pages (`https://adar4026.github.io/LexLife/`) работает как раньше, `main` не менялся.

## Архитектура

```
GitHub (main) ── source of truth
   │  push в main
   ├──► GitHub Pages            https://adar4026.github.io/LexLife/   (как сейчас, без изменений)
   └──► Cloudflare Workers Builds ──► Worker «lexlife»                 https://lexlife.<subdomain>.workers.dev/
                                        ├─ Static Assets (dist/)      PWA от корня /
                                        ├─ /api/*                     Web Push backend (тот же origin, без CORS)
                                        ├─ D1 «lexlife» (binding DB)  только инфраструктура уведомлений
                                        └─ Cron «* * * * *»           due-уведомления → Web Push → SW → iPhone
```

Один код фронтенда обслуживает оба адреса: все пути относительные (`./…`), SW регистрируется как `sw.js`
(scope = каталог приложения), `start_url`/`scope` в манифесте — `./index.html` и `./`. Поэтому на Pages scope
`/LexLife/`, на Cloudflare — `/`, без сборочных подстановок. Разные origin = разные SW, кэши и хранилища, они не
конфликтуют.

## Файлы

| Файл | Назначение |
|---|---|
| `wrangler.jsonc` | Worker, assets (`dist/`, `run_worker_first`), D1, cron, rate limit, публичные vars. Секретов нет |
| `worker/index.js` | вход: статика (`/index.html` без редиректа), `/api/*`, `scheduled`, security headers |
| `worker/api.js` | маршруты API, авторизация, sync, тестовый push, rate limit |
| `worker/cron.js` | due → атомарный claim → push → retry; обслуживание раз в час |
| `worker/webpush.js` | VAPID (ES256) + шифрование aes128gcm на WebCrypto, без npm-зависимостей; allowlist push-сервисов |
| `worker/delivery.js` | отправка на подписку устройства, 404/410/4xx/5xx → состояние подписки |
| `worker/auth.js`, `worker/rules.js`, `worker/headers.js` | токены устройства, проверка правил, CSP и др. |
| `migrations/0001_push_infrastructure.sql` | схема D1 |
| `js/services/zonedSchedule.js` | расписание в IANA timezone (общий для сервера и occurrenceId) |
| `js/services/pushClient.js` | фронтенд: устройство, подписка, синхронизация правил, offline |
| `js/services/occurrenceStore.js` | журнал показанных срабатываний (Cache API, общий со SW) |
| `js/services/deployment.js` | где запущено приложение; `NEW_HOME_URL` для экрана переноса (пока `null`) |
| `scripts/build-assets.mjs` | `dist/` из allowlist: `index.html manifest.json sw.js css js icons` |
| `scripts/gen-vapid.mjs` | пара VAPID; `--dev-vars` пишет локальную пару в `.dev.vars` (gitignored) |

## D1 — только уведомления

Медицинские данные (вес, давление, вода, анализы, PDF, заметки, бэкапы) **не покидают устройство**.
Тексты напоминаний на сервер тоже не уходят — push содержит нейтральную фразу по типу правила.

- `devices` — `id` (UUID), `token_hash` (SHA-256), `timezone`, `rules_rev`, `last_sync_at`, `last_test_push_at`
- `push_subscriptions` — `endpoint UNIQUE`, `p256dh`, `auth`, `active`, `failure_count`, `last_success_at`, `last_failure_at`
- `notification_rules` — `UNIQUE(device_id, client_rule_id)`, `type`, `enabled`, `schedule_type`, `local_time`,
  `days_of_week`, `interval_minutes`, `window_start/end`, `once_date`, `timezone`, `next_fire_at` (UTC мс), `fire_at`, `completed_at`
- `notification_deliveries` — `UNIQUE(rule_id, scheduled_fire_at)`, `occurrence_id`, `status`, `attempts`, `next_attempt_at`, `sent_at`, `error_code`

Индексы: частичный `idx_notification_rules_due (next_fire_at) WHERE enabled = 1 AND next_fire_at IS NOT NULL`
(cron не сканирует таблицу — проверено `EXPLAIN QUERY PLAN`), `device_id`, retry-индекс, `(status, created_at)`.

Хранение: журнал доставок — 30 дней; устройство без подписки — удаляется через 90 дней;
«Отключить фоновые уведомления» сразу удаляет подписку и зеркало правил.

## API (тот же origin)

| | Авторизация | |
|---|---|---|
| `GET /api/config` | нет | публичный VAPID-ключ |
| `POST /api/device/register` | нет (rate limit по IP) | `{deviceId}` → `{deviceId, token}`; занятый id → 409 |
| `POST /api/push/subscribe` | Bearer | endpoint только Apple/Google/Mozilla/Microsoft push; одна подписка на устройство |
| `POST /api/push/unsubscribe` | Bearer | удалить подписку и правила |
| `GET /api/push/status` | Bearer | подписка, последняя синхронизация, последний push (без endpoint) |
| `POST /api/notifications/sync` | Bearer | полное зеркало правил + `rev` (устаревший → 409) |
| `POST /api/notifications/test` | Bearer | push только своему устройству, не чаще 1 раза в 20 с |

`Authorization: Bearer <device_id>.<token>` — токен только в заголовке. `device_id` не является паролем:
без токена (32 случайных байта; в D1 — только SHA-256) ничего изменить нельзя. POST принимает только
`application/json`, CORS не открыт.

## Cron и защита от дублей

Раз в минуту: `next_fire_at <= now` по индексу → в одной транзакции D1 `INSERT delivery` (UNIQUE
`rule_id + scheduled_fire_at`) + сдвиг `next_fire_at` на следующее срабатывание, вычисленное из локального
времени и timezone (не «+24 ч»). Второй параллельный запуск получает конфликт → пропуск.

- 2xx → `sent`; 404/410 → подписка удалена, правила сняты с расписания до новой подписки;
- 429/5xx/сеть → `retry` через 1 и 2 мин, максимум 3 попытки и только в пределах 10 минут опоздания;
- прочие 4xx → `failed`, после 3 подряд подписка деактивируется (после 10 подряд временных — тоже);
- Worker оборвался после claim → строка `claimed` **не повторяется** (максимум одна доставка), через 5 мин — `unknown`;
- опоздание > 10 мин (cron стоял) → `skipped`, как у локального планировщика.

Дальше по цепочке: `Topic` (push-сервис заменяет неотправленный дубль) → `tag = occurrenceId` в SW
(повтор заменяет уведомление) → журнал occurrence в Cache API → локальный планировщик не показывает то,
что пришло push'ем. Пока push — основной канал, локальный планировщик (приложение открыто) ждёт 2 минуты и
только потом показывает запасное уведомление — с тем же tag.

## Синхронизация правил (фронтенд)

localStorage остаётся главным. Сервер — зеркало расписания. Нужна ли синхронизация, определяется по
«отпечатку» правил + timezone (без текста и `lastFiredAt`), а не по событиям: offline-изменения
переживают перезапуск, несколько изменений подряд → одна (последняя) версия, restore из бэкапа и смена
timezone в поездке синхронизируются сами. Ошибка → «Не удалось синхронизировать фоновые уведомления».
Триггеры: изменение правила, запуск, возврат в приложение, событие `online`.

## Backup / restore

Ключи `lexlife_device_id`, `lexlife_device_token`, `lexlife_push_state` — вне `DATA_KEYS`: в резервную копию
не попадают, restore их не трогает. Restore на другом устройстве восстанавливает правила локально; новое
устройство регистрируется и получает **новую** подписку (старый endpoint не переносится). Формат бэкапа не менялся.

## Security headers

CSP `default-src 'self'`; `script-src 'self' 'wasm-unsafe-eval'`; `style-src 'self' 'unsafe-inline' fonts.googleapis.com`
(в приложении есть inline `style=""`); `font-src fonts.gstatic.com`; `img-src data: blob:`; `connect-src 'self' blob: data:` +
Google Fonts (SW кэширует шрифты); `worker-src 'self' blob:`; `object-src 'none'`; `frame-ancestors 'none'`.
Плюс `X-Content-Type-Options`, `Referrer-Policy: no-referrer`, `Permissions-Policy`, `X-Frame-Options`, HSTS.
Проверено в браузере: приложение, PDF viewer (3 страницы), шрифты, SW — 0 нарушений CSP.

## Перенос данных пользователя (GitHub Pages → Cloudflare)

**Данные автоматически не появятся на новом адресе.** localStorage и IndexedDB привязаны к origin.
На iPhone приложение с экрана «Домой» к тому же имеет своё хранилище, отдельное от Safari, поэтому «мост»
через окно или iframe (`postMessage` с github.io) прочитал бы пустое хранилище Safari, а не данные приложения.
Пересылать данные через сервер не будем (минимизация данных).

Надёжный путь — уже существующая полная резервная копия (ZIP с PDF/фото), всё остаётся у пользователя:

1. В старом LexLife с экрана «Домой»: Меню → Резервная копия → «Полная резервная копия с документами» → «Файлы».
2. Safari → новый адрес → Поделиться → «На экран „Домой“».
3. Новый LexLife **с экрана «Домой»** → Меню → Резервная копия → «Восстановить из копии» → ZIP.
4. Проверить данные; включить фоновые уведомления в новом приложении.
5. Старое приложение не удалять, пока всё не проверено.

Это работает уже сейчас, без изменений на Pages. Экран-подсказка «Перенести LexLife на новый адрес»
(`#/move`, в меню) готов и появится, когда в `js/services/deployment.js` будет задан `NEW_HOME_URL`
(на Pages — режим «экспорт», на новом адресе — «импорт»).

## Deploy из GitHub — выбран Cloudflare Workers Builds

Git-интеграция Cloudflare (Workers Builds): push в `main` → сборка и `wrangler deploy` на стороне Cloudflare.
Плюсы: не нужен API-токен Cloudflare в GitHub Secrets публичного репозитория, нет workflow-файлов,
ветки получают preview-версии. Настройки проекта:

- Build command: `npm ci && npm test && npm run build`
- Deploy command: `npx wrangler deploy`
- Root directory: `/`

Миграции D1 применяются вручную и осознанно (`npm run db:migrate:remote`), не при каждом push.
GitHub Pages продолжает деплоиться из того же `main` — оба адреса живут параллельно.

## Production: шаги 1–5 выполнены 2026-10-03, остальное ждёт подтверждения

1. `wrangler login` (аккаунт Cloudflare, Free plan достаточно).
2. `wrangler d1 create lexlife` → записать `database_id` в `wrangler.jsonc`.
3. `npm run db:migrate:remote` (создаёт 4 таблицы — данных пользователя там нет).
4. Production VAPID: `node scripts/gen-vapid.mjs` → публичный ключ в `vars.VAPID_PUBLIC_KEY`,
   приватный → `wrangler secret put VAPID_PRIVATE_KEY`, `wrangler secret put VAPID_SUBJECT` (`mailto:…`).
5. Первый деплой: `npm run deploy` → `https://lexlife.<subdomain>.workers.dev`; cron создаётся из `triggers`.
6. Dashboard → Worker → Settings → Builds → Connect GitHub `adar4026/LexLife`, ветка `main`.
7. Проверки на iPhone: установка с экрана «Домой», включение фоновых уведомлений, тестовый push при
   заблокированном экране, правило через минуту при закрытом приложении, offline, перенос данных через ZIP.
8. Только после этого — `NEW_HOME_URL` и решение о судьбе GitHub Pages.

## Локальная разработка

```
npm install
npm run vapid:dev          # .dev.vars с локальной парой
npm run db:migrate:local
npm run dev                # http://127.0.0.1:8787, cron: GET /__scheduled
npm test                   # все тесты (node:sqlite вместо D1, заглушка push-сервиса)
```

## Стабильная точка отката (2026-10-03)

Зафиксирована после переноса данных пользователем и проверки целостности.

| | |
|---|---|
| Git | тег `cf-stable-2026-10-03` → коммит `dfb8b33` (ветка `cloudflare-push`) |
| Worker | `lexlife`, версия `ea6631f7-ffc5-4041-948a-413da3b6b8fd` (код + секреты VAPID) |
| Static assets | 29 файлов, побайтно совпадают со сборкой `npm run build` из `dfb8b33`; SW `lexlife-v35` |
| D1 | `lexlife` `c8eaba54-3002-484a-924d-e0ef5a896012`, bookmark `00000004-00000012-000050f9-cdfa24c76977369578f61a5db0c9cf91` (2026-10-03T16:46Z) |
| Cron | `* * * * *` |

Откат:

```
npx wrangler rollback ea6631f7-ffc5-4041-948a-413da3b6b8fd     # код/конфиг Worker
git checkout cf-stable-2026-10-03 && npm run deploy            # или пересобрать из тега
npx wrangler d1 time-travel restore lexlife --bookmark=<bookmark>   # только если повреждена D1
```

D1 Time Travel на Free plan хранит 7 дней. В D1 только инфраструктура push: при её потере устройство
перерегистрируется и заново синхронизирует правила; данные здоровья живут на устройстве и в бэкапах пользователя.
Откат Worker не трогает localStorage/IndexedDB на iPhone.
