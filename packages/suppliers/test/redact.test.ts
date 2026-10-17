/** Error texts never carry our secrets, even when a provider echoes a callback URL back. */
import { describe, expect, it } from "vitest";
import { redact } from "../src/shared";
import { redact as redactPayment } from "../../payments/src/util";

describe("redact", () => {
  it("masks the given secrets and secret-looking query values (suppliers)", () => {
    expect(redact("bad key sk_live_123", ["sk_live_123"])).toBe("bad key ***");
    expect(redact("invalid callback_url https://s.test/api/webhooks/suppliers/g2bulk?token=abc123&x=1")).toBe(
      "invalid callback_url https://s.test/api/webhooks/suppliers/g2bulk?token=***&x=1",
    );
    expect(redact("see https://s.test/cb?a=1&secret=zzz")).toBe("see https://s.test/cb?a=1&secret=***");
    expect(redact("token count 3")).toBe("token count 3");
  });

  it("masks the given secrets and secret-looking query values (payments)", () => {
    expect(redactPayment("webhookUrl https://s.test/api/webhooks/payments/sam?token=s3cr3t&pid=9", [])).toBe(
      "webhookUrl https://s.test/api/webhooks/payments/sam?token=[redacted]&pid=9",
    );
    expect(redactPayment("key abcd1234 refused", ["abcd1234"])).toBe("key [redacted] refused");
  });
});
