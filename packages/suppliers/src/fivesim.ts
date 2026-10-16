/**
 * 5sim — virtual phone numbers for one-time SMS verification ("activation").
 *
 * JSON at https://5sim.net/v1, `Authorization: Bearer <key>`; /guest/* routes
 * are public. Every action is a GET, including buy, cancel, finish and ban.
 *
 * In the store: one product per service (Telegram, WhatsApp, Google...), one
 * package per country ("🇺🇸 United States" / "🇺🇸 الولايات المتحدة"). The
 * customer buys a number, sees it with a countdown, and gets the code in the
 * order as soon as it arrives; before a code arrives they can cancel the
 * number or report it as already used, and are refunded (5sim charges nothing
 * for a number that never received an SMS).
 *
 * Quirks worth knowing:
 * - Prices and the balance are in RUBLES. They are converted with a configured
 *   rate (default 1 RUB = 0.011 USD). Costs round UP and the balance rounds
 *   DOWN so the estimate never flatters the margin.
 * - The full price list (/guest/prices) is several megabytes: far too much for
 *   one Worker run. So the catalogue is listed a service at a time
 *   (listGroups from /guest/products/any/any, then /guest/prices?product=X),
 *   and the sync reads only the services the store sells, a few per run.
 * - /guest/prices nests `{ country: { product: { operator: { cost, count } } } }`,
 *   or `{ product: { country: { operator: ... } } }` when asked per product.
 *   A package is a (country, service) pair bought with operator "any", priced
 *   at the cheapest operator that has numbers; the buy passes that price as
 *   `maxPrice`, so 5sim never charges more than the store priced.
 * - /guest/countries gives each country's ISO code (for flags and the Arabic name).
 * - Buying answers `{ id, phone, price, status: "PENDING", expires }` (about 15
 *   minutes later); refusals are plain text: "no free phones", "not enough user
 *   balance", "not enough rating", "bad country", "no product", "server offline".
 *   Buys have no idempotency key: a retried buy allocates a second number
 *   (an unused one costs nothing: 5sim refunds it when it expires).
 * - /user/check/:id statuses: PENDING, RECEIVED, CANCELED, TIMEOUT, FINISHED,
 *   BANNED, with `sms: [{ code, text }]`. When a code arrives the order is
 *   finished upstream at once. Cancel and ban are refused once an SMS arrived
 *   ("order has sms") or the order ended ("order expired").
 * - No callbacks.
 *
 * externalId: "<country>/<service>". supplierOrderId: the 5sim order id.
 * purchase → pending + { kind: "phone" }; checkOrder → delivered + { kind: "sms" }.
 *
 * Config: FIVESIM_API_KEY, FIVESIM_BASE_URL (default https://5sim.net/v1),
 * FIVESIM_RUB_USD_RATE (default 0.011; set 1 for a USD-priced account),
 * FIVESIM_COUNTRIES / FIVESIM_SERVICES (optional comma lists limiting the
 * catalogue), FIVESIM_OPERATOR (default "any").
 */
import { AdapterError } from "../../core/src/adapters";
import type { AdapterContext, DeliveredItem, PurchaseResult, SupplierAdapter, SupplierGroup, SupplierProduct } from "../../core/src/adapters";
import {
  arr, baseUrl, caught, cfg, csv, failed, http, httpError, isObj, mapLimit, num, obj, refusal, str, supplierMessage,
  type HttpResult,
} from "./shared";

const ID = "fivesim";
const DEFAULT_RATE = 0.011;
const SERVICE = "service:";
const DEAD: Record<string, string> = {
  CANCELED: "the number was cancelled before an SMS arrived",
  TIMEOUT: "the number expired without receiving an SMS",
  BANNED: "the number was reported as banned",
  FINISHED: "the order was closed without an SMS",
};

/** Brand spellings 5sim writes in lower case. */
const BRANDS: Record<string, string> = {
  whatsapp: "WhatsApp", tiktok: "TikTok", openai: "OpenAI", linkedin: "LinkedIn", paypal: "PayPal", youtube: "YouTube",
  wechat: "WeChat", vkontakte: "VK", vk: "VK", ebay: "eBay", onlyfans: "OnlyFans", imo: "imo", okcupid: "OkCupid",
  icq: "ICQ", aol: "AOL", kfc: "KFC", bigolive: "Bigo Live", mailru: "Mail.ru", yandex: "Yandex", x: "X",
};

