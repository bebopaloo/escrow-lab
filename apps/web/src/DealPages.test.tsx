import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { delay, http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { App } from "./App.tsx";
import { server } from "./test-server.ts";

const ALICE = {
  id: "00000000-0000-4000-8000-000000000001",
  displayName: "Alice Buyer",
  role: "buyer",
} as const;
const CAROL = {
  id: "00000000-0000-4000-8000-000000000003",
  displayName: "Carol Seller",
  role: "seller",
} as const;
const DEAL_ID = "11111111-1111-4111-8111-111111111111";

const SUMMARY = {
  id: DEAL_ID,
  title: "Logo design",
  buyerId: ALICE.id,
  buyerName: ALICE.displayName,
  sellerId: CAROL.id,
  sellerName: CAROL.displayName,
  totalMinor: 100_000,
  currency: "GBP",
  state: "draft",
  createdAt: "2026-11-14T10:00:00.000Z",
};
/** A Milestone as an action route sends it: the action routes send no Payout. */
const ACTION_BASE = {
  id: "22222222-2222-4222-8222-222222222221",
  position: 1,
  title: "Draft",
  amountMinor: 40_000,
  state: "pending",
  evidenceText: null,
  rejectionReason: null,
};
const DETAIL = {
  ...SUMMARY,
  milestones: [
    { ...ACTION_BASE, payout: null },
    {
      id: "22222222-2222-4222-8222-222222222222",
      position: 2,
      title: "Final",
      amountMinor: 60_000,
      state: "pending",
      evidenceText: null,
      rejectionReason: null,
      payout: null,
    },
  ],
};

function renderApp() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <App />
    </QueryClientProvider>,
  );
}

function signedInAs(user: typeof ALICE | typeof CAROL, deals: unknown[] = [SUMMARY]) {
  server.use(
    http.get("*/api/health", () => HttpResponse.json({ status: "ok" })),
    http.get("*/api/session", () => HttpResponse.json({ user, csrfToken: "token-1" })),
    http.get("*/api/users", () => HttpResponse.json({ users: [ALICE, CAROL] })),
    http.get("*/api/deals", () =>
      HttpResponse.json({ deals, total: deals.length, limit: 20, offset: 0 }),
    ),
    http.get(`*/api/deals/${DEAL_ID}`, () => HttpResponse.json(DETAIL)),
  );
}

describe("Deal list", () => {
  it("lists the Deals with their state and total", async () => {
    signedInAs(ALICE);
    renderApp();
    const row = await screen.findByRole("link", { name: /Logo design/ });
    expect(row).toBeInTheDocument();
    expect(screen.getByText(/£1,000\.00/)).toBeInTheDocument();
    expect(screen.getByText(/draft/)).toBeInTheDocument();
  });

  it("shows the empty state", async () => {
    signedInAs(ALICE, []);
    renderApp();
    expect(await screen.findByText("You have no Deals yet.")).toBeInTheDocument();
  });

  it("announces loading in a status region", async () => {
    signedInAs(ALICE);
    server.use(
      http.get("*/api/deals", async () => {
        await delay("infinite");
        return HttpResponse.json({});
      }),
    );
    renderApp();
    expect(await screen.findByText("Loading the Deals.")).toHaveAttribute("role", "status");
  });

  it("shows an error when the list cannot load", async () => {
    signedInAs(ALICE);
    server.use(http.get("*/api/deals", () => new HttpResponse(null, { status: 500 })));
    renderApp();
    expect(await screen.findByRole("alert")).toHaveTextContent(/cannot be loaded/);
  });

  it("offers Create Deal to a Buyer", async () => {
    signedInAs(ALICE);
    renderApp();
    expect(await screen.findByRole("button", { name: "Create a Deal" })).toBeVisible();
  });

  it("tells the person when there are more Deals than the list shows", async () => {
    signedInAs(ALICE);
    server.use(
      http.get("*/api/deals", () =>
        HttpResponse.json({ deals: [SUMMARY], total: 150, limit: 100, offset: 0 }),
      ),
    );
    renderApp();
    expect(await screen.findByText("This list shows 1 of 150 Deals.")).toBeVisible();
  });

  it("does not offer Create Deal to a Seller", async () => {
    signedInAs(CAROL);
    renderApp();
    await screen.findByRole("link", { name: /Logo design/ });
    expect(screen.queryByRole("button", { name: "Create a Deal" })).not.toBeInTheDocument();
  });
});

