import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { SessionUser } from "@escrow-lab/shared";
import { fetchHealth, fetchSession } from "./api.ts";
import { ApprovalQueue } from "./ApprovalQueue.tsx";
import { Deals } from "./Deals.tsx";
import { Profile } from "./Profile.tsx";
import { SignIn } from "./SignIn.tsx";
import { SignOut } from "./SignOut.tsx";

function SignedIn({ user, csrfToken }: { user: SessionUser; csrfToken: string }) {
  // This state goes away at sign-out, so the next person starts on the home page.
  const [page, setPage] = useState<"home" | "profile">("home");
  return (
    <>
      <p role="status">Signed in as {user.displayName}.</p>
      <button
        type="button"
        onClick={() => {
          setPage(page === "profile" ? "home" : "profile");
        }}
      >
        {page === "profile" ? "Back" : "Profile"}
      </button>
      {page === "profile" ? (
        <Profile user={user} csrfToken={csrfToken} />
      ) : user.role === "approver" ? (
        <ApprovalQueue csrfToken={csrfToken} />
      ) : (
        <Deals role={user.role} userId={user.id} csrfToken={csrfToken} />
      )}
      <SignOut csrfToken={csrfToken} />
    </>
  );
}

export function App() {
  const health = useQuery({
    queryKey: ["health"],
    queryFn: ({ signal }) => fetchHealth(signal),
  });

  const session = useQuery({
    queryKey: ["session"],
    queryFn: ({ signal }) => fetchSession(signal),
  });

  // Move focus to the heading of the new view when the signed-in user changes (WCAG 2.4.3).
  // The button that had focus unmounts, so focus would go to the body.
  const signedIn = session.data === undefined ? undefined : session.data.user !== null;
  const previous = useRef(signedIn);
  useEffect(() => {
    if (previous.current !== undefined && signedIn !== undefined && previous.current !== signedIn) {
      document.querySelector<HTMLElement>("main h2")?.focus();
    }
    previous.current = signedIn;
  }, [signedIn]);

  let message: string;
  if (health.isPending) {
    message = "Checking the API.";
  } else if (health.isError) {
    message = "The API cannot be reached. Start it with pnpm dev, then reload this page.";
  } else {
    message = `API status: ${health.data.status}`;
  }

  return (
    <main>
      <h1>escrow-lab</h1>
      <p role="status">{message}</p>
      {session.isPending && <p role="status">Loading the session.</p>}
      {session.isError && <p role="alert">The session cannot be read. Reload this page.</p>}
      {session.data?.user === null && <SignIn csrfToken={session.data.csrfToken} />}
      {session.data?.user && (
        <SignedIn user={session.data.user} csrfToken={session.data.csrfToken} />
      )}
    </main>
  );
}
