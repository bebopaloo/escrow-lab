import { HealthResponse, SessionResponse, UsersResponse } from "@escrow-lab/shared";

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
