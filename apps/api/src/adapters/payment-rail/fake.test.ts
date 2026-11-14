import { describe, expect, it, vi } from "vitest";
import { createFakePaymentRail } from "./fake.ts";

describe("fake payment rail", () => {
  it("charges a buyer and returns a transaction id", async () => {
    const rail = createFakePaymentRail();
    const charge = await rail.charge("buyer-1", 500, "key-1");
    expect(charge.ok && charge.txId.length > 0).toBe(true);
    expect(rail.moved).toBe(500);
  });

  it("returns the first result for the same key, amount and party", async () => {
    const rail = createFakePaymentRail();
    const first = await rail.charge("buyer-1", 500, "key-1");
    expect(await rail.charge("buyer-1", 500, "key-1")).toEqual(first);
    expect(rail.moved).toBe(500);
  });

  it("rejects a known key with a different amount or party", async () => {
    const rail = createFakePaymentRail();
    await rail.charge("buyer-1", 500, "key-1");
    expect(await rail.charge("buyer-1", 501, "key-1")).toEqual({
      ok: false,
      failure: "key_conflict",
    });
    expect(await rail.charge("buyer-2", 500, "key-1")).toEqual({
      ok: false,
      failure: "key_conflict",
    });
    expect(rail.moved).toBe(500);
  });

  it("rejects an amount that is not a non-negative integer", async () => {
    const rail = createFakePaymentRail();
    expect(await rail.charge("buyer-1", 0.5, "key-1")).toEqual({
      ok: false,
      failure: "invalid_amount",
    });
    expect(rail.moved).toBe(0);
  });
});

describe("fake payment rail failure script", () => {
  it("fails a call with a typed failure, has no effect and stores no key", async () => {
    const rail = createFakePaymentRail([{ kind: "fail", failure: "refused" }]);
    expect(await rail.charge("buyer-1", 500, "key-1")).toEqual({ ok: false, failure: "refused" });
    expect(rail.moved).toBe(0);
    expect((await rail.charge("buyer-1", 900, "key-1")).ok).toBe(true);
  });

  it("loses the reply: the charge happens once and a retry returns the first result", async () => {
    const rail = createFakePaymentRail([{ kind: "lose_reply" }]);
    expect(await rail.charge("buyer-1", 500, "key-1")).toEqual({ ok: false, failure: "timeout" });
    expect((await rail.charge("buyer-1", 500, "key-1")).ok).toBe(true);
    expect(rail.moved).toBe(500);
  });

  it("delays a call", async () => {
    vi.useFakeTimers();
    try {
      const rail = createFakePaymentRail([{ kind: "delay", ms: 1000 }]);
      let done = false;
      const call = rail.charge("buyer-1", 500, "key-1").then((result) => {
        done = true;
        return result;
      });
      await vi.advanceTimersByTimeAsync(999);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect((await call).ok).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("records a duplicate event while the charge happens once", async () => {
    const rail = createFakePaymentRail([{ kind: "duplicate_event" }]);
    expect((await rail.charge("buyer-1", 500, "key-1")).ok).toBe(true);
    expect(rail.moved).toBe(500);
    expect(rail.events).toHaveLength(2);
  });
});
