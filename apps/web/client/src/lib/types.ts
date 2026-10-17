/** Shapes of the API responses the web app uses (see packages/api). */

export type Lang = "ar" | "en";
export type Role = "customer" | "monitor" | "support" | "owner";
export type PaymentMethod = "sam" | "nowpayments" | "bep20" | "stars";
export type Kind = "id" | "code" | "account" | "link" | "sms";

export interface PublicConfig {
  theme: { preset: "calm" | "energetic" | "minimal" | "warm"; defaultMode: "system" | "light" | "dark" };
  sypPerUsd: number | null;
  payments: { methods: PaymentMethod[]; minCents: number; maxCents: number; starsPerUsd: number | null };
  /** How customers reach the store, set in Admin → Settings. */
  support: { telegram: string | null; whatsapp: string | null; email: string | null };
  login: ("telegram" | "email" | "google")[];
  supabase: { url: string; key: string } | null;
  /** The store bot's username (from Connect bot) and the store's Telegram channel. */
  telegram?: { bot: string; channel: string | null };
  /** The store's pages linked at the bottom (terms, privacy, refund…). */
  pages?: { slug: string; titleAr: string; titleEn: string }[];
  /** Cloudflare Web Analytics, when the owner set its token. */
  analytics?: { cfBeacon: string | null };
}

export interface Me {
  user: {
    id: string;
    name: string;
    locale: Lang;
    role: Role;
    notify: boolean;
    telegramUsername: string | null;
    hasTelegram: boolean;
    email: string | null;
    /** The Telegram profile picture, when Telegram shares one. */
    photoUrl?: string | null;
  };
  balanceCents: number;
  stats: { orders: number; spentCents: number };
  channel: "web" | "miniapp" | "admin";
}

export interface Category {
  slug: string;
  nameAr: string;
  nameEn: string;
  /** A name from the category icon set (Admin → Home). */
  icon?: string | null;
}

/** A slide of the home page carousel (Admin → Home). */
export interface Banner {
  id: string;
  titleAr: string;
  titleEn: string;
  subtitleAr: string;
  subtitleEn: string;
  ctaAr: string;
  ctaEn: string;
  imageUrl: string | null;
  link: { type: "product" | "category" | "url"; value: string } | null;
  style: "accent" | "dark" | "light";
  /** The slide's own look; null follows the store's default (Admin → Home). */
  look?: "cinematic" | "deal" | null;
  /** Which of the product's pictures: wide cover, square icon or auto; null follows the store's setting. */
  pictureMode?: "auto" | "wide" | "square" | null;
}

export interface ProductCard {
  id: string;
  slug: string;
  category: string;
  nameAr: string;
  nameEn: string;
  kind: Kind;
  imageUrl: string | null;
  /** A wide picture (cover art), when the product has one. */
  coverUrl?: string | null;
  featured: boolean;
  fromCents: number;
  packages: number;
  searchTerms: string;
  /** Delivered by the store's team (not instantly). */
  byHand?: boolean;
  /** The owner's badge for the card. */
  badge?: ProductBadge | null;
  /** Customers' stars (Reviews), when it has any. */
  rating?: { average: number; count: number } | null;
}

export type ProductBadge = "instant" | "new" | "hot" | "best" | "sale";

export interface InputField {
  key: string;
  labelEn: string;
  labelAr?: string;
  required: boolean;
  pattern?: string;
  /** A fixed list to choose from (a game server, a region). */
  options?: { value: string; labelEn?: string; labelAr?: string }[];
}

export interface Offer {
  id: string;
  nameAr: string;
  nameEn: string;
  priceCents: number;
  fields: InputField[];
  maxQuantity: number;
  /** "Full warranty", "5-hour warranty" (null: none said). */
  warrantyAr?: string | null;
  warrantyEn?: string | null;
  /** How often it delivers, 0-100 (virtual numbers: the share of numbers that got their SMS). */
  successPct?: number | null;
  /** None left right now: customers can ask to be told when it is back. */
  soldOut?: boolean;
}

/** The customer's saved products and the sold-out packages they wait for. */
export interface Favorites {
  productIds: string[];
  offerIds: string[];
  products: { id: string; slug: string; nameAr: string; nameEn: string; imageUrl: string | null; category: string; fromCents: number | null }[];
}

/** What a customer gives after paying for a product delivered by hand. */
export type AfterType = "email" | "password" | "id" | "username" | "token" | "custom";

export interface AfterFieldDef {
  key?: string;
  type: AfterType;
  labelEn: string;
  labelAr: string;
  hintEn?: string;
  hintAr?: string;
  required: boolean;
}

