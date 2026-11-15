import { describe, expect, it } from "vitest";
import { formatMoney, parsePounds } from "./money.ts";

describe("parsePounds", () => {
  it.each([
    ["400", 40_000],
    ["400.50", 40_050],
    ["400.5", 40_050],
    ["0.01", 1],
    [" 12.30 ", 1_230],
  ])("reads %j as %i", (text, minor) => {
    expect(parsePounds(text)).toBe(minor);
  });

  it.each(["abc", "400.", ".5", "-1", "1,000", "1.234", "", "1234567890"])("refuses %j", (text) => {
    expect(parsePounds(text)).toBeNull();
  });
});

describe("formatMoney", () => {
  it("shows pence as pounds", () => {
    expect(formatMoney(40_000)).toBe("£400.00");
  });
});
