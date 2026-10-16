-- A watch-only staff role. Monitors see the admin's overview, top-ups, orders
-- and customers and receive order alerts on Telegram, but cannot approve,
-- refund, retry or change anything. Set in Admin → Users.
alter table app.users drop constraint users_role_check;
alter table app.users add constraint users_role_check check (role in ('customer', 'monitor', 'support', 'owner'));
