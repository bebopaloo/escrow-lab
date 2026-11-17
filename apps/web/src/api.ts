import {
  ApprovalQueueResponse,
  ApprovePayoutResponse,
  RetryPayoutResponse,
  DealListResponse,
  DealResponse,
  ErrorResponse,
  HealthResponse,
  MilestoneResponse,
  NoteResponse,
  NotesResponse,
  PAYMENT_FAILED,
  SessionResponse,
  UsersResponse,
  type CreateDealRequest,
} from "@escrow-lab/shared";

export async function fetchHealth(signal?: AbortSignal): Promise<HealthResponse> {
  const url = new URL("/api/health", window.location.origin);
  const response = await fetch(url, signal ? { signal } : {});
  if (response.status !== 200 && response.status !== 503) {
    throw new Error(`Health check failed with status ${response.status.toString()}`);
  }
  return HealthResponse.parse(await response.json());
}

async function readJson(response: Response, expected: number, what: string): Promise<unknown> {
  if (response.status !== expected) {
    throw new Error(`${what} failed with status ${response.status.toString()}`);
  }
  return response.json();
}

export async function fetchSession(signal?: AbortSignal): Promise<SessionResponse> {
  const response = await fetch(
    new URL("/api/session", window.location.origin),
    signal ? { signal } : {},
  );
  return SessionResponse.parse(await readJson(response, 200, "Session check"));
}

export async function fetchUsers(signal?: AbortSignal): Promise<UsersResponse> {
  const response = await fetch(
    new URL("/api/users", window.location.origin),
    signal ? { signal } : {},
  );
  return UsersResponse.parse(await readJson(response, 200, "User list"));
}

export async function signIn(userId: string, csrfToken: string): Promise<SessionResponse> {
  const response = await fetch(new URL("/api/session", window.location.origin), {
    method: "POST",
    headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
    body: JSON.stringify({ userId }),
  });
  return SessionResponse.parse(await readJson(response, 200, "Sign-in"));
}

export async function signOut(csrfToken: string): Promise<void> {
  const response = await fetch(new URL("/api/session", window.location.origin), {
    method: "DELETE",
    headers: { "x-csrf-token": csrfToken },
  });
  if (response.status !== 204) {
    throw new Error(`Sign-out failed with status ${response.status.toString()}`);
  }
}

export class NotFoundError extends Error {}

/** A refusal that the API explains in words that the person can read. */
export class RefusedError extends Error {}

export async function fetchDeals(signal?: AbortSignal): Promise<DealListResponse> {
  const url = new URL("/api/deals", window.location.origin);
  url.searchParams.set("limit", "100");
  const response = await fetch(url, signal ? { signal } : {});
  return DealListResponse.parse(await readJson(response, 200, "Deal list"));
}

export async function fetchDeal(id: string, signal?: AbortSignal): Promise<DealResponse> {
  const response = await fetch(
    new URL(`/api/deals/${encodeURIComponent(id)}`, window.location.origin),
    signal ? { signal } : {},
  );
  if (response.status === 404) throw new NotFoundError("Deal not found");
  return DealResponse.parse(await readJson(response, 200, "Deal"));
}

export async function createDeal(
  request: CreateDealRequest,
  csrfToken: string,
): Promise<DealResponse> {
  const response = await fetch(new URL("/api/deals", window.location.origin), {
    method: "POST",
    headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
    body: JSON.stringify(request),
  });
  if (response.status === 400) {
    const parsed = ErrorResponse.safeParse(await response.json());
    const known = parsed.success && parsed.data.error !== "Bad request";
    throw new RefusedError(
      known ? parsed.data.error : "The Deal was refused. Check the details and try again.",
    );
  }
  return DealResponse.parse(await readJson(response, 201, "Create Deal"));
}

/** The payment rail refused the charge. The Deal is back in draft. */
export class PaymentFailedError extends Error {}