describe("Deal detail", () => {
  it("opens a Deal with its Milestones and moves focus to the heading", async () => {
    signedInAs(ALICE);
    renderApp();
    await userEvent.click(await screen.findByRole("link", { name: /Logo design/ }));
    const heading = await screen.findByRole("heading", { name: "Logo design" });
    expect(heading).toHaveFocus();
    const table = screen.getByRole("table");
    expect(within(table).getByText("Draft")).toBeInTheDocument();
    expect(within(table).getByText("£400.00")).toBeInTheDocument();
    expect(within(table).getByText("£600.00")).toBeInTheDocument();
  });

  it("goes back to the list and moves focus to its heading", async () => {
    signedInAs(ALICE);
    renderApp();
    await userEvent.click(await screen.findByRole("link", { name: /Logo design/ }));
    await userEvent.click(await screen.findByRole("button", { name: "Back to the Deals" }));
    expect(await screen.findByRole("heading", { name: "Deals" })).toHaveFocus();
  });

  it("tells the user when the Deal is not found", async () => {
    signedInAs(ALICE);
    server.use(
      http.get(`*/api/deals/${DEAL_ID}`, () =>
        HttpResponse.json({ error: "Not found", requestId: "r" }, { status: 404 }),
      ),
    );
    renderApp();
    await userEvent.click(await screen.findByRole("link", { name: /Logo design/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("This Deal was not found.");
  });
});

describe("Create Deal", () => {
  async function openForm() {
    await userEvent.click(await screen.findByRole("button", { name: "Create a Deal" }));
    return screen.findByRole("heading", { name: "Create a Deal" });
  }

  it("moves focus to the heading of the form", async () => {
    signedInAs(ALICE);
    renderApp();
    expect(await openForm()).toHaveFocus();
  });

  it("sends the Deal in minor units with the CSRF token and opens it", async () => {
    signedInAs(ALICE);
    let sent: { body: unknown; token: string | null } | undefined;
    server.use(
      http.post("*/api/deals", async ({ request }) => {
        sent = { body: await request.json(), token: request.headers.get("x-csrf-token") };
        return HttpResponse.json(DETAIL, { status: 201 });
      }),
    );
    renderApp();
    await openForm();
    await userEvent.selectOptions(await screen.findByLabelText("Seller"), CAROL.id);
    await userEvent.type(screen.getByLabelText("Deal title"), "Logo design");
    await userEvent.type(screen.getByLabelText("Total (£)"), "1000");
    await userEvent.type(screen.getByLabelText("Milestone 1 title"), "Draft");
    await userEvent.type(screen.getByLabelText("Milestone 1 amount (£)"), "400");
    await userEvent.click(screen.getByRole("button", { name: "Add a Milestone" }));
    await userEvent.type(screen.getByLabelText("Milestone 2 title"), "Final");
    await userEvent.type(screen.getByLabelText("Milestone 2 amount (£)"), "600.00");
    await userEvent.click(screen.getByRole("button", { name: "Create the Deal" }));
    expect(await screen.findByRole("heading", { name: "Logo design" })).toHaveFocus();
    expect(sent).toEqual({
      token: "token-1",
      body: {
        sellerId: CAROL.id,
        title: "Logo design",
        totalMinor: 100_000,
        milestones: [
          { title: "Draft", amountMinor: 40_000 },
          { title: "Final", amountMinor: 60_000 },
        ],
      },
    });
  });

  it("shows the refusal when the Milestones do not add up", async () => {
    signedInAs(ALICE);
    server.use(
      http.post("*/api/deals", () =>
        HttpResponse.json(
          { error: "The Milestones must add up to the total.", requestId: "r" },
          { status: 400 },
        ),
      ),
    );
    renderApp();
    await openForm();
    await userEvent.selectOptions(await screen.findByLabelText("Seller"), CAROL.id);
    await userEvent.type(screen.getByLabelText("Deal title"), "Logo design");
    await userEvent.type(screen.getByLabelText("Total (£)"), "1000");
    await userEvent.type(screen.getByLabelText("Milestone 1 title"), "Draft");
    await userEvent.type(screen.getByLabelText("Milestone 1 amount (£)"), "400");
    await userEvent.click(screen.getByRole("button", { name: "Create the Deal" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The Milestones must add up to the total.",
    );
  });

  it("disables the submit button while the request runs", async () => {
    signedInAs(ALICE);
    server.use(
      http.post("*/api/deals", async () => {
        await delay("infinite");
        return HttpResponse.json(DETAIL, { status: 201 });
      }),
    );
    renderApp();
    await openForm();
    await userEvent.selectOptions(await screen.findByLabelText("Seller"), CAROL.id);
    await userEvent.type(screen.getByLabelText("Deal title"), "Logo design");
    await userEvent.type(screen.getByLabelText("Total (£)"), "10");
    await userEvent.type(screen.getByLabelText("Milestone 1 title"), "All");
    await userEvent.type(screen.getByLabelText("Milestone 1 amount (£)"), "10");
    await userEvent.click(screen.getByRole("button", { name: "Create the Deal" }));
    expect(await screen.findByRole("button", { name: "Create the Deal" })).toBeDisabled();
  });

  it("refuses an amount that is not money before it sends anything", async () => {
    signedInAs(ALICE);
    renderApp();
    await openForm();
    await userEvent.selectOptions(await screen.findByLabelText("Seller"), CAROL.id);
    await userEvent.type(screen.getByLabelText("Deal title"), "Logo design");
    await userEvent.type(screen.getByLabelText("Total (£)"), "abc");
    await userEvent.type(screen.getByLabelText("Milestone 1 title"), "All");
    await userEvent.type(screen.getByLabelText("Milestone 1 amount (£)"), "10");
    await userEvent.click(screen.getByRole("button", { name: "Create the Deal" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/pounds and pence/);
  });

  it("limits a Deal to 10 Milestones", async () => {
    signedInAs(ALICE);
    renderApp();
    await openForm();
    for (let i = 0; i < 9; i += 1) {
      await userEvent.click(screen.getByRole("button", { name: "Add a Milestone" }));
    }
    expect(screen.getByRole("button", { name: "Add a Milestone" })).toBeDisabled();
  });
  it("moves focus to the title of a new Milestone, also after the 10th", async () => {
    signedInAs(ALICE);
    renderApp();
    await openForm();
    await userEvent.click(screen.getByRole("button", { name: "Add a Milestone" }));
    expect(screen.getByLabelText("Milestone 2 title")).toHaveFocus();
    for (let i = 0; i < 8; i += 1) {
      await userEvent.click(screen.getByRole("button", { name: "Add a Milestone" }));
    }
    expect(screen.getByRole("button", { name: "Add a Milestone" })).toBeDisabled();
    expect(screen.getByLabelText("Milestone 10 title")).toHaveFocus();
  });

  it("moves focus to the nearest Milestone title after a removal", async () => {
    signedInAs(ALICE);
    renderApp();
    await openForm();
    await userEvent.click(screen.getByRole("button", { name: "Add a Milestone" }));
    await userEvent.click(screen.getByRole("button", { name: "Add a Milestone" }));
    await userEvent.click(screen.getByRole("button", { name: "Remove Milestone 2" }));
    expect(screen.getByLabelText("Milestone 2 title")).toHaveFocus();
    await userEvent.click(screen.getByRole("button", { name: "Remove Milestone 2" }));
    expect(screen.getByLabelText("Milestone 1 title")).toHaveFocus();
  });

  it("links the form error to each amount that fails", async () => {
    signedInAs(ALICE);
    renderApp();
    await openForm();
    await userEvent.selectOptions(await screen.findByLabelText("Seller"), CAROL.id);
    await userEvent.type(screen.getByLabelText("Deal title"), "Logo design");
    await userEvent.type(screen.getByLabelText("Total (£)"), "abc");
    await userEvent.type(screen.getByLabelText("Milestone 1 title"), "All");
    await userEvent.type(screen.getByLabelText("Milestone 1 amount (£)"), "10");
    await userEvent.click(screen.getByRole("button", { name: "Create the Deal" }));
    const alert = await screen.findByRole("alert");
    const total = screen.getByLabelText("Total (£)");
    expect(total).toHaveAttribute("aria-invalid", "true");
    expect(total.getAttribute("aria-describedby")).toContain(alert.id);
    expect(alert.id).not.toBe("");
    const amount = screen.getByLabelText("Milestone 1 amount (£)");
    expect(amount).not.toHaveAttribute("aria-invalid", "true");
    expect(amount.getAttribute("aria-describedby")).not.toContain(alert.id);
  });
});

describe("Payout words on the Deal page", () => {
  const milestone = (position: number, state: string, payout: unknown) => ({
    ...DETAIL.milestones[0],
    id: `22222222-2222-4222-8222-22222222223${String(position)}`,
    position,
    title: `Step ${String(position)}`,
    state,
    payout,
  });
  const WITH_PAYOUTS = {
    ...DETAIL,
    state: "funded",
    milestones: [
      milestone(1, "paid", { state: "confirmed", paidAt: "2026-11-14T23:30:00.000Z" }),
      milestone(2, "accepted", { state: "pending", paidAt: null }),
      milestone(3, "accepted", { state: "failed", paidAt: null }),
      milestone(4, "accepted", null),
      milestone(5, "pending", null),
    ],
  };

  it.each([ALICE, CAROL])("says where each Payout stands to $role", async (user) => {
    signedInAs(user);
    server.use(http.get(`*/api/deals/${DEAL_ID}`, () => HttpResponse.json(WITH_PAYOUTS)));
    renderApp();
    await userEvent.click(await screen.findByRole("link", { name: /Logo design/ }));
    const row = async (title: string) =>
      within(await screen.findByRole("row", { name: new RegExp(title) }));
    expect((await row("Step 1")).getByText("Paid on 14 November 2026")).toBeVisible();
    expect((await row("Step 2")).getByText("Payment to the Seller is on its way")).toBeVisible();
    expect(
      (await row("Step 3")).getByText("Payment to the Seller failed. An Approver will retry it."),
    ).toBeVisible();
    expect((await row("Step 4")).getByText("Waiting for an Approver")).toBeVisible();
    expect(
      screen.getAllByText(/Paid on|Payment to the Seller|Waiting for an Approver/),
    ).toHaveLength(4);
  });
});

describe("Fund a Deal", () => {
  async function openDeal() {
    await userEvent.click(await screen.findByRole("link", { name: /Logo design/ }));
    await screen.findByRole("heading", { name: "Logo design" });
  }
  const FUNDED = {
    ...DETAIL,
    state: "funded",
    milestones: [{ ...DETAIL.milestones[0], state: "awaiting_evidence" }, DETAIL.milestones[1]],
  };

  it("offers Fund to the Buyer of a draft Deal only", async () => {
    signedInAs(ALICE);
    renderApp();
    await openDeal();
    expect(screen.getByRole("button", { name: "Fund the Deal" })).toBeVisible();
  });

  it("does not offer Fund to the Seller", async () => {
    signedInAs(CAROL);
    renderApp();
    await openDeal();
    expect(screen.queryByRole("button", { name: "Fund the Deal" })).not.toBeInTheDocument();
  });

  it("does not offer Fund for a Deal that is not in draft", async () => {
    signedInAs(ALICE);
    server.use(http.get(`*/api/deals/${DEAL_ID}`, () => HttpResponse.json(FUNDED)));
    renderApp();
    await openDeal();
    expect(screen.queryByRole("button", { name: "Fund the Deal" })).not.toBeInTheDocument();
  });

  it("sends the CSRF token, shows the funded Deal and moves focus to the heading", async () => {
    signedInAs(ALICE);
    let token: string | null = null;
    server.use(
      http.post(`*/api/deals/${DEAL_ID}/fund`, ({ request }) => {
        token = request.headers.get("x-csrf-token");
        server.use(http.get(`*/api/deals/${DEAL_ID}`, () => HttpResponse.json(FUNDED)));
        return HttpResponse.json(FUNDED);
      }),
    );
    renderApp();
    await openDeal();
    await userEvent.click(screen.getByRole("button", { name: "Fund the Deal" }));
    expect(await screen.findByText("The Deal is funded.")).toHaveAttribute("role", "status");
    expect(token).toBe("token-1");
    expect(screen.getByRole("heading", { name: "Logo design" })).toHaveFocus();
    expect(screen.queryByRole("button", { name: "Fund the Deal" })).not.toBeInTheDocument();
  });

  it("shows that the payment failed and keeps focus on the button", async () => {
    signedInAs(ALICE);
    server.use(
      http.post(`*/api/deals/${DEAL_ID}/fund`, () =>
        HttpResponse.json(
          { error: "The payment failed. Try again.", requestId: "r" },
          { status: 402 },
        ),
      ),
    );
    renderApp();
    await openDeal();
    await userEvent.click(screen.getByRole("button", { name: "Fund the Deal" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The payment failed. Try again.");
    const button = screen.getByRole("button", { name: "Fund the Deal" });
    expect(button).toBeEnabled();
    expect(button).toHaveFocus();
  });

  it("tells the Buyer when the payment is still in progress", async () => {
    signedInAs(ALICE);
    const FUNDING = { ...DETAIL, state: "funding" };
    server.use(
      http.post(`*/api/deals/${DEAL_ID}/fund`, () => {
        server.use(http.get(`*/api/deals/${DEAL_ID}`, () => HttpResponse.json(FUNDING)));
        return HttpResponse.json(FUNDING);
      }),
    );
    renderApp();
    await openDeal();
    await userEvent.click(screen.getByRole("button", { name: "Fund the Deal" }));
    expect(await screen.findByText(/payment is in progress/)).toHaveAttribute("role", "status");
  });

  it("disables the button while the request runs", async () => {
    signedInAs(ALICE);
    server.use(
      http.post(`*/api/deals/${DEAL_ID}/fund`, async () => {
        await delay("infinite");
        return HttpResponse.json(FUNDED);
      }),
    );
    renderApp();
    await openDeal();
    await userEvent.click(screen.getByRole("button", { name: "Fund the Deal" }));
    expect(await screen.findByRole("button", { name: "Fund the Deal" })).toBeDisabled();
  });
});

describe("Milestone evidence", () => {
  const MILESTONE_ID = "22222222-2222-4222-8222-222222222221";
  const withFirst = (change: Record<string, unknown>) => ({
    ...DETAIL,
    state: "funded",
    milestones: [{ ...DETAIL.milestones[0], ...change }, DETAIL.milestones[1]],
  });

  async function openDeal() {
    await userEvent.click(await screen.findByRole("link", { name: /Logo design/ }));
    await screen.findByRole("heading", { name: "Logo design" });
  }

  function serve(detail: object) {
    server.use(http.get(`*/api/deals/${DEAL_ID}`, () => HttpResponse.json(detail)));
  }

  it("lets the Seller send evidence, then moves focus to the evidence heading", async () => {
    signedInAs(CAROL);
    serve(withFirst({ state: "awaiting_evidence" }));
    let sent: { body: unknown; token: string | null } | undefined;
    server.use(
      http.post(`*/api/milestones/${MILESTONE_ID}/evidence`, async ({ request }) => {
        sent = { body: await request.json(), token: request.headers.get("x-csrf-token") };
        serve(withFirst({ state: "evidence_sent", evidenceText: "Link" }));
        return HttpResponse.json({
          ...ACTION_BASE,
          state: "evidence_sent",
          evidenceText: "Link",
        });
      }),
    );
    renderApp();
    await openDeal();
    await userEvent.type(await screen.findByLabelText("Evidence"), "Link");
    await userEvent.click(screen.getByRole("button", { name: "Send evidence" }));
    expect(await screen.findByText("The evidence is sent.")).toHaveAttribute("role", "status");
    expect(sent).toEqual({ token: "token-1", body: { evidenceText: "Link" } });
    expect(screen.getByRole("heading", { name: "Evidence for Milestone 1" })).toHaveFocus();
    expect(screen.queryByRole("button", { name: "Send evidence" })).not.toBeInTheDocument();
  });

  it("shows the Seller the last rejection reason", async () => {
    signedInAs(CAROL);
    serve(withFirst({ state: "awaiting_evidence", rejectionReason: "Wrong file" }));
    renderApp();
    await openDeal();
    expect(await screen.findByText("Wrong file")).toBeVisible();
    expect(screen.getByLabelText("Evidence")).toBeVisible();
  });

  it("disables Send evidence while the request runs", async () => {
    signedInAs(CAROL);
    serve(withFirst({ state: "awaiting_evidence" }));
    server.use(
      http.post(`*/api/milestones/${MILESTONE_ID}/evidence`, async () => {
        await delay("infinite");
        return HttpResponse.json({});
      }),
    );
    renderApp();
    await openDeal();
    await userEvent.type(await screen.findByLabelText("Evidence"), "Link");
    await userEvent.click(screen.getByRole("button", { name: "Send evidence" }));
    expect(await screen.findByRole("button", { name: "Send evidence" })).toBeDisabled();
  });

  it("refuses whitespace-only evidence and links the error to the field", async () => {
    signedInAs(CAROL);
    serve(withFirst({ state: "awaiting_evidence" }));
    let posted = false;
    server.use(
      http.post(`*/api/milestones/${MILESTONE_ID}/evidence`, () => {
        posted = true;
        return HttpResponse.json({ error: "x", requestId: "r" }, { status: 400 });
      }),
    );
    renderApp();
    await openDeal();
    await userEvent.type(await screen.findByLabelText("Evidence"), "   ");
    await userEvent.click(screen.getByRole("button", { name: "Send evidence" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Write the evidence before you send it.");
    const field = screen.getByLabelText("Evidence");
    expect(field).toHaveAttribute("aria-invalid", "true");
    expect(field.getAttribute("aria-describedby")).toContain(alert.id);
    expect(posted).toBe(false);
  });

  it("links an API refusal to the evidence field", async () => {
    signedInAs(CAROL);
    serve(withFirst({ state: "awaiting_evidence" }));
    server.use(
      http.post(`*/api/milestones/${MILESTONE_ID}/evidence`, () =>
        HttpResponse.json({ error: "x", requestId: "r" }, { status: 409 }),
      ),
    );
    renderApp();
    await openDeal();
    await userEvent.type(await screen.findByLabelText("Evidence"), "Link");
    await userEvent.click(screen.getByRole("button", { name: "Send evidence" }));
    const alert = await screen.findByRole("alert");
    const field = screen.getByLabelText("Evidence");
    expect(field).toHaveAttribute("aria-invalid", "true");
    expect(field.getAttribute("aria-describedby")).toContain(alert.id);
  });

  it("does not offer the evidence form to the Buyer", async () => {
    signedInAs(ALICE);
    serve(withFirst({ state: "awaiting_evidence" }));
    renderApp();
    await openDeal();
    expect(await screen.findByText("Waiting for the Seller to send evidence.")).toBeVisible();
    expect(screen.queryByLabelText("Evidence")).not.toBeInTheDocument();
  });

  it("shows the Seller a waiting message, without Accept or Reject", async () => {
    signedInAs(CAROL);
    serve(withFirst({ state: "evidence_sent", evidenceText: "Here is the link" }));
    renderApp();
    await openDeal();
    expect(await screen.findByText("Waiting for the Buyer to review the evidence.")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Accept the evidence" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reject the evidence" })).not.toBeInTheDocument();
  });

  it("lets the Buyer accept the evidence", async () => {
    signedInAs(ALICE);
    serve(withFirst({ state: "evidence_sent", evidenceText: "Here is the link" }));
    let token: string | null = null;
    server.use(
      http.post(`*/api/milestones/${MILESTONE_ID}/accept`, ({ request }) => {
        token = request.headers.get("x-csrf-token");
        serve(withFirst({ state: "accepted", evidenceText: "Here is the link" }));
        return HttpResponse.json({ ...ACTION_BASE, state: "accepted" });
      }),
    );
    renderApp();
    await openDeal();
    expect(await screen.findByText("Here is the link")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Accept the evidence" }));
    expect(await screen.findByText("The evidence is accepted.")).toHaveAttribute("role", "status");
    expect(token).toBe("token-1");
    expect(screen.getByRole("heading", { name: "Evidence for Milestone 1" })).toHaveFocus();
  });

  it("lets the Buyer reject the evidence with a reason", async () => {
    signedInAs(ALICE);
    serve(withFirst({ state: "evidence_sent", evidenceText: "Here is the link" }));
    let body: unknown;
    server.use(
      http.post(`*/api/milestones/${MILESTONE_ID}/reject`, async ({ request }) => {
        body = await request.json();
        serve(withFirst({ state: "awaiting_evidence", rejectionReason: "Wrong file" }));
        return HttpResponse.json({ ...ACTION_BASE, state: "awaiting_evidence" });
      }),
    );
    renderApp();
    await openDeal();
    await userEvent.type(await screen.findByLabelText("Reason for rejection"), "Wrong file");
    await userEvent.click(screen.getByRole("button", { name: "Reject the evidence" }));
    expect(await screen.findByText("The evidence is rejected.")).toHaveAttribute("role", "status");
    expect(body).toEqual({ reason: "Wrong file" });
    expect(screen.getByRole("heading", { name: "Evidence for Milestone 1" })).toHaveFocus();
  });

  it("asks for a reason before it rejects, and links the error to the field", async () => {
    signedInAs(ALICE);
    serve(withFirst({ state: "evidence_sent", evidenceText: "Here is the link" }));
    renderApp();
    await openDeal();
    await userEvent.click(await screen.findByRole("button", { name: "Reject the evidence" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Give a reason for the rejection.");
    const field = screen.getByLabelText("Reason for rejection");
    expect(field).toHaveAttribute("aria-invalid", "true");
    expect(field.getAttribute("aria-describedby")).toContain(alert.id);
  });

  it("disables Accept and Reject while a request runs", async () => {
    signedInAs(ALICE);
    serve(withFirst({ state: "evidence_sent", evidenceText: "Here is the link" }));
    server.use(
      http.post(`*/api/milestones/${MILESTONE_ID}/accept`, async () => {
        await delay("infinite");
        return HttpResponse.json({});
      }),
    );
    renderApp();
    await openDeal();
    await userEvent.click(await screen.findByRole("button", { name: "Accept the evidence" }));
    expect(await screen.findByRole("button", { name: "Accept the evidence" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reject the evidence" })).toBeDisabled();
  });
});
