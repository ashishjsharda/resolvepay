import { config } from "@/lib/config";

/** Always-visible statement of what is real and what is simulated. */
export function ModeBanner() {
  const cfg = config();
  const fixturePay = cfg.PAYMENTS_MODE === "fixture";
  const fixtureAi = cfg.AI_MODE === "fixture";
  return (
    <div className="text-xs">
      {fixturePay ? (
        <div className="bg-amber-400 px-4 py-1.5 text-center font-semibold text-amber-950">
          SIMULATED PAYMENTS (fixture mode): no PayPal API is called. IDs starting with FIXTURE- are not real payments.
        </div>
      ) : (
        <div className="bg-sky-700 px-4 py-1.5 text-center font-medium text-white">
          PayPal SANDBOX: real PayPal sandbox API, test money only. Live payments are disabled.
        </div>
      )}
      {fixtureAi && (
        <div className="bg-violet-100 px-4 py-1 text-center text-violet-900">
          Simulated AI: analyses come from recorded fixtures, not a live model call (AI_MODE=fixture).
        </div>
      )}
    </div>
  );
}
