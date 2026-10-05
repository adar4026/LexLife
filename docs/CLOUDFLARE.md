# LexLife: production на Cloudflare, резерв на GitHub Pages

| | |
|---|---|
| **Primary production** | `https://lexlife.alexus4026.workers.dev/` — Worker `lexlife` (Static Assets + `/api` + D1 + Cron) |
| **Legacy backup** | `https://adar4026.github.io/LexLife/` — GitHub Pages: production-сборка `dist/` из `main` (workflow `.github/workflows/pages.yml`), без серверного push, не отключается до отдельного решения |
| **Source of truth** | GitHub `adar4026/LexLife` |
| **Ветка релизов Cloudflare** | `cloudflare-push` — из неё собирается и деплоится production |
| **Стабильная ветка** | `main` — синхронизируется с `cloudflare-push` после релиза; источник GitHub Pages |
| **Deploy Cloudflare** | **только вручную**: `npm run deploy` (= `npm run build && npx wrangler deploy`) с машины разработчика. Автодеплоя из Git нет |
| **Deploy Pages** | автоматически: push в `main` → `.github/workflows/pages.yml` → `npm test` → `npm run build` → публикуется `dist/` |

Медицинские данные живут только на устройстве (localStorage + IndexedDB) и в бэкапах пользователя.
В D1 — только инфраструктура уведомлений. Перенос между адресами — только через файл полной резервной копии.

## Архитектура

```
GitHub adar4026/LexLife
   │
   ├─ cloudflare-push ──► `npm run deploy` вручную ──► Worker «lexlife»   https://lexlife.alexus4026.workers.dev/   PRIMARY
   │                      (build + wrangler deploy)       ├─ Static Assets (dist/)      PWA от корня /
   │        │                                             ├─ /api/*                     Web Push backend (тот же origin)
   │        │ merge после проверки релиза                 ├─ D1 «lexlife» (DB)          только уведомления
   │        ▼                                             └─ Cron «* * * * *»           due → Web Push → SW → iPhone
   └─ main ──► push ──► GitHub Actions (pages.yml) ──► GitHub Pages        https://adar4026.github.io/LexLife/   LEGACY BACKUP
                        (test → build → publish dist/)                     без /api, резервная копия

Push в любую ветку GitHub НЕ деплоит Cloudflare: Git-интеграции (Workers Builds) у этого Worker'а нет.
```

Один код фронтенда обслуживает оба адреса: все пути относительные (`./…`), SW регистрируется как `sw.js`
(scope = каталог приложения), `start_url`/`scope` в манифесте — `./index.html` и `./`. На Pages scope `/LexLife/`,
на Cloudflare — `/`. Разные origin = разные SW, кэши и хранилища: они не конфликтуют, данные не смешиваются.

Роль адреса — `js/services/deployment.js` (`deploymentRole`):

| Роль | Где | Серверный push | Интерфейс |
|---|---|---|---|
| `primary` | `lexlife.alexus4026.workers.dev` | да | обычный |
| `legacy` | `*.github.io` | **нет**: ни одного запроса к `/api`, нет device id, подписки, правил на сервере | плашка «Резервная версия LexLife» на Главной, статус на экране «Уведомления», пункт меню «Перенести LexLife на новый адрес» |
| `dev` | `localhost`, `127.0.0.1` | да (локальный `wrangler dev`) | обычный |
| `other` | любой другой адрес | нет | обычный |

Две установленные PWA на iPhone (старая Pages и новая Cloudflare) не дают двух наборов серверных уведомлений:
резервная копия физически не обращается к серверу. Её локальный планировщик работает, только пока она открыта
(может повторить напоминание основной версии — об этом предупреждает экран «Уведомления»). Данные старой копии
не удаляются и не синхронизируются.

## Файлы

