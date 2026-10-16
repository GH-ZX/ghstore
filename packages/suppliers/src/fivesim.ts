/**
 * 5sim — virtual phone numbers for one-time SMS verification.
 *
 * JSON at https://5sim.net/v1, `Authorization: Bearer <key>`; /guest/* routes
 * are public. Every action is a GET, including buy, cancel, finish and ban.
 *
 * Quirks worth knowing:
 * - Prices and the balance are in RUBLES. They are converted with a configured
 *   rate (the old bot's default: 1 RUB = 0.011 USD). Costs round UP and the
 *   balance rounds DOWN so the estimate never flatters the margin.
 * - /guest/prices nests `{ country: { product: { operator: { cost, count } } } }`.
 *   A product here is a (country, service) pair bought with operator "any",
 *   priced like the old bot did: the cheapest operator that has numbers.
 * - Buying answers `{ id, phone, price, status: "PENDING", expires }`; refusals
 *   are plain text such as "no free phones" or "not enough user balance".
 *   Buys have no idempotency key: a retried buy allocates a second number
 *   (an unused one is refunded by 5sim when it expires or is cancelled).
 * - /user/check/:id statuses: PENDING, RECEIVED, CANCELED, TIMEOUT, FINISHED,
 *   BANNED, with `sms: [{ code, text }]`. When a code arrives the order is
 *   finished upstream at once, as the old bot did.
 * - No callbacks.
 *
 * externalId: "<country>/<service>". supplierOrderId: the 5sim order id.
 * purchase → pending + { kind: "phone" }; checkOrder → delivered + { kind: "sms" }.
 *
 * Config: FIVESIM_API_KEY, FIVESIM_BASE_URL (default https://5sim.net/v1),
 * FIVESIM_RUB_USD_RATE (default 0.011; set 1 for a USD-priced account),
 * FIVESIM_COUNTRIES / FIVESIM_SERVICES (optional comma lists limiting the
 * catalogue; replaces the old admin toggles), FIVESIM_OPERATOR (default "any").
 */
import { AdapterError } from "../../core/src/adapters";
import type { AdapterContext, DeliveredItem, PurchaseResult, SupplierAdapter, SupplierProduct } from "../../core/src/adapters";
import {
  arr, baseUrl, caught, cfg, csv, failed, http, httpError, isObj, num, obj, refusal, str, supplierMessage,
  type HttpResult,
} from "./shared";

const ID = "fivesim";
const DEFAULT_RATE = 0.011;
const DEAD: Record<string, string> = {
  CANCELED: "the number was cancelled before an SMS arrived",
  TIMEOUT: "the number expired without receiving an SMS",
  BANNED: "the number was reported as banned",
  FINISHED: "the order was closed without an SMS",
};

export type FiveSimAdapter = SupplierAdapter & {
  /** Report the number as already used by the target service (releases it, 5sim refunds). */
  ban(supplierOrderId: string): Promise<boolean>;
};

