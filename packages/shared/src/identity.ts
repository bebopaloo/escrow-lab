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

/** Control characters and invisible format characters (zero-width, direction marks). */
const HIDDEN_CHARACTER = /[\p{Cc}\p{Cf}]/u;

/**
 * A display name in one form: no hidden characters, NFKC, one space between words, no outer
 * space. Two names that look the same then have the same text.
 */
export const DisplayName = z
  .string()
  .refine((value) => !HIDDEN_CHARACTER.test(value), "A name has no control or hidden characters")
  .transform((value) => value.normalize("NFKC").replace(/\s+/gu, " ").trim())
  .pipe(z.string().min(1).max(DISPLAY_NAME_MAX));

export const ChangeDisplayNameRequest = z.object({ displayName: DisplayName }).strict();
export type ChangeDisplayNameRequest = z.infer<typeof ChangeDisplayNameRequest>;

export const ErrorResponse = z.object({ error: z.string(), requestId: z.string() }).strict();
export type ErrorResponse = z.infer<typeof ErrorResponse>;