export async function fundDeal(id: string, csrfToken: string): Promise<DealResponse> {
  const response = await fetch(
    new URL(`/api/deals/${encodeURIComponent(id)}/fund`, window.location.origin),
    { method: "POST", headers: { "x-csrf-token": csrfToken } },
  );
  if (response.status === 402) throw new PaymentFailedError(PAYMENT_FAILED);
  return DealResponse.parse(await readJson(response, 200, "Fund Deal"));
}

/** The API refused a Milestone action, for example because the state changed. */
export class MilestoneActionError extends Error {}

async function postMilestoneAction(
  id: string,
  action: "evidence" | "accept" | "reject",
  csrfToken: string,
  body: object,
): Promise<MilestoneResponse> {
  const response = await fetch(
    new URL(`/api/milestones/${encodeURIComponent(id)}/${action}`, window.location.origin),
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
      body: JSON.stringify(body),
    },
  );
  if (response.status !== 200) {
    throw new MilestoneActionError(
      "The action failed. Reload this page to see the current state of the Milestone.",
    );
  }
  return MilestoneResponse.parse(await response.json());
}

export function sendEvidence(id: string, evidenceText: string, csrfToken: string) {
  return postMilestoneAction(id, "evidence", csrfToken, { evidenceText });
}

export function acceptEvidence(id: string, csrfToken: string) {
  return postMilestoneAction(id, "accept", csrfToken, {});
}

export function rejectEvidence(id: string, reason: string, csrfToken: string) {
  return postMilestoneAction(id, "reject", csrfToken, { reason });
}

export async function fetchApprovals(signal?: AbortSignal): Promise<ApprovalQueueResponse> {
  const url = new URL("/api/approvals", window.location.origin);
  url.searchParams.set("limit", "100");
  const response = await fetch(url, signal ? { signal } : {});
  return ApprovalQueueResponse.parse(await readJson(response, 200, "Approval queue"));
}

/** The API refused the approval, for example because the state changed. */
export class ApprovalError extends Error {}

export async function approvePayout(
  milestoneId: string,
  csrfToken: string,
): Promise<ApprovePayoutResponse> {
  const response = await fetch(
    new URL(`/api/milestones/${encodeURIComponent(milestoneId)}/payout`, window.location.origin),
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
      body: JSON.stringify({}),
    },
  );
  if (response.status !== 200) {
    throw new ApprovalError("The approval failed. Reload the queue to see the current state.");
  }
  return ApprovePayoutResponse.parse(await response.json());
}

/** The API refused the retry, for example because the Payout is no longer failed. */
export class RetryError extends Error {}

export async function retryPayout(
  payoutId: string,
  csrfToken: string,
): Promise<RetryPayoutResponse> {
  const response = await fetch(
    new URL(`/api/payouts/${encodeURIComponent(payoutId)}/retry`, window.location.origin),
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
      body: JSON.stringify({}),
    },
  );
  if (response.status !== 200) {
    throw new RetryError("The retry failed. Reload the queue to see the current state.");
  }
  return RetryPayoutResponse.parse(await response.json());
}

export async function fetchNotes(dealId: string, signal?: AbortSignal): Promise<NotesResponse> {
  const response = await fetch(
    new URL(`/api/deals/${encodeURIComponent(dealId)}/notes`, window.location.origin),
    signal ? { signal } : {},
  );
  return NotesResponse.parse(await readJson(response, 200, "Notes"));
}

/** The API refused the note, for example because it is empty or too long. */
export class NoteRefusedError extends Error {}

export async function addNote(
  dealId: string,
  text: string,
  csrfToken: string,
): Promise<NoteResponse> {
  const response = await fetch(
    new URL(`/api/deals/${encodeURIComponent(dealId)}/notes`, window.location.origin),
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
      body: JSON.stringify({ text }),
    },
  );
  if (response.status !== 201) throw new NoteRefusedError("The note was not added.");
  return NoteResponse.parse(await response.json());
}
