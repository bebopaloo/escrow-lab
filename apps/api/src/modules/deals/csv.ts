// A spreadsheet runs a cell that starts with one of these characters as a formula.
const FORMULA_START = /^[=+\-@\t\r]/;

function quote(field: string): string {
  const safe = FORMULA_START.test(field) ? `'${field}` : field;
  return `"${safe.replaceAll('"', '""')}"`;
}

/** RFC 4180: every field quoted, a double quote doubled, each row ends with CRLF. */
export function toCsv(rows: readonly (readonly string[])[]): string {
  return rows.map((row) => `${row.map(quote).join(",")}\r\n`).join("");
}
