import { merchantAction } from "@/lib/session";
import { ServiceError } from "@/lib/services/cases";
import { appDeps } from "@/lib/services/deps";
import { FixturePaymentsAdapter, type FixtureFault } from "@/lib/paypal/fixture";

const FAULTS: FixtureFault[] = ["none", "timeout_after_commit", "timeout_before_commit", "server_error", "pending"];

// FIXTURE MODE ONLY: arm a failure for the next simulated refund call (to demo uncertain outcomes).
export const POST = merchantAction(
  (_r, form) => {
    const to = String(form.get("returnTo") ?? "/demo");
    return /^\/(cases\/[\w-]+|demo)?$/.test(to) ? to : "/demo"; // same-site paths only (no //host)
  },
  async ({ form }) => {
    const deps = appDeps();
    if (!(deps.payments instanceof FixturePaymentsAdapter)) throw new ServiceError("Fault injection is only available in fixture mode");
    const fault = String(form.get("fault")) as FixtureFault;
    if (!FAULTS.includes(fault)) throw new ServiceError("Unknown fault");
    deps.payments.nextFault = fault;
    return { msg: fault === "none" ? "Fault injection cleared." : `Next simulated refund will: ${fault.replace(/_/g, " ")}.` };
  },
);
