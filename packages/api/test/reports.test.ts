/** Owner reports: daily summary and CSV exports. */
import { afterAll, describe, expect, it } from "vitest";
import { handle, localNow, previousDay, queueDailySummary, sendOutbox, summaryText, toCsv } from "../src/index";
import { connectTestDb, env, Harness } from "./helpers";

const conn = await connectTestDb();
const db = conn.db;
const h = new Harness(db);

afterAll(async () => {
  await conn.close();
});

async function raw(path: string, token?: string) {
  const res = await handle(new Request(`${env.PUBLIC_BASE_URL}${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} }), env, h.svc);
  return { status: res.status, type: res.headers.get("content-type") ?? "", disposition: res.headers.get("content-disposition") ?? "", text: await res.text() };
}

describe("daily summary", () => {
  it("knows the local day and hour", () => {
    expect(localNow(new Date("2026-01-01T21:30:00Z"), "Asia/Damascus")).toEqual({ hour: 0, date: "2026-01-02" });
    expect(localNow(new Date("2026-06-15T10:05:00Z"), "UTC")).toEqual({ hour: 10, date: "2026-06-15" });
  });

  it("is sent once a day to owners at the chosen hour, even with notifications off", async () => {
    const owner = await h.login(900001, "Owner", "en");
    const hour = localNow(h.svc.now()).hour;
    await db.query(`update app.settings set value = to_jsonb($1::int) where key = 'reports.daily_hour'`, [(hour + 1) % 24]);
    await db.query(`delete from app.settings where key = 'reports.daily_last'`);
    expect(await queueDailySummary(h.svc)).toBe(false); // not the hour yet
    await db.query(`update app.settings set value = to_jsonb($1::int) where key = 'reports.daily_hour'`, [hour]);
    expect(await queueDailySummary(h.svc)).toBe(true);
    expect(await queueDailySummary(h.svc)).toBe(false); // once a day
    await h.call("PATCH", "/api/me", { token: owner, body: { notify: false, locale: "en" } });
    h.telegramCalls.length = 0;
    await sendOutbox(h.svc, env, 1000);
    const msg = h.telegramCalls.find((c) => c.payload.chat_id === "900001" && String(c.payload.text).startsWith("Daily summary"));
    expect(msg).toBeDefined();
    expect(String(msg!.payload.text)).toMatch(/Sales: \$\d+\.\d{2} \(\d+ orders\)/);
    // It covers yesterday, a complete day.
    expect(String(msg!.payload.text)).toContain(`Daily summary · ${previousDay(localNow(h.svc.now()).date)}`);
    expect(JSON.stringify(msg!.payload.reply_markup)).toContain("startapp=admin");
    await h.call("PATCH", "/api/me", { token: owner, body: { notify: true } });
  });

  it("reads well in both languages and lists what needs attention", () => {
    const s = { date: "2026-10-15", salesCents: 12345, orders: 12, profitCents: 1520, rewardsCents: 30, topupsCents: 20000, topups: 8, newUsers: 5,
      failedOrders: 2, refundedOrders: 0, openOrders: 0, toReview: 1, lowSuppliers: ["G2Bulk"] };
    expect(summaryText(s, "en")).toBe(
      "Daily summary · 2026-10-15\nSales: $123.45 (12 orders)\nProfit: $15.20 (after $0.30 invite rewards)\nTop-ups: $200.00 (8)\nNew customers: 5\n\nNeeds attention: 2 failed orders · 1 top-ups to review · Low balance: G2Bulk",
    );
    expect(summaryText({ ...s, failedOrders: 0, toReview: 0, lowSuppliers: [] }, "ar")).not.toContain("يحتاج");
  });
});

describe("CSV exports", () => {
  it("escapes cells and blocks spreadsheet formulas", () => {
    const csv = toCsv(["a", "b", "c", "d"], [["x,y", 'say "hi"', "=HYPERLINK(1)", "-12.50"], [null, "line\nbreak", "@me", 3]]);
    expect(csv.startsWith("﻿a,b,c,d\r\n")).toBe(true);
    expect(csv).toContain('"x,y","say ""hi""",\'=HYPERLINK(1),-12.50\r\n');
    expect(csv).toContain(',"line\nbreak",\'@me,3\r\n');
    expect(toCsv(["a"], [["x;=cmd"]])).toContain('"x;=cmd"');
  });

  it("lets only the owner download orders, top-ups and wallet history", async () => {
    const owner = await h.login(900001, "Owner", "en");
    const customer = await h.login(600_000_777, "Customer", "en");
    expect((await raw("/api/admin/export/orders.csv", customer)).status).toBe(403);
    expect((await raw("/api/admin/export/orders.csv")).status).toBe(401);
    for (const kind of ["orders", "topups", "wallet"]) {
      const r = await raw(`/api/admin/export/${kind}.csv`, owner);
      expect(r.status).toBe(200);
      expect(r.type).toContain("text/csv");
      expect(r.disposition).toMatch(new RegExp(`attachment; filename="gh-store-${kind}-\\d{4}-\\d{2}-\\d{2}-to-\\d{4}-\\d{2}-\\d{2}\\.csv"`));
    }
    const wallet = await raw("/api/admin/export/wallet.csv", owner);
    expect(wallet.text.split("\r\n")[0]).toBe("﻿id,created_at,customer,telegram,kind,amount_usd,balance_after_usd,ref_type,ref_id,note");
    expect((await raw("/api/admin/export/orders.csv?from=2020-01-01&to=2026-01-01", owner)).status).toBe(400);
    expect((await raw("/api/admin/export/orders.csv?from=nope", owner)).status).toBe(400);
    expect((await raw("/api/admin/export/orders.csv?from=2026-02-31&to=2026-03-02", owner)).status).toBe(400);
    expect((await raw("/api/admin/export/secrets.csv", owner)).status).toBe(404);
  });
});
