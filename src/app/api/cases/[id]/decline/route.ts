import { merchantAction } from "@/lib/session";
import { declineCase } from "@/lib/services/cases";
import { appDeps } from "@/lib/services/deps";

export const POST = merchantAction(
  (_r, _f, p) => `/cases/${p.id}`,
  async ({ form, params, actor }) => {
    await declineCase(appDeps(), params.id, String(form.get("note") ?? ""), actor);
    return { msg: "Case declined. No refund will be issued." };
  },
);
