import { useQuery } from "@tanstack/react-query";
import { fetchDeal, NotFoundError } from "./api.ts";
import { formatMoney } from "./money.ts";

export interface DealDetailProps {
  id: string;
  onBack: () => void;
}

export function DealDetail({ id, onBack }: DealDetailProps) {
  const deal = useQuery({
    queryKey: ["deal", id],
    queryFn: ({ signal }) => fetchDeal(id, signal),
    retry: false,
  });

  return (
    <section aria-labelledby="deal-heading">
      <h2 id="deal-heading" tabIndex={-1}>
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
