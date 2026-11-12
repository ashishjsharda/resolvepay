import { z } from "zod";
import { merchantAction } from "@/lib/session";
import { approveProposal, ServiceError } from "@/lib/services/cases";
import { appDeps } from "@/lib/services/deps";

const Input = z.object({
  proposalId: z.string().min(1).max(64),
  proposalVersion: z.coerce.number().int().positive(),
  amountCents: z.coerce.number().int().positive(),
  confirm: z.literal("yes"),
});

export const POST = merchantAction(
  (_r, _f, p) => `/cases/${p.id}`,
  async ({ form, params, actor }) => {
    const parsed = Input.safeParse(Object.fromEntries(form));
    if (!parsed.success) throw new ServiceError("Approval requires an explicit confirmation of the exact proposal and amount.");
    await approveProposal(appDeps(), params.id, parsed.data, actor);
    return { msg: "Approved. The approval is bound to this exact proposal, amount, and capture." };
  },
);
