import { execFileSync } from "node:child_process";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const WCAG_22_AA = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

test.beforeAll(() => {
  // The seed uses DATABASE_URL, like `pnpm dev`, so both reach the same database.
  execFileSync("pnpm", ["db:seed"], { stdio: "ignore" });
});

test("a Buyer signs in and sees the Deal list, then an Approver sees the approval queue", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await page.getByRole("button", { name: /Alice Buyer/ }).click();
  await expect(page.getByRole("heading", { name: "Deals" })).toBeVisible();

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await page.getByRole("button", { name: /Erin Approver/ }).click();
  await expect(page.getByRole("heading", { name: "Approval queue" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Deals" })).toHaveCount(0);
});

test("the sign-in page has no WCAG 2.2 AA violations", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: /Alice Buyer/ })).toBeVisible();
  const results = await new AxeBuilder({ page }).withTags(WCAG_22_AA).analyze();
  expect(results.violations).toEqual([]);
});
