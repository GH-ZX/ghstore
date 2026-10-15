/** Shapes of the API responses the web app uses (see packages/api). */

export type Lang = "ar" | "en";
export type Role = "customer" | "support" | "owner";
export type PaymentMethod = "sam" | "nowpayments" | "bep20" | "stars";
export type Kind = "id" | "code" | "account" | "link" | "sms";

export interface PublicConfig {
  theme: { preset: "calm" | "energetic" | "minimal" | "warm"; defaultMode: "system" | "light" | "dark" };
  sypPerUsd: number | null;
  payments: { methods: PaymentMethod[]; minCents: number; maxCents: number };
  login: ("telegram" | "email" | "google")[];
  supabase: { url: string; key: string } | null;
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
  };
  balanceCents: number;
  stats: { orders: number; spentCents: number };
  channel: "web" | "miniapp" | "admin";
}

export interface Category {
  slug: string;
  nameAr: string;
  nameEn: string;
}

export interface ProductCard {
  id: string;
  slug: string;
  category: string;
  nameAr: string;
  nameEn: string;
  kind: Kind;
  imageUrl: string | null;
  featured: boolean;
  fromCents: number;
  packages: number;
  searchTerms: string;
}

export interface InputField {
  key: string;
  labelEn: string;
  labelAr?: string;
  required: boolean;
  pattern?: string;
}

export interface Offer {
  id: string;
  nameAr: string;
  nameEn: string;
  priceCents: number;
  fields: InputField[];
  maxQuantity: number;
}

export interface ProductDetail {
  product: {
    id: string;
    slug: string;
    category: string;
    kind: Kind;
    imageUrl: string | null;
    nameAr: string;
    nameEn: string;
    descriptionAr: string;
    descriptionEn: string;
    instructionsAr: string;
    instructionsEn: string;
    warrantyAr: string;
    warrantyEn: string;
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
}

export interface OrderDetail {
  order: {
    id: string;
    number: number;
    status: OrderStatus;
    totalCents: number;
    createdAt: string;
    deliveredAt: string | null;
    input: Record<string, string>;
    productAr: string;
    productEn: string;
    packageAr: string;
    packageEn: string;
    fields: { key: string; labelEn: string; labelAr: string | null }[];
  };
  deliveries: { kind: string; label: string | null; value: string }[];
}

export interface WalletEntry {
  id: string;
  amountCents: number;
  kind: "topup" | "purchase" | "refund" | "adjustment";
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
  | { type: "telegram_invoice"; url: string }
  | { type: "instructions"; textEn: string; textAr: string };

export interface CreatedTopup {
  paymentId: string;
  amountCents: number;
  action: PaymentAction;
  expiresAt: string | null;
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
}
