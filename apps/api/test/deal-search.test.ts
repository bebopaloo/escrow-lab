import { schema, seedUsers } from "@escrow-lab/db";
import { DealListResponse } from "@escrow-lab/shared";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openTestDatabase } from "./database.ts";
import { ALICE, BOB, CAROL, startHarness, type Harness, type TestDatabase } from "./harness.ts";

describe("search and filter the Deal list", () => {
  let database: TestDatabase;
  let h: Harness;
  // A unique tag keeps these Deals apart from the Deals of other test files.
  const tag = randomUUID().slice(0, 8);

  beforeAll(async () => {
    database = await openTestDatabase();
    await seedUsers(database.db);
    h = await startHarness(database);
  });

  afterAll(async () => {
    await h.close();
    await database.close();
  });

  async function insert(title: string, state: "draft" | "cancelled" = "draft", buyerId = ALICE) {
    await database.db
      .insert(schema.deals)
      .values({ buyerId, sellerId: CAROL, title: `${tag} ${title}`, totalMinor: 1000, state });
  }

  async function search(userId: string, query: string) {
    const response = await h.call(userId, "GET", `/api/deals?${query}`);
    return { status: response.statusCode, response };
  }

  const titles = (body: DealListResponse) => body.deals.map((d) => d.title.replace(`${tag} `, ""));

  it("shows only the Deals whose title matches, ignoring case", async () => {
    await insert("Kitchen refit");
    await insert("Garden wall");
    const { response } = await search(ALICE, `q=${encodeURIComponent(`${tag} KITCHEN`)}`);
    const body = DealListResponse.parse(response.json());
    expect(titles(body)).toEqual(["Kitchen refit"]);
    expect(body.total).toBe(1);
  });

  it("returns only the Deals of the user", async () => {
    await insert("Bathroom tiles", "draft", ALICE);
    await insert("Bathroom taps", "draft", BOB);
    const alice = DealListResponse.parse(
      (await search(ALICE, `q=${encodeURIComponent(`${tag} bathroom`)}`)).response.json(),
    );
    expect(titles(alice)).toEqual(["Bathroom tiles"]);
  });

  it("treats % and _ as plain characters", async () => {
    await insert(`Sale 50% off`);
    await insert(`Sale 50 off`);
    await insert(`Item_one`);
    await insert(`ItemXone`);
    const percent = DealListResponse.parse(
      (await search(ALICE, `q=${encodeURIComponent(`${tag} sale 50%`)}`)).response.json(),
    );
    expect(titles(percent)).toEqual(["Sale 50% off"]);
    const underscore = DealListResponse.parse(
      (await search(ALICE, `q=${encodeURIComponent(`${tag} item_one`)}`)).response.json(),
    );
    expect(titles(underscore)).toEqual(["Item_one"]);
  });

  it("treats a backslash as a plain character", async () => {
    await insert(`Path a\\b`);
    await insert(`Path ab`);
    const body = DealListResponse.parse(
      (await search(ALICE, `q=${encodeURIComponent(`${tag} path a\\b`)}`)).response.json(),
    );
    expect(titles(body)).toEqual(["Path a\\b"]);
  });

  it("accepts q of 100 characters and refuses q of 101", async () => {
    expect((await search(ALICE, `q=${"a".repeat(100)}`)).status).toBe(200);
    expect((await search(ALICE, `q=${"a".repeat(101)}`)).status).toBe(400);
  });

  it("refuses an unknown state with 400", async () => {
    expect((await search(ALICE, "state=bogus")).status).toBe(400);
  });

  it("hides cancelled Deals by default and shows them for state=cancelled", async () => {
    await insert("Shed live");
    await insert("Shed dropped", "cancelled");
    const q = encodeURIComponent(`${tag} shed`);
    const all = DealListResponse.parse((await search(ALICE, `q=${q}`)).response.json());
    expect(titles(all)).toEqual(["Shed live"]);
    const cancelled = DealListResponse.parse(
      (await search(ALICE, `q=${q}&state=cancelled`)).response.json(),
    );
    expect(titles(cancelled)).toEqual(["Shed dropped"]);
    expect(cancelled.total).toBe(1);
  });

  it("filters by another state", async () => {
    await insert("Fence");
    const q = encodeURIComponent(`${tag} fence`);
    const funded = DealListResponse.parse(
      (await search(ALICE, `q=${q}&state=funded`)).response.json(),
    );
    expect(funded.deals).toEqual([]);
    expect(funded.total).toBe(0);
    const draft = DealListResponse.parse(
      (await search(ALICE, `q=${q}&state=draft`)).response.json(),
    );
    expect(titles(draft)).toEqual(["Fence"]);
  });

  it("keeps the pagination, and total counts the filtered Deals", async () => {
    for (const n of [1, 2, 3]) await insert(`Paged ${String(n)}`);
    const q = encodeURIComponent(`${tag} paged`);
    const first = DealListResponse.parse(
      (await search(ALICE, `q=${q}&limit=2&offset=0`)).response.json(),
    );
    expect(first.deals).toHaveLength(2);
    expect(first.total).toBe(3);
    const second = DealListResponse.parse(
      (await search(ALICE, `q=${q}&limit=2&offset=2`)).response.json(),
    );
    expect(second.deals).toHaveLength(1);
    expect(second.total).toBe(3);
  });
});
