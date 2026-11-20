import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ApprovalItem } from "@escrow-lab/shared";
import { approvePayout, fetchApprovals, refundDeal, retryPayout } from "./api.ts";
import { formatMoney } from "./money.ts";

export interface ApprovalQueueProps {
  csrfToken: string;
}

function ItemBody({ item }: { item: ApprovalItem }) {
  const headingId = `approval-${item.kind}-${item.id}`;
  if (item.kind === "funding_failed") {
    return (
      <>
        <strong id={headingId}>{item.dealTitle}</strong>
        <p>Funding failed. The Deal total is {formatMoney(item.totalMinor)}.</p>
      </>
    );
  }
  if (item.kind === "refundable" || item.kind === "refund_failed") {
    return (
      <>
        <strong id={headingId}>{item.dealTitle}</strong>
        <p>
          {item.kind === "refund_failed" ? "Refund failed. " : "Funded, with no Payout. "}
          The Deal total is {formatMoney(item.totalMinor)}.
        </p>
      </>
    );
  }
  return (
    <>
      <strong id={headingId}>
        Milestone {item.position}: {item.title}
      </strong>
      {item.kind === "express_payout" && <mark>express</mark>}
      <p>
        Deal {item.dealTitle}. Amount {formatMoney(item.amountMinor)}.
        {item.kind === "failed_payout" && " Payout failed."}
      </p>
    </>
  );
}

/** The work that waits for an Approver. A failed Payout has a Retry button. */
export function ApprovalQueue({ csrfToken }: ApprovalQueueProps) {
  const client = useQueryClient();
  const heading = useRef<HTMLHeadingElement>(null);
  const [notice, setNotice] = useState("");
  const queue = useQuery({
    queryKey: ["approvals"],
    queryFn: ({ signal }) => fetchApprovals(signal),
  });

  const approve = useMutation({
    mutationFn: (item: { id: string; title: string }) => approvePayout(item.id, csrfToken),
    onSuccess: async (result, item) => {
      setNotice(
        result.state === "confirmed"
          ? `The Payout for ${item.title} is paid.`
          : `The Payout for ${item.title} is approved. The transfer is not confirmed yet. It stays pending.`,
      );
      await client.invalidateQueries({ queryKey: ["approvals"] });
      // The button unmounts, so focus would go to the body (WCAG 2.4.3).
      heading.current?.focus();
    },
  });

  const retry = useMutation({
    mutationFn: (item: { id: string; title: string }) => retryPayout(item.id, csrfToken),
    onSuccess: async (_result, item) => {
      setNotice(`The Payout for ${item.title} will be tried again.`);
      await client.invalidateQueries({ queryKey: ["approvals"] });
      heading.current?.focus();
    },
  });

  const refund = useMutation({
    mutationFn: (item: { id: string; title: string }) => refundDeal(item.id, csrfToken),
    onSuccess: async (result, item) => {
      setNotice(
        result.state === "refunded"
          ? `The Deal ${item.title} is refunded.`
          : `The refund of ${item.title} is not confirmed yet. The app will try again.`,
      );
      await client.invalidateQueries({ queryKey: ["approvals"] });
      heading.current?.focus();
    },
  });

  return (
    <section aria-labelledby="approval-queue-heading">
      <h2 id="approval-queue-heading" tabIndex={-1} ref={heading}>
        Approval queue
      </h2>
      {notice !== "" && <p role="status">{notice}</p>}
      {approve.isError && <p role="alert">{approve.error.message}</p>}
      {retry.isError && <p role="alert">{retry.error.message}</p>}
      {refund.isError && <p role="alert">{refund.error.message}</p>}
      {queue.isPending && <p role="status">Loading the approval queue.</p>}
      {queue.isError && <p role="alert">The approval queue cannot be loaded. Reload this page.</p>}
      {queue.data && queue.data.total > queue.data.items.length && (
        <p role="status">
          This queue shows {queue.data.items.length} of {queue.data.total} items.
        </p>
      )}
      {queue.data?.items.length === 0 && <p>Nothing waits for approval.</p>}
      {queue.data !== undefined && queue.data.items.length > 0 && (
        <ul>
          {queue.data.items.map((item) => (
            <li
              key={`${item.kind}-${item.id}`}
              aria-labelledby={`approval-${item.kind}-${item.id}`}
            >
              <ItemBody item={item} />
              {(item.kind === "milestone" || item.kind === "express_payout") && (
                <button
                  type="button"
                  disabled={approve.isPending}
                  onClick={() => {
                    approve.mutate({ id: item.id, title: item.title });
                  }}
                >
                  Approve the Payout for {item.title}
                </button>
              )}
              {item.kind === "failed_payout" && (
                <button
                  type="button"
                  disabled={retry.isPending}
                  onClick={() => {
                    retry.mutate({ id: item.id, title: item.title });
                  }}
                >
                  Retry the Payout for {item.title}
                </button>
              )}
              {item.kind === "refundable" && (
                <button
                  type="button"
                  disabled={refund.isPending}
                  onClick={() => {
                    refund.mutate({ id: item.id, title: item.dealTitle });
                  }}
                >
                  Refund the Deal {item.dealTitle}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
