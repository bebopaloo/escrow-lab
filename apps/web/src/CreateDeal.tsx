import { useEffect, useRef, useState, type SubmitEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MAX_MILESTONES, type CreateDealRequest, type DealResponse } from "@escrow-lab/shared";
import { createDeal, fetchUsers } from "./api.ts";
import { parsePounds } from "./money.ts";

export interface CreateDealProps {
  csrfToken: string;
  onCreated: (deal: DealResponse) => void;
  onCancel: () => void;
}

interface MilestoneInput {
  title: string;
  amount: string;
}

const ERROR_ID = "deal-form-error";
const AMOUNT_HELP = "Enter amounts in pounds and pence, for example 400 or 400.50.";

function describedBy(failing: boolean): string {
  return failing ? `deal-amount-help ${ERROR_ID}` : "deal-amount-help";
}

export function CreateDeal({ csrfToken, onCreated, onCancel }: CreateDealProps) {
  const client = useQueryClient();
  const users = useQuery({ queryKey: ["users"], queryFn: ({ signal }) => fetchUsers(signal) });
  const [sellerId, setSellerId] = useState("");
  const [title, setTitle] = useState("");
  const [total, setTotal] = useState("");
  const [milestones, setMilestones] = useState<MilestoneInput[]>([{ title: "", amount: "" }]);
  const [formError, setFormError] = useState<string | null>(null);
  const [badTotal, setBadTotal] = useState(false);
  const [badAmounts, setBadAmounts] = useState<boolean[]>([]);
  const focusIndex = useRef<number | null>(null);

  useEffect(() => {
    if (focusIndex.current === null) return;
    document.getElementById(`milestone-title-${focusIndex.current.toString()}`)?.focus();
    focusIndex.current = null;
  }, [milestones]);

  const mutation = useMutation({
    mutationFn: (request: CreateDealRequest) => createDeal(request, csrfToken),
    onSuccess: async (deal) => {
      client.setQueryData(["deal", deal.id], deal);
      await client.invalidateQueries({ queryKey: ["deals"] });
      onCreated(deal);
    },
  });

  function update(index: number, change: Partial<MilestoneInput>) {
    setMilestones((current) =>
      current.map((item, position) => (position === index ? { ...item, ...change } : item)),
    );
  }

  function submit(event: SubmitEvent) {
    event.preventDefault();
    const totalMinor = parsePounds(total);
    const parsed = milestones.map((item) => ({
      title: item.title,
      amountMinor: parsePounds(item.amount),
    }));
    if (totalMinor === null || parsed.some((item) => item.amountMinor === null)) {
      setBadTotal(totalMinor === null);
      setBadAmounts(parsed.map((item) => item.amountMinor === null));
      setFormError(AMOUNT_HELP);
      return;
    }
    setBadTotal(false);
    setBadAmounts([]);
    setFormError(null);
    mutation.mutate({
      sellerId,
      title,
      totalMinor,
      milestones: parsed.map((item) => ({ title: item.title, amountMinor: item.amountMinor ?? 0 })),
    });
  }

  const sellers = users.data?.users.filter((user) => user.role === "seller") ?? [];
  const error = formError ?? (mutation.isError ? mutation.error.message : null);

  return (
    <section aria-labelledby="create-deal-heading">
      <h2 id="create-deal-heading" tabIndex={-1}>
        Create a Deal
      </h2>
      {users.isPending && <p role="status">Loading the Sellers.</p>}
      {users.isError && <p role="alert">The Sellers cannot be loaded. Reload this page.</p>}
      <form onSubmit={submit}>
        <p>
          <label htmlFor="deal-seller">Seller</label>{" "}
          <select
            id="deal-seller"
            required
            value={sellerId}
            onChange={(event) => {
              setSellerId(event.target.value);
            }}
          >
            <option value="">Choose a Seller</option>
            {sellers.map((seller) => (
              <option key={seller.id} value={seller.id}>
                {seller.displayName}
              </option>
            ))}
          </select>
        </p>
        <p>
          <label htmlFor="deal-title">Deal title</label>{" "}
          <input
            id="deal-title"
            required
            maxLength={100}
            value={title}
            onChange={(event) => {
              setTitle(event.target.value);
            }}
          />
        </p>
        <p>
          <label htmlFor="deal-total">Total (£)</label>{" "}
          <input
            id="deal-total"
            required
            inputMode="decimal"
            aria-invalid={badTotal && formError !== null ? true : undefined}
            aria-describedby={describedBy(badTotal && formError !== null)}
            value={total}
            onChange={(event) => {
              setTotal(event.target.value);
            }}
          />
        </p>
        <p id="deal-amount-help">{AMOUNT_HELP}</p>
        <fieldset>
          <legend>Milestones</legend>
          {milestones.map((item, index) => (
            <p key={index}>
              <label htmlFor={`milestone-title-${index.toString()}`}>
                Milestone {index + 1} title
              </label>{" "}
              <input
                id={`milestone-title-${index.toString()}`}
                required
                maxLength={100}
                value={item.title}
                onChange={(event) => {
                  update(index, { title: event.target.value });
                }}
              />{" "}
              <label htmlFor={`milestone-amount-${index.toString()}`}>
                Milestone {index + 1} amount (£)
              </label>{" "}
              <input
                id={`milestone-amount-${index.toString()}`}
                required
                inputMode="decimal"
                aria-invalid={badAmounts[index] === true && formError !== null ? true : undefined}
                aria-describedby={describedBy(badAmounts[index] === true && formError !== null)}
                value={item.amount}
                onChange={(event) => {
                  update(index, { amount: event.target.value });
                }}
              />{" "}
              {milestones.length > 1 && (
                <button
                  type="button"
                  onClick={() => {
                    focusIndex.current = Math.min(index, milestones.length - 2);
                    setMilestones((current) => current.filter((_, position) => position !== index));
                  }}
                >
                  Remove Milestone {index + 1}
                </button>
              )}
            </p>
          ))}
          <button
            type="button"
            disabled={milestones.length >= MAX_MILESTONES}
            onClick={() => {
              focusIndex.current = milestones.length;
              setMilestones((current) => [...current, { title: "", amount: "" }]);
            }}
          >
            Add a Milestone
          </button>
        </fieldset>
        {error !== null && (
          <p id={ERROR_ID} role="alert">
            {error}
          </p>
        )}
        <button type="submit" disabled={mutation.isPending}>
          Create the Deal
        </button>{" "}
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </form>
    </section>
  );
}
