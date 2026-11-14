import { seedUsers } from "@escrow-lab/db";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { openTestDatabase } from "./database.ts";
import {
  accepted,
  approved,
  completed,
  evidenceSent,
  failures,
  funded,
  startHarness,
  type Harness,
  type HarnessOptions,
  type Target,
} from "./harness.ts";
import type { TestDatabase } from "./harness.ts";

interface Scenario {
  options: HarnessOptions;
  /** The states that the build must reach: the Deal, the two Milestones and the Payout. */
  states: string;
  build: (h: Harness) => Promise<Target>;
}

const FIRST_TRANSFER_FAILS: HarnessOptions = {
  chain: [{ kind: "ok" }, { kind: "fail", failure: "timeout" }],
};

/** Each scenario drives a Deal to a state through the API and the retry job. */
const scenarios = {
  draft: {
    states: "draft|pending|pending|-",
    options: {},
    build: async (h) => ({ ...(await h.createDeal()), payoutId: "" }),
  },
  // The rail takes the charge and loses the reply, so the Deal stays in "funding".
  funding: {
    states: "funding|pending|pending|-",
    options: { rail: [{ kind: "lose_reply" }] },
    build: funded,
  },
  // The first lock and the 5 tries of the job all fail.
  fundingFailed: {
    states: "funding_failed|pending|pending|-",
    options: { chain: failures(6) },
    build: async (h) => {
      const ids = await funded(h);
      await h.runJob(ids.dealId, 5);
      return ids;
    },
  },
  funded: {
    states: "funded|awaiting_evidence|pending|-",
    options: {},
    build: funded,
  },
  evidenceSent: {
    states: "funded|evidence_sent|pending|-",
    options: {},
    build: evidenceSent,
  },
  accepted: {
    states: "funded|accepted|pending|-",
    options: {},
    build: accepted,
  },
  paid: {
    states: "funded|paid|awaiting_evidence|confirmed",
    options: {},
    build: approved,
  },
  completed: {
    states: "completed|paid|paid|confirmed",
    options: {},
    build: completed,
  },
  payoutPending: {
    states: "funded|accepted|pending|pending",
    options: FIRST_TRANSFER_FAILS,
    build: approved,
  },
  payoutFailed: {
    states: "funded|accepted|pending|failed",
    options: { chain: [{ kind: "ok" }, ...failures(6)] },
    build: async (h) => {
      const ids = await approved(h);
      await h.runJob(ids.dealId, 5);
      return ids;
    },
  },
} satisfies Record<string, Scenario>;

type ScenarioName = keyof typeof scenarios;
type Which = "first" | "second";

interface Action {
  name: string;
  send: (h: Harness, target: Target, which: Which) => Promise<{ statusCode: number }>;
  /** The states in which the action is refused: a scenario, and the Milestone it aims at. */
  wrong: [ScenarioName, Which][];
}

const actions: Action[] = [
  {
    name: "fund a Deal",
    send: (h, t) => h.fund(t.dealId),
    wrong: [
      ["funding", "first"],
      ["fundingFailed", "first"],
      ["funded", "first"],
      ["completed", "first"],
    ],
  },
  {
    name: "send evidence",
    send: (h, t, which) => h.sendEvidence(t[which]),
    wrong: [
      ["draft", "first"], // pending
      ["funded", "second"], // pending
      ["evidenceSent", "first"],
      ["accepted", "first"],
      ["paid", "first"],
      ["completed", "second"], // paid
    ],
  },
  {
    name: "accept the evidence",
    send: (h, t, which) => h.accept(t[which]),
    wrong: [
      ["draft", "first"], // pending
      ["funded", "second"], // pending
      ["funded", "first"], // awaiting_evidence
      ["accepted", "first"],
      ["paid", "first"],
      ["completed", "second"], // paid
    ],
  },
  {
    name: "reject the evidence",
    send: (h, t, which) => h.reject(t[which]),
    wrong: [
      ["draft", "first"], // pending
      ["funded", "second"], // pending
      ["funded", "first"], // awaiting_evidence
      ["accepted", "first"],
      ["paid", "first"],
      ["completed", "second"], // paid
    ],
  },
  {
    name: "approve a Payout",
    send: (h, t, which) => h.approve(t[which]),
    wrong: [
      ["draft", "first"], // pending
      ["funded", "second"], // pending
      ["funded", "first"], // awaiting_evidence
      ["evidenceSent", "first"],
      ["payoutPending", "first"], // accepted, with a pending Payout
      ["payoutFailed", "first"], // accepted, with a failed Payout
      ["paid", "first"],
      ["completed", "second"], // paid
    ],
  },
  {
    name: "retry a Payout",
    send: (h, t) => h.retry(t.payoutId),
    wrong: [
      ["payoutPending", "first"],
      ["paid", "first"], // confirmed
      ["completed", "second"], // confirmed
    ],
  },
];

describe("state rules: a wrong-state action returns 409 and changes nothing", () => {
  let database: TestDatabase;
  const harnesses: Harness[] = [];

  beforeAll(async () => {
    database = await openTestDatabase();
    await seedUsers(database.db);
  });

  afterEach(async () => {
    for (const h of harnesses.splice(0)) await h.close();
  });

  afterAll(async () => {
    await database.close();
  });

  for (const action of actions) {
    describe(action.name, () => {
      it.each(action.wrong)("is refused in %s (Milestone: %s)", async (name, which) => {
        const scenario: Scenario = scenarios[name];
        const h = await startHarness(database, scenario.options);
        harnesses.push(h);
        const target = await scenario.build(h);
        const before = await h.snapshot(target.dealId);
        const reached = [
          before.deal[0]?.state,
          before.milestones[0]?.state,
          before.milestones[1]?.state,
          before.payouts[0]?.state ?? "-",
        ].join("|");
        expect(reached).toBe(scenario.states);

        const response = await action.send(h, target, which);

        expect(response.statusCode).toBe(409);
        expect(await h.snapshot(target.dealId)).toEqual(before);
      });
    });
  }
});
