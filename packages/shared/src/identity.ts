import { z } from "zod";

export const Role = z.enum(["buyer", "seller", "approver"]);
export type Role = z.infer<typeof Role>;

export const SessionUser = z
  .object({
    id: z.uuid(),
    displayName: z.string().min(1),
    role: Role,
  })
  .strict();
export type SessionUser = z.infer<typeof SessionUser>;

export const UsersResponse = z.object({ users: z.array(SessionUser) }).strict();
export type UsersResponse = z.infer<typeof UsersResponse>;

export const SessionResponse = z
  .object({
    user: SessionUser.nullable(),
    csrfToken: z.string().min(1),
  })
  .strict();
export type SessionResponse = z.infer<typeof SessionResponse>;

export const SignInRequest = z.object({ userId: z.uuid() }).strict();
export type SignInRequest = z.infer<typeof SignInRequest>;

export const DISPLAY_NAME_MAX = 60;

export const DISPLAY_NAME_RULE =
  "Enter a name of 1 to 60 characters, with no hidden characters and no mix of Latin, Cyrillic and Greek letters.";

/** Control characters and invisible format characters (zero-width, direction marks). */
const HIDDEN_CHARACTER = /[\p{Cc}\p{Cf}]/u;

const LOOKALIKE_SCRIPTS = [/\p{Script=Latin}/u, /\p{Script=Cyrillic}/u, /\p{Script=Greek}/u];

/** Latin, Cyrillic and Greek have letters that look the same. A name uses at most one of them. */
function mixesLookalikeScripts(value: string): boolean {
  return LOOKALIKE_SCRIPTS.filter((script) => script.test(value)).length > 1;
}

/**
 * A display name in one form: no hidden characters, NFKC, one space between words, no outer
 * space, and no mix of Latin, Cyrillic and Greek letters. NFKC folds width and compatibility
 * variants only: a name fully in one script can still look like a name in another script.
 */
export const DisplayName = z
  .string()
  .refine((value) => !HIDDEN_CHARACTER.test(value), "A name has no control or hidden characters")
  .refine((value) => !mixesLookalikeScripts(value.normalize("NFKC")), "A name uses one script")
  .transform((value) => value.normalize("NFKC").replace(/\s+/gu, " ").trim())
  .pipe(z.string().min(1).max(DISPLAY_NAME_MAX));

export const ChangeDisplayNameRequest = z.object({ displayName: DisplayName }).strict();
export type ChangeDisplayNameRequest = z.infer<typeof ChangeDisplayNameRequest>;

export const ErrorResponse = z.object({ error: z.string(), requestId: z.string() }).strict();
export type ErrorResponse = z.infer<typeof ErrorResponse>;
