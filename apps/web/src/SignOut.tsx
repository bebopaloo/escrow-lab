import { useMutation, useQueryClient } from "@tanstack/react-query";
import { signOut } from "./api.ts";

export function SignOut({ csrfToken }: { csrfToken: string }) {
  const client = useQueryClient();
  const mutation = useMutation({
    mutationFn: () => signOut(csrfToken),
    onSuccess: () => client.invalidateQueries({ queryKey: ["session"] }),
  });
  return (
    <>
      {mutation.isError && <p role="alert">Sign-out failed. Reload this page and try again.</p>}
      <button
        type="button"
        disabled={mutation.isPending}
        onClick={() => {
          mutation.mutate();
        }}
      >
        Sign out
      </button>
    </>
  );
}
