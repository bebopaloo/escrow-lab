import { useState, type SubmitEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MAX_NOTE_LENGTH } from "@escrow-lab/shared";
import { addNote, fetchNotes } from "./api.ts";

export interface DealNotesProps {
  dealId: string;
  csrfToken: string;
}

const ERROR_ID = "note-error";

/** The notes of a Deal, newest first, and the form to add one. */
export function DealNotes({ dealId, csrfToken }: DealNotesProps) {
  const client = useQueryClient();
  const [text, setText] = useState("");
  const [missing, setMissing] = useState(false);
  const notes = useQuery({
    queryKey: ["notes", dealId],
    queryFn: ({ signal }) => fetchNotes(dealId, signal),
    retry: false,
  });
  const add = useMutation({
    mutationFn: (value: string) => addNote(dealId, value, csrfToken),
    onSuccess: async () => {
      setText("");
      await client.invalidateQueries({ queryKey: ["notes", dealId] });
    },
  });

  function submit(event: SubmitEvent) {
    event.preventDefault();
    if (text.trim() === "") {
      setMissing(true);
      return;
    }
    setMissing(false);
    add.mutate(text);
  }

  const error = missing
    ? "Write a note before you add it."
    : add.isError
      ? add.error.message
      : null;

  return (
    <section aria-labelledby="notes-heading">
      <h3 id="notes-heading">Notes</h3>
      {notes.isPending && <p role="status">Loading the notes.</p>}
      {notes.isError && <p role="alert">The notes cannot be loaded. Reload this page.</p>}
      {notes.data?.notes.length === 0 && <p>This Deal has no notes yet.</p>}
      {notes.data !== undefined && notes.data.notes.length > 0 && (
        <ul>
          {notes.data.notes.map((note) => (
            <li key={note.id}>
              <p>
                {note.authorName},{" "}
                <time dateTime={note.createdAt}>
                  {new Date(note.createdAt).toLocaleString("en-GB")}
                </time>
              </p>
              <p style={{ whiteSpace: "pre-wrap" }}>{note.text}</p>
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={submit}>
        <p>
          <label htmlFor="note-text">Add a note</label>
        </p>
        <textarea
          id="note-text"
          rows={3}
          maxLength={MAX_NOTE_LENGTH}
          aria-invalid={error !== null ? true : undefined}
          aria-describedby={error !== null ? ERROR_ID : undefined}
          value={text}
          onChange={(event) => {
            setText(event.target.value);
          }}
        />
        {error !== null && (
          <p id={ERROR_ID} role="alert">
            {error}
          </p>
        )}
        <p>
          <button type="submit" disabled={add.isPending}>
            Add the note
          </button>
        </p>
      </form>
    </section>
  );
}
