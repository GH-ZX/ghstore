# Next up

Work the owner asked for, with the recommended direction. Nothing here is
fixed: confirm the plan with the owner before building, and show screenshots
(mobile and desktop, Arabic and English) before calling a UI change done.

## Done: choosing what to sell, and the home showcase

- **Admin → Suppliers → Choose packages** replaced the old "Import from
  supplier" sheet (see `docs/architecture.md` → Choosing what to sell). Each
  supplier groups its items its own way (G2Bulk per game, MaxStore per
  category, 5SIM per service, BatStore and ProdSeller one product per item).
  New products show at once, with the supplier's description template
  (Suppliers → Settings → New products) and the store's picture template
  (`Tile` in `ui/kit.tsx`) until they get a picture of their own.
- **The home showcase** (`ui/Showcase.tsx`) replaced the carousel: two looks,
  Cinematic (a poster: a cover photo fills the slide, an icon becomes a card
  over its blurred colours) and Deal (small glass buttons with the product's
  packages). Each slide picks its look or follows the default; badges,
  autoplay and packages per Deal slide are settings (Admin → Home → Showcase,
  `home.*` in app.settings). Admin → Home previews with the same component.

## Live checks after the next deploy

- Migration `0018_supplier_catalogue.sql` is on the live database first.
- Admin → Suppliers → Choose packages, for each enabled supplier: the list
  loads (G2Bulk: the games; opening one reads it), counts match what the store
  sells, and the `supplier_catalogue` job fills the rest over a few hours
  without errors in Admin → Overview.
- Apply a small change (one package added and removed again) and check the
  product, its price and its description in the store.
- Each enabled supplier's "last check" updates and its report has no errors.
- BatStore renumbered its catalogue: its paused packages show as "gone" in
  Choose packages; point each at its new item with "Replace with…", or untick
  them and tick the new items.

## Ideas not started

- Uploading slide and product pictures instead of pasting a link (needs a
  storage bucket in the gh-store Supabase project: ask the owner first).
- A name override per new product in the review step (today: edit it in
  Catalogue afterwards).
