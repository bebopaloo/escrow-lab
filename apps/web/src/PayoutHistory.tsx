import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchPayoutHistory } from "./api.ts";
import { formatMoney } from "./money.ts";

const PAGE_SIZE = 20;

const dateFormatter = new Intl.DateTimeFormat("en-GB", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
});

export function PayoutHistory({ onBack }: { onBack: () => void }) {
  const [offset, setOffset] = useState(0);
  const history = useQuery({
    queryKey: ["payouts", "mine", offset],
    queryFn: ({ signal }) => fetchPayoutHistory(PAGE_SIZE, offset, signal),
  });
  const page = history.data;
  const last = page === undefined ? 0 : Math.min(page.offset + page.limit, page.total);

  return (
    <section aria-labelledby="payouts-heading">
      <h2 id="payouts-heading" tabIndex={-1}>
        Payout history
      </h2>
      <button type="button" onClick={onBack}>
        Back to the Deals
      </button>
      {history.isPending && <p role="status">Loading the Payouts.</p>}
      {history.isError && <p role="alert">The Payouts cannot be loaded. Reload this page.</p>}
      {page?.total === 0 && <p>You have no Payouts yet.</p>}
      {page && page.payouts.length > 0 && (
        <>
          <table>
            <caption>Payouts, newest first</caption>
            <thead>
              <tr>
                <th scope="col">Deal</th>
                <th scope="col">Milestone</th>
                <th scope="col">Amount</th>
                <th scope="col">State</th>
                <th scope="col">Time (UTC)</th>
              </tr>
            </thead>
            <tbody>
              {page.payouts.map((payout) => (
                <tr key={payout.id}>
                  <td>{payout.dealTitle}</td>
                  <td>{payout.milestoneTitle}</td>
                  <td>{formatMoney(payout.amountMinor)}</td>
                  <td>{payout.state}</td>
                  <td>{dateFormatter.format(new Date(payout.createdAt))}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p role="status">
            Showing {page.offset + 1} to {last} of {page.total} Payouts.
          </p>
          <button
            type="button"
            disabled={page.offset === 0}
            onClick={() => {
              setOffset(Math.max(0, page.offset - PAGE_SIZE));
            }}
          >
            Previous page
          </button>
          <button
            type="button"
            disabled={last >= page.total}
            onClick={() => {
              setOffset(page.offset + PAGE_SIZE);
            }}
          >
            Next page
          </button>
        </>
      )}
    </section>
  );
}
