-- Manual USDT top-ups: the exact amount the customer sends, in ten-thousandths of
-- a dollar (2.0137 USDT → 20137). It is the requested amount plus a small tag
-- (0.0100 to 0.0199), unique among open requests, so a transfer matches the one
-- request it was sent for. The request itself (amount_cents) is what is credited.
--
-- The old uniqueness on amount_cents (requested + 1 to 99 cents) goes: two open
-- requests may now ask for the same $2.00, told apart by what they send.
alter table app.payments
  add column if not exists send_units bigint check (send_units is null or send_units > 0);

drop index if exists app.payments_bep20_open_amount_idx;
create unique index if not exists payments_bep20_open_send_idx on app.payments (send_units)
  where method = 'bep20' and status in ('created', 'pending', 'review') and send_units is not null;
