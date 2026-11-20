import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { Reconciliation } from "./Reconciliation.tsx";
import { server } from "./test-server.ts";

const DEAL = "11111111-1111-4111-8111-111111111111";
const ID_1 = "55555555-5555-4555-8555-555555555551";
const ID_2 = "55555555-5555-4555-8555-555555555552";

const ITEMS = [
  {
    id: ID_1,
    kind: "missing_in_ledger",
    dealId: DEAL,
    dealTitle: "Logo design",
    payoutId: null,
    chainTxId: "tx-100",
    ledgerAmountMinor: null,
    chainAmountMinor: 40_000,
    foundAt: "2026-11-16T10:30:00.000Z",
  },
  {
    id: ID_2,
    kind: "amount_differs",
    dealId: DEAL,
    dealTitle: "Website",
    payoutId: null,
    chainTxId: "tx-200",
    ledgerAmountMinor: 9_000,
    chainAmountMinor: 10_000,
    foundAt: "2026-11-17T08:00:00.000Z",
  },
];

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <Reconciliation />
    </QueryClientProvider>,
  );
}

function pageOf(items: unknown[], total = items.length, offset = 0, limit = 20) {
  return HttpResponse.json({ items, total, oldCount: 0, limit, offset });
}

describe("Reconciliation", () => {
  it("lists each mismatch with its kind, Deal, amounts, transaction id and time", async () => {
    server.use(http.get("*/api/reconciliation/mismatches", () => pageOf(ITEMS)));
    renderPage();
    const first = await screen.findByRole("listitem", { name: /Logo design/ });
    expect(within(first).getByText(/Missing in ledger/)).toBeVisible();
    expect(within(first).getByText(/tx-100/)).toBeVisible();
    expect(within(first).getByText(/Chain amount £400\.00/)).toBeVisible();
    expect(within(first).getByText(/2026-11-16 10:30 UTC/)).toBeVisible();
    const second = screen.getByRole("listitem", { name: /Website/ });
    expect(within(second).getByText(/Amount differs/)).toBeVisible();
    expect(within(second).getByText(/Ledger amount £90\.00/)).toBeVisible();
    expect(within(second).getByText(/Chain amount £100\.00/)).toBeVisible();
    const rows = screen.getAllByRole("listitem");
    expect(rows[0]).toHaveTextContent("Logo design");
    expect(rows[1]).toHaveTextContent("Website");
  });

  it("says that there are no open mismatches", async () => {
    server.use(http.get("*/api/reconciliation/mismatches", () => pageOf([])));
    renderPage();
    expect(await screen.findByText("There are no open mismatches.")).toBeVisible();
  });

  it("moves to the next page and back", async () => {
    const offsets: string[] = [];
    server.use(
      http.get("*/api/reconciliation/mismatches", ({ request }) => {
        const offset = Number(new URL(request.url).searchParams.get("offset"));
        offsets.push(String(offset));
        return pageOf([ITEMS[offset === 0 ? 0 : 1]], 21, offset, 20);
      }),
    );
    renderPage();
    await screen.findByRole("listitem", { name: /Logo design/ });
    expect(screen.getByRole("button", { name: "Previous page" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(await screen.findByRole("listitem", { name: /Website/ })).toBeVisible();
    expect(screen.getByRole("button", { name: "Next page" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Previous page" }));
    expect(await screen.findByRole("listitem", { name: /Logo design/ })).toBeVisible();
    expect(offsets).toEqual(["0", "20", "0"]);
  });

  it("keeps the paging buttons and does not claim that the list is empty when a later page is empty", async () => {
    server.use(
      http.get("*/api/reconciliation/mismatches", ({ request }) => {
        const offset = Number(new URL(request.url).searchParams.get("offset"));
        return offset === 0 ? pageOf([ITEMS[0]], 21, 0, 20) : pageOf([], 1, offset, 20);
      }),
    );
    renderPage();
    await screen.findByRole("listitem", { name: /Logo design/ });
    await userEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(await screen.findByText(/No mismatches on this page/)).toBeVisible();
    expect(screen.queryByText("There are no open mismatches.")).toBeNull();
    expect(screen.getByRole("button", { name: "Previous page" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Next page" })).toBeDisabled();
  });

  it("keeps the keyboard focus on the paging button while the next page loads", async () => {
    server.use(
      http.get("*/api/reconciliation/mismatches", async ({ request }) => {
        const offset = Number(new URL(request.url).searchParams.get("offset"));
        if (offset > 0) await new Promise((resolve) => setTimeout(resolve, 50));
        return pageOf([ITEMS[offset === 0 ? 0 : 1]], 21, offset, 20);
      }),
    );
    renderPage();
    await screen.findByRole("listitem", { name: /Logo design/ });
    const next = screen.getByRole("button", { name: "Next page" });
    await userEvent.click(next);
    expect(screen.getByRole("button", { name: "Next page" })).toHaveFocus();
    expect(await screen.findByRole("listitem", { name: /Website/ })).toBeVisible();
    expect(document.body).not.toHaveFocus();
  });

  it("shows an error when the list cannot be read", async () => {
    server.use(
      http.get("*/api/reconciliation/mismatches", () => new HttpResponse(null, { status: 403 })),
    );
    renderPage();
    expect(await screen.findByRole("alert")).toHaveTextContent("The mismatches cannot be loaded");
  });
});
