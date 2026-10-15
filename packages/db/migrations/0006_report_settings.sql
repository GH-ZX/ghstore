-- Owner's daily summary on Telegram: on, sent at 23:00 in the store's time zone
-- (store.config.ts → timeZone). Changed in Admin → Settings.
insert into app.settings (key, value) values
  ('reports.daily', 'true'),
  ('reports.daily_hour', '23')
on conflict (key) do nothing;
