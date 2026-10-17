/**
 * What a product's picture box shows when the owner gave it no picture:
 *
 * - a brand mark, when the product's name starts with a brand that has one in
 *   simple-icons (CC0; https://simpleicons.org). Only real marks: brands that
 *   simple-icons removed (Adobe, Amazon, Microsoft, OpenAI...) are not here,
 *   and nothing is drawn to look like them. The build copies these SVGs into
 *   the site as /brands/<slug>.svg (apps/web/client/build.mjs), so nothing is
 *   fetched from anyone else at runtime and none of it is in the JavaScript.
 * - else the product's name, set as a title ("Duolingo Super" → "Duolingo",
 *   with "Super" as a small tag).
 *
 * The owner's own picture (Admin → Catalogue) always comes first.
 */

export interface Brand {
  /** simple-icons' slug: the file is /brands/<slug>.svg. */
  slug: string;
  /** The brand's name as simple-icons writes it. */
  title: string;
  /** The brand's colour (simple-icons' hex, without "#"). */
  hex: string;
  /** Other names a product's name may start with. */
  also?: readonly string[];
}

/**
 * The marks the store carries. Add a line (and nothing else) to carry another:
 * the slug and colour must be simple-icons' (a test checks them against the
 * package), and `also` lists other ways product names write the brand.
 */
