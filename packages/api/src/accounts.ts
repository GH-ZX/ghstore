/**
 * Admin → Settings → APIs: each supplier's and payment provider's account as
 * the provider describes it (name, balances, latest movements). Owner only;
 * read on demand, a request or three per look, every look audit logged.
 *
 * GET /api/admin/accounts              the providers and whether each can be read
 * GET /api/admin/accounts/:kind/:id    one account (kind: supplier | payment)
 */
import type { AccountInfo, PaymentMethod } from "@store/core";
import { audit } from "./audit";
import type { Ctx } from "./context";
import { requireStaff } from "./guard";
import { ApiError, checkSupplierId, json } from "./http";
import { effectiveEnv } from "./keys";

/** Payment providers with an account to show (Stars has none to read). */
const PAYMENTS: { id: PaymentMethod; name: string; key: string }[] = [
  { id: "sam", name: "ShamCash (SAM)", key: "SAM_API_KEY" },
  { id: "bep20", name: "USDT (BEP20)", key: "BEP20_ADDRESS" },
];

/** A supplier's key name (G2BULK_API_KEY...): an adapter may exist without one (5SIM's public prices). */
const supplierKey = (id: string) => `${id.toUpperCase()}_API_KEY`;

export async function listAccounts(ctx: Ctx): Promise<Response> {
  await requireStaff(ctx, "owner");
  const suppliers = await ctx.svc.db.query<{ id: string; name: string; enabled: boolean }>(`select id, name, enabled from app.suppliers order by name`);
  const env = (await effectiveEnv(ctx.env, ctx.svc.db)) as Record<string, unknown>;
  const has = (name: string) => typeof env[name] === "string" && (env[name] as string).trim() !== "";
  return json({
    accounts: [
      ...suppliers.map((s) => {
        const a = ctx.svc.supplier(s.id);
        const configured = !!a && has(supplierKey(s.id));
        return { kind: "supplier", id: s.id, name: s.name, enabled: s.enabled, configured, readable: configured && !!a?.accountInfo };
      }),
      ...PAYMENTS.map((p) => {
        const a = ctx.svc.payment(p.id);
        const configured = !!a && has(p.key);
        return { kind: "payment", id: p.id, name: p.name, enabled: true, configured, readable: configured && !!a?.accountInfo };
      }),
    ],
  });
}

export async function getAccount(ctx: Ctx): Promise<Response> {
  const staff = await requireStaff(ctx, "owner");
  const kind = ctx.params.kind;
  let info: AccountInfo;
  let id: string;
  try {
    if (kind === "supplier") {
      id = checkSupplierId(ctx.params.id);
      const a = ctx.svc.supplier(id);
      if (!a?.accountInfo) throw new ApiError("not_found");
      info = await a.accountInfo();
    } else if (kind === "payment") {
      const p = PAYMENTS.find((x) => x.id === ctx.params.id);
      if (!p) throw new ApiError("not_found");
      id = p.id;
      const a = ctx.svc.payment(p.id);
      if (!a?.accountInfo) throw new ApiError("not_found");
      info = await a.accountInfo();
    } else {
      throw new ApiError("not_found");
    }
  } catch (err) {
    if (err instanceof ApiError) throw err;
    // The provider refused or is down: say why (adapters never put keys in messages).
    return json({ error: (err instanceof Error ? err.message : String(err)).slice(0, 300) });
  }
  await audit(ctx.svc.db, { actor: staff.id, action: "account.view", targetType: kind, targetId: id });
  return json({ info });
}
