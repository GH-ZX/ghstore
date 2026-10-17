/** The settings registry: what the admin accepts and what readers fall back to, from one table. */
import { describe, expect, it } from "vitest";
import { store } from "@store/config";
import { isSettingKey, SETTINGS, settingValue } from "../src/settings-registry";

describe("settings registry", () => {
  it("knows the admin's keys, and nothing else", () => {
    expect(isSettingKey("theme.preset")).toBe(true);
    expect(isSettingKey("supplier.g2bulk.url")).toBe(false);
    expect(isSettingKey("toString")).toBe(false);
    // Written by the store itself (Connect bot), never typed in the admin.
    expect(SETTINGS["telegram.bot_username"].check("my_store_bot")).toBe(false);
  });

  it("gives the fallback while a key is unset or unusable", () => {
    expect(settingValue({}, "channel.max_per_day")).toBe(6);
    expect(settingValue({ "channel.max_per_day": 50 }, "channel.max_per_day")).toBe(6);
    expect(settingValue({ "channel.max_per_day": 12 }, "channel.max_per_day")).toBe(12);
    expect(settingValue({}, "reviews.ask_hours")).toBe(3);
    expect(settingValue({}, "telegram.bot_username")).toBe(store.telegramBot);
    expect(settingValue({}, "loyalty.tiers")).toHaveLength(3);
    // Switches: unset means the documented default, a stored boolean wins.
    expect(settingValue({}, "email.receipts")).toBe(true);
    expect(settingValue({ "email.receipts": false }, "email.receipts")).toBe(false);
    expect(settingValue({}, "push.enabled")).toBe(false);
    expect(settingValue({ "push.enabled": "yes" }, "push.enabled")).toBe(false);
  });

  it("lets readers keep values looser than today's admin check", () => {
    // The admin takes 1-50 top-ups an hour; a reader uses any positive whole number already saved.
    expect(SETTINGS["payments.topups_per_hour"].check(80)).toBe(false);
    expect(settingValue({ "payments.topups_per_hour": 80 }, "payments.topups_per_hour")).toBe(80);
    expect(settingValue({ "payments.topups_per_hour": 0 }, "payments.topups_per_hour")).toBe(6);
    // Theme: whatever is stored, or the default when nothing is.
    expect(settingValue({ "theme.preset": null }, "theme.preset")).toBe("energetic");
    // null switches Stars top-ups off.
    expect(settingValue({ "payments.stars_per_usd": null }, "payments.stars_per_usd")).toBeNull();
    expect(settingValue({ "payments.stars_per_usd": 80 }, "payments.stars_per_usd")).toBe(80);
  });
});
