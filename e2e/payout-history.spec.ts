import { execFileSync } from "node:child_process";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const WCAG_22_AA = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

test.beforeAll(() => {
  execFileSync("pnpm", ["db:seed"], { stdio: "ignore" });
});

test("a Seller opens the Payout history and a Buyer has no link to it", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /Carol Seller/ }).click();
  await page.getByRole("button", { name: "Payout history" }).click();
  await expect(page.getByRole("heading", { name: "Payout history" })).toBeFocused();
  // Carol has a table of Payouts once a journey has run, and an empty note before.
  await expect(
    page.getByRole("table").or(page.getByText("You have no Payouts yet.")),
  ).toBeVisible();
  const results = await new AxeBuilder({ page }).withTags(WCAG_22_AA).analyze();
  expect(results.violations).toEqual([]);

  await page.getByRole("button", { name: "Sign out" }).click();
  await page.getByRole("button", { name: /Bob Buyer/ }).click();
  await expect(page.getByRole("heading", { name: "Deals" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Payout history" })).toHaveCount(0);
});
