import { merchantAction } from "@/lib/session";
import { executeRefund, ServiceError } from "@/lib/services/cases";
import { appDeps } from "@/lib/services/deps";

export const POST = merchantAction(
  (_r, _f, p) => `/cases/${p.id}`,
  async ({ form, params, actor }) => {
    const approvalId = String(form.get("approvalId") ?? "");
    if (!approvalId) throw new ServiceError("Missing approval");
    const res = await executeRefund(appDeps(), params.id, approvalId, actor);
    return { msg: res.message };
  },
);
