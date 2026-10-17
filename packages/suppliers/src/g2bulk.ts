/**
 * G2Bulk — game top-ups straight to a player ID, and voucher codes.
 *
 * JSON over HTTPS at https://api.g2bulk.com/v1. The key travels in `X-API-Key`;
 * catalogue routes (/games, /games/:code/catalogue, /games/fields,
 * /games/servers, /games/checkPlayerId, /products) are public.
 *
 * Quirks worth knowing:
 * - Repeated 401s earn a PERMANENT IP ban, so auth failures are never retryable.
 * - Purchases take `X-Idempotency-Key`, exactly 36 characters, honoured for
 *   30 minutes. A key of another length is mapped through uuid5(NAMESPACE_DNS)
 *   exactly as the old bot did, so a retry replays the original order.
 * - Top-ups: POST /games/:code/order → PENDING → PROCESSING → COMPLETED | FAILED
 *   (FAILED is refunded by G2Bulk). State is read from the documented, paginated
 *   GET /games/orders list; statuses come upper- or lowercase.
 * - Vouchers: POST /products/:id/purchase answers COMPLETED with
 *   `delivery_items`, or PENDING; GET /orders/:id/delivery then answers
 *   200 ready / 202 processing / 410 failed+refunded / 404 not ours.
 * - POST /games/servers answers 403 when a game needs no server (not an error).
 * - Callback (top-ups only): POST {order_id, status, remark, ...} to the
 *   `callback_url` given at order time, retried once, authenticated by our
 *   `?token=` secret. It is treated as a wake-up: the order is re-read here.
 *
 * - The catalogue is hundreds of games, each with its own catalogue, fields
 *   and servers requests: far more than the 50 requests one Worker invocation
 *   may make on the free plan. So the admin lists it a game at a time
 *   (listGroups, then listProducts(group)), and the sync reads only the
 *   catalogues of games the store sells (listProductsFor), a few per run.
 *
 * externalId: "game:<code>:<catalogue name>" | "voucher:<product id>".
 * In the store: one product per game (its catalogue entries are the packages),
 * one per voucher brand (G2Bulk's category).
 * supplierOrderId: "g2b-game-<id>" | "g2b-vouch-<id>" (the refs the old bot stored).
 *
 * Config: G2BULK_API_KEY, G2BULK_BASE_URL (default https://api.g2bulk.com/v1),
 * G2BULK_WEBHOOK_SECRET (falls back to SUPPLIER_WEBHOOK_SECRET),
 * G2BULK_CALLBACK_URL (optional; our webhook URL, the secret is appended as
 * `token`), G2BULK_GAME_CODES (optional comma list limiting which games sync).
 */
import { AdapterError } from "../../core/src/adapters";
import type {
  AdapterContext, DeliveredItem, PurchaseRequest, PurchaseResult, SupplierAdapter, SupplierProduct,
} from "../../core/src/adapters";
import { CHARNAME_KEYS, g2bulkInputFields, PLAYER_KEYS, SERVER_KEYS } from "./g2bulk-fields";
import {
  accountFacts, arr, baseUrl, caught, cfg, csv, deliveryValues, failed, http, httpError, isObj, isTransient, itemsFrom, mapLimit, num, obj, pick, refusal, str, supplierMessage, usdCostToCents, usdToCents, uuid5, wakeUpWebhook, webhookSecret, type HttpOptions, type HttpResult,
} from "./shared";

const ID = "g2bulk";
const GAME = "g2b-game-";
const VOUCHER = "g2b-vouch-";
const STATUS_PAGES = 10;
const VOUCHERS = "vouchers";

function classify(status: unknown): "completed" | "failed" | "pending" {
  const s = typeof status === "string" ? status.trim().toLowerCase() : "";
  if (s === "completed" || s === "success") return "completed";
  if (s === "failed" || s === "cancelled" || s === "canceled" || s === "refunded") return "failed";
  return "pending";
}

