-- LexLife D1: ТОЛЬКО инфраструктура фоновых уведомлений.
-- Медицинских данных здесь нет и не будет: ни показателей, ни анализов,
-- ни текстов напоминаний, ни названий лекарств. Время — INTEGER, мс UTC.

-- Устройство без аккаунта: случайный UUID + хэш секретного токена.
-- Сам токен хранится только на устройстве (localStorage), сервер знает SHA-256.
CREATE TABLE devices (
  id                TEXT    PRIMARY KEY,           -- lexlife_device_id (случайный UUID v4)
  token_hash        TEXT    NOT NULL,              -- hex SHA-256 токена
  timezone          TEXT,                          -- IANA, напр. Europe/Madrid
  rules_rev         INTEGER NOT NULL DEFAULT 0,    -- версия последней принятой синхронизации
  last_sync_at      INTEGER,
  last_test_push_at INTEGER,                       -- rate limit тестового push
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

-- Web Push подписка. endpoint — идентификатор устройства у push-сервиса:
-- не выводится в UI, логи и ответы API. Одна активная подписка на устройство.
CREATE TABLE push_subscriptions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id       TEXT    NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  endpoint        TEXT    NOT NULL UNIQUE,
  p256dh          TEXT    NOT NULL,
  auth            TEXT    NOT NULL,
  active          INTEGER NOT NULL DEFAULT 1,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  last_success_at INTEGER,
  last_failure_at INTEGER,
  failure_count   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_push_subscriptions_device ON push_subscriptions(device_id, active);

-- Зеркало расписания правил (без текста напоминания).
-- Повторяющееся правило хранит локальное время + timezone; next_fire_at (UTC)
-- после каждого срабатывания вычисляется заново из локального времени.
CREATE TABLE notification_rules (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id        TEXT    NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  client_rule_id   TEXT    NOT NULL,                -- id правила в localStorage устройства
  type             TEXT    NOT NULL,                -- meds | water | pressure | weight | tests | visits
  enabled          INTEGER NOT NULL DEFAULT 1,
  schedule_type    TEXT    NOT NULL,                -- daily | weekdays | weekly | interval | once
  local_time       TEXT,                            -- ЧЧ:ММ (daily/weekdays/weekly/once)
  days_of_week     TEXT,                            -- weekly: «1,3,5» (0 = вс)
  interval_minutes INTEGER,                         -- interval
  window_start     TEXT,                            -- interval: начало окна ЧЧ:ММ
  window_end       TEXT,                            -- interval: конец окна (может быть через полночь)
  once_date        TEXT,                            -- once: ГГГГ-ММ-ДД (локальная дата)
  timezone         TEXT    NOT NULL,
  next_fire_at     INTEGER,                         -- NULL — не запланировано
  fire_at          INTEGER,                         -- once: вычисленный момент
  completed_at     INTEGER,                         -- once: когда сработало
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  UNIQUE (device_id, client_rule_id)
);
CREATE INDEX idx_notification_rules_device ON notification_rules(device_id);
-- Выборка due cron'ом каждую минуту: частичный индекс только по активным правилам
CREATE INDEX idx_notification_rules_due ON notification_rules(next_fire_at)
  WHERE enabled = 1 AND next_fire_at IS NOT NULL;

-- Одно срабатывание = одна строка. UNIQUE (rule_id, scheduled_fire_at) —
-- атомарный claim: второй cron/повтор не сможет вставить ту же occurrence.
CREATE TABLE notification_deliveries (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_id           INTEGER NOT NULL REFERENCES notification_rules(id) ON DELETE CASCADE,
  scheduled_fire_at INTEGER NOT NULL,
  occurrence_id     TEXT    NOT NULL,              -- <client_rule_id>@<локальное время>
  status            TEXT    NOT NULL,              -- claimed | sent | retry | failed | skipped | unknown | expired
  attempts          INTEGER NOT NULL DEFAULT 0,
  next_attempt_at   INTEGER,
  created_at        INTEGER NOT NULL,
  sent_at           INTEGER,
  error_code        TEXT,
  UNIQUE (rule_id, scheduled_fire_at)
);
CREATE INDEX idx_notification_deliveries_retry ON notification_deliveries(next_attempt_at)
  WHERE status = 'retry';
CREATE INDEX idx_notification_deliveries_status_created ON notification_deliveries(status, created_at);
