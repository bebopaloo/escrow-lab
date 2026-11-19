import { useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { MismatchItem } from "@escrow-lab/shared";
import { fetchMismatches } from "./api.ts";
import { formatMoney } from "./money.ts";

const PAGE_SIZE = 20;

const KIND_LABEL: Record<MismatchItem["kind"], string> = {
  missing_in_ledger: "Missing in ledger",
  missing_on_chain: "Missing on chain",
  amount_differs: "Amount differs",
};

/** "2026-11-16 10:30 UTC": the same text for every reader and every time zone. */
function formatFound(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

/** The open differences between the ledger and the chain, oldest first. */
export function Reconciliation() {
  const [offset, setOffset] = useState(0);
  const list = useQuery({
    queryKey: ["mismatches", offset],
    queryFn: ({ signal }) => fetchMismatches(PAGE_SIZE, offset, signal),
    placeholderData: keepPreviousData,
  });
  const data = list.data;

  return (
    <section aria-labelledby="reconciliation-heading">
      <h2 id="reconciliation-heading" tabIndex={-1}>
        Reconciliation
      </h2>
      {list.isPending && <p role="status">Loading the mismatches.</p>}
      {list.isError && <p role="alert">The mismatches cannot be loaded. Reload this page.</p>}
      {data?.total === 0 && <p>There are no open mismatches.</p>}
      {data !== undefined && data.total > 0 && (
        <>
          {data.items.length === 0 && (
            <p>No mismatches on this page. Use Previous page to go back.</p>
          )}
          <ul>
            {data.items.map((item) => (
              <li key={item.id} aria-labelledby={`mismatch-${item.id}`}>
                <strong id={`mismatch-${item.id}`}>
                  {KIND_LABEL[item.kind]}: {item.dealTitle}
                </strong>
                <p>
                  Chain transaction {item.chainTxId}.
                  {item.ledgerAmountMinor !== null &&
                    ` Ledger amount ${formatMoney(item.ledgerAmountMinor)}.`}
                  {item.chainAmountMinor !== null &&
                    ` Chain amount ${formatMoney(item.chainAmountMinor)}.`}{" "}
                  Found {formatFound(item.foundAt)}.
                </p>
              </li>
            ))}
          </ul>
          <p role="status">
            {data.items.length === 0 ? (
              <>{data.total} open mismatches in total.</>
            ) : (
              <>
                Showing {data.offset + 1} to {data.offset + data.items.length} of {data.total}.
              </>
            )}
          </p>
          <button
            type="button"
            disabled={data.offset === 0}
            onClick={() => {
              setOffset(Math.max(0, offset - PAGE_SIZE));
            }}
          >
            Previous page
          </button>
          <button
            type="button"
            disabled={data.offset + data.items.length >= data.total}
            onClick={() => {
              setOffset(offset + PAGE_SIZE);
            }}
          >
            Next page
          </button>
        </>
      )}
    </section>
  );
}
