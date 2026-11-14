import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchUsers, signIn } from "./api.ts";

export function SignIn({ csrfToken }: { csrfToken: string }) {
  const client = useQueryClient();
  const users = useQuery({ queryKey: ["users"], queryFn: ({ signal }) => fetchUsers(signal) });
  const mutation = useMutation({
    mutationFn: (userId: string) => signIn(userId, csrfToken),
    onSuccess: (session) => {
      client.setQueryData(["session"], session);
    },
  });

  return (
    <section aria-labelledby="sign-in-heading">
      <h2 id="sign-in-heading">Sign in</h2>
      {users.isPending && <p>Loading the users.</p>}
      {users.isError && <p role="alert">The users cannot be loaded. Reload this page.</p>}
      {mutation.isError && <p role="alert">Sign-in failed. Reload this page and try again.</p>}
      {users.data && (
        <ul>
          {users.data.users.map((user) => (
            <li key={user.id}>
              <button
                type="button"
                onClick={() => {
                  mutation.mutate(user.id);
                }}
              >
                {user.displayName} ({user.role})
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