| Файл | Назначение |
|---|---|
| `wrangler.jsonc` | Worker, assets (`dist/`, `run_worker_first`), D1, cron, rate limit, публичные vars, `preview_urls: false`. Секретов нет |
| `worker/index.js` | вход: статика (`/index.html` без редиректа), `/api/*`, `scheduled`, security headers |
| `worker/api.js` | маршруты API, авторизация, sync, тестовый push, rate limit, `/api/status` |
| `worker/cron.js` | due → атомарный claim → push → retry; обслуживание раз в час |
| `worker/webpush.js` | VAPID (ES256) + шифрование aes128gcm на WebCrypto, без npm-зависимостей; allowlist push-сервисов |
| `worker/delivery.js` | отправка на подписку устройства, 404/410/4xx/5xx → состояние подписки |
| `worker/auth.js`, `worker/rules.js`, `worker/headers.js` | токены устройства, проверка правил, CSP и др. |
| `migrations/0001_push_infrastructure.sql` | схема D1 |
| `js/services/deployment.js` | роль адреса (`primary`/`legacy`/`dev`/`other`), `PRIMARY_URL`, экран переноса |
| `js/services/pushClient.js` | фронтенд: устройство, подписка, синхронизация правил, offline; `serverAllowed: false` на резервной копии |
| `js/services/zonedSchedule.js` | расписание в IANA timezone (общий для сервера и occurrenceId) |
| `js/services/occurrenceStore.js` | журнал показанных срабатываний (Cache API, общий со SW) |
| `build-info.json` | в репозитории `sha: null` (заглушка для корня репозитория без сборки); сборка — Cloudflare и GitHub Pages — пишет version/sha/builtAt |
| `scripts/build-assets.mjs` | `dist/` из allowlist + отметки сборки (`build-info.json`, `CACHE_VERSION-<sha7>` в `sw.js`) |
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
| `GET /api/status` | нет | здоровье: `db`, `push` (VAPID настроен), `build` (version, sha, builtAt); 503 при проблеме |
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

Выполнен пользователем 2026-10-03 через резервную копию. Данные автоматически между адресами не переносятся
(разные origin; у PWA с экрана «Домой» на iPhone ещё и своё хранилище), сервер в переносе не участвует.
Повторить при необходимости: в старой копии Меню → «Перенести LexLife на новый адрес» (пошаговая инструкция:
полная копия ZIP → «Файлы» → новое приложение с экрана «Домой» → «Восстановить из копии»).

## Deploy Cloudflare — только вручную

Автодеплоя нет. Production обновляется одной командой с машины разработчика, из ветки `cloudflare-push`:

```bash
npm test && npm run deploy      # build-assets → dist/ → npx wrangler deploy
```

Git-интеграции Cloudflare (Workers Builds) у этого Worker'а нет, GitHub Actions Cloudflare не деплоит
(единственный workflow в репозитории — `pages.yml`, он публикует только GitHub Pages). API-токен Cloudflare
в GitHub не хранится: деплой идёт через OAuth-сессию wrangler на машине разработчика.

Следствия, которые важно не перепутать:

- **Push в GitHub — не deploy.** Ни push в `cloudflare-push`, ни push в `main` не меняют production.
  Пока не выполнен `npm run deploy`, на Cloudflare живёт предыдущая сборка.
- **Merge `cloudflare-push` → `main` не требует повторного deploy.** Merge переносит уже выпущенный код
  в стабильную ветку; код при этом не меняется, поэтому передеплоивать Cloudflare не нужно.
- **`CACHE_VERSION` поднимается только при релизе веб-приложения** (изменились ассеты), а не при merge
  в `main` и не ради синхронизации веток. Вместе с ним в том же коммите обновляется ожидаемое значение
  в `tests/notifications.test.mjs` — тест сверяет точную строку.
- **Тесты — ответственность разработчика перед deploy.** В pipeline их нет, потому что pipeline'а нет;
  `npm test` гоняется локально (и ещё раз в Pages-workflow после merge, уже постфактум).
- Миграции D1 в deploy не входят — применяются отдельно (`npm run db:migrate:remote`).

Как проверить, чем именно задеплоена текущая версия:

```bash
npx wrangler deployments list        # Source: «Unknown (deployment)» = загрузка wrangler, не CI
curl -s https://lexlife.alexus4026.workers.dev/build-info.json   # branch/sha/source сборки
```

`build-info.json` на production показывает `"branch": "cloudflare-push"`, `"source": "local"` — то есть
сборка сделана локально из ветки релизов. У сборки из Workers Builds было бы `"source": "workers-builds"`.

## Канонический порядок релиза

```text
разработка в cloudflare-push
→ npm test (зелёный)
→ если менялись ассеты: bump CACHE_VERSION в sw.js + то же число в tests/notifications.test.mjs
→ commit в cloudflare-push
→ push origin cloudflare-push
→ npm run deploy                    (build + wrangler deploy — единственный шаг, который меняет production)
→ production verification           (/api/status, SW, push на iPhone — см. Release checklist)
→ merge cloudflare-push в main      (--no-ff, без повторного deploy)
→ push origin main
→ GitHub Actions автоматически публикует dist/ на GitHub Pages (резервная копия)
```

### Версия сборки