function parseExternalId(id: string): { type: "game"; code: string; item: string } | { type: "voucher"; id: string } | null {
  const game = /^game:([^:]+):(.+)$/.exec(id);
  if (game?.[1] && game[2]) return { type: "game", code: game[1], item: game[2] };
  const voucher = /^voucher:(\d+)$/.exec(id);
  return voucher?.[1] ? { type: "voucher", id: voucher[1] } : null;
}

export function createG2Bulk(ctx: AdapterContext): SupplierAdapter {
  const base = baseUrl(ctx, "G2BULK_BASE_URL", "https://api.g2bulk.com/v1");
  const origin = new URL(base).origin;
  const key = cfg(ctx, "G2BULK_API_KEY");
  // The callback secret too: an error echoing our callback_url must not carry it into logs or order notes.
  const secrets = [key, webhookSecret(ctx, "G2BULK_WEBHOOK_SECRET")].filter((s): s is string => Boolean(s));
  const enc = encodeURIComponent;

  async function call(path: string, opts: HttpOptions & { auth?: boolean } = {}): Promise<HttpResult> {
    const headers: Record<string, string> = { ...opts.headers };
    if (opts.auth) {
      if (!key) throw new AdapterError(ID, "G2BULK_API_KEY is not configured");
      headers["X-API-Key"] = key;
    }
    return http(ctx, ID, base + path, { ...opts, headers, secrets });
  }

  async function read(path: string, auth = false): Promise<unknown> {
    const r = await call(path, { auth });
    if (!r.ok) throw httpError(ID, r, secrets);
    return r.json;
  }

  const image = (value: unknown): string | null => {
    const s = str(value);
    return !s ? null : /^https?:\/\//i.test(s) ? s : `${origin}${s.startsWith("/") ? "" : "/"}${s}`;
  };

  /** Field keys for a game. Transient failures abort the sync; a 4xx means "just a user id" (old bot rule). */
  async function gameFields(code: string): Promise<string[]> {
    const r = await call("/games/fields", { method: "POST", body: { game: code } });
    if (isTransient(r)) throw httpError(ID, r, secrets);
    const fields = arr(obj(obj(r.json)?.info)?.fields).filter((f): f is string => typeof f === "string");
    return r.ok && fields.length > 0 ? fields : ["userid"];
  }

  async function gameServers(code: string): Promise<Record<string, string> | null> {
    const r = await call("/games/servers", { method: "POST", body: { game: code } });
    if (isTransient(r)) throw httpError(ID, r, secrets);
    const servers = obj(r.json)?.servers;
    if (!r.ok || !servers) return null; // 403 = this game needs no server
    if (Array.isArray(servers)) return Object.fromEntries(servers.filter((s) => typeof s === "string").map((s) => [s, s]));
    return isObj(servers) ? Object.fromEntries(Object.entries(servers).map(([k, v]) => [k, String(v)])) : null;
  }

  async function topUpProducts(game: Record<string, unknown>): Promise<SupplierProduct[]> {
    const code = str(game.code) ?? "";
    const gameName = str(game.name) ?? code;
    const catalogue = await read(`/games/${enc(code)}/catalogue`).catch((err) => {
      if (err instanceof AdapterError && err.retryable) return read(`/games/${enc(code)}/catalogue`);
      throw err;
    });
    const items = arr(obj(catalogue)?.catalogues).filter(isObj);
    if (items.length === 0) return [];
    const rawKeys = await gameFields(code);
    const baseFields = g2bulkInputFields(rawKeys);
    const servers = baseFields.some((f) => f.key === "server_id") ? await gameServers(code) : null;
    // A server list ({label: value}, as the old bot read it) becomes a choice for a real
    // "server" field, so customers pick instead of typing. A zone id stays typed.
    const serverChoice = rawKeys.some((k) => ["serverid", "server_id", "server"].includes(k.trim().toLowerCase()));
    const entries = servers ? Object.entries(servers) : [];
    const fields = serverChoice && entries.length > 0 && entries.length <= 50
      ? baseFields.map((f) => f.key === "server_id"
        ? { ...f, options: entries.map(([label, value]) => ({ value, labelEn: label, labelAr: label })) }
        : f)
      : baseFields;
    return items.flatMap((item): SupplierProduct[] => {
      const name = str(item.name);
      const cost = usdCostToCents(item.amount);
      if (!name || cost === null) return [];
      return [{
        externalId: `game:${code}:${name}`,
        name: `${gameName} — ${name}`,
        costCents: cost,
        available: true,
        kind: "id",
        fields,
        // One store product per game, its catalogue entries as the packages.
        productKey: `game:${code}`,
        productName: gameName,
        packageName: name,
        meta: { type: "topup", game: code, gameName, catalogueId: item.id ?? null, image: image(game.image_url), servers },
      }];
    });
  }

  async function allGames(): Promise<Record<string, unknown>[]> {
    const only = new Set(csv(ctx, "G2BULK_GAME_CODES"));
    return arr(obj(await read("/games"))?.games)
      .filter(isObj)
      .filter((g) => !!str(g.code) && (only.size === 0 || only.has((str(g.code) ?? "").toLowerCase())));
  }

  /** Every voucher and gift card, in one request. */
  async function vouchers(): Promise<SupplierProduct[]> {
    return arr(obj(await read("/products"))?.products).filter(isObj).flatMap((p): SupplierProduct[] => {
      const id = str(p.id);
      const title = str(p.title);
      const cost = usdCostToCents(p.unit_price);
      if (!id || !title || cost === null) return [];
      const stock = num(p.stock);
      return [{
        externalId: `voucher:${id}`,
        name: title,
        costCents: cost,
        available: (stock ?? 0) > 0,
        kind: "code",
        // Gift cards of one brand (G2Bulk's category) are one product.
        ...(str(p.category_title)
          ? { productKey: `voucher:${str(p.category_id) ?? str(p.category_title)}`, productName: str(p.category_title), packageName: title }
          : {}),
        meta: {
          type: "voucher", categoryId: p.category_id ?? null, category: str(p.category_title) ?? null,
          faceValue: p.face_value ?? null, stock, image: image(p.image_url), description: str(p.description) ?? null,
        },
      }];
    });
  }

  /**
   * Prices of one game's top-ups for the sync: just the catalogue (one request),
   * without the input fields and servers an import needs. A game G2Bulk no
   * longer lists (404) has nothing for sale; an outage aborts the sync.
   */
  async function prices(code: string): Promise<SupplierProduct[]> {
    const r = await call(`/games/${enc(code)}/catalogue`);
    if (r.status === 404) return [];
    if (!r.ok) throw httpError(ID, r, secrets);
    return arr(obj(r.json)?.catalogues).filter(isObj).flatMap((item): SupplierProduct[] => {
      const name = str(item.name);
      const cost = usdCostToCents(item.amount);
      if (!name || cost === null) return [];
      return [{ externalId: `game:${code}:${name}`, name, costCents: cost, available: true, kind: "id" }];
    });
  }

  function topUpResult(supplierOrderId: string, status: unknown, playerId: string | undefined, playerName: string | undefined, price: unknown): PurchaseResult {
    const state = classify(status);
    if (state === "failed") return failed("G2Bulk could not complete the top-up (refunded by G2Bulk)", false, supplierOrderId);
    if (state === "pending") return { status: "pending", supplierOrderId };
    const items: DeliveredItem[] = playerId
      ? [{ kind: "id", value: playerId, ...(playerName ? { label: playerName } : {}) }]
      : [];
    const cost = usdCostToCents(price);
    return { status: "delivered", supplierOrderId, items, ...(cost !== null ? { costCents: cost } : {}) };
  }

  function voucherResult(supplierOrderId: string, status: unknown, deliveryItems: unknown): PurchaseResult {
    const codes = deliveryValues(deliveryItems);
    if (codes.length > 0) return { status: "delivered", supplierOrderId, items: itemsFrom(codes, "code") };
    if (classify(status) === "failed") return failed("G2Bulk could not deliver the voucher (refunded by G2Bulk)", false, supplierOrderId);
    return { status: "pending", supplierOrderId };
  }

  /** 409 or any stock wording means out of stock (old bot rule); the rest is generic. */
  function orderRefusal(r: HttpResult): PurchaseResult {
    const message = supplierMessage(r, secrets);
    return r.status === 409 ? failed(`out of stock at supplier: ${message}`, false) : refusal(r.status, message);
  }

  function callbackUrl(): string | undefined {
    const raw = cfg(ctx, "G2BULK_CALLBACK_URL");
    if (!raw || !URL.canParse(raw)) return undefined;
    const url = new URL(raw);
    const secret = webhookSecret(ctx, "G2BULK_WEBHOOK_SECRET");
    if (secret && !url.searchParams.has("token")) url.searchParams.set("token", secret);
    return url.toString();
  }

  async function topUp(code: string, catalogueName: string, req: PurchaseRequest, idem: string): Promise<PurchaseResult> {
    if (req.quantity !== 1) return failed("G2Bulk top-ups are bought one at a time (quantity must be 1)", false);
    const playerId = pick(req.fields, ...PLAYER_KEYS);
    const serverId = pick(req.fields, ...SERVER_KEYS);
    const charname = pick(req.fields, ...CHARNAME_KEYS);
    if (!playerId) return failed("a player ID is required for this top-up", false);
    const player = { ...(serverId ? { server_id: serverId } : {}), ...(charname ? { charname } : {}) };

    // Validate the player before spending anything. An outage here is not proof
    // the ID is wrong, so only a definite answer can stop the order.
    const check = await call("/games/checkPlayerId", { method: "POST", body: { game: code, user_id: playerId, ...player } }).catch(() => null);
    if (check?.ok) {
      const c = obj(check.json);
      if (str(c?.valid)?.toLowerCase() !== "valid" && !str(c?.name)) {
        return failed("the game rejected this player ID", false);
      }
    }

    const callback = callbackUrl();
    const r = await call(`/games/${enc(code)}/order`, {
      method: "POST",
      auth: true,
      headers: { "X-Idempotency-Key": idem },
      body: { catalogue_name: catalogueName, player_id: playerId, ...player, remark: req.idempotencyKey, ...(callback ? { callback_url: callback } : {}) },
    });
    if (!r.ok) return orderRefusal(r);
    const body = obj(r.json);
    if (body?.success === false) return refusal(400, supplierMessage(r, secrets));
    const order = obj(body?.order);
    const orderId = str(order?.order_id) ?? str(body?.order_id);
    if (!orderId) return failed("G2Bulk answered without an order id; supplier state unknown", true);
    return topUpResult(GAME + orderId, order?.status ?? "PENDING", playerId, str(order?.player_name), order?.price);
  }

  async function buyVoucher(productId: string, req: PurchaseRequest, idem: string): Promise<PurchaseResult> {
    const r = await call(`/products/${enc(productId)}/purchase`, {
      method: "POST",
      auth: true,
      headers: { "X-Idempotency-Key": idem },
      body: { quantity: Math.max(1, Math.floor(req.quantity)) },
    });
    if (!r.ok) return orderRefusal(r);
    const body = obj(r.json);
    if (body?.success === false) return refusal(400, supplierMessage(r, secrets));
    const orderId = str(body?.order_id);
    if (!orderId) return failed("G2Bulk answered without an order id; supplier state unknown", true);
    return voucherResult(VOUCHER + orderId, body?.status, body?.delivery_items);
  }

  const adapter: SupplierAdapter = {
    id: ID,
    name: "G2Bulk",

    // The full catalogue is hundreds of games, each needing its own requests: far
    // more than one Worker invocation may make. So the admin lists one group at a
    // time (a game, or the vouchers), and the sync reads only the games the store sells.
    async listGroups() {
      const games = await allGames();
      return [
        { id: VOUCHERS, name: "Vouchers & gift cards" },
        ...games.map((g) => ({ id: `game:${str(g.code)}`, name: str(g.name) ?? str(g.code) ?? "", image: image(g.image_url) })),
      ];
    },

    async listProducts(group) {
      if (group?.startsWith("game:")) {
        const code = group.slice(5);
        const game = (await allGames()).find((g) => str(g.code) === code);
        return game ? topUpProducts(game) : [];
      }
      // No group: the vouchers (one request). Games are listed one at a time.
      return vouchers();
    },

    async listProductsFor(externalIds) {
      const codes = new Set<string>();
      let wantVouchers = false;
      for (const id of externalIds) {
        const ref = parseExternalId(id);
        if (ref?.type === "game") codes.add(ref.code);
        else if (ref?.type === "voucher") wantVouchers = true;
      }
      const games = await mapLimit([...codes], 6, async (code) => prices(code));
      return [...games.flat(), ...(wantVouchers ? await vouchers() : [])];
    },

    syncGroup(externalId) {
      const ref = parseExternalId(externalId);
      return ref?.type === "game" ? `game:${ref.code}` : VOUCHERS;
    },

    async accountInfo() {
      const me = obj(await read("/getMe", true));
      const balance = num(me?.balance);
      return { fields: accountFacts(me, ["balance"]), balances: balance === null ? [] : [{ currency: "USD", amount: balance }], history: [] };
    },

    async getBalance() {
      const balance = usdToCents(obj(await read("/getMe", true))?.balance);
      if (balance === null) throw new AdapterError(ID, "/getMe returned no readable balance");
      return { amountCents: balance, currency: "USD" };
    },

    async purchase(req) {
      try {
        const ref = parseExternalId(req.externalId);
        if (!ref) return failed(`unknown G2Bulk product id "${req.externalId}"`, false);
        if (!key) return failed("G2BULK_API_KEY is not configured", false);
        const idem = req.idempotencyKey.length === 36 ? req.idempotencyKey : await uuid5(req.idempotencyKey);
        return ref.type === "game" ? await topUp(ref.code, ref.item, req, idem) : await buyVoucher(ref.id, req, idem);
      } catch (err) {
        return caught(err);
      }
    },

    async checkOrder(supplierOrderId) {
      if (supplierOrderId.startsWith(VOUCHER)) {
        const r = await call(`/orders/${enc(supplierOrderId.slice(VOUCHER.length))}/delivery`, { auth: true });
        if (r.status === 202) return { status: "pending", supplierOrderId };
        if (r.status === 410) return failed("G2Bulk failed the voucher order and refunded it", false, supplierOrderId);
        if (r.status === 404) throw new AdapterError(ID, `order ${supplierOrderId} not found at G2Bulk`);
        if (!r.ok) throw httpError(ID, r, secrets);
        return voucherResult(supplierOrderId, obj(r.json)?.status, obj(r.json)?.delivery_items);
      }
      if (supplierOrderId.startsWith(GAME)) {
        const wanted = supplierOrderId.slice(GAME.length);
        let pages = 1;
        for (let page = 1; page <= Math.min(pages, STATUS_PAGES); page += 1) {
          const json = obj(await read(`/games/orders?page=${page}&limit=100`, true));
          const orders = arr(json?.orders).filter(isObj);
          const hit = orders.find((o) => str(o.order_id) === wanted);
          if (hit) {
            const status = hit.is_refunded === true ? "refunded" : hit.status;
            return topUpResult(supplierOrderId, status, str(hit.player_id), str(hit.player_name), hit.price);
          }
          const total = num(obj(json?.pagination)?.total_pages);
          pages = total && total > 0 ? total : orders.length < 100 ? page : page + 1;
        }
        return { status: "pending", supplierOrderId };
      }
      throw new AdapterError(ID, `unrecognised supplier order id "${supplierOrderId}"`);
    },

    async parseWebhook(req) {
      return wakeUpWebhook(req, {
        secret: webhookSecret(ctx, "G2BULK_WEBHOOK_SECRET"),
        // G2Bulk only calls back for top-ups (callback_url is a top-up field).
        orderRef: (body) => {
          const id = str(body.order_id);
          return id ? GAME + id : null;
        },
        check: (id) => adapter.checkOrder(id),
      });
    },
  };
  return adapter;
}
