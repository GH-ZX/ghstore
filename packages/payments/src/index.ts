/**
 * Payment adapters: SAM (ShamCash / Syriatel Cash), NOWPayments (USDT), manual
 * USDT BEP20, and Telegram Stars. Each factory takes an AdapterContext and reads
 * its keys from ctx.config only; see the top of each module for the keys.
 */
import type { PaymentFactory, PaymentMethod } from "../../core/src/adapters";
import { createBep20 } from "./bep20";
import { createNowPayments } from "./nowpayments";
import { createSam } from "./sam";
import { createStars } from "./stars";

export const paymentFactories: Record<PaymentMethod, PaymentFactory> = {
  sam: createSam,
  nowpayments: createNowPayments,
  bep20: createBep20,
  stars: createStars,
};

export {
  createSam,
  resolveSamWallet,
  samChargeAmount,
  samInvoiceToEvent,
  SAM_DEFAULT_BASE_URL,
  type SamAdapter,
  type SamCurrency,
  type SamInvoice,
  type SamMethod,
  type SamReferenceResult,
} from "./sam";

export {
  createNowPayments,
  mapNowPaymentsStatus,
  nowPaymentsSignature,
  nowPaymentsToEvent,
  sortKeysDeep,
  verifyNowPaymentsSignature,
  NOWPAYMENTS_DEFAULT_BASE_URL,
  NOWPAYMENTS_DEFAULT_PAY_CURRENCY,
  NOWPAYMENTS_SIGNATURE_HEADER,
  type NowPaymentsAdapter,
} from "./nowpayments";

export {
  createBep20,
  sumTransfers,
  unitsToCents,
  verifyTransfer,
  BEP20_NETWORK_LABEL,
  BSC_DEFAULT_RPC_URL,
  BSC_USDT_CONTRACT,
  TRANSFER_TOPIC,
  type Bep20Adapter,
  type Bep20Reason,
  type Bep20Verification,
  type VerifyTransferOptions,
} from "./bep20";

export {
  answerPreCheckout,
  centsForStars,
  createStars,
  parsePreCheckoutQuery,
  parseSuccessfulPayment,
  starsForCents,
  TELEGRAM_DEFAULT_API_BASE,
  type StarsAdapter,
  type StarsPreCheckout,
} from "./stars";
