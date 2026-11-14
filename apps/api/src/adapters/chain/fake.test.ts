import { describe, expect, it, vi } from "vitest";
import { createFakeChain } from "./fake.ts";

describe("fake chain", () => {
  it("locks and transfers money and returns a transaction id", async () => {
    const chain = createFakeChain();
    const lock = await chain.lock("deal-1", 500, "key-1");
    const transfer = await chain.transfer("seller-1", 200, "key-2");
    expect(lock.ok && lock.txId.length > 0).toBe(true);
    expect(transfer.ok && transfer.txId.length > 0).toBe(true);
    expect(chain.moved).toBe(700);
  });

  it("returns the first result for the same key, amount and party", async () => {
    const chain = createFakeChain();
    const first = await chain.lock("deal-1", 500, "key-1");
    const again = await chain.lock("deal-1", 500, "key-1");
    expect(again).toEqual(first);
    expect(chain.moved).toBe(500);
  });

  it("rejects a known key with a different amount or party", async () => {
    const chain = createFakeChain();
    await chain.lock("deal-1", 500, "key-1");
    await chain.transfer("seller-1", 200, "key-2");
    expect(await chain.lock("deal-1", 501, "key-1")).toEqual({
      ok: false,
      failure: "key_conflict",
    });
    expect(await chain.lock("deal-2", 500, "key-1")).toEqual({
      ok: false,
      failure: "key_conflict",
    });
    expect(await chain.transfer("seller-1", 201, "key-2")).toEqual({
      ok: false,
      failure: "key_conflict",
    });
    expect(await chain.transfer("seller-2", 200, "key-2")).toEqual({
      ok: false,
      failure: "key_conflict",
    });
    expect(chain.moved).toBe(700);
  });

  it("rejects an amount that is not a non-negative integer", async () => {
    const chain = createFakeChain();
    expect(await chain.lock("deal-1", 1.5, "key-1")).toEqual({
      ok: false,
      failure: "invalid_amount",
    });
    expect(await chain.lock("deal-1", -1, "key-2")).toEqual({
      ok: false,
      failure: "invalid_amount",
    });
    expect(chain.moved).toBe(0);
  });
});

describe("fake chain failure script", () => {
  it("fails a call with a typed failure, has no effect and stores no key", async () => {
    const chain = createFakeChain([{ kind: "fail", failure: "refused" }]);
    expect(await chain.lock("deal-1", 500, "key-1")).toEqual({ ok: false, failure: "refused" });
    expect(chain.moved).toBe(0);
    const retry = await chain.lock("deal-1", 900, "key-1");
    expect(retry.ok).toBe(true);
    expect(chain.moved).toBe(900);
  });

  it("loses the reply: the effect happens and a retry returns the first result", async () => {
    const chain = createFakeChain([{ kind: "lose_reply" }]);
    expect(await chain.lock("deal-1", 500, "key-1")).toEqual({ ok: false, failure: "timeout" });
    expect(chain.moved).toBe(500);
    const retry = await chain.lock("deal-1", 500, "key-1");
    expect(retry.ok).toBe(true);
    expect(chain.moved).toBe(500);
    expect(chain.events).toHaveLength(1);
  });

  it("delays a call", async () => {
    vi.useFakeTimers();
    try {
      const chain = createFakeChain([{ kind: "delay", ms: 1000 }]);
      let done = false;
      const call = chain.lock("deal-1", 500, "key-1").then((result) => {
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

  it("records a duplicate event while the effect happens once", async () => {
    const chain = createFakeChain([{ kind: "duplicate_event" }]);
    const result = await chain.lock("deal-1", 500, "key-1");
    expect(result.ok).toBe(true);
    expect(chain.moved).toBe(500);
    expect(chain.events).toHaveLength(2);
    expect(chain.events[0]).toEqual(chain.events[1]);
  });

  it("uses one step for each call, in order, then succeeds", async () => {
    const chain = createFakeChain([{ kind: "ok" }, { kind: "fail", failure: "timeout" }]);
    expect((await chain.lock("deal-1", 1, "a")).ok).toBe(true);
    expect((await chain.lock("deal-1", 1, "b")).ok).toBe(false);
    expect((await chain.lock("deal-1", 1, "c")).ok).toBe(true);
  });
});
