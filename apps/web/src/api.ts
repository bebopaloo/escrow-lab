import {
  DealListResponse,
  DealResponse,
  ErrorResponse,
  HealthResponse,
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
