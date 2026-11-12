import { merchantAction } from "@/lib/session";
import { prisma } from "@/lib/db";
import { resetAndSeed } from "@/lib/seed";

export const POST = merchantAction(
  () => "/demo",
  async () => {
    await resetAndSeed(prisma);
    return { msg: "Demo data reset. Re-link captures before approving refunds." };
  },
);
