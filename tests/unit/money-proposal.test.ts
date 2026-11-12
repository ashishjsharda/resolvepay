import { describe, expect, it } from "vitest";
import { addCents, centsToDecimal, formatUSD, MoneyError, parseDecimalToCents } from "@/lib/money";
import { approvalFingerprint, priceSelection, ProposalError, remainingRefundableCents } from "@/lib/proposal";

const ITEMS = [
  { id: "li_a1", sku: "POUR", name: "Pour-over", unitCents: 4800, quantity: 1 },
  { id: "li_a2", sku: "NAP", name: "Napkins", unitCents: 2400, quantity: 1 },
  { id: "li_x", sku: "MUG", name: "Mug", unitCents: 1999, quantity: 3 },
];

describe("money", () => {
  it("parses decimal strings to integer cents without float error", () => {
    expect(parseDecimalToCents("19.99")).toBe(1999);
    expect(parseDecimalToCents("0.29")).toBe(29); // 0.29*100 = 28.999999999999996 in floats
    expect(parseDecimalToCents("5")).toBe(500);
    expect(parseDecimalToCents("5.5")).toBe(550);
    expect(parseDecimalToCents("1234567.01")).toBe(123456701);
  });
  it("rejects malformed or negative money strings", () => {
    for (const bad of ["-1.00", "1.001", "abc", "", "1e3", " 1.00", "1,000.00"]) {
      expect(() => parseDecimalToCents(bad)).toThrow(MoneyError);
    }
  });
  it("formats cents for PayPal and display", () => {
    expect(centsToDecimal(4800)).toBe("48.00");
    expect(centsToDecimal(7)).toBe("0.07");
    expect(formatUSD(123456789)).toBe("$1,234,567.89");
    expect(() => centsToDecimal(1.5)).toThrow(MoneyError);
  });
  it("adds only integer cents", () => {
    expect(addCents(1999, 1, 0)).toBe(2000);
    expect(() => addCents(10, 0.1)).toThrow(MoneyError);
  });
});

describe("partial refund calculation", () => {
  it("prices only the selected damaged item (shipping excluded)", () => {
    const r = priceSelection(ITEMS, [{ lineItemId: "li_a1", quantity: 1 }]);
    expect(r.amountCents).toBe(4800);
  });
  it("prices partial quantities", () => {
    expect(priceSelection(ITEMS, [{ lineItemId: "li_x", quantity: 2 }]).amountCents).toBe(3998);
  });
  it("rejects items not in the order, duplicates, and excess quantity", () => {
    expect(() => priceSelection(ITEMS, [{ lineItemId: "li_fake", quantity: 1 }])).toThrow(ProposalError);
    expect(() => priceSelection(ITEMS, [{ lineItemId: "li_a1", quantity: 1 }, { lineItemId: "li_a1", quantity: 1 }])).toThrow(ProposalError);
    expect(() => priceSelection(ITEMS, [{ lineItemId: "li_x", quantity: 4 }])).toThrow(ProposalError);
    expect(() => priceSelection(ITEMS, [{ lineItemId: "li_x", quantity: 0 }])).toThrow(ProposalError);
    expect(() => priceSelection(ITEMS, [{ lineItemId: "li_x", quantity: 1.5 }])).toThrow(ProposalError);
  });
});

describe("maximum remaining refundable amount", () => {
  it("subtracts completed and in-flight refunds", () => {
    expect(remainingRefundableCents(8000, [])).toBe(8000);
    expect(remainingRefundableCents(8000, [4800])).toBe(3200);
    expect(remainingRefundableCents(8000, [4800, 3200])).toBe(0);
  });
  it("never goes negative", () => {
    expect(remainingRefundableCents(8000, [9000])).toBe(0);
  });
});

describe("approval fingerprint", () => {
  const base = { caseId: "c", captureId: "CAP1", currency: "USD", amountCents: 4800, proposalId: "p", proposalVersion: 1 };
  it("changes when any bound field changes", () => {
    const f = approvalFingerprint(base);
    expect(approvalFingerprint({ ...base })).toBe(f);
    for (const change of [
      { caseId: "c2" },
      { captureId: "CAP2" },
      { currency: "EUR" },
      { amountCents: 4801 },
      { proposalId: "p2" },
      { proposalVersion: 2 },
    ]) {
      expect(approvalFingerprint({ ...base, ...change })).not.toBe(f);
    }
  });
});
