import { execFileSync } from "node:child_process";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const WCAG_22_AA = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

test.beforeAll(() => {
  execFileSync("pnpm", ["db:seed"], { stdio: "ignore" });
});

test("a Buyer creates a Deal and the Seller sees it", async ({ page }) => {
  const title = `Logo design ${Date.now().toString()}`;
  await page.goto("/");
  await page.getByRole("button", { name: /Bob Buyer/ }).click();
  await page.getByRole("button", { name: "Create a Deal" }).click();
  await expect(page.getByRole("heading", { name: "Create a Deal" })).toBeFocused();

  await page.getByLabel("Seller").selectOption({ label: "Carol Seller" });
  await page.getByLabel("Deal title").fill(title);
  await page.getByLabel("Total (£)").fill("1000");
  await page.getByLabel("Milestone 1 title").fill("Draft");
  await page.getByLabel("Milestone 1 amount (£)").fill("400");
  await page.getByRole("button", { name: "Add a Milestone" }).click();
  await page.getByLabel("Milestone 2 title").fill("Final");
  await page.getByLabel("Milestone 2 amount (£)").fill("500");
  await page.getByRole("button", { name: "Create the Deal" }).click();
  await expect(page.getByRole("alert")).toHaveText("The Milestones must add up to the total.");
  const refusalScan = await new AxeBuilder({ page }).withTags(WCAG_22_AA).analyze();
  expect(refusalScan.violations).toEqual([]);

  await page.getByLabel("Milestone 2 amount (£)").fill("600");
  await page.getByRole("button", { name: "Create the Deal" }).click();
  await expect(page.getByRole("heading", { name: title })).toBeFocused();
  await expect(page.getByText("£600.00")).toBeVisible();
  const results = await new AxeBuilder({ page }).withTags(WCAG_22_AA).analyze();
  expect(results.violations).toEqual([]);

  await page.getByRole("button", { name: "Sign out" }).click();
  await page.getByRole("button", { name: /Carol Seller/ }).click();
  await expect(page.getByRole("link", { name: title })).toBeVisible();
  await expect(page.getByRole("button", { name: "Create a Deal" })).toHaveCount(0);
  const listScan = await new AxeBuilder({ page }).withTags(WCAG_22_AA).analyze();
  expect(listScan.violations).toEqual([]);

  await page.getByRole("button", { name: "Sign out" }).click();
  await page.getByRole("button", { name: /Dan Seller/ }).click();
  await expect(page.getByRole("heading", { name: "Deals" })).toBeVisible();
  await expect(page.getByRole("link", { name: title })).toHaveCount(0);
});
