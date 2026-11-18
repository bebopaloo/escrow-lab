import { schema, seedUsers } from "@escrow-lab/db";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { openTestDatabase } from "./database.ts";
import {
  ALICE,
  CAROL,
  ERIN,
  accepted,
  approved,
  evidenceSent,
  failures,
  funded,
  startHarness,
  type Harness,
  type HarnessOptions,
  type Target,
  type TestDatabase,
} from "./harness.ts";

interface AuditCase {
  action: string;
  /** The test name, when it differs from the action: a Control ID tags a money or authority action. */
  name?: string;
  /** The user that the event names. */
  user: string;
  options?: HarnessOptions;
  /** Brings the Deal to the state just before the trigger. */
  setup: (h: Harness) => Promise<Target>;
  /** The one step that must write the event. */
  trigger: (h: Harness, target: Target) => Promise<unknown>;
  /** Whether the event names the Deal. Sign in does not. */
  withDeal?: boolean;
}

const noDeal = (): Promise<Target> =>
  Promise.resolve({ dealId: "", first: "", second: "", payoutId: "" });
const draft = async (h: Harness): Promise<Target> => ({ ...(await h.createDeal()), payoutId: "" });

const cases: AuditCase[] = [
  {
    action: "sign_in",
    user: ALICE,
    setup: noDeal,
    trigger: (h) => h.call(ALICE, "GET", "/api/deals"),
    withDeal: false,
  },
  { action: "create_deal", user: ALICE, setup: noDeal, trigger: (h) => h.createDeal() },
  {
    action: "fund",
    name: "[CTRL-AUD-01] fund",
    user: ALICE,
    setup: draft,
    trigger: (h, t) => h.fund(t.dealId),
  },
  { action: "funding_confirmed", user: ALICE, setup: draft, trigger: (h, t) => h.fund(t.dealId) },
  {
    // The first lock and the 5 tries of the job all fail.
    action: "funding_failed",
    user: ALICE,
    options: { chain: failures(6) },
    setup: async (h) => {
      const ids = await draft(h);
      await h.step(h.fund(ids.dealId));
      return ids;
    },
    trigger: (h, t) => h.runJob(t.dealId, 5),
  },
  {
    action: "send_evidence",
    user: CAROL,
    setup: funded,
    trigger: (h, t) => h.sendEvidence(t.first),
  },
  {
    action: "add_note",
    user: CAROL,
    setup: draft,
    trigger: (h, t) =>
      h.call(CAROL, "POST", `/api/deals/${t.dealId}/notes`, { text: "A note for the Buyer." }),
  },
  { action: "accept", user: ALICE, setup: evidenceSent, trigger: (h, t) => h.accept(t.first) },
  { action: "reject", user: ALICE, setup: evidenceSent, trigger: (h, t) => h.reject(t.first) },
  {
    action: "approve_payout",
    name: "[CTRL-AUD-01] approve_payout",
    user: ERIN,
    setup: accepted,
    trigger: (h, t) => h.approve(t.first),
  },
  {
    action: "payout_confirmed",
    user: ERIN,
    setup: accepted,
    trigger: (h, t) => h.approve(t.first),
  },
  {
    // The first transfer and the 5 tries of the job all fail.
    action: "payout_failed",
    user: ERIN,
    options: { chain: [{ kind: "ok" }, ...failures(6)] },
    setup: approved,
    trigger: (h, t) => h.runJob(t.dealId, 5),
  },
  {
    action: "retry_payout",
    name: "[CTRL-AUD-01] retry_payout",
    user: ERIN,
    options: { chain: [{ kind: "ok" }, ...failures(6)] },
    setup: async (h) => {
      const ids = await approved(h);
      await h.runJob(ids.dealId, 5);
      return ids;
    },
    trigger: (h, t) => h.retry(t.payoutId),
  },
];

describe("audit trail: each action writes one event with the user, the action, the Deal and the time", () => {
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

  it.each(cases.map((item) => ({ ...item, name: item.name ?? item.action })))(
    "$name",
    async (item) => {
      const h = await startHarness(database, item.options);
      harnesses.push(h);
      const target = await item.setup(h);
      const known = new Set((await database.db.select().from(schema.auditEvents)).map((e) => e.id));
      const startedAt = Date.now();

      await item.trigger(h, target);

      const written = (await database.db.select().from(schema.auditEvents)).filter(
        (event) => !known.has(event.id) && event.action === item.action,
      );
      expect(written).toHaveLength(1);
      const [event] = written;
      expect(event?.userId).toBe(item.user);
      // The Deal of a "create_deal" event is new, so the test reads it from the event.
      if (item.withDeal === false) expect(event?.dealId).toBeNull();
      else if (item.action === "create_deal") expect(event?.dealId).toEqual(expect.any(String));
      else expect(event?.dealId).toBe(target.dealId);
      const writtenAt = event?.createdAt.getTime() ?? 0;
      expect(writtenAt).toBeGreaterThanOrEqual(startedAt - 5_000);
      expect(writtenAt).toBeLessThanOrEqual(Date.now() + 5_000);
    },
  );
});