export const BRANDS: readonly Brand[] = [
  { slug: "steam", title: "Steam", hex: "000000" },
  { slug: "playstation", title: "PlayStation", hex: "0070D1", also: ["psn","ps plus","playstation plus","playstation network"] },
  { slug: "roblox", title: "Roblox", hex: "000000" },
  { slug: "pubg", title: "PUBG", hex: "F4B942", also: ["pubg mobile"] },
  { slug: "valorant", title: "Valorant", hex: "FA4454" },
  { slug: "leagueoflegends", title: "League of Legends", hex: "C28F2C" },
  { slug: "fortnite", title: "Fortnite", hex: "000000" },
  { slug: "epicgames", title: "Epic Games", hex: "313131", also: ["epic games store"] },
  { slug: "riotgames", title: "Riot Games", hex: "EB0029", also: ["riot points"] },
  { slug: "battledotnet", title: "Battle.net", hex: "4381C3", also: ["battle net","battlenet"] },
  { slug: "ea", title: "EA", hex: "000000", also: ["ea play","ea sports"] },
  { slug: "ubisoft", title: "Ubisoft", hex: "000000" },
  { slug: "rockstargames", title: "Rockstar Games", hex: "FCAF17", also: ["rockstar"] },
  { slug: "twitch", title: "Twitch", hex: "9146FF" },
  { slug: "kick", title: "Kick", hex: "53FC19" },
  { slug: "discord", title: "Discord", hex: "5865F2", also: ["discord nitro"] },
  { slug: "nvidia", title: "NVIDIA", hex: "76B900", also: ["geforce now"] },
  { slug: "netflix", title: "Netflix", hex: "E50914" },
  { slug: "spotify", title: "Spotify", hex: "1ED760" },
  { slug: "youtube", title: "YouTube", hex: "FF0000" },
  { slug: "youtubemusic", title: "YouTube Music", hex: "FF0000" },
  { slug: "applemusic", title: "Apple Music", hex: "FA243C" },
  { slug: "appletv", title: "Apple TV", hex: "000000", also: ["apple tv plus"] },
  { slug: "deezer", title: "Deezer", hex: "A238FF" },
  { slug: "soundcloud", title: "SoundCloud", hex: "FF5500" },
  { slug: "tidal", title: "TIDAL", hex: "000000" },
  { slug: "hbomax", title: "HBO Max", hex: "000000" },
  { slug: "crunchyroll", title: "Crunchyroll", hex: "FF5E00" },
  { slug: "apple", title: "Apple", hex: "000000", also: ["apple gift card","apple id"] },
  { slug: "icloud", title: "iCloud", hex: "3693F3", also: ["icloud plus"] },
  { slug: "itunes", title: "iTunes", hex: "FB5BC5" },
  { slug: "google", title: "Google", hex: "4285F4" },
  { slug: "googleplay", title: "Google Play", hex: "414141" },
  { slug: "googlegemini", title: "Google Gemini", hex: "8E75B2", also: ["gemini"] },
  { slug: "googledrive", title: "Google Drive", hex: "4285F4" },
  { slug: "telegram", title: "Telegram", hex: "26A5E4" },
  { slug: "whatsapp", title: "WhatsApp", hex: "25D366" },
  { slug: "instagram", title: "Instagram", hex: "FF0069" },
  { slug: "facebook", title: "Facebook", hex: "0866FF" },
  { slug: "tiktok", title: "TikTok", hex: "000000" },
  { slug: "snapchat", title: "Snapchat", hex: "FFFC00" },
  { slug: "x", title: "X", hex: "000000", also: ["twitter"] },
  { slug: "reddit", title: "Reddit", hex: "FF4500" },
  { slug: "pinterest", title: "Pinterest", hex: "BD081C" },
  { slug: "viber", title: "Viber", hex: "7360F2" },
  { slug: "signal", title: "Signal", hex: "3B45FD" },
  { slug: "wechat", title: "WeChat", hex: "07C160" },
  { slug: "tinder", title: "Tinder", hex: "FF6B6B" },
  { slug: "claude", title: "Claude", hex: "D97757" },
  { slug: "anthropic", title: "Anthropic", hex: "191919" },
  { slug: "perplexity", title: "Perplexity", hex: "1FB8CD" },
  { slug: "cursor", title: "Cursor", hex: "000000" },
  { slug: "githubcopilot", title: "GitHub Copilot", hex: "000000" },
  { slug: "github", title: "GitHub", hex: "181717" },
  { slug: "replit", title: "Replit", hex: "F26207" },
  { slug: "vercel", title: "Vercel", hex: "000000" },
  { slug: "supabase", title: "Supabase", hex: "3FCF8E" },
  { slug: "huggingface", title: "Hugging Face", hex: "FFD21E" },
  { slug: "deepseek", title: "DeepSeek", hex: "5786FE" },
  { slug: "mistralai", title: "Mistral AI", hex: "FA520F", also: ["mistral","le chat"] },
  { slug: "qwen", title: "QWen", hex: "6950EF" },
  { slug: "openrouter", title: "OpenRouter", hex: "94A3B8" },
  { slug: "elevenlabs", title: "ElevenLabs", hex: "000000", also: ["eleven labs"] },
  { slug: "notion", title: "Notion", hex: "000000" },
  { slug: "figma", title: "Figma", hex: "F24E1E" },
  { slug: "framer", title: "Framer", hex: "0055FF" },
  { slug: "webflow", title: "Webflow", hex: "146EF5" },
  { slug: "linear", title: "Linear", hex: "5E6AD2" },
  { slug: "miro", title: "Miro", hex: "050038" },
  { slug: "zapier", title: "Zapier", hex: "FF4F00" },
  { slug: "n8n", title: "n8n", hex: "EA4B71" },
  { slug: "obsidian", title: "Obsidian", hex: "7C3AED" },
  { slug: "todoist", title: "Todoist", hex: "E44332" },
  { slug: "trello", title: "Trello", hex: "0052CC" },
  { slug: "asana", title: "Asana", hex: "F06A6A" },
  { slug: "clickup", title: "ClickUp", hex: "7B68EE" },
  { slug: "airtable", title: "Airtable", hex: "18BFFF" },
  { slug: "grammarly", title: "Grammarly", hex: "027E6F" },
  { slug: "deepl", title: "DeepL", hex: "0F2B46" },
  { slug: "zoom", title: "Zoom", hex: "0B5CFF" },
  { slug: "dropbox", title: "Dropbox", hex: "0061FF" },
  { slug: "warp", title: "Warp", hex: "01A4FF" },
  { slug: "ilovepdf", title: "iLovePDF", hex: "E5322D", also: ["i love pdf"] },
  { slug: "duolingo", title: "Duolingo", hex: "58CC02" },
  { slug: "coursera", title: "Coursera", hex: "0056D2" },
  { slug: "udemy", title: "Udemy", hex: "A435F0" },
  { slug: "edx", title: "edX", hex: "02262B" },
  { slug: "quizlet", title: "Quizlet", hex: "4255FF" },
  { slug: "khanacademy", title: "Khan Academy", hex: "14BF96" },
  { slug: "codecademy", title: "Codecademy", hex: "1F4056" },
  { slug: "datacamp", title: "DataCamp", hex: "03EF62" },
  { slug: "leetcode", title: "LeetCode", hex: "FFA116" },
  { slug: "chessdotcom", title: "Chess.com", hex: "81B64C" },
  { slug: "medium", title: "Medium", hex: "000000" },
  { slug: "nordvpn", title: "NordVPN", hex: "4687FF" },
  { slug: "expressvpn", title: "ExpressVPN", hex: "DA3940" },
  { slug: "protonvpn", title: "Proton VPN", hex: "66DEB1" },
  { slug: "surfshark", title: "Surfshark", hex: "1EBFBF" },
  { slug: "shopify", title: "Shopify", hex: "7AB55C" },
  { slug: "wix", title: "Wix", hex: "0C6EFC" },
  { slug: "godaddy", title: "GoDaddy", hex: "1BDBDB" },
  { slug: "namecheap", title: "Namecheap", hex: "DE3723" },
  { slug: "hostinger", title: "Hostinger", hex: "673DE6" },
  { slug: "cloudflare", title: "Cloudflare", hex: "F38020" },
  { slug: "digitalocean", title: "DigitalOcean", hex: "0080FF" },
  { slug: "patreon", title: "Patreon", hex: "000000" },
  { slug: "fiverr", title: "Fiverr", hex: "1DBF73" },
  { slug: "upwork", title: "Upwork", hex: "6FDA44" },
];

