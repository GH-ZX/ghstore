-- Telegram settings, changed in Admin → Settings:
--
-- telegram.bot_username: the store bot, learned from Telegram (getMe) whenever
--   the owner taps Connect bot, so changing to a new bot needs no code change.
--   Until then the web app uses telegramBot from store.config.ts.
-- telegram.channel_url: the store's Telegram channel (https://t.me/...), shown
--   with the support contacts and in the bot's /help. Empty = none.
-- notify.new_orders: tell owners and support staff about each new order.
insert into app.settings (key, value) values
  ('telegram.bot_username', 'null'),
  ('telegram.channel_url', 'null'),
  ('notify.new_orders', 'true')
on conflict (key) do nothing;
