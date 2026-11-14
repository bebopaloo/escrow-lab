import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ApprovalItem } from "@escrow-lab/shared";
import { approvePayout, fetchApprovals } from "./api.ts";
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
  return (
    <>
      <strong id={headingId}>
        Milestone {item.position}: {item.title}
      </strong>
      <p>
        Deal {item.dealTitle}. Amount {formatMoney(item.amountMinor)}.
        {item.kind === "failed_payout" && " Payout failed."}
      </p>
    </>
  );
}

/** The work that waits for an Approver. Failed items are read-only. */
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

  return (
    <section aria-labelledby="approval-queue-heading">
      <h2 id="approval-queue-heading" tabIndex={-1} ref={heading}>
        Approval queue
      </h2>
      {notice !== "" && <p role="status">{notice}</p>}
      {approve.isError && <p role="alert">{approve.error.message}</p>}
      {queue.isPending && <p role="status">Loading the approval queue.</p>}
      {queue.isError && <p role="alert">The approval queue cannot be loaded. Reload this page.</p>}
      {queue.data?.items.length === 0 && <p>Nothing waits for approval.</p>}
      {queue.data !== undefined && queue.data.items.length > 0 && (
        <ul>
          {queue.data.items.map((item) => (
            <li
              key={`${item.kind}-${item.id}`}
              aria-labelledby={`approval-${item.kind}-${item.id}`}
            >
              <ItemBody item={item} />
              {item.kind === "milestone" && (
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
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
