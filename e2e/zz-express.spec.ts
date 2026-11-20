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

/** Puts the first Milestone of the Deal in `evidence_sent`, as the Seller's evidence request does. */
function sendEvidenceDirectly(title: string): void {
  const script = `
    import postgres from "postgres";
    const sql = postgres(process.env.DATABASE_URL ?? "postgres://app@127.0.0.1:41032/app");
    await sql\`update milestones set state = 'evidence_sent', evidence_text = 'Evidence link'
      where position = 1 and deal_id in (select id from deals where title = \${process.argv[1]})\`;
    await sql.end();
  `;
  execFileSync(
    "pnpm",
    ["--filter", "@escrow-lab/db", "exec", "node", "--input-type=module", "-e", script, title],
    { stdio: "ignore" },
  );
}

/**
 * Signs a user in. The sign-in route allows 20 sign-ins a minute, and the other specs use all of
 * them, so this spec runs last (see its file name) and waits for the next window when a sign-in
 * is refused.
 */
async function signIn(browser: Browser, name: RegExp): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  const signedIn = page.getByRole("heading", { name: /Deals|Approval queue/ });
  for (let attempt = 0; attempt < 14; attempt += 1) {
    await page.goto("/");
    await page.getByRole("button", { name }).click();
    const ok = await signedIn
      .waitFor({ timeout: 5_000 })
      .then(() => true)
      .catch(() => false);
    if (ok) return page;
    await page.waitForTimeout(5_000);
  }
  await expect(signedIn).toBeVisible();
  return page;
}

async function openDeal(page: Page, title: string): Promise<void> {
  await page.goto("/");
  await page.getByRole("link", { name: title }).click();
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
}

test("an express Deal queues its Payout first when the Buyer accepts, and an Approver pays it", async ({
  browser,
}) => {
  test.setTimeout(120_000);
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

  // The sign-in route allows 20 sign-ins a minute, and the other specs use most of them. The
  // evidence flow has its own specs, so the database stands in for the Seller here.
  sendEvidenceDirectly(title);

  await openDeal(buyer, title);
  await buyer.getByRole("button", { name: "Accept the evidence" }).click();
  await expect(buyer.getByText("State: funded.")).toBeVisible();
  await expect(buyer.getByRole("row", { name: /Only.*accepted/ })).toBeVisible();

  // The Payout waits for an Approver. No party to the Deal approves it.
  const approver = await signIn(browser, /Erin Approver/);
  await approver.goto("/");
  await expect(approver.getByRole("heading", { name: "Approval queue" })).toBeVisible();
  const first = approver.getByRole("listitem").first();
  await expect(first).toContainText(title);
  await expect(first.getByText("express", { exact: true })).toBeVisible();
  await scan(approver);
  await first.getByRole("button", { name: "Approve the Payout for Only" }).click();
  await expect(approver.getByText("The Payout for Only is paid.")).toBeVisible();
  await scan(approver);

  await openDeal(buyer, title);
  await expect(buyer.getByText("State: completed.")).toBeVisible();
  await expect(buyer.getByRole("row", { name: /Only.*paid/ })).toBeVisible();
  await scan(buyer);
});
