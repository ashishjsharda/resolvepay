import { merchantAction } from "@/lib/session";
import { reconcileOperation } from "@/lib/services/cases";
import { appDeps } from "@/lib/services/deps";

export const POST = merchantAction(
  (_r, form) => `/cases/${encodeURIComponent(String(form.get("caseId") ?? ""))}`,
  async ({ params, actor }) => {
    const res = await reconcileOperation(appDeps(), params.opId, actor);
    return { msg: `Reconciled: ${res.message}` };
  },
);
