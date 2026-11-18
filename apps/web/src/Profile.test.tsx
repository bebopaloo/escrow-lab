import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { App } from "./App.tsx";
import { server } from "./test-server.ts";

const ALICE = {
  id: "00000000-0000-4000-8000-000000000001",
  displayName: "Alice Buyer",
  role: "buyer",
} as const;

function renderApp() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <App />
    </QueryClientProvider>,
  );
}

function signedIn() {
  server.use(
    http.get("*/api/health", () => HttpResponse.json({ status: "ok" })),
    http.get("*/api/session", () => HttpResponse.json({ user: ALICE, csrfToken: "token-1" })),
    http.get("*/api/deals", () => HttpResponse.json({ deals: [], total: 0, limit: 20, offset: 0 })),
  );
}

async function openProfile() {
  renderApp();
  await userEvent.click(await screen.findByRole("button", { name: "Profile" }));
  return screen.findByRole("textbox", { name: "Display name" });
}

describe("Profile page", () => {
  it("changes the display name with the CSRF token and shows the new name", async () => {
    signedIn();
    let sent: { body: unknown; token: string | null } | undefined;
    server.use(
      http.patch("*/api/session/user", async ({ request }) => {
        sent = { body: await request.json(), token: request.headers.get("x-csrf-token") };
        return HttpResponse.json({ ...ALICE, displayName: "Alice Builder" });
      }),
    );
    const input = await openProfile();
    expect(input).toHaveValue("Alice Buyer");
    await userEvent.clear(input);
    await userEvent.type(input, "  Alice Builder ");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Signed in as Alice Builder.")).toBeInTheDocument();
    expect(sent).toEqual({ body: { displayName: "Alice Builder" }, token: "token-1" });
  });

  it("refuses a name of only spaces before it sends anything", async () => {
    signedIn();
    const input = await openProfile();
    await userEvent.clear(input);
    await userEvent.type(input, "   ");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/1 to 60 characters/);
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAccessibleDescription(/1 to 60 characters/);
  });

  it("refuses a name that mixes Latin and Cyrillic letters before it sends anything", async () => {
    signedIn();
    const input = await openProfile();
    await userEvent.clear(input);
    await userEvent.type(input, "\u0410lice Builder");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/no mix of Latin/);
  });

  it("explains every reason when the API answers 400", async () => {
    signedIn();
    server.use(
      http.patch("*/api/session/user", () =>
        HttpResponse.json({ error: "Bad request", requestId: "r1" }, { status: 400 }),
      ),
    );
    const input = await openProfile();
    await userEvent.clear(input);
    await userEvent.type(input, "Alice Builder");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/no hidden characters/);
  });

  it("tells the user when another user has the name", async () => {
    signedIn();
    server.use(
      http.patch("*/api/session/user", () =>
        HttpResponse.json({ error: "Name already in use", requestId: "r1" }, { status: 409 }),
      ),
    );
    const input = await openProfile();
    await userEvent.clear(input);
    await userEvent.type(input, "Carol Seller");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/another user has that name/i);
    expect(screen.getByText("Signed in as Alice Buyer.")).toBeInTheDocument();
  });
});
