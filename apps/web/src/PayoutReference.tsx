import { useState, type SubmitEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { MAX_REFERENCE_LENGTH } from "@escrow-lab/shared";
import { setPayoutReference } from "./api.ts";

export interface PayoutReferenceProps {
  dealId: string;
  milestoneId: string;
  title: string;
  reference: string | null;
  /** True for the Seller of the Deal, who can change the reference. */
  editable: boolean;
  csrfToken: string;
}

/** The Seller reference of a Payout. The Seller also gets a form to set, change or clear it. */
export function PayoutReference({
  dealId,
  milestoneId,
  title,
  reference,
  editable,
  csrfToken,
}: PayoutReferenceProps) {
  const client = useQueryClient();
  const [text, setText] = useState(reference ?? "");
  const save = useMutation({
    mutationFn: (value: string) => setPayoutReference(dealId, milestoneId, value, csrfToken),
    onSuccess: () => client.invalidateQueries({ queryKey: ["deal", dealId] }),
  });
  const errorId = `reference-error-${milestoneId}`;

  function submit(event: SubmitEvent) {
    event.preventDefault();
    save.mutate(text.trim());
  }

  return (
    <>
      {reference !== null && <p>Reference: {reference}</p>}
      {editable && (
        <form onSubmit={submit}>
          <label htmlFor={`reference-${milestoneId}`}>Reference for {title}</label>{" "}
          <input
            id={`reference-${milestoneId}`}
            type="text"
            maxLength={MAX_REFERENCE_LENGTH}
            aria-invalid={save.isError ? true : undefined}
            aria-describedby={save.isError ? errorId : undefined}
            value={text}
            onChange={(event) => {
              setText(event.target.value);
            }}
          />{" "}
          <button type="submit" disabled={save.isPending}>
            Save the reference for {title}
          </button>
          {save.isError && (
            <p id={errorId} role="alert">
              {save.error.message}
            </p>
          )}
        </form>
      )}
    </>
  );
}
