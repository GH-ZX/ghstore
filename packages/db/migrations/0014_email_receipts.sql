-- Email receipts (Admin → Settings → Email receipts): order delivered, order
-- refunded and balance added also go to the customer's linked email, as their
-- own outbox rows (channel 'email') so a Telegram retry never resends an email.
--
-- email.receipts: on/off. email.from: the sender, e.g. "GH Store <orders@gh-store.me>",
-- on a domain verified in Resend. Nothing is sent until both and RESEND_API_KEY are set.
alter table app.outbox drop constraint outbox_channel_check;
alter table app.outbox add constraint outbox_channel_check check (channel in ('telegram', 'email'));

insert into app.settings (key, value) values ('email.receipts', 'true'), ('email.from', 'null')
on conflict (key) do nothing;
