-- LexLife D1: диагностика доставки push (2026-10-06).
-- Только ADD COLUMN / CREATE INDEX: существующие строки не меняются,
-- старый код Worker'а новые колонки просто не читает (миграция безопасна
-- до и после deploy).

-- Подтверждение показа от Service Worker'а: сервер знает не только, что
-- push-сервис принял сообщение (sent_at), но и когда iPhone его показал.
-- ack_key — случайный ключ этой доставки, он есть только в зашифрованном
-- payload; позволяет лишь отметить показ этой одной строки.
ALTER TABLE notification_deliveries ADD COLUMN ack_key  TEXT;
ALTER TABLE notification_deliveries ADD COLUMN shown_at INTEGER; -- время устройства при показе (мс UTC)
ALTER TABLE notification_deliveries ADD COLUMN acked_at INTEGER; -- время сервера, когда пришло подтверждение
CREATE INDEX idx_notification_deliveries_occurrence ON notification_deliveries(occurrence_id);

-- Последнее подтверждённое получение push этой подпиской
ALTER TABLE push_subscriptions ADD COLUMN last_ack_at INTEGER;

-- Последний запуск приложения на устройстве (GET /api/push/status при старте).
-- Вместе с last_ack_at отличает живую установку от удалённой с экрана «Домой»:
-- Apple продолжает отвечать 201 на подписку удалённого PWA.
ALTER TABLE devices ADD COLUMN last_seen_at INTEGER;
