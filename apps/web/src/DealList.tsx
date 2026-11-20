import { DealState, MAX_SEARCH_LENGTH } from "@escrow-lab/shared";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { fetchDeals } from "./api.ts";
import { formatMoney } from "./money.ts";

export interface DealListProps {
  canCreate: boolean;
  onOpen: (id: string) => void;
  onCreate: () => void;
  /** Set for a Seller: opens the Payout history. */
  onPayouts?: () => void;
}

export function DealList({ canCreate, onOpen, onCreate, onPayouts }: DealListProps) {
  const [q, setQ] = useState("");
  const [state, setState] = useState<DealState | "">("");
  const filtered = q !== "" || state !== "";
  const deals = useQuery({
    queryKey: ["deals", { q, state }],
    queryFn: ({ signal }) => fetchDeals({ q, state }, signal),
  });

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
      {onPayouts && (
        <button type="button" onClick={onPayouts}>
          Payout history
        </button>
      )}
      <form
        role="search"
        onSubmit={(event) => {
          event.preventDefault();
        }}
      >
        <label>
          Search Deals{" "}
          <input
            type="search"
            maxLength={MAX_SEARCH_LENGTH}
            value={q}
            onChange={(event) => {
              setQ(event.target.value);
            }}
          />
        </label>{" "}
        <label>
          State{" "}
          <select
            value={state}
            onChange={(event) => {
              setState(event.target.value as DealState | "");
            }}
          >
            <option value="">Open Deals</option>
            {DealState.options.map((option) => (
              <option key={option} value={option}>
                {option.replace("_", " ")}
              </option>
            ))}
          </select>
        </label>
      </form>
      {deals.isPending && <p role="status">Loading the Deals.</p>}
      {deals.isError && <p role="alert">The Deals cannot be loaded. Reload this page.</p>}
      {deals.data && deals.data.total > deals.data.deals.length && (
        <p role="status">
          This list shows {deals.data.deals.length} of {deals.data.total} Deals.
        </p>
      )}
      {deals.data?.deals.length === 0 && (
        <p role="status">{filtered ? "No Deals match." : "You have no Deals yet."}</p>
      )}
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