`npm run build` пишет в `dist/build-info.json` версию (`APP_VERSION`), commit (`WORKERS_CI_COMMIT_SHA`) и время, а в
`dist/sw.js` — `CACHE_VERSION = 'lexlife-vNN-<sha7>'`. Видно в «Настройки → О приложении» (`build 1a2b3c4 · дата`)
и в `GET /api/status`. На GitHub Pages тот же `npm run build` (workflow `pages.yml`), поэтому номер сборки есть и там;
адрес по-прежнему «резервный (GitHub Pages)», `/api` на нём нет.

### Обновление Service Worker

Каждый deploy `main` даёт новый `sw.js` (суффикс commit) → браузер ставит новый SW при следующем запуске/навигации
(`sw.js` отдаётся с `Cache-Control: no-cache`), `install` берёт файлы мимо HTTP-кэша, `activate` удаляет старый
кэш приложения (кэши шрифтов и журнала уведомлений сохраняются), `clients.claim()`.
`skipWaiting()` используется сознательно: SW не хранит и не трогает данные (localStorage/IndexedDB), все модули
приложения загружаются статически при старте (динамически — только pdf.js, он не меняется между сборками), а без
`skipWaiting` PWA на iPhone, которую почти никогда не закрывают полностью, могла бы неделями оставаться на старой
версии. Открытая вкладка переходит на новый код сама — одной перезагрузкой, без ручного hard reload
(протокол `lexlife:update-ready`, отложенная перезагрузка во время формы, защита от цикла — `ARCHITECTURE.md` §9.1);
в открытом приложении новая версия ищется при возврате на передний план. Ручной `CACHE_VERSION` (`lexlife-vNN`) всё
равно поднимается при изменении ассетов: это человекочитаемая версия ассетов, по ней видно, что менялось,
и она попадает в имя кэша на обоих адресах (`lexlife-vNN-<sha7>`).

## D1 migrations

Только вручную и осознанно, никогда из pipeline:

```
npx wrangler d1 migrations list lexlife --remote     # что применено
npx wrangler d1 time-travel info lexlife             # закладка ДО миграции — записать
npm run db:migrate:remote                            # применить
```

Миграция — отдельный коммит + отдельное решение; схема только расширяется (новый код должен работать и со
старой схемой до применения миграции).

## Secrets

| Имя | Где | Примечание |
|---|---|---|
| `VAPID_PRIVATE_KEY` | Cloudflare secret | никогда в Git/логах/README; deploy кода его не требует и не меняет |
| `VAPID_SUBJECT` | Cloudflare secret | `mailto:` оператора |
| `VAPID_PUBLIC_KEY` | `wrangler.jsonc` vars | публичный |

Проверка: `npx wrangler secret list` (только имена). Секреты привязаны к Worker, а не к сборке: `npm run build`
их не видит, в `dist/` и в Git они не попадают. Смена пары VAPID = все подписки устройств станут недействительны (устройства переподпишутся при запуске).

## Cron и Web Push — эксплуатация

- Один Cron Trigger `* * * * *` (из `wrangler.jsonc`). Пустая система: 2 запроса чтения D1 в минуту, 0 записей
  (замер 2026-10-03: ~1 440 запусков и ~3 000 прочитанных строк в сутки, CPU ≈ 1,2 мс на запуск).
- Логи cron — только счётчики, когда что-то было due; endpoint, ключи, токены и данные здоровья не логируются.
- Здоровье: `GET /api/status` (D1 + VAPID), `npx wrangler tail lexlife --format pretty` (вызовы cron),
  `npx wrangler d1 info lexlife` (запросы/строки за 24 ч).
- Тестовый push: приложение → Меню → Уведомления → «Проверить фоновый push».

## Recovery и rollback

Стабильные точки:

| Точка | Git | Worker version | D1 bookmark |
|---|---|---|---|
| `cf-stable-2026-10-03` | `dfb8b33` | `ea6631f7-ffc5-4041-948a-413da3b6b8fd` | `00000004-00000012-000050f9-cdfa24c76977369578f61a5db0c9cf91` (16:46Z) |

Сценарии:

1. **Плохой deploy кода** (самое частое): `npx wrangler deployments list` → `npx wrangler rollback <version-id>`
   (мгновенно, без сборки; секреты сохраняются). Затем исправить в `cloudflare-push` и выпустить новый
   `npm run deploy`. Откат живёт только на Cloudflare: Git после `rollback` не меняется, поэтому следующий
   ручной deploy из невыправленной ветки вернёт проблемный код.
2. **Откат на стабильный тег**: `git revert` проблемных коммитов в `cloudflare-push` (не force-push) →
   `npm run deploy`; либо аварийно `git checkout cf-stable-2026-10-03 && npm run deploy`.
