/**
 * G2Bulk's POST /games/fields returns bare keys ("userid", "zoneid"...) with no
 * labels. This maps them to the store's canonical input keys and bilingual
 * labels. Aliases follow the old bot's checkout (uid/userid → player_id,
 * zone_id/serverid → server_id, nickname/character_name → charname).
 */
import type { InputField } from "../../core/src/adapters";

type FieldDef = { key: string; en: string; ar: string };

const PLAYER: FieldDef = { key: "player_id", en: "Player ID", ar: "معرّف اللاعب (ID)" };
const SERVER: FieldDef = { key: "server_id", en: "Server", ar: "السيرفر" };
const ZONE: FieldDef = { key: "server_id", en: "Zone ID", ar: "المنطقة (Zone)" };
const CHAR: FieldDef = { key: "charname", en: "Character name", ar: "اسم الشخصية" };

const FIELD_DEFS: Record<string, FieldDef> = {
  userid: PLAYER, user_id: PLAYER, uid: PLAYER, playerid: PLAYER, player_id: PLAYER,
  serverid: SERVER, server_id: SERVER, server: SERVER, zoneid: ZONE, zone_id: ZONE,
  charname: CHAR, character: CHAR, character_name: CHAR, nickname: CHAR,
  email: { key: "email", en: "Email", ar: "البريد الإلكتروني" },
};

/** Request-field aliases accepted at purchase time, canonical key first. */
export const PLAYER_KEYS = ["player_id", "userid", "user_id", "uid", "playerid"];
export const SERVER_KEYS = ["server_id", "serverid", "zone_id", "zoneid", "server"];
export const CHARNAME_KEYS = ["charname", "character", "character_name", "nickname"];

/**
 * Input fields for a game. Every key /games/fields returns is required by the
 * supplier; an unknown key still becomes a (humanised) text field rather than
 * being dropped.
 */
export function g2bulkInputFields(rawKeys: string[]): InputField[] {
  const seen = new Set<string>();
  const out: InputField[] = [];
  for (const raw of rawKeys) {
    const key = raw.trim().toLowerCase();
    if (!key) continue;
    const label = key.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    const def = FIELD_DEFS[key] ?? { key, en: label, ar: label };
    if (seen.has(def.key)) continue;
    seen.add(def.key);
    out.push({ key: def.key, labelEn: def.en, labelAr: def.ar, required: true });
  }
  return out;
}