export function createFiveSim(ctx: AdapterContext): FiveSimAdapter {
  const base = baseUrl(ctx, "FIVESIM_BASE_URL", "https://5sim.net/v1");
  const key = cfg(ctx, "FIVESIM_API_KEY");
  const secrets = key ? [key] : [];
  const configuredRate = Number(cfg(ctx, "FIVESIM_RUB_USD_RATE"));
  const rate = Number.isFinite(configuredRate) && configuredRate > 0 ? configuredRate : DEFAULT_RATE;
  const operator = cfg(ctx, "FIVESIM_OPERATOR")?.toLowerCase() ?? "any";
  const enc = encodeURIComponent;

  /** Rubles to US cents: costs round up, balances round down (epsilon absorbs float noise). */
  const costCents = (rub: number): number => Math.ceil(rub * rate * 100 - 1e-6);
  const balanceCents = (rub: number): number => Math.max(0, Math.floor(rub * rate * 100 + 1e-6));

  async function user(path: string): Promise<HttpResult> {
    if (!key) throw new AdapterError(ID, "FIVESIM_API_KEY is not configured");
    return http(ctx, ID, `${base}/user${path}`, { headers: { Authorization: `Bearer ${key}` }, secrets, timeoutMs: 10_000 });
  }

  /** cancel / ban: true when 5sim accepted, false when it refused (e.g. an SMS already arrived). */
  async function close(action: "cancel" | "ban", supplierOrderId: string): Promise<boolean> {
    const r = await user(`/${action}/${enc(supplierOrderId)}`);
    if (r.status === 401 || r.status === 429 || r.status >= 500) throw httpError(ID, r, secrets);
    return r.ok;
  }

  async function prices(): Promise<Record<string, unknown>> {
    const countries = csv(ctx, "FIVESIM_COUNTRIES");
    const urls = countries.length > 0 ? countries.map((c) => `${base}/guest/prices?country=${enc(c)}`) : [`${base}/guest/prices`];
    const merged: Record<string, unknown> = {};
    for (const url of urls) {
      const r = await http(ctx, ID, url, { secrets });
      if (!r.ok) throw httpError(ID, r, secrets);
      Object.assign(merged, obj(r.json) ?? {});
    }
    return merged;
  }

  const adapter: FiveSimAdapter = {
    id: ID,
    name: "5sim",

    async listProducts() {
      const services = new Set(csv(ctx, "FIVESIM_SERVICES"));
      const out: SupplierProduct[] = [];
      for (const [country, byService] of Object.entries(await prices())) {
        if (!isObj(byService)) continue;
        for (const [service, byOperator] of Object.entries(byService)) {
          if (!isObj(byOperator) || (services.size > 0 && !services.has(service.toLowerCase()))) continue;
          const offers = Object.entries(byOperator)
            .filter(([name, info]) => isObj(info) && (operator === "any" || name === operator))
            .map(([, info]) => ({ cost: num(obj(info)?.cost), count: num(obj(info)?.count) ?? 0 }))
            .filter((o): o is { cost: number; count: number } => o.cost !== null && o.cost >= 0);
          if (offers.length === 0) continue;
          const inStock = offers.filter((o) => o.count > 0);
          const priced = inStock.length > 0 ? inStock : offers;
          const costs = priced.map((o) => o.cost);
          out.push({
            externalId: `${country}/${service}`,
            name: `${service} (${country})`,
            costCents: costCents(Math.min(...costs)),
            available: inStock.length > 0,
            kind: "sms",
            // One store product per service (Telegram, WhatsApp...), a package per country.
            productKey: `service:${service}`,
            productName: service.charAt(0).toUpperCase() + service.slice(1),
            packageName: country.charAt(0).toUpperCase() + country.slice(1),
            meta: {
              country, service, operator,
              stock: inStock.reduce((sum, o) => sum + o.count, 0),
              maxCostCents: costCents(Math.max(...costs)),
              rubUsdRate: rate,
            },
          });
        }
      }
      return out;
    },

    async getBalance() {
      const r = await user("/profile");
      if (!r.ok) throw httpError(ID, r, secrets);
      const rub = num(obj(r.json)?.balance);
      if (rub === null) throw new AdapterError(ID, "/user/profile returned no readable balance");
      return { amountCents: balanceCents(rub), currency: "USD" };
    },

    async purchase(req) {
      try {
        const match = /^([^/]+)\/([^/]+)$/.exec(req.externalId);
        if (!match?.[1] || !match[2]) return failed(`unknown 5sim product id "${req.externalId}"`, false);
        if (req.quantity !== 1) return failed("5sim numbers are bought one at a time (quantity must be 1)", false);
        if (!key) return failed("FIVESIM_API_KEY is not configured", false);
        const r = await user(`/buy/activation/${enc(match[1])}/${enc(operator)}/${enc(match[2])}`);
        const order = obj(r.json);
        const id = str(order?.id);
        const phone = str(order?.phone);
        if (r.ok && id && phone) {
          return { status: "pending", supplierOrderId: id, items: [{ kind: "phone", value: phone }] };
        }
        const message = supplierMessage(r, secrets);
        if (/no free phones/i.test(message)) return failed("out of stock at supplier: no free numbers", false);
        if (/not enough|balance/i.test(message)) return failed(`supplier wallet balance too low: ${message}`, true);
        return r.ok ? failed(`5sim refused the purchase: ${message}`, false) : refusal(r.status, message);
      } catch (err) {
        return caught(err);
      }
    },

    async checkOrder(supplierOrderId) {
      const r = await user(`/check/${enc(supplierOrderId)}`);
      if (r.status === 404) throw new AdapterError(ID, `order ${supplierOrderId} not found at 5sim`);
      if (!r.ok) throw httpError(ID, r, secrets);
      const order = obj(r.json);
      const status = str(order?.status)?.toUpperCase() ?? "PENDING";
      const phone = str(order?.phone);
      const phoneItem: DeliveredItem[] = phone ? [{ kind: "phone", value: phone }] : [];
      const latest = obj(arr(order?.sms).filter(isObj).at(-1));
      const code = str(latest?.code);
      if (code) {
        // Close the activation upstream as soon as the code is in (best effort).
        if (status === "RECEIVED") await user(`/finish/${enc(supplierOrderId)}`).catch(() => null);
        const text = str(latest?.text);
        return { status: "delivered", supplierOrderId, items: [...phoneItem, { kind: "sms", value: code, ...(text ? { label: text } : {}) }] };
      }
      const dead = DEAD[status];
      if (dead) return failed(dead, false, supplierOrderId);
      return { status: "pending", supplierOrderId, ...(phoneItem.length ? { items: phoneItem } : {}) };
    },

    cancel: (supplierOrderId) => close("cancel", supplierOrderId),
    ban: (supplierOrderId) => close("ban", supplierOrderId),
  };
  return adapter;
}
