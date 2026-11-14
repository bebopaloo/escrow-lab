import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { delay, http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { ApprovalQueue } from "./ApprovalQueue.tsx";
import { server } from "./test-server.ts";

const DEAL = "11111111-1111-4111-8111-111111111111";
const MILESTONE = "22222222-2222-4222-8222-222222222221";
const PAYOUT = "33333333-3333-4333-8333-333333333331";
const FAILED_DEAL = "44444444-4444-4444-8444-444444444441";

const ITEMS = [
  {
    kind: "milestone",
    id: MILESTONE,
    dealId: DEAL,
    dealTitle: "Logo design",
    title: "Draft",
    position: 1,
    amountMinor: 40_000,
  },
  {
    kind: "failed_payout",
    id: PAYOUT,
    dealId: DEAL,
    dealTitle: "Logo design",
    title: "Final",
    position: 2,
    amountMinor: 60_000,
  },
  {
    kind: "funding_failed",
    id: FAILED_DEAL,
    dealId: FAILED_DEAL,
    dealTitle: "Website",
    totalMinor: 250_000,
  },
];

function page(items: unknown[]) {
  return HttpResponse.json({ items, total: items.length, limit: 100, offset: 0 });
}

function renderQueue() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ApprovalQueue csrfToken="token-1" />
    </QueryClientProvider>,
  );
}

describe("ApprovalQueue", () => {
  it("lists accepted Milestones with an Approve button and the failed items without one", async () => {
    server.use(http.get("*/api/approvals", () => page(ITEMS)));
    renderQueue();
    const milestone = await screen.findByRole("listitem", { name: /Draft/ });
    expect(within(milestone).getByText(/Logo design/)).toBeVisible();
    expect(within(milestone).getByText(/£400\.00/)).toBeVisible();
    expect(
      within(milestone).getByRole("button", { name: "Approve the Payout for Draft" }),
    ).toBeEnabled();

    const payout = screen.getByRole("listitem", { name: /Final/ });
    expect(within(payout).getByText(/Payout failed/)).toBeVisible();
    expect(within(payout).queryByRole("button")).not.toBeInTheDocument();

    const deal = screen.getByRole("listitem", { name: /Website/ });
    expect(within(deal).getByText(/Funding failed/)).toBeVisible();
    expect(within(deal).getByText(/£2,500\.00/)).toBeVisible();
    expect(within(deal).queryByRole("button")).not.toBeInTheDocument();
  });

  it("says that nothing waits when the queue is empty", async () => {
    server.use(http.get("*/api/approvals", () => page([])));
    renderQueue();
    expect(await screen.findByText("Nothing waits for approval.")).toBeVisible();
  });

  it("shows a generic error when the queue cannot be read", async () => {
    server.use(http.get("*/api/approvals", () => new HttpResponse(null, { status: 500 })));
    renderQueue();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The approval queue cannot be loaded",
    );
  });

  it("rejects a response that breaks the contract", async () => {
    server.use(http.get("*/api/approvals", () => page([{ kind: "other" }])));
    renderQueue();
    expect(await screen.findByRole("alert")).toBeVisible();
  });

  it("approves with the CSRF token, announces it and reloads the queue", async () => {
    let approved = false;
    let token: string | null = null;
    server.use(
      http.get("*/api/approvals", () => page(approved ? [] : [ITEMS[0]])),
      http.post(`*/api/milestones/${MILESTONE}/payout`, async ({ request }) => {
        token = request.headers.get("x-csrf-token");
        await delay(20);
        approved = true;
        return HttpResponse.json({ payoutId: PAYOUT, milestoneId: MILESTONE, state: "confirmed" });
      }),
    );
    renderQueue();
    const button = await screen.findByRole("button", { name: "Approve the Payout for Draft" });
    await userEvent.click(button);
    expect(button).toBeDisabled();
    expect(await screen.findByText("The Payout for Draft is paid.")).toHaveAttribute(
      "role",
      "status",
    );
    expect(token).toBe("token-1");
    expect(await screen.findByText("Nothing waits for approval.")).toBeVisible();
    expect(screen.getByRole("heading", { name: "Approval queue" })).toHaveFocus();
  });

  it("says that a transfer without a result stays pending", async () => {
    server.use(
      http.get("*/api/approvals", () => page([ITEMS[0]])),
      http.post(`*/api/milestones/${MILESTONE}/payout`, () =>
        HttpResponse.json({ payoutId: PAYOUT, milestoneId: MILESTONE, state: "pending" }),
      ),
    );
    renderQueue();
    await userEvent.click(
      await screen.findByRole("button", { name: "Approve the Payout for Draft" }),
    );
    expect(
      await screen.findByText(
        /The Payout for Draft is approved\. The transfer is not confirmed yet/,
      ),
    ).toBeVisible();
  });

  it("shows an error when the API refuses the approval", async () => {
    server.use(
      http.get("*/api/approvals", () => page([ITEMS[0]])),
      http.post(`*/api/milestones/${MILESTONE}/payout`, () =>
        HttpResponse.json({ error: "x", requestId: "r" }, { status: 409 }),
      ),
    );
    renderQueue();
    await userEvent.click(
      await screen.findByRole("button", { name: "Approve the Payout for Draft" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("The approval failed");
  });
});
