import { z } from "zod";
import { merchantAction } from "@/lib/session";
import { reviseProposal, ServiceError } from "@/lib/services/cases";
import { appDeps } from "@/lib/services/deps";

const Input = z.object({
  action: z.enum(["REFUND", "ESCALATE"]),
  note: z.string().max(500).optional(),
});

export const POST = merchantAction(
  (_r, _f, p) => `/cases/${p.id}`,
  async ({ form, params, actor }) => {
    const parsed = Input.safeParse({ action: form.get("action"), note: form.get("note") || undefined });
    if (!parsed.success) throw new ServiceError("Invalid proposal input");
    // Quantities arrive as qty_<lineItemId>=<n>; only positive integers are kept.
    const items: { lineItemId: string; quantity: number }[] = [];
    for (const [k, v] of form.entries()) {
      if (!k.startsWith("qty_")) continue;
      const q = z.coerce.number().int().min(0).max(1000).safeParse(v);
      if (!q.success) throw new ServiceError(`Invalid quantity for ${k.slice(4)}`);
      if (q.data > 0) items.push({ lineItemId: k.slice(4), quantity: q.data });
    }
    const p = await reviseProposal(appDeps(), params.id, { ...parsed.data, items }, actor);
    return { msg: `Saved proposal v${p.version}. Any previous approval was invalidated.` };
  },
);
