/** Admin → Settings → Telegram bot: status and one-tap connect. */
import { afterAll, describe, expect, it } from "vitest";
import { BOT_TOKEN, connectTestDb, env, Harness } from "./helpers";

const conn = await connectTestDb();
const db = conn.db;
const h = new Harness(db);
const tg = (k: number) => 720_000_000 + (Date.now() % 100_000_000) + k;

afterAll(async () => {
  await conn.close();
});

// A small stand-in for the Bot API that remembers what was set.
const bot = {
  url: "https://old-server.example/bot-hook",
  secret: "",
  allowed: [] as unknown[],
  commands: {} as Record<string, { command: string; description: string }[]>,
  menu: null as Record<string, any> | null,
  failOn: "" as string,
};
h.svc.telegram = async (method, payload) => {
  if (method === bot.failOn) throw new Error(`telegram ${method}: ${method === "getMe" ? "Unauthorized" : "Bad Request: bad webhook: Failed to resolve host"}`);
  switch (method) {
    case "getMe":
      return { id: 1, is_bot: true, username: "gh_store1_bot" };
    case "getWebhookInfo":
      return { url: bot.url, pending_update_count: 2, last_error_date: 1_760_000_000, last_error_message: "Wrong response from the webhook: 404 Not Found" };
    case "setWebhook":
      bot.url = String(payload.url);
      bot.secret = String(payload.secret_token);
      bot.allowed = payload.allowed_updates as unknown[];
      return true;
    case "setMyCommands":
      bot.commands[String(payload.language_code ?? "default")] = payload.commands as never;
      return true;
    case "setChatMenuButton":
      bot.menu = payload.menu_button as Record<string, any>;
      return true;
  }
  throw new Error(`telegram ${method}: Bad Request: method not expected`);
};

async function ownerToken(): Promise<string> {
  return h.login(900001, "Owner");
}

describe("telegram bot setup", () => {
  it("is for the owner only", async () => {
    const customer = await h.login(tg(1));
    expect((await h.call("GET", "/api/admin/telegram", { token: customer })).status).toBe(403);
    expect((await h.call("POST", "/api/admin/telegram/connect", { token: customer })).status).toBe(403);
    expect(bot.url).toBe("https://old-server.example/bot-hook");
  });

  it("shows where the bot's messages go, then connects it to this store", async () => {
    const owner = await ownerToken();
    const before = await h.call("GET", "/api/admin/telegram", { token: owner });
    expect(before.status).toBe(200);
    expect(before.data).toMatchObject({
      configured: true,
      bot: "gh_store1_bot",
      expectedUrl: "https://store.test/telegram/webhook",
      url: "https://old-server.example/bot-hook",
      connected: false,
      pendingUpdates: 2,
      error: null,
    });
    expect(before.data.lastError.message).toContain("404");
    expect(before.data.lastError.at).toBe(new Date(1_760_000_000_000).toISOString());

    const r = await h.call("POST", "/api/admin/telegram/connect", { token: owner });
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ connected: true, url: "https://store.test/telegram/webhook", error: null });
    expect(bot.secret).toBe(env.TELEGRAM_WEBHOOK_SECRET);
    expect(bot.allowed).toEqual(["message", "callback_query", "pre_checkout_query"]);
    expect(bot.commands.default!.map((c) => c.command)).toEqual(["start", "balance", "orders", "invite", "help"]);
    expect(bot.commands.ar!.find((c) => c.command === "balance")!.description).toBe("رصيدك");
    expect(bot.menu).toEqual({ type: "web_app", text: "افتح المتجر", web_app: { url: "https://store.test/tg" } });
    const audit = await db.query(`select 1 from app.audit_log where action = 'telegram.connect' and target_id = 'https://store.test/telegram/webhook'`);
    expect(audit.length).toBeGreaterThan(0);
  });

  it("reports Telegram's answer without exposing the token", async () => {
    const owner = await ownerToken();
    bot.failOn = "setWebhook";
    const failed = await h.call("POST", "/api/admin/telegram/connect", { token: owner });
    expect(failed.status).toBe(200);
    expect(failed.data.error).toBe("Bad Request: bad webhook: Failed to resolve host");

    bot.failOn = "getMe";
    const s = await h.call("GET", "/api/admin/telegram", { token: owner });
    expect(s.data).toMatchObject({ error: "Unauthorized", bot: null, connected: false });
    expect(JSON.stringify(s.data)).not.toContain(BOT_TOKEN);
    bot.failOn = "";
  });

  it("refuses to connect without the webhook secret", async () => {
    const owner = await ownerToken();
    const saved = env.TELEGRAM_WEBHOOK_SECRET;
    delete env.TELEGRAM_WEBHOOK_SECRET;
    try {
      const r = await h.call("POST", "/api/admin/telegram/connect", { token: owner });
      expect(r.status).toBe(409);
      expect(r.data.error).toEqual({ code: "bad_state", field: "telegram_secrets" });
      const s = await h.call("GET", "/api/admin/telegram", { token: owner });
      expect(s.data.configured).toBe(false);
    } finally {
      env.TELEGRAM_WEBHOOK_SECRET = saved;
    }
  });
});
