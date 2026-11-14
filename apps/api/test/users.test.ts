import { UsersResponse } from "@escrow-lab/shared";
import { seedUsers } from "@escrow-lab/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { openTestDatabase, testConfig } from "./database.ts";

describe("GET /api/users", () => {
  let database: Awaited<ReturnType<typeof openTestDatabase>>;

  beforeAll(async () => {
    database = await openTestDatabase();
    await seedUsers(database.db);
  });

  afterAll(async () => {
    await database.close();
  });

  it("lists the seeded users without a session", async () => {
    const app = await buildApp({ config: testConfig, db: database.db, logger: false });
    const response = await app.inject({ method: "GET", url: "/api/users" });
    expect(response.statusCode).toBe(200);
    const body = UsersResponse.parse(response.json());
    expect(body.users).toHaveLength(6);
    for (const role of ["buyer", "seller", "approver"]) {
      expect(body.users.filter((user) => user.role === role)).toHaveLength(2);
    }
    await app.close();
  });
});
