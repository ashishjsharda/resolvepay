// Integer-cents money helpers. No floating-point arithmetic anywhere.

export const SUPPORTED_CURRENCY = "USD" as const;

export class MoneyError extends Error {}

export function assertCents(n: number, label = "amount"): number {
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new MoneyError(`${label} must be a non-negative integer number of cents, got ${n}`);
  }
  return n;
}

/** Parse a PayPal decimal string ("19.99", "5", "5.5") to integer cents without floats. */
export function parseDecimalToCents(value: string): number {
  if (typeof value !== "string" || !/^\d{1,12}(\.\d{1,2})?$/.test(value)) {
    throw new MoneyError(`Invalid money string: ${JSON.stringify(value)}`);
  }
  const [whole, frac = ""] = value.split(".");
  return assertCents(Number(whole) * 100 + Number(frac.padEnd(2, "0")));
}

/** Format integer cents as a PayPal decimal string ("19.99"). */
export function centsToDecimal(cents: number): string {
  assertCents(cents);
  const whole = Math.trunc(cents / 100);
  const frac = cents % 100;
  return `${whole}.${frac.toString().padStart(2, "0")}`;
}

export function formatUSD(cents: number): string {
  const [whole, frac] = centsToDecimal(cents).split(".");
  return `$${whole.replace(/\B(?=(\d{3})+$)/g, ",")}.${frac}`;
}

export function addCents(...values: number[]): number {
  return values.reduce((sum, v) => assertCents(sum + assertCents(v)), 0);
}

export function lineTotalCents(unitCents: number, quantity: number): number {
  assertCents(unitCents, "unitCents");
  if (!Number.isSafeInteger(quantity) || quantity < 0) throw new MoneyError(`Invalid quantity ${quantity}`);
  return assertCents(unitCents * quantity);
}

export function assertCurrency(currency: string): typeof SUPPORTED_CURRENCY {
  if (currency !== SUPPORTED_CURRENCY) throw new MoneyError(`Unsupported currency ${currency}; MVP is USD-only`);
  return SUPPORTED_CURRENCY;
}
