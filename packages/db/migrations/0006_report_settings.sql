-- Owner's daily summary on Telegram: on, sent around 09:00 in the store's time
-- zone (store.config.ts → timeZone) about the day before. Admin → Settings.
insert into app.settings (key, value) values
  ('reports.daily', 'true'),
  ('reports.daily_hour', '9')
on conflict (key) do nothing;
