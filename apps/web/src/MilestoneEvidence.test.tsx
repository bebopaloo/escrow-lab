import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import type { MilestoneResponse } from "@escrow-lab/shared";
import { MilestoneEvidence } from "./MilestoneEvidence.tsx";
import { server } from "./test-server.ts";

const DEAL_ID = "11111111-1111-4111-8111-111111111111";
const MILESTONE: MilestoneResponse = {
  id: "22222222-2222-4222-8222-222222222221",
  position: 1,
  title: "Draft",
  amountMinor: 40_000,
  state: "awaiting_evidence",
  evidenceText: null,
  rejectionReason: null,
};

function setup(role: "buyer" | "seller", milestone: MilestoneResponse) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const ui = (current: MilestoneResponse) => (
    <QueryClientProvider client={client}>
      <MilestoneEvidence dealId={DEAL_ID} milestone={current} role={role} csrfToken="token-1" />
    </QueryClientProvider>
  );
  const view = render(ui(milestone));
  return (next: MilestoneResponse) => {
    view.rerender(ui(next));
  };
}

describe("MilestoneEvidence state changes", () => {
  it("clears the evidence text and the old notice when the Milestone state changes", async () => {
    server.use(
      http.post(`*/api/milestones/${MILESTONE.id}/evidence`, () =>
        HttpResponse.json({ ...MILESTONE, state: "evidence_sent", evidenceText: "Link" }),
      ),
    );
    const show = setup("seller", MILESTONE);
    await userEvent.type(screen.getByLabelText("Evidence"), "Link");
    await userEvent.click(screen.getByRole("button", { name: "Send evidence" }));
    expect(await screen.findByText("The evidence is sent.")).toBeVisible();

    show({ ...MILESTONE, state: "evidence_sent", evidenceText: "Link" });
    show({ ...MILESTONE, state: "awaiting_evidence", rejectionReason: "Wrong file" });

    expect(screen.queryByText("The evidence is sent.")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Evidence")).toHaveValue("");
  });

  it("clears the rejection reason when the Milestone state changes", async () => {
    const sent: MilestoneResponse = { ...MILESTONE, state: "evidence_sent", evidenceText: "Link" };
    const show = setup("buyer", sent);
    await userEvent.type(screen.getByLabelText("Reason for rejection"), "Wrong file");
    show(MILESTONE);
    show(sent);
    expect(screen.getByLabelText("Reason for rejection")).toHaveValue("");
  });
});
