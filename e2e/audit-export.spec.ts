import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { expect, test } from "@playwright/test";

test.beforeAll(() => {
  execFileSync("pnpm", ["db:seed"], { stdio: "ignore" });
});

test("a Buyer downloads the audit trail of a Deal as a CSV", async ({ page }) => {
  const title = `Audit ${Date.now().toString()}`;
  await page.goto("/");
  await page.getByRole("button", { name: /Bob Buyer/ }).click();
  await page.getByRole("button", { name: "Create a Deal" }).click();
  await page.getByLabel("Seller").selectOption({ label: "Carol Seller" });
  await page.getByLabel("Deal title").fill(title);
  await page.getByLabel("Total (£)").fill("1000");
  await page.getByLabel("Milestone 1 title").fill("Draft");
  await page.getByLabel("Milestone 1 amount (£)").fill("1000");
  await page.getByRole("button", { name: "Create the Deal" }).click();
  await expect(page.getByRole("heading", { name: title })).toBeFocused();

  const download = page.waitForEvent("download");
  await page.getByRole("link", { name: "Export audit trail" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^audit-.*\.csv$/);
  const text = await readFile(await file.path(), "utf8");
  expect(text).toContain('"Time","User","Action"');
  expect(text).toContain('"Bob Buyer","create_deal"');
});
