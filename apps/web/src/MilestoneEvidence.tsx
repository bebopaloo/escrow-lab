import { useRef, useState, type SubmitEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  MAX_EVIDENCE_LENGTH,
  MAX_REJECTION_REASON_LENGTH,
  type MilestoneResponse,
} from "@escrow-lab/shared";
import { acceptEvidence, rejectEvidence, sendEvidence } from "./api.ts";

export interface MilestoneEvidenceProps {
  dealId: string;
  milestone: MilestoneResponse;
  role: "buyer" | "seller";
  csrfToken: string;
}

const SEND_ERROR_ID = "evidence-error";
const REJECT_ERROR_ID = "reject-error";

/** The evidence step of the open Milestone, for the Buyer or the Seller of the Deal. */
export function MilestoneEvidence({ dealId, milestone, role, csrfToken }: MilestoneEvidenceProps) {
  const client = useQueryClient();
  const heading = useRef<HTMLHeadingElement>(null);
  const [evidence, setEvidence] = useState("");
  const [reason, setReason] = useState("");
  const [reasonMissing, setReasonMissing] = useState(false);
  const [notice, setNotice] = useState("");

  function done(message: string) {
    return async () => {
      setNotice(message);
      await client.invalidateQueries({ queryKey: ["deal", dealId] });
      // The form or the buttons unmount, so focus would go to the body (WCAG 2.4.3).
      heading.current?.focus();
    };
  }

  const send = useMutation({
    mutationFn: (text: string) => sendEvidence(milestone.id, text, csrfToken),
    onSuccess: done("The evidence is sent."),
  });
  const accept = useMutation({
    mutationFn: () => acceptEvidence(milestone.id, csrfToken),
    onSuccess: done("The evidence is accepted."),
  });
  const reject = useMutation({
    mutationFn: (text: string) => rejectEvidence(milestone.id, text, csrfToken),
    onSuccess: done("The evidence is rejected."),
  });
  const reviewing = accept.isPending || reject.isPending;

  function submitEvidence(event: SubmitEvent) {
    event.preventDefault();
    send.mutate(evidence);
  }

  function submitReject() {
    if (reason.trim() === "") {
      setReasonMissing(true);
      return;
    }
    setReasonMissing(false);
    reject.mutate(reason);
  }

  const reviewError = reasonMissing
    ? "Give a reason for the rejection."
    : reject.isError
      ? reject.error.message
      : null;
  const state = milestone.state;

  return (
    <section aria-labelledby="evidence-heading">
      <h3 id="evidence-heading" tabIndex={-1} ref={heading}>
        Evidence for Milestone {milestone.position}
      </h3>
      {notice !== "" && <p role="status">{notice}</p>}

      {role === "seller" && state === "awaiting_evidence" && (
        <form onSubmit={submitEvidence}>
          {milestone.rejectionReason !== null && (
            <p>
              The Buyer rejected the last evidence. Reason: <q>{milestone.rejectionReason}</q>
            </p>
          )}
          <p>
            <label htmlFor="evidence-text">Evidence</label>
          </p>
          <textarea
            id="evidence-text"
            required
            rows={5}
            maxLength={MAX_EVIDENCE_LENGTH}
            aria-invalid={send.isError ? true : undefined}
            aria-describedby={send.isError ? SEND_ERROR_ID : undefined}
            value={evidence}
            onChange={(event) => {
              setEvidence(event.target.value);
            }}
          />
          {send.isError && (
            <p id={SEND_ERROR_ID} role="alert">
              {send.error.message}
            </p>
          )}
          <p>
            <button type="submit" disabled={send.isPending}>
              Send evidence
            </button>
          </p>
          {send.isPending && <p role="status">Sending the evidence.</p>}
        </form>
      )}
      {role === "buyer" && state === "awaiting_evidence" && (
        <p>Waiting for the Seller to send evidence.</p>
      )}

      {state === "evidence_sent" && (
        <>
          {role === "buyer" && (
            <>
              <p>Evidence from the Seller:</p>
              <blockquote style={{ whiteSpace: "pre-wrap" }}>{milestone.evidenceText}</blockquote>
              <p>
                <button
                  type="button"
                  disabled={reviewing}
                  onClick={() => {
                    accept.mutate();
                  }}
                >
                  Accept the evidence
                </button>
              </p>
              <p>
                <label htmlFor="reject-reason">Reason for rejection</label>
              </p>
              <textarea
                id="reject-reason"
                rows={3}
                maxLength={MAX_REJECTION_REASON_LENGTH}
                aria-invalid={reviewError !== null ? true : undefined}
                aria-describedby={reviewError !== null ? REJECT_ERROR_ID : undefined}
                value={reason}
                onChange={(event) => {
                  setReason(event.target.value);
                }}
              />
              {reviewError !== null && (
                <p id={REJECT_ERROR_ID} role="alert">
                  {reviewError}
                </p>
              )}
              {accept.isError && <p role="alert">{accept.error.message}</p>}
              <p>
                <button type="button" disabled={reviewing} onClick={submitReject}>
                  Reject the evidence
                </button>
              </p>
              {reviewing && <p role="status">Saving your decision.</p>}
            </>
          )}
          {role === "seller" && <p>Waiting for the Buyer to review the evidence.</p>}
        </>
      )}

      {state === "accepted" && (
        <>
          {milestone.evidenceText !== null && (
            <blockquote style={{ whiteSpace: "pre-wrap" }}>{milestone.evidenceText}</blockquote>
          )}
          <p>The Buyer accepted the evidence. An Approver can now approve the Payout.</p>
        </>
      )}
    </section>
  );
}
