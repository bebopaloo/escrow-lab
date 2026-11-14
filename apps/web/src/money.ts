const formatter = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" });

/** Shows an amount in minor units (pence) as pounds, for example 40000 as £400.00. */
export function formatMoney(minor: number): string {
  return formatter.format(minor / 100);
}

/** Reads "400" or "400.50" as minor units. Returns null for anything else. */
export function parsePounds(text: string): number | null {
  const match = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(text.trim());
  if (match === null) return null;
  const pence = (match[2] ?? "").padEnd(2, "0");
  return Number(match[1]) * 100 + Number(pence);
}
