import { useState, type SubmitEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  DISPLAY_NAME_RULE,
  DisplayName,
  type SessionResponse,
  type SessionUser,
} from "@escrow-lab/shared";
import { changeDisplayName, DisplayNameError } from "./api.ts";

export function Profile({ user, csrfToken }: { user: SessionUser; csrfToken: string }) {
  const client = useQueryClient();
  const [name, setName] = useState(user.displayName);
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const mutation = useMutation({
    mutationFn: (displayName: string) => changeDisplayName(displayName, csrfToken),
    onSuccess: (changed) => {
      client.setQueryData<SessionResponse>(["session"], (old) =>
        old === undefined ? old : { ...old, user: changed },
      );
      void client.invalidateQueries({ queryKey: ["users"] });
      void client.invalidateQueries({ queryKey: ["deals"] });
      void client.invalidateQueries({ queryKey: ["deal"] });
      setName(changed.displayName);
      setSaved(true);
    },
    onError: (error) => {
      setProblem(
        error instanceof DisplayNameError
          ? error.message
          : "The name was not saved. Reload this page and try again.",
      );
    },
  });

  function submit(event: SubmitEvent) {
    event.preventDefault();
    setSaved(false);
    const parsed = DisplayName.safeParse(name);
    if (!parsed.success) {
      setProblem(DISPLAY_NAME_RULE);
      return;
    }
    setProblem(null);
    mutation.mutate(parsed.data);
  }

  return (
    <section aria-labelledby="profile-heading">
      <h2 id="profile-heading" tabIndex={-1}>
        Profile
      </h2>
      {problem !== null && (
        <p id="profile-name-problem" role="alert">
          {problem}
        </p>
      )}
      {saved && <p role="status">The display name is saved.</p>}
      <form onSubmit={submit}>
        <p>
          <label htmlFor="profile-name">Display name</label>{" "}
          <input
            id="profile-name"
            type="text"
            value={name}
            aria-invalid={problem !== null}
            aria-describedby={problem !== null ? "profile-name-problem" : undefined}
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
        </p>
        <button type="submit" disabled={mutation.isPending}>
          Save
        </button>
      </form>
    </section>
  );
}
