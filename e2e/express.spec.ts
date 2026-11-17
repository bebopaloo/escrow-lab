import { execFileSync } from "node:child_process";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Browser, type Page } from "@playwright/test";

const WCAG_22_AA = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

test.beforeAll(() => {
  execFileSync("pnpm", ["db:seed"], { stdio: "ignore" });
});

async function scan(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(WCAG_22_AA).analyze();
  expect(results.violations).toEqual([]);
}

async function signIn(browser: Browser, name: RegExp): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await page.goto("/");
  await page.getByRole("button", { name }).click();
  await expect(page.getByRole("heading", { name: /Deals|Approval queue/ })).toBeVisible();
  return page;
}

async function openDeal(page: Page, title: string): Promise<void> {
  await page.goto("/");
  await page.getByRole("link", { name: title }).click();
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
}

test("an express Deal pays a Milestone when the Buyer accepts, with no Approver", async ({
  browser,
}) => {
  const title = `Express ${Date.now().toString()}`;

  const buyer = await signIn(browser, /Bob Buyer/);
  await buyer.getByRole("button", { name: "Create a Deal" }).click();
  await expect(buyer.getByRole("checkbox", { name: /Express/ })).toBeChecked();
  await buyer.getByLabel("Seller").selectOption({ label: "Carol Seller" });
  await buyer.getByLabel("Deal title").fill(title);
  await buyer.getByLabel("Total (£)").fill("500");
  await buyer.getByLabel("Milestone 1 title").fill("Only");
  await buyer.getByLabel("Milestone 1 amount (£)").fill("500");
  await scan(buyer);
  await buyer.getByRole("button", { name: "Create the Deal" }).click();
  await expect(buyer.getByText("Express: on.")).toBeVisible();
  await buyer.getByRole("button", { name: "Fund the Deal" }).click();
  await expect(buyer.getByText("The Deal is funded.")).toBeVisible();

  const seller = await signIn(browser, /Carol Seller/);
  await openDeal(seller, title);
  await seller.getByLabel("Evidence", { exact: true }).fill("Evidence link");
  await seller.getByRole("button", { name: "Send evidence" }).click();
  await expect(seller.getByText("The evidence is sent.")).toBeVisible();

  await openDeal(buyer, title);
  await buyer.getByRole("button", { name: "Accept the evidence" }).click();
  await expect(buyer.getByText("State: completed.")).toBeVisible();

  for (const page of [buyer, seller]) {
    await openDeal(page, title);
    await expect(page.getByText("State: completed.")).toBeVisible();
    await expect(page.getByRole("row", { name: /Only.*paid/ })).toBeVisible();
    await scan(page);
  }
});
