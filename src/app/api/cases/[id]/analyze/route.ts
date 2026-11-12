import { merchantAction } from "@/lib/session";
import { analyzeCase } from "@/lib/services/cases";
import { appDeps } from "@/lib/services/deps";

export const POST = merchantAction(
  (_r, _f, p) => `/cases/${p.id}`,
  async ({ params, actor }) => {
    const res = await analyzeCase(appDeps(), params.id, actor);
    if (!res.proposal) return { msg: "AI analysis failed (model error or invalid output) and nothing was proposed. See the analysis panel." };
    return { msg: `Analysis complete: ${res.proposal.action} (proposal v${res.proposal.version}).` };
  },
);
