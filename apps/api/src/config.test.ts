import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.ts";

const DATABASE_URL = "postgres://app@127.0.0.1:41032/app";
const SESSION_KEY = "a1".repeat(32);
const ZERO_KEY = "0".repeat(64);

describe("loadConfig", () => {
  it("uses safe defaults for a local run", () => {
    const config = loadConfig({ DATABASE_URL, SESSION_KEY });
    expect(config.HOST).toBe("127.0.0.1");
    expect(config.PORT).toBe(41030);
    expect(config.SIGN_IN_LIMIT).toBe(20);
  });

  it("splits the CORS allow-list", () => {
    const config = loadConfig({
      DATABASE_URL,
      SESSION_KEY,
      CORS_ORIGINS: "https://a.example, https://b.example",
    });
    expect(config.CORS_ORIGINS).toEqual(["https://a.example", "https://b.example"]);
  });

  it("fails fast without a database URL", () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
  });

  it("names the variable but never echoes its value", () => {
    const secret = "not-a-url-but-a-secret";
    expect(() => loadConfig({ DATABASE_URL: secret, SESSION_KEY })).toThrow(/DATABASE_URL/);
    expect(() => loadConfig({ DATABASE_URL: secret, SESSION_KEY })).not.toThrow(new RegExp(secret));
  });

  it("reads the sign-in limit and rejects one below 1", () => {
    expect(loadConfig({ DATABASE_URL, SESSION_KEY, SIGN_IN_LIMIT: "100" }).SIGN_IN_LIMIT).toBe(100);
    expect(() => loadConfig({ DATABASE_URL, SESSION_KEY, SIGN_IN_LIMIT: "0" })).toThrow(
      /SIGN_IN_LIMIT/,
    );
  });

  it("rejects a port out of range", () => {
    expect(() => loadConfig({ DATABASE_URL, SESSION_KEY, PORT: "70000" })).toThrow(/PORT/);
  });

  it("reads the session key", () => {
    expect(loadConfig({ DATABASE_URL, SESSION_KEY }).SESSION_KEY).toBe(SESSION_KEY);
  });

  it("fails fast without a session key", () => {
    expect(() => loadConfig({ DATABASE_URL })).toThrow(/SESSION_KEY/);
  });

  it("names SESSION_KEY but never echoes a key that is not 64 hex characters", () => {
    const bad = "short-secret-value";
    expect(() => loadConfig({ DATABASE_URL, SESSION_KEY: bad })).toThrow(/SESSION_KEY/);
    expect(() => loadConfig({ DATABASE_URL, SESSION_KEY: bad })).not.toThrow(new RegExp(bad));
  });

  it("accepts the all-zero key outside production", () => {
    expect(loadConfig({ DATABASE_URL, SESSION_KEY: ZERO_KEY }).SESSION_KEY).toBe(ZERO_KEY);
  });

  it("refuses the all-zero key in production and does not echo it", () => {
    const env = { DATABASE_URL, SESSION_KEY: ZERO_KEY, NODE_ENV: "production" };
    expect(() => loadConfig(env)).toThrow(/SESSION_KEY/);
    expect(() => loadConfig(env)).not.toThrow(new RegExp(ZERO_KEY));
  });

  it("turns demo auto-approve on by default outside production", () => {
    expect(loadConfig({ DATABASE_URL, SESSION_KEY }).DEMO_AUTO_APPROVE).toBe(true);
    expect(loadConfig({ DATABASE_URL, SESSION_KEY, NODE_ENV: "test" }).DEMO_AUTO_APPROVE).toBe(
      true,
    );
  });

  it("turns demo auto-approve off by default in production", () => {
    const env = { DATABASE_URL, SESSION_KEY, NODE_ENV: "production" };
    expect(loadConfig(env).DEMO_AUTO_APPROVE).toBe(false);
  });

  it("reads DEMO_AUTO_APPROVE=false outside production", () => {
    expect(
      loadConfig({ DATABASE_URL, SESSION_KEY, DEMO_AUTO_APPROVE: "false" }).DEMO_AUTO_APPROVE,
    ).toBe(false);
  });

  it("refuses DEMO_AUTO_APPROVE=true in production", () => {
    const env = { DATABASE_URL, SESSION_KEY, NODE_ENV: "production", DEMO_AUTO_APPROVE: "true" };
    expect(() => loadConfig(env)).toThrow(/DEMO_AUTO_APPROVE/);
  });
});
