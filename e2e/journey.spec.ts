import { execFileSync } from "node:child_process";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Browser, type Page } from "@playwright/test";

const WCAG_22_AA = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

test.beforeAll(() => {
  // The seed uses DATABASE_URL, like `pnpm dev`, so both reach the same database.
  execFileSync("pnpm", ["db:seed"], { stdio: "ignore" });
});

async function scan(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(WCAG_22_AA).analyze();
  expect(results.violations).toEqual([]);
}

/**
 * A signed-in person in a browser context of their own. The sign-in rate limit allows 20 sign-ins
 * a minute for all the specs, so each person signs in once and the test uses their page in turn.
 */
async function signIn(browser: Browser, name: RegExp): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await scan(page);
  await page.getByRole("button", { name }).click();
  return page;
}

/** Opens the Deal from the Deal list with fresh data. */
async function openDeal(page: Page, title: string): Promise<void> {
  await page.goto("/");
  await page.getByRole("link", { name: title }).click();
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
}

test("a Buyer, a Seller and an Approver take a two-Milestone Deal from creation to completed", async ({
  browser,
}) => {
  const title = `Journey ${Date.now().toString()}`;

  // The Buyer creates and funds the Deal.
  const buyer = await signIn(browser, /Bob Buyer/);
  await expect(buyer.getByRole("heading", { name: "Deals" })).toBeVisible();
  await scan(buyer);
  await buyer.getByRole("button", { name: "Create a Deal" }).click();
  await expect(buyer.getByRole("heading", { name: "Create a Deal" })).toBeFocused();
  await buyer.getByLabel("Seller").selectOption({ label: "Carol Seller" });
  await buyer.getByLabel("Deal title").fill(title);
  await buyer.getByLabel("Total (£)").fill("1000");
  await buyer.getByRole("checkbox", { name: /Express/ }).uncheck();
  await buyer.getByLabel("Milestone 1 title").fill("Draft");
  await buyer.getByLabel("Milestone 1 amount (£)").fill("400");
  await buyer.getByRole("button", { name: "Add a Milestone" }).click();
  await buyer.getByLabel("Milestone 2 title").fill("Final");
  await buyer.getByLabel("Milestone 2 amount (£)").fill("600");
  await scan(buyer);
  await buyer.getByRole("button", { name: "Create the Deal" }).click();
  await expect(buyer.getByRole("heading", { name: title })).toBeFocused();
  await expect(buyer.getByText("State: draft.")).toBeVisible();
  await scan(buyer);
  await buyer.getByRole("button", { name: "Fund the Deal" }).click();
  await expect(buyer.getByText("The Deal is funded.")).toBeVisible();
  await expect(buyer.getByRole("row", { name: /Draft.*awaiting evidence/ })).toBeVisible();
  await scan(buyer);

  const seller = await signIn(browser, /Carol Seller/);
  const approver = await signIn(browser, /Erin Approver/);

  for (const [index, name] of ["Draft", "Final"].entries()) {
    const evidence = `Evidence link ${(index + 1).toString()}`;

    // The Seller sends the evidence.
    await openDeal(seller, title);
    await expect(
      seller.getByRole("row", { name: new RegExp(`${name}.*awaiting evidence`) }),
    ).toBeVisible();
    await seller.getByLabel("Evidence", { exact: true }).fill(evidence);
    await scan(seller);
    await seller.getByRole("button", { name: "Send evidence" }).click();
    await expect(seller.getByText("The evidence is sent.")).toBeVisible();
    await scan(seller);

    // The Buyer accepts it.
    await openDeal(buyer, title);
    await expect(buyer.getByText(evidence)).toBeVisible();
    await scan(buyer);
    await buyer.getByRole("button", { name: "Accept the evidence" }).click();
    await expect(buyer.getByText("The evidence is accepted.")).toBeVisible();
    await expect(buyer.getByRole("row", { name: new RegExp(`${name}.*accepted`) })).toBeVisible();

    // The Approver approves the Payout.
    await approver.goto("/");
    await expect(approver.getByRole("heading", { name: "Approval queue" })).toBeVisible();
    const entry = approver.getByRole("listitem").filter({ hasText: title });
    await expect(entry).toBeVisible();
    await scan(approver);
    await entry.getByRole("button", { name: `Approve the Payout for ${name}` }).click();
    await expect(approver.getByText(`The Payout for ${name} is paid.`)).toBeVisible();
    await expect(approver.getByRole("listitem").filter({ hasText: title })).toHaveCount(0);
    await scan(approver);
  }

  // The Buyer and the Seller see the completed Deal.
  for (const page of [buyer, seller]) {
    await openDeal(page, title);
    await expect(page.getByText("State: completed.")).toBeVisible();
    await expect(page.getByRole("row", { name: /Draft.*paid/ })).toBeVisible();
    await expect(page.getByRole("row", { name: /Final.*paid/ })).toBeVisible();
    await scan(page);
  }
});
