export type Failure = "refused" | "timeout" | "key_conflict" | "invalid_amount";

export type Result = { ok: true; txId: string } | { ok: false; failure: Failure };

export type Step =
  | { kind: "ok" }
  | { kind: "delay"; ms: number }
  | { kind: "fail"; failure: Failure }
  | { kind: "lose_reply" }
  | { kind: "duplicate_event" };

export interface FakeEvent {
  txId: string;
  party: string;
  amount: number;
  key: string;
}

export interface FakeCore {
  readonly moved: number;
  readonly events: readonly FakeEvent[];
  run(party: string, amount: number, key: string): Promise<Result>;
}

interface Seen {
  party: string;
  amount: number;
  result: Result;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** In-memory core of a fake partner. The script is for test use: the next calls take its steps in order. */
export function createFakeCore(script: readonly Step[] = []): FakeCore {
  const steps = [...script];
  const seen = new Map<string, Seen>();
  const events: FakeEvent[] = [];
  let moved = 0;
  let counter = 0;

  return {
    get moved() {
      return moved;
    },
    get events() {
      return events;
    },
    async run(party, amount, key) {
      const step: Step = steps.shift() ?? { kind: "ok" };
      if (step.kind === "delay") await sleep(step.ms);
      if (step.kind === "fail") return { ok: false, failure: step.failure };
      if (!Number.isInteger(amount) || amount < 0) return { ok: false, failure: "invalid_amount" };
      const known = seen.get(key);
      if (known) {
        if (known.party !== party || known.amount !== amount) {
          return { ok: false, failure: "key_conflict" };
        }
        return known.result;
      }
      counter += 1;
      const txId = `tx-${String(counter)}`;
      const result: Result = { ok: true, txId };
      seen.set(key, { party, amount, result });
      moved += amount;
      const event = { txId, party, amount, key };
      events.push(event);
      if (step.kind === "duplicate_event") events.push({ ...event });
      if (step.kind === "lose_reply") return { ok: false, failure: "timeout" };
      return result;
    },
  };
}
