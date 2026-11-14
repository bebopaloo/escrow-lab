import { useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchDeal, fundDeal, NotFoundError, PaymentFailedError } from "./api.ts";
import { formatMoney } from "./money.ts";

export interface DealDetailProps {
  id: string;
  userId: string;
  role: "buyer" | "seller";
  csrfToken: string;
  onBack: () => void;
}

export function DealDetail({ id, userId, role, csrfToken, onBack }: DealDetailProps) {
  const client = useQueryClient();
  const heading = useRef<HTMLHeadingElement>(null);
  const deal = useQuery({
    queryKey: ["deal", id],
    queryFn: ({ signal }) => fetchDeal(id, signal),
    retry: false,
  });

  const fund = useMutation({
    mutationFn: () => fundDeal(id, csrfToken),
    onSuccess: async (funded) => {
      client.setQueryData(["deal", id], funded);
      await client.invalidateQueries({ queryKey: ["deals"] });
      // The Fund button unmounts, so focus would go to the body (WCAG 2.4.3).
      heading.current?.focus();
    },
  });

  const canFund = role === "buyer" && deal.data?.buyerId === userId && deal.data.state === "draft";

  return (
    <section aria-labelledby="deal-heading">
      <h2 id="deal-heading" tabIndex={-1} ref={heading}>
        {deal.data?.title ?? "Deal"}
      </h2>
      <button type="button" onClick={onBack}>
        Back to the Deals
      </button>
      {deal.isPending && <p role="status">Loading the Deal.</p>}
      {deal.isError && (
        <p role="alert">
          {deal.error instanceof NotFoundError
            ? "This Deal was not found."
            : "The Deal cannot be loaded. Reload this page."}
        </p>
      )}
      {deal.data && (
        <>
          <p>
            Buyer: {deal.data.buyerName}. Seller: {deal.data.sellerName}.
          </p>
          <p>
            Total: {formatMoney(deal.data.totalMinor)}. State: {deal.data.state.replace("_", " ")}.
          </p>
          {canFund && (
            <button
              type="button"
              disabled={fund.isPending}
              onClick={() => {
                fund.mutate();
              }}
            >
              Fund the Deal
            </button>
          )}
          {fund.isPending && <p role="status">Funding the Deal.</p>}
          {fund.isError && <p role="alert">{fundError(fund.error)}</p>}
          {fund.isSuccess && deal.data.state === "funded" && (
            <p role="status">The Deal is funded.</p>
          )}
          {deal.data.state === "funding" && (
            <p role="status">
              The payment is in progress. The Deal is not funded yet. Check this page later.
            </p>
          )}
          <table>
            <caption>Milestones</caption>
            <thead>
              <tr>
                <th scope="col">Number</th>
                <th scope="col">Title</th>
                <th scope="col">Amount</th>
                <th scope="col">State</th>
              </tr>
            </thead>
            <tbody>
              {deal.data.milestones.map((milestone) => (
                <tr key={milestone.id}>
                  <td>{milestone.position}</td>
                  <td>{milestone.title}</td>
                  <td>{formatMoney(milestone.amountMinor)}</td>
                  <td>{milestone.state.replace("_", " ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}

function fundError(error: Error): string {
  return error instanceof PaymentFailedError
    ? error.message
    : "The Deal cannot be funded now. Reload this page.";
}
