import { useQuery } from "@tanstack/react-query";
import { fetchHealth, fetchSession } from "./api.ts";
import { ApprovalQueue } from "./ApprovalQueue.tsx";
import { DealList } from "./DealList.tsx";
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
      {session.isError && <p role="alert">The session cannot be read. Reload this page.</p>}
      {session.data?.user === null && <SignIn csrfToken={session.data.csrfToken} />}
      {session.data?.user && (
        <>
          <p>Signed in as {session.data.user.displayName}.</p>
          {session.data.user.role === "approver" ? <ApprovalQueue /> : <DealList />}
          <SignOut csrfToken={session.data.csrfToken} />
        </>
      )}
    </main>
  );
}
