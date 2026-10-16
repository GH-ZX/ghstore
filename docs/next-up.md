# Next up

Work the owner asked for, with the recommended direction. Nothing here is
fixed: confirm the plan with the owner before building, and show screenshots
(mobile and desktop, Arabic and English) before calling a UI change done.

## Done recently

- **Choose packages** (Admin → Suppliers): tick what to sell from each
  supplier, review, apply (`docs/architecture.md` → Choosing what to sell).
- **Home showcase**: Cinematic and Deal looks, per slide, with settings.
- **Units, covers and pictures**, **5SIM virtual numbers**, **per-supplier
  check schedules** (architecture → Stock, units and pictures; Virtual numbers).
- **Products delivered by hand** and **details asked after paying**
  (architecture → Orders that wait for someone), **supplier deliveries checked
  before release**, **clean names** for BatStore / ProdSeller shorthand with
  package warranties (Admin → Suppliers → Names).
- BatStore renumbered its catalogue in October 2026: the store's old BatStore
  products were removed and its in-stock items put on sale again with clean names.
- **5SIM in dollars with success rates** and "Try another number"; **APIs** in
  Admin → Settings (each supplier's and SAM's account: balances, details,
  latest movements); **sales made in person** by the owner; **product badges**
  chosen per product; Telegram full-screen safe areas; admin section icons.
- **Admin → Profit** (charts, period comparison, price calculator), **supplier
  balances** with days left on the Overview, **automatic badges** (New, Best
  seller), **pinned packages**, **USDT found by its exact amount** (no hash
  needed), a **retry limit** for "Try another number", in-person sales in the
  daily summary, and the **opening splash**.

## Live checks after the next deploy

- Migrations up to `0023_auto_badges_pinned.sql` are on the live database first.
- Open the site and the Mini App: the splash draws the logo, then the store
  opens with the balance already shown (no "Sign in" flash).
- A small USDT top-up: send the exact amount without pasting the hash; it is
  credited within a few minutes (`usdt_deposits` on the Overview's jobs).
- Admin → Profit opens for the owner; Overview shows each supplier's days left.
- Admin → Settings → APIs: each account opens and shows its balance (5SIM in dollars).
- In Telegram full screen, the header and the admin menu sit below Telegram's buttons.
- Admin → Suppliers → Names: BatStore and ProdSeller items show clean names;
  Choose packages groups them (Zoom 3 / 6 / 12 months under one product).
- A product set to "By hand" with after-payment details: buy it, give the
  details on the order page, deliver it from Admin → Orders → Waiting; the
  customer sees the delivery and gets a message.
- 5SIM: add a service (Telegram) in Choose packages and buy a cheap number:
  the number, countdown and code appear in Orders; cancel one before a code
  arrives and check the refund.
- Pictures: with the Supabase secret key in Settings → Keys → Storage, the
  `store_images` job copies linked pictures into the `store-images` bucket.

## Asked for, not started

- **Units and covers for every game**: units in both languages (UC, Diamonds,
  Genesis Crystals, CP…) and wide covers for the games still without one
  (MLBB, Genshin, Free Fire…). Show the list before changing anything live.
- **"Tell me when it's back"**: a customer asks to be told when a package that
  ran out is back (Telegram message on restock); favourites with it.
- **MaxStore**: a real $1 order before relying on it (formats not fully verified).
