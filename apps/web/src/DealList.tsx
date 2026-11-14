import { useQuery } from "@tanstack/react-query";
import { fetchDeals } from "./api.ts";
import { formatMoney } from "./money.ts";

export interface DealListProps {
  canCreate: boolean;
  onOpen: (id: string) => void;
  onCreate: () => void;
}

export function DealList({ canCreate, onOpen, onCreate }: DealListProps) {
  const deals = useQuery({ queryKey: ["deals"], queryFn: ({ signal }) => fetchDeals(signal) });

  return (
    <section aria-labelledby="deals-heading">
      <h2 id="deals-heading" tabIndex={-1}>
        Deals
      </h2>
      {canCreate && (
        <button type="button" onClick={onCreate}>
          Create a Deal
        </button>
      )}
      {deals.isPending && <p role="status">Loading the Deals.</p>}
      {deals.isError && <p role="alert">The Deals cannot be loaded. Reload this page.</p>}
      {deals.data && deals.data.total > deals.data.deals.length && (
        <p role="status">
          This list shows {deals.data.deals.length} of {deals.data.total} Deals.
        </p>
      )}
      {deals.data?.deals.length === 0 && <p>You have no Deals yet.</p>}
      {deals.data && deals.data.deals.length > 0 && (
        <ul>
          {deals.data.deals.map((deal) => (
            <li key={deal.id}>
              <a
                href={`#deal-${deal.id}`}
                onClick={(event) => {
                  event.preventDefault();
                  onOpen(deal.id);
                }}
              >
                {deal.title}
              </a>{" "}
              ({deal.buyerName} to {deal.sellerName}, {formatMoney(deal.totalMinor)},{" "}
              {deal.state.replace("_", " ")})
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
