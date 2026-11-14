import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { App } from "./App.tsx";
import { server } from "./test-server.ts";

function renderApp() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <App />
    </QueryClientProvider>,
  );
}

const USERS = [
  { id: "00000000-0000-4000-8000-000000000001", displayName: "Alice Buyer", role: "buyer" },
  { id: "00000000-0000-4000-8000-000000000003", displayName: "Carol Seller", role: "seller" },
  { id: "00000000-0000-4000-8000-000000000005", displayName: "Erin Approver", role: "approver" },
] as const;

function signedOutHandlers() {
  server.use(
    http.get("*/api/session", () => HttpResponse.json({ user: null, csrfToken: "token-1" })),
    http.get("*/api/users", () => HttpResponse.json({ users: USERS })),
  );
}

describe("App", () => {
  it("shows the API status", async () => {
    signedOutHandlers();
    server.use(http.get("*/api/health", () => HttpResponse.json({ status: "ok" })));
    renderApp();
    expect(screen.getByRole("heading", { level: 1 })).toBeInTheDocument();
    expect(await screen.findByText("API status: ok")).toBeInTheDocument();
  });

  it("tells the user what to do when the API cannot be reached", async () => {
    signedOutHandlers();
    server.use(http.get("*/api/health", () => new HttpResponse(null, { status: 500 })));
    renderApp();
    await screen.findByText(/cannot be reached/);
    expect(screen.getByRole("status")).toHaveTextContent(/cannot be reached.*pnpm dev/);
  });

  it("rejects a response that breaks the contract", async () => {
    signedOutHandlers();
    server.use(http.get("*/api/health", () => HttpResponse.json({ status: "ok", extra: 1 })));
    renderApp();
    expect(await screen.findByText(/cannot be reached/)).toBeInTheDocument();
  });

  it("shows the sign-in page with one button for each user", async () => {
    signedOutHandlers();
    server.use(http.get("*/api/health", () => HttpResponse.json({ status: "ok" })));
    renderApp();
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();
    for (const user of USERS) {
      expect(
        await screen.findByRole("button", { name: new RegExp(user.displayName) }),
      ).toBeVisible();
    }
  });

  it("signs in with the CSRF token when the person chooses a user", async () => {
    signedOutHandlers();
    server.use(http.get("*/api/health", () => HttpResponse.json({ status: "ok" })));
    let sent: { body: unknown; token: string | null } | undefined;
    server.use(
      http.post("*/api/session", async ({ request }) => {
        sent = { body: await request.json(), token: request.headers.get("x-csrf-token") };
        return HttpResponse.json({ user: USERS[0], csrfToken: "token-2" });
      }),
    );
    renderApp();
    await userEvent.click(await screen.findByRole("button", { name: /Alice Buyer/ }));
    expect(await screen.findByRole("heading", { name: "Deals" })).toBeInTheDocument();
    expect(sent).toEqual({ body: { userId: USERS[0].id }, token: "token-1" });
  });

  it.each([
    ["Buyer", USERS[0], "Deals"],
    ["Seller", USERS[1], "Deals"],
  ] as const)("shows the Deal list to a %s", async (_role, user, heading) => {
    server.use(
      http.get("*/api/health", () => HttpResponse.json({ status: "ok" })),
      http.get("*/api/session", () => HttpResponse.json({ user, csrfToken: "token-1" })),
    );
    renderApp();
    expect(await screen.findByRole("heading", { name: heading })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Approval queue" })).not.toBeInTheDocument();
  });

  it("shows the approval queue, and not the Deal list, to an Approver", async () => {
    server.use(
      http.get("*/api/health", () => HttpResponse.json({ status: "ok" })),
      http.get("*/api/session", () => HttpResponse.json({ user: USERS[2], csrfToken: "token-1" })),
    );
    renderApp();
    expect(await screen.findByRole("heading", { name: "Approval queue" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Deals" })).not.toBeInTheDocument();
  });

  it("signs out and shows the sign-in page", async () => {
    let signedOut = false;
    let token: string | null = null;
    server.use(
      http.get("*/api/health", () => HttpResponse.json({ status: "ok" })),
      http.get("*/api/users", () => HttpResponse.json({ users: USERS })),
      http.get("*/api/session", () =>
        HttpResponse.json(
          signedOut
            ? { user: null, csrfToken: "token-3" }
            : { user: USERS[0], csrfToken: "token-1" },
        ),
      ),
      http.delete("*/api/session", ({ request }) => {
        signedOut = true;
        token = request.headers.get("x-csrf-token");
        return new HttpResponse(null, { status: 204 });
      }),
    );
    renderApp();
    await userEvent.click(await screen.findByRole("button", { name: "Sign out" }));
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();
    expect(token).toBe("token-1");
  });
});
