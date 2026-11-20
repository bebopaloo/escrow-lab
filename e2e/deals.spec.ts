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

test("a Buyer funds a Deal and the first Milestone opens", async ({ page }) => {
  const title = `Fund me ${Date.now().toString()}`;
  await page.goto("/");
  await page.getByRole("button", { name: /Bob Buyer/ }).click();
  await page.getByRole("button", { name: "Create a Deal" }).click();
  await page.getByLabel("Seller").selectOption({ label: "Carol Seller" });
  await page.getByLabel("Deal title").fill(title);
  await page.getByLabel("Total (£)").fill("1000");
  await page.getByLabel("Milestone 1 title").fill("Draft");
  await page.getByLabel("Milestone 1 amount (£)").fill("400");
  await page.getByRole("button", { name: "Add a Milestone" }).click();
  await page.getByLabel("Milestone 2 title").fill("Final");
  await page.getByLabel("Milestone 2 amount (£)").fill("600");
  await page.getByRole("button", { name: "Create the Deal" }).click();
  await expect(page.getByRole("heading", { name: title })).toBeFocused();

  await page.getByRole("button", { name: "Fund the Deal" }).click();
  await expect(page.getByText("The Deal is funded.")).toBeVisible();
  await expect(page.getByRole("heading", { name: title })).toBeFocused();
  await expect(page.getByRole("button", { name: "Fund the Deal" })).toHaveCount(0);
  await expect(page.getByRole("row", { name: /Draft.*awaiting evidence/ })).toBeVisible();
  const results = await new AxeBuilder({ page }).withTags(WCAG_22_AA).analyze();
  expect(results.violations).toEqual([]);
});

test("a Seller sends evidence, the Buyer rejects it, then accepts the new evidence, and an Approver pays it", async ({
  page,
}) => {
  const title = `Evidence ${Date.now().toString()}`;
  await page.goto("/");
  await page.getByRole("button", { name: /Bob Buyer/ }).click();
  await page.getByRole("button", { name: "Create a Deal" }).click();
  await page.getByLabel("Seller").selectOption({ label: "Carol Seller" });
  await page.getByLabel("Deal title").fill(title);
  await page.getByLabel("Total (£)").fill("1000");
  await page.getByRole("checkbox", { name: /Express/ }).uncheck();
  await page.getByLabel("Milestone 1 title").fill("Draft");
  await page.getByLabel("Milestone 1 amount (£)").fill("1000");
  await page.getByRole("button", { name: "Create the Deal" }).click();
  await expect(page.getByRole("heading", { name: title })).toBeFocused();
  await page.getByRole("button", { name: "Fund the Deal" }).click();
  await expect(page.getByText("The Deal is funded.")).toBeVisible();
  await page.getByRole("button", { name: "Sign out" }).click();

  await page.getByRole("button", { name: /Carol Seller/ }).click();
  await page.getByRole("link", { name: title }).click();
  await page.getByLabel("Evidence", { exact: true }).fill("First link");
  const formScan = await new AxeBuilder({ page }).withTags(WCAG_22_AA).analyze();
  expect(formScan.violations).toEqual([]);
  await page.getByRole("button", { name: "Send evidence" }).click();
  await expect(page.getByText("The evidence is sent.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Evidence for Milestone 1" })).toBeFocused();
  await page.getByRole("button", { name: "Sign out" }).click();

  await page.getByRole("button", { name: /Bob Buyer/ }).click();
  await page.getByRole("link", { name: title }).click();
  await expect(page.getByText("First link")).toBeVisible();
  const reviewScan = await new AxeBuilder({ page }).withTags(WCAG_22_AA).analyze();
  expect(reviewScan.violations).toEqual([]);
  await page.getByLabel("Reason for rejection").fill("Wrong file");
  await page.getByRole("button", { name: "Reject the evidence" }).click();
  await expect(page.getByText("The evidence is rejected.")).toBeVisible();
  await page.getByRole("button", { name: "Sign out" }).click();

  await page.getByRole("button", { name: /Carol Seller/ }).click();
  await page.getByRole("link", { name: title }).click();
  await expect(page.getByText("Wrong file")).toBeVisible();
  await page.getByLabel("Evidence", { exact: true }).fill("Second link");
  await page.getByRole("button", { name: "Send evidence" }).click();
  await expect(page.getByText("The evidence is sent.")).toBeVisible();
  await page.getByRole("button", { name: "Sign out" }).click();

  await page.getByRole("button", { name: /Bob Buyer/ }).click();
  await page.getByRole("link", { name: title }).click();
  await page.getByRole("button", { name: "Accept the evidence" }).click();
  await expect(page.getByText("The evidence is accepted.")).toBeVisible();
  await expect(page.getByRole("row", { name: /Draft.*accepted/ })).toBeVisible();
  const doneScan = await new AxeBuilder({ page }).withTags(WCAG_22_AA).analyze();
  expect(doneScan.violations).toEqual([]);

  await page.getByRole("button", { name: "Sign out" }).click();
  await page.getByRole("button", { name: /Erin Approver/ }).click();
  await expect(page.getByRole("heading", { name: "Approval queue" })).toBeVisible();
  // The Deal is funded with no Payout, so it also has a refundable item. Pick the Milestone item.
  const entry = page
    .getByRole("listitem")
    .filter({ hasText: `Milestone 1: Draft` })
    .filter({ hasText: title });
  await expect(entry).toBeVisible();
  const queueScan = await new AxeBuilder({ page }).withTags(WCAG_22_AA).analyze();
  expect(queueScan.violations).toEqual([]);
  await entry.getByRole("button", { name: "Approve the Payout for Draft" }).click();
  await expect(page.getByText("The Payout for Draft is paid.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Approval queue" })).toBeFocused();
  await expect(page.getByRole("listitem").filter({ hasText: title })).toHaveCount(0);
});

test("a Buyer and a Seller add notes to a Deal and both see them, newest first", async ({
  page,
}) => {
  const title = `Remarks ${Date.now().toString()}`;
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

  await page.getByLabel("Add a note").fill("Please send the draft by Friday.");
  await page.getByRole("button", { name: "Add the note" }).click();
  await expect(page.getByRole("region", { name: "Notes" }).getByRole("listitem")).toHaveCount(1);
  await expect(page.getByLabel("Add a note")).toHaveValue("");
  await page.getByRole("button", { name: "Sign out" }).click();

  await page.getByRole("button", { name: /Carol Seller/ }).click();
  await page.getByRole("link", { name: title }).click();
  await page.getByLabel("Add a note").fill("Will do.");
  await page.getByRole("button", { name: "Add the note" }).click();
  const items = page.getByRole("region", { name: "Notes" }).getByRole("listitem");
  await expect(items).toHaveCount(2);
  await expect(items.nth(0)).toContainText("Will do.");
  await expect(items.nth(0)).toContainText("Carol Seller");
  await expect(items.nth(1)).toContainText("Please send the draft by Friday.");
  await expect(items.nth(1)).toContainText("Bob Buyer");
  const results = await new AxeBuilder({ page }).withTags(WCAG_22_AA).analyze();
  expect(results.violations).toEqual([]);
});
