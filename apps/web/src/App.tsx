import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchHealth, fetchSession } from "./api.ts";
import { ApprovalQueue } from "./ApprovalQueue.tsx";
import { Deals } from "./Deals.tsx";
import { SignIn } from "./SignIn.tsx";
import { SignOut } from "./SignOut.tsx";

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
        <>
          <p role="status">Signed in as {session.data.user.displayName}.</p>
          {session.data.user.role === "approver" ? (
            <ApprovalQueue />
          ) : (
            <Deals
              role={session.data.user.role}
              userId={session.data.user.id}
              csrfToken={session.data.csrfToken}
            />
          )}
          <SignOut csrfToken={session.data.csrfToken} />
        </>
      )}
    </main>
  );
}
