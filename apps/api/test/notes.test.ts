import { SEED_USERS, seedUsers } from "@escrow-lab/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openTestDatabase } from "./database.ts";
import {
  ALICE,
  CAROL,
  ERIN,
  signIn,
  startHarness,
  type Harness,
  type TestDatabase,
} from "./harness.ts";

const BOB = SEED_USERS[1]?.id ?? "";
const DAN = SEED_USERS[3]?.id ?? "";

describe("notes on a Deal", () => {
  let database: TestDatabase;
  let h: Harness;
  let dealId: string;

  beforeAll(async () => {
    database = await openTestDatabase();
    await seedUsers(database.db);
    h = await startHarness(database);
    dealId = (await h.createDeal()).dealId;
  });

  afterAll(async () => {
    await h.close();
    await database.close();
  });

  const notes = (userId: string) => h.call(userId, "GET", `/api/deals/${dealId}/notes`);
  const addNote = (userId: string, text: unknown) =>
    h.call(userId, "POST", `/api/deals/${dealId}/notes`, { text });

  it("lets the Buyer and the Seller add notes that both see, newest first, with author and time", async () => {
    const first = await addNote(ALICE, "Please send the draft by Friday.");
    expect(first.statusCode).toBe(201);
    const second = await addNote(CAROL, "Will do.");
    expect(second.statusCode).toBe(201);

    for (const viewer of [ALICE, CAROL]) {
      const response = await notes(viewer);
      expect(response.statusCode).toBe(200);
      const body = response.json<{
        notes: { text: string; authorId: string; authorName: string; createdAt: string }[];
      }>();
      expect(body.notes.map((n) => [n.text, n.authorId, n.authorName])).toEqual([
        ["Will do.", CAROL, "Carol Seller"],
        ["Please send the draft by Friday.", ALICE, "Alice Buyer"],
      ]);
      expect(Number.isNaN(Date.parse(body.notes[0]?.createdAt ?? ""))).toBe(false);
    }
  });

  it("answers 404 to another Buyer or Seller, on read and on write", async () => {
    for (const outsider of [BOB, DAN]) {
      expect((await notes(outsider)).statusCode).toBe(404);
      expect((await addNote(outsider, "Hello")).statusCode).toBe(404);
    }
  });

  it("answers 403 to an Approver, on read and on write", async () => {
    expect((await notes(ERIN)).statusCode).toBe(403);
    expect((await addNote(ERIN, "Hello")).statusCode).toBe(403);
  });

  it("refuses an empty note, a note of only spaces and a note over 1,000 characters", async () => {
    const before = (await notes(ALICE)).json<{ notes: unknown[] }>().notes.length;
    expect((await addNote(ALICE, "")).statusCode).toBe(400);
    expect((await addNote(ALICE, "   ")).statusCode).toBe(400);
    expect((await addNote(ALICE, "x".repeat(1001))).statusCode).toBe(400);
    expect((await addNote(ALICE, "x".repeat(1000))).statusCode).toBe(201);
    const after = (await notes(ALICE)).json<{ notes: unknown[] }>().notes.length;
    expect(after).toBe(before + 1);
  });

  it("refuses unknown fields in the body", async () => {
    const response = await h.call(ALICE, "POST", `/api/deals/${dealId}/notes`, {
      text: "Hi",
      authorId: CAROL,
    });
    expect(response.statusCode).toBe(400);
  });

  it("refuses a note without a session, and a note without the CSRF token", async () => {
    const anonymous = await h.app.inject({
      method: "POST",
      url: `/api/deals/${dealId}/notes`,
      payload: { text: "Hi" },
    });
    expect(anonymous.statusCode).toBe(401);
    const session = await signIn(h.app, ALICE);
    const noToken = await h.app.inject({
      method: "POST",
      url: `/api/deals/${dealId}/notes`,
      headers: { cookie: session.cookie },
      payload: { text: "Hi" },
    });
    expect(noToken.statusCode).toBe(403);
  });
});