export interface ProductDetail {
  product: {
    /** Customers' stars (Reviews), when it has any. */
    rating?: { average: number; count: number } | null;
    id: string;
    slug: string;
    category: string;
    kind: Kind;
    imageUrl: string | null;
    /** A wide picture (cover art), when the product has one. */
    coverUrl?: string | null;
    nameAr: string;
    nameEn: string;
    descriptionAr: string;
    descriptionEn: string;
    instructionsAr: string;
    instructionsEn: string;
    warrantyAr: string;
    warrantyEn: string;
    /** Delivered by the store's team (not instantly). */
    byHand?: boolean;
    /** Asked after paying. */
    afterFields?: { key: string; type: AfterType; labelEn: string; labelAr: string; required: boolean }[];
    badge?: ProductBadge | null;
  };
  offers: Offer[];
}

export type OrderStatus = "paid" | "processing" | "delivered" | "failed" | "refunded";

export interface OrderRow {
  id: string;
  number: number;
  status: OrderStatus;
  totalCents: number;
  createdAt: string;
  kind: Kind;
  productAr: string;
  productEn: string;
  packageAr: string;
  packageEn: string;
  /** Waiting for the customer's details ("info") or the team ("owner", "release"). */
  hold?: OrderHold | null;
}

export type OrderHold = "info" | "owner" | "release";

export interface OrderDetail {
  order: {
    id: string;
    number: number;
    status: OrderStatus;
    totalCents: number;
    discountCents: number;
    createdAt: string;
    deliveredAt: string | null;
    input: Record<string, string>;
    productAr: string;
    productEn: string;
    packageAr: string;
    packageEn: string;
    productSlug: string | null;
    fields: { key: string; labelEn: string; labelAr: string | null }[];
    kind?: Kind;
    /** Virtual numbers: when the number ends. */
    expiresAt?: string | null;
    /** Virtual numbers: the number can still be cancelled or reported as already used. */
    numberActions?: boolean;
    hold?: OrderHold | null;
    /** The details asked after paying; secrets come back as null with given: true. */
    afterFields?: {
      key: string; type: AfterType; labelEn: string; labelAr: string; hintEn: string | null; hintAr: string | null;
      required: boolean; value: string | null; given: boolean;
    }[];
    answeredAt?: string | null;
    canAnswer?: boolean;
  };
  deliveries: { kind: string; label: string | null; value: string }[];
}

export interface WalletEntry {
  id: string;
  amountCents: number;
  kind: "topup" | "purchase" | "refund" | "adjustment" | "referral";
  createdAt: string;
  method: PaymentMethod | null;
  productAr: string | null;
  productEn: string | null;
  note: string | null;
}

export interface Wallet {
  balanceCents: number;
  entries: WalletEntry[];
  pending: { id: string; method: PaymentMethod; amountCents: number; status: string; createdAt: string }[];
}

export type PaymentAction =
  | { type: "redirect"; url: string }
  | { type: "address"; network: string; asset: string; address: string; amount: string; memo?: string }
  | { type: "telegram_invoice"; url: string; stars?: number }
  | { type: "instructions"; textEn: string; textAr: string };

export interface CreatedTopup {
  paymentId: string;
  amountCents: number;
  action: PaymentAction;
  expiresAt: string | null;
  /** Pay before this time, by the server's clock. */
  sendBy?: string | null;
  /** Seconds left to pay (the countdown starts from this). */
  secondsLeft?: number;
}

export interface Topup {
  id: string;
  method: PaymentMethod;
  amountCents: number;
  status: "created" | "pending" | "review" | "paid" | "partial" | "failed" | "expired" | "rejected";
  action: PaymentAction | null;
  creditedCents: number | null;
  createdAt: string;
  txHash: string | null;
  /** Manual USDT only: waiting for a hash, checking it on chain, or it did not match. */
  stage: "await_hash" | "checking" | "mismatch" | null;
  /** Pay before this time (15 minutes from the request), by the server's clock. */
  sendBy: string | null;
  /** Seconds left to pay, by the server's clock (the countdown starts from this). */
  secondsLeft?: number;
}

export interface CouponQuote {
  code: string;
  discountCents: number;
  totalCents: number;
}

export type Referral =
  | { enabled: false }
  | { enabled: true; percent: number; days: number; code: string; invited: number; buyers: number; earnedCents: number };

export interface AdminCoupon {
  id: string;
  code: string;
  percentOff: number | null;
  amountOffCents: number | null;
  maxDiscountCents: number | null;
  minOrderCents: number;
  productId: string | null;
  productEn: string | null;
  productAr: string | null;
  maxUses: number | null;
  maxUsesPerUser: number;
  uses: number;
  startsAt: string | null;
  expiresAt: string | null;
  active: boolean;
  note: string;
  createdAt: string;
  discountTotalCents: number;
}
