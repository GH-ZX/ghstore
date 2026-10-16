# Next up

Work the owner asked for, with the recommended direction. Nothing here is
fixed: confirm the plan with the owner before building, and show screenshots
(mobile and desktop, Arabic and English) before calling a UI change done.

## 1. Choosing what to sell from each supplier (rethink the "Import" sheet)

**What the owner wants.** Today's "Import from supplier" sheet in Admin →
Catalogue adds one package at a time and is confusing. The owner wants a list
of everything a supplier offers where they tick what the store should sell,
with "select all" / "deselect all" per supplier, and where applying also
removes what was unticked. It must be solid, and must work the same for every
supplier, including ones added later.

**Recommended design.**

- *Screen:* Admin → Suppliers → a supplier → **Choose packages** (also
  reachable from Catalogue). Supplier tabs at the top. On big catalogues
  (G2Bulk) a list of groups (games) with "3 of 12 chosen" counts, then the
  group's items. Each item: tick box, name, supplier cost, the store price it
  would get, and a status (new, on sale, gone at supplier, cost changed).
  Search; filters (all, chosen, not chosen, new, gone); select all / deselect
  all for the supplier and for a group, acting on what the filter shows.
  A bar at the bottom: "+5 to add · −3 to remove · Review".
- *Review step:* lists exactly what will change, and where each new package
  goes (by default: one product per supplier group, in a category the owner
  picks, priced with the supplier's import defaults; the owner can change the
  product per group). Then **Apply**.
- *Removing:* an unticked package that was never ordered is deleted; one with
  orders is archived (hidden, kept for order history and refunds). A product
  left with no packages is hidden. The review step says which is which.
- *Server:* a cached copy of each supplier's catalogue in the database
  (e.g. `app.supplier_items`: supplier, external id, group, name, cost,
  available, first/last seen, missing since), filled group by group by a job
  inside the request budget (see CLAUDE.md) and on "Refresh list". The screen
  reads the cache, so it is fast and never hits the 50-request limit.
  `POST /api/admin/suppliers/:id/selection` with a dry-run mode that returns
  the diff, then the real run: one transaction, every item checked against the
  cache, refuses a stale view (send the version the screen loaded), audit
  logged, owner only, batch-size limit. Tests for add, remove, archive,
  stale view, a second supplier, and an unknown item.
- *Generic:* only the `SupplierAdapter` contract (`listGroups`,
  `listProducts`, `listProductsFor`) feeds it, so a new supplier works with
  no new screen code. The current "Replace a missing package" (relink) moves
  into this screen for items marked "gone".

## 2. The home carousel

The owner does not like the current carousel (Admin → Home, `Store.tsx`).
Ask what they dislike, and show two or three directions as screenshots before
building. Directions worth offering: picture-first slides at a fixed shape
(the picture is the slide, text optional), the next slide peeking on phones,
uploading pictures instead of pasting a link (needs a storage bucket — ask
first), and a better look when there are no slides. Keep the admin's live
preview matching the store exactly.

## 3. Live checks after the next deploy

- Admin → Suppliers: each enabled supplier's "last check" updates and its
  report has no errors; G2Bulk finishes a full pass over a few runs.
- BatStore is switched off with its packages paused because the supplier
  renumbered its catalogue: re-point them (relink, or item 1 above), then
  switch it on.
