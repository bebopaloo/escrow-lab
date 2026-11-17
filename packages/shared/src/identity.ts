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

export const ChangeDisplayNameRequest = z
  .object({ displayName: z.string().trim().min(1).max(DISPLAY_NAME_MAX) })
  .strict();
export type ChangeDisplayNameRequest = z.infer<typeof ChangeDisplayNameRequest>;

export const ErrorResponse = z.object({ error: z.string(), requestId: z.string() }).strict();
export type ErrorResponse = z.infer<typeof ErrorResponse>;
