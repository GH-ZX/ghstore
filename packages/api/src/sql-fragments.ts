/**
 * SQL conditions the shop, the SEO pages, the channel and favourites must
 * agree on, written once. Each expects the offer as alias `o` (and, for
 * SOLD_OUT, its product as `p`), and is parenthesised so it can be dropped
 * into any `where`/`on` clause or negated with `not`.
 */

/** The offer's supplier, if it has one, is switched on in Admin → Suppliers. */
export const SUPPLIER_ON = `(o.supplier_id is null or exists (select 1 from app.suppliers s where s.id = o.supplier_id and s.enabled))`;

/** A package on sale: active, not paused, and its supplier (if any) switched on. */
export const ON_SALE = `(o.active and o.paused_reason is null
  and ${SUPPLIER_ON})`;

/** A package shown on its product page: on sale, or sold out at the supplier (customers can ask to be told when it is back). */
export const LISTED = `(o.active and (o.paused_reason is null or o.paused_reason = 'supplier_unavailable')
  and ${SUPPLIER_ON})`;

/** This offer cannot be bought right now for lack of stock (its supplier has none, or the store's own codes ran out). */
export const SOLD_OUT = `(coalesce(o.paused_reason = 'supplier_unavailable', false)
  or (o.supplier_id is null and p.delivery = 'auto'
      and not exists (select 1 from app.stock_items s where s.offer_id = o.id and s.status = 'available')))`;