export function serviceName(service: string): string {
  const s = service.toLowerCase();
  return BRANDS[s] ?? s.split(/[_\s-]+/).filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

/** 🇺🇸 from "us". */
function flag(iso: string | null): string {
  if (!iso || !/^[a-z]{2}$/i.test(iso)) return "";
  return String.fromCodePoint(...[...iso.toUpperCase()].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}

function regionName(iso: string | null, lang: "ar" | "en"): string | null {
  if (!iso || !/^[a-z]{2}$/i.test(iso)) return null;
  try {
    return new Intl.DisplayNames([lang], { type: "region" }).of(iso.toUpperCase()) ?? null;
  } catch {
    return null;
  }
}

export type FiveSimAdapter = SupplierAdapter & {
  /** Report the number as already used by the target service (releases it, 5sim refunds). */
  ban(supplierOrderId: string): Promise<boolean>;
};

interface Country {
  iso: string | null;
  en: string;
}

export function createFiveSim(ctx: AdapterContext): FiveSimAdapter {
  const base = baseUrl(ctx, "FIVESIM_BASE_URL", "https://5sim.net/v1");
  const key = cfg(ctx, "FIVESIM_API_KEY");
  const secrets = key ? [key] : [];
  const configuredRate = Number(cfg(ctx, "FIVESIM_RUB_USD_RATE"));
  const rate = Number.isFinite(configuredRate) && configuredRate > 0 ? configuredRate : DEFAULT_RATE;
  const operator = cfg(ctx, "FIVESIM_OPERATOR")?.toLowerCase() ?? "any";
  const onlyCountries = new Set(csv(ctx, "FIVESIM_COUNTRIES"));
  const onlyServices = new Set(csv(ctx, "FIVESIM_SERVICES"));
  const enc = encodeURIComponent;

  /** Rubles to US cents: costs round up, balances round down (epsilon absorbs float noise). */
  const costCents = (rub: number): number => Math.ceil(rub * rate * 100 - 1e-6);
  const balanceCents = (rub: number): number => Math.max(0, Math.floor(rub * rate * 100 + 1e-6));

  async function user(path: string): Promise<HttpResult> {
    if (!key) throw new AdapterError(ID, "FIVESIM_API_KEY is not configured");
    return http(ctx, ID, `${base}/user${path}`, { headers: { Authorization: `Bearer ${key}` }, secrets, timeoutMs: 10_000 });
  }

  async function guest(path: string): Promise<unknown> {
    const r = await http(ctx, ID, `${base}/guest${path}`, { secrets });
    if (!r.ok) throw httpError(ID, r, secrets);
    return r.json;
  }

  /** cancel / ban: true when 5sim accepted, false when it refused (e.g. an SMS already arrived). */
  async function close(action: "cancel" | "ban", supplierOrderId: string): Promise<boolean> {
    const r = await user(`/${action}/${enc(supplierOrderId)}`);
    if (r.status === 401 || r.status === 429 || r.status >= 500) throw httpError(ID, r, secrets);
    return r.ok;
  }

  let countryCache: Promise<Map<string, Country>> | null = null;
  /** Country slug → ISO code and English name (one request per adapter). */
  function countries(): Promise<Map<string, Country>> {
    countryCache ??= guest("/countries").then((raw) => {
      const out = new Map<string, Country>();
      for (const [slug, info] of Object.entries(obj(raw) ?? {})) {
        const o = obj(info);
        const iso = Object.keys(obj(o?.iso) ?? {})[0] ?? null;
        out.set(slug, { iso: iso?.toLowerCase() ?? null, en: str(o?.text_en) ?? slug.charAt(0).toUpperCase() + slug.slice(1) });
      }
      return out;
    }).catch((err) => {
      countryCache = null;
      throw err;
    });
    return countryCache;
  }

  /** The cheapest operator that has numbers (or the cheapest at all, unavailable). */
  function price(byOperator: unknown): { cost: number; max: number; stock: number; available: boolean } | null {
    if (!isObj(byOperator)) return null;
    const offers = Object.entries(byOperator)
      .filter(([name, info]) => isObj(info) && (operator === "any" || name === operator))
      .map(([, info]) => ({ cost: num(obj(info)?.cost), count: num(obj(info)?.count) ?? 0 }))
      .filter((o): o is { cost: number; count: number } => o.cost !== null && o.cost >= 0);
    if (offers.length === 0) return null;
    const inStock = offers.filter((o) => o.count > 0);
    const priced = (inStock.length > 0 ? inStock : offers).map((o) => o.cost);
    return { cost: Math.min(...priced), max: Math.max(...priced), stock: inStock.reduce((s, o) => s + o.count, 0), available: inStock.length > 0 };
  }

  function item(country: string, service: string, p: NonNullable<ReturnType<typeof price>>, names?: Map<string, Country>): SupplierProduct {
    const c = names?.get(country);
    const f = flag(c?.iso ?? null);
    const en = c?.en ?? country.charAt(0).toUpperCase() + country.slice(1);
    const ar = regionName(c?.iso ?? null, "ar") ?? en;
    const brand = serviceName(service);
    return {
      externalId: `${country}/${service}`,
      name: `${brand} (${en})`,
      costCents: costCents(p.cost),
      available: p.available,
      kind: "sms",
      productKey: `${SERVICE}${service}`,
      productName: `${brand} number`,
      productNameAr: `رقم ${brand}`,
      packageName: f ? `${f} ${en}` : en,
      packageNameAr: f ? `${f} ${ar}` : ar,
      meta: { country, service, operator, iso: c?.iso ?? null, stock: p.stock, maxCostCents: costCents(p.max), rubUsdRate: rate },
    };
  }

  /** One service's countries: `/guest/prices?product=X`. */
  async function servicePrices(service: string): Promise<Array<[string, NonNullable<ReturnType<typeof price>>]>> {
    const raw = obj(await guest(`/prices?product=${enc(service)}`)) ?? {};
    // Asked per product, 5sim nests { product: { country: ... } }; be lenient with a flat answer.
    const byCountry = obj(raw[service]) ?? raw;
    const out: Array<[string, NonNullable<ReturnType<typeof price>>]> = [];
    for (const [country, byOperator] of Object.entries(byCountry)) {
      if (onlyCountries.size > 0 && !onlyCountries.has(country.toLowerCase())) continue;
      const p = price(byOperator);
      if (p) out.push([country, p]);
    }
    return out;
  }

  const adapter: FiveSimAdapter = {
    id: ID,
    name: "5sim",

    /** The services 5sim sells numbers for, the most available first. */
    async listGroups() {
      const raw = obj(await guest("/products/any/any")) ?? {};
      const groups: (SupplierGroup & { qty: number })[] = [];
      for (const [service, info] of Object.entries(raw)) {
        const o = obj(info);
        if (str(o?.Category)?.toLowerCase() !== "activation") continue;
        if (onlyServices.size > 0 && !onlyServices.has(service.toLowerCase())) continue;
        groups.push({ id: `${SERVICE}${service}`, name: serviceName(service), qty: num(o?.Qty) ?? 0 });
      }
      return groups.sort((a, b) => b.qty - a.qty).map(({ id, name }) => ({ id, name }));
    },

    async listProducts(group) {
      if (group?.startsWith(SERVICE)) {
        const service = group.slice(SERVICE.length);
        const [list, names] = await Promise.all([servicePrices(service), countries()]);
        return list.map(([country, p]) => item(country, service, p, names));
      }
      // No service: the configured countries in one go (small accounts; the admin lists by service).
      const urls = onlyCountries.size > 0 ? [...onlyCountries].map((c) => `/prices?country=${enc(c)}`) : ["/prices"];
      const out: SupplierProduct[] = [];
      for (const url of urls) {
        for (const [country, byService] of Object.entries(obj(await guest(url)) ?? {})) {
          if (!isObj(byService)) continue;
          for (const [service, byOperator] of Object.entries(byService)) {
            if (onlyServices.size > 0 && !onlyServices.has(service.toLowerCase())) continue;
            const p = price(byOperator);
            if (p) out.push(item(country, service, p));
          }
        }
      }
      return out;
    },

    /** Current prices of these packages only: one request per service. */
    async listProductsFor(externalIds) {
      const services = new Set<string>();
      for (const id of externalIds) {
        const m = /^[^/]+\/([^/]+)$/.exec(id);
        if (m?.[1]) services.add(m[1]);
      }
      const lists = await mapLimit([...services], 4, async (service) => (await servicePrices(service)).map(([c, p]) => item(c, service, p)));
      return lists.flat();
    },

    syncGroup(externalId) {
      return `${SERVICE}${externalId.split("/")[1] ?? ""}`;
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
        // Never pay more than the package was priced from (only possible with operator "any").
        const cap = operator === "any" && req.maxCostCents && req.maxCostCents > 0 ? `?maxPrice=${(req.maxCostCents / 100 / rate).toFixed(4)}` : "";
        const r = await user(`/buy/activation/${enc(match[1])}/${enc(operator)}/${enc(match[2])}${cap}`);
        const order = obj(r.json);
        const id = str(order?.id);
        const phone = str(order?.phone);
        if (r.ok && id && phone) {
          const expires = str(order?.expires);
          return {
            status: "pending",
            supplierOrderId: id,
            items: [{ kind: "phone", value: phone }],
            ...(expires && !Number.isNaN(Date.parse(expires)) ? { expiresAt: new Date(expires).toISOString() } : {}),
          };
        }
        const message = supplierMessage(r, secrets);
        if (/no free phones/i.test(message)) return failed("out of stock at supplier: no free numbers", false);
        if (/not enough user balance|not enough balance/i.test(message)) return failed(`supplier wallet balance too low: ${message}`, true);
        if (/server offline/i.test(message)) return failed(`5sim is offline: ${message}`, true);
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