/** "Bolt.new Pro" → ["bolt", "new", "pro"]: lower case, accents and punctuation gone. */
function words(text: string): string[] {
  return text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/** Each brand's names with the spaces taken out ("you tube" and "YouTube" are the same). */
const KEYS: [string, Brand][] = BRANDS.flatMap((b) => [b.title, ...(b.also ?? [])].map((n) => [words(n).join(""), b] as [string, Brand]))
  .filter(([k]) => k.length > 0);
const BY_KEY = new Map(KEYS);
const LONGEST = Math.max(...KEYS.map(([k]) => k.length));

/**
 * The brand a product's name starts with, or null. The longest match wins
 * ("Google Gemini Advanced" is Gemini, not Google; "YouTube Music" is not
 * YouTube), and only whole words count ("Xbox" is not "X", "Steamworks" not "Steam").
 */
export function brandFor(name: string): Brand | null {
  const w = words(name);
  let found: Brand | null = null;
  let joined = "";
  for (const part of w) {
    joined += part;
    if (joined.length > LONGEST) break;
    found = BY_KEY.get(joined) ?? found;
  }
  return found;
}

/** The brand by its simple-icons slug ("duolingo"), or null when the store does not carry it. */
export function brandBySlug(slug: string): Brand | null {
  return BRANDS.find((b) => b.slug === slug) ?? null;
}

/**
 * A picture address that is simple-icons' own file for a brand the store
 * carries ("https://cdn.jsdelivr.net/npm/simple-icons@13/icons/telegram.svg"):
 * that brand, so it is drawn like the store's other marks (in its colour)
 * instead of a black shape on a grey tile.
 */
export function brandFromIconUrl(url: string): Brand | null {
  const m = /simple-?icons[^?#]*\/(?:icons\/)?([a-z0-9]+)\.svg(?:[?#]|$)/i.exec(url) ?? /simpleicons\.org\/(?:icons\/)?([a-z0-9]+)(?:\/|$|\?)/i.exec(url);
  return m ? brandBySlug(m[1]!.toLowerCase()) : null;
}

/** White or black for marks drawn on the brand's colour (Snapchat's yellow takes black). */
export function brandInk(hex: string): "#000000" | "#FFFFFF" {
  const c = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  const lum = 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
  // White like the brands' own app icons (Telegram, Duolingo, Spotify), black only on
  // really light colours (Snapchat's yellow, Kick's green), where white would vanish.
  return lum > 0.6 ? "#000000" : "#FFFFFF";
}

/** Plan words that come after a product's name: shown as a small tag, not in the title. */
const PLAN_WORDS = new Set([
  "pro", "premium", "plus", "super", "business", "starter", "team", "teams", "essentials", "creator", "personal", "professional",
  "build", "advanced", "invite", "basic", "standard", "family", "individual", "student", "membership", "subscription", "plan",
  "monthly", "yearly", "annual", "max", "ultra", "unlimited", "lite",
]);

/**
 * A product's name for its title tile: the name without the plan words at its
 * end, and those words ("Duolingo Super" → "Duolingo" + "Super"; "Canva Pro
 * Team Invite" → "Canva" + "Pro Team Invite"). A name made only of such words
 * stays whole ("Premium"), and so does a name without any.
 */
export function artName(name: string): { title: string; plan: string } {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  let end = parts.length;
  while (end > 1 && PLAN_WORDS.has(parts[end - 1]!.toLowerCase().replace(/[^\p{L}\p{N}]/gu, ""))) end--;
  return { title: parts.slice(0, end).join(" "), plan: parts.slice(end).join(" ") };
}