3. **Повреждена D1** (только инфраструктура push): `npx wrangler d1 time-travel restore lexlife --bookmark=<bookmark>`
   (Free plan — 7 дней). Даже полная потеря D1 не затрагивает данные здоровья: устройство перерегистрируется,
   правила синхронизируются заново при следующем запуске приложения.
4. **Cloudflare недоступен**: GitHub Pages (резерв) открывается с тем же кодом и локальными напоминаниями
   (только пока приложение открыто); данные там — те, что были на старом адресе.

Откат Worker не трогает localStorage/IndexedDB на iPhone. Откат на версию со старым `CACHE_VERSION` браузер
воспримет как новую версию SW (байты `sw.js` другие) — это безопасно.

## GitHub Pages (legacy backup)

- Источник — workflow `.github/workflows/pages.yml`: push в `main` → `npm test` → `npm run build` → публикуется `dist/`.
  Наружу уходит только allowlist сборки (`index.html`, `manifest.json`, `build-info.json`, `sw.js`, `css`, `js`, `icons`);
  `tests/`, `docs/`, `scripts/`, `worker/`, `private/` на Pages недоступны (404). До 2026-10-05 публиковался корень
  репозитория (`build_type: legacy`), поэтому `sw.js` там был без суффикса commit, а `tests/` отдавались наружу.
- Не отключать, не делать redirect, не менять DNS, не удалять старую PWA с iPhone до отдельного решения.
- Роль `legacy`: ни одного запроса к `/api` (проверено e2e по логу сервера), плашка «Резервная версия» со ссылкой
  на основной адрес (без автоматического перехода), `notificationclick` открывает только свой origin (относительные
  маршруты `./#/…`), абсолютных ссылок на Cloudflare в коде нет, кроме `PRIMARY_URL` для плашки и экрана переноса.
- Обновление старой копии: SW v34 → v36 проверено с `Cache-Control: max-age=600` (как у Pages): данные и PDF
  сохраняются, старый кэш удаляется, офлайн работает.

## Release checklist (каждый релиз Cloudflare из `cloudflare-push`)

1. `npm test` — зелёный локально (Pages-workflow позже прогонит те же тесты на Node 22).
2. Секретов нет: `git diff origin/cloudflare-push..HEAD` без ключей/токенов/endpoint, без `private/` и бэкапов.
3. D1: `npx wrangler d1 migrations list lexlife --remote` — новых миграций нет, или применены отдельно до релиза.
4. Если менялись ассеты — поднят `CACHE_VERSION` в `sw.js`, и проверка версии в `tests/notifications.test.mjs`
   обновлена на то же число (она сверяет точное значение). Номер — следующий свободный по всем веткам и worktree
   (`git show <ветка>:sw.js`, `.claude/worktrees/*/sw.js`) и production (`/sw.js`): один номер — одна версия.
5. `git push origin cloudflare-push`, затем `npm run deploy` — деплой выполняется только этой командой.
6. `GET /api/status` → `200`, `db: ok`, `push: configured`, `build.sha` = задеплоенный commit из `cloudflare-push`.
7. SW обновился: на установленной PWA (не закрывая её) уйти в фон и вернуться — приложение один раз
   перезагружается само; «Настройки → О приложении» показывает новый `build`; переходы по экранам и повторный
   запуск — без новых перезагрузок; офлайн открывается. До выпуска: `node tests/e2e/pwa-update.e2e.mjs`
   (прежняя production-сборка → новая → ещё две, настоящий Chrome).
8. Push: «Проверить фоновый push» на iPhone приходит; число устройств/подписок в D1 не выросло.
9. Cron: `npx wrangler tail lexlife` — вызовы раз в минуту без исключений; D1 без ошибок (`d1 info`).
10. GitHub Pages: workflow «GitHub Pages (резервная копия)» зелёный; `https://adar4026.github.io/LexLife/` открывается,
    показывает «Резервная версия», к `/api` не обращается; `/tests/run-all.mjs` и `/package.json` отдают 404.
11. Записать новую стабильную точку (тег + Worker version), если релиз подтверждён на iPhone.
12. Merge `cloudflare-push` → `main` (`--no-ff`) и `git push origin main` — без повторного deploy Cloudflare;
    Pages-workflow сам опубликует `dist/` резервной копии.

## Локальная разработка

```
npm install
npm run vapid:dev          # .dev.vars с локальной парой
npm run db:migrate:local
npm run dev                # http://127.0.0.1:8787, cron: GET /__scheduled
npm test                   # все тесты (node:sqlite вместо D1, заглушка push-сервиса)
```
