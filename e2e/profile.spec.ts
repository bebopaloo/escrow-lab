import { execFileSync } from "node:child_process";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const WCAG_22_AA = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

test.beforeAll(() => {
  execFileSync("pnpm", ["db:seed"], { stdio: "ignore" });
});

test("Dan Seller changes the display name and the sign-in page lists it", async ({ page }) => {
  const stamp = Date.now().toString(36);
  const newName = `Dan ${stamp}`;
  await page.goto("/");
  await page.getByRole("button", { name: /Dan Seller/ }).click();
  await page.getByRole("button", { name: "Profile" }).click();
  const input = page.getByRole("textbox", { name: "Display name" });
  const clean = await new AxeBuilder({ page }).withTags(WCAG_22_AA).analyze();
  expect(clean.violations).toEqual([]);
  await input.fill("   ");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(input).toHaveAttribute("aria-invalid", "true");
  const withError = await new AxeBuilder({ page }).withTags(WCAG_22_AA).analyze();
  expect(withError.violations).toEqual([]);
  await input.fill(`  ${newName}  `);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText(`Signed in as ${newName}.`)).toBeVisible();

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("button", { name: new RegExp(newName) })).toBeVisible();

  // Put the seed name back, so other specs and runs find it.
  await page.getByRole("button", { name: new RegExp(newName) }).click();
  await page.getByRole("button", { name: "Profile" }).click();
  await page.getByRole("textbox", { name: "Display name" }).fill("Dan Seller");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Signed in as Dan Seller.")).toBeVisible();
});
