import { describe, expect, it } from "vitest";
import { toCsv } from "./csv.ts";

describe("toCsv", () => {
  it("quotes each field and ends each row with CRLF", () => {
    expect(
      toCsv([
        ["time", "user"],
        ["a", "b"],
      ]),
    ).toBe('"time","user"\r\n"a","b"\r\n');
  });

  it("doubles a double quote inside a field", () => {
    expect(toCsv([['say "hi", ok']])).toBe('"say ""hi"", ok"\r\n');
  });

  it("keeps a line break inside a quoted field", () => {
    expect(toCsv([["a\nb"]])).toBe('"a\nb"\r\n');
  });

  it.each(["=1+1", "+1", "-1", "@SUM(A1)", "\tx", "\rx"])(
    "adds a leading apostrophe to a field that starts with %j",
    (field) => {
      expect(toCsv([[field]])).toBe(`"'${field.replaceAll('"', '""')}"\r\n`);
    },
  );

  it("leaves a field that starts with another character as it is", () => {
    expect(toCsv([["Alice =x"]])).toBe('"Alice =x"\r\n');
  });
});
