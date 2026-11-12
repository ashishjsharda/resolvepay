import Link from "next/link";
import { prisma } from "@/lib/db";
import { requireMerchantPage } from "@/lib/session";
import { config } from "@/lib/config";
import { Nav } from "@/components/Nav";
import { Badge, Flash, one, Usd, type SearchParams } from "@/components/ui";

export const dynamic = "force-dynamic";

const REVIEW = ["NEW", "ANALYSIS_FAILED", "AWAITING_REVIEW", "APPROVED"];
const IN_FLIGHT = ["EXECUTING", "REFUND_PENDING", "NEEDS_RECONCILIATION"];

export default async function Dashboard({ searchParams }: { searchParams: SearchParams }) {
  const { csrf } = await requireMerchantPage();
  const sp = await searchParams;
  const mode = config().PAYMENTS_MODE === "sandbox" ? "SANDBOX" : "FIXTURE";
  const cases = await prisma.case.findMany({
    orderBy: { createdAt: "asc" },
    include: { order: { include: { payment: true } }, proposals: { orderBy: { version: "desc" }, take: 1 } },
  });
  const completed = await prisma.refundOperation.findMany({ where: { state: "COMPLETED", mode } });
  const unsettled = await prisma.refundOperation.count({ where: { state: { in: ["PAYPAL_PENDING", "UNKNOWN", "SUBMITTED"] }, mode } });
  const totalCents = completed.reduce((s, o) => s + o.amountCents, 0);

  const groups = [
    { title: "Awaiting review", rows: cases.filter((c) => REVIEW.includes(c.status)) },
    { title: "Escalated: needs a human decision", rows: cases.filter((c) => c.status === "ESCALATED") },
    { title: "Refund in progress or uncertain", rows: cases.filter((c) => IN_FLIGHT.includes(c.status)) },
    { title: "Closed", rows: cases.filter((c) => ["REFUNDED", "DECLINED", "REFUND_FAILED"].includes(c.status)) },
  ];

  return (
    <>
      <Nav csrf={csrf} active="dashboard" />
      <main className="mx-auto max-w-6xl px-4 py-6">
        <Flash msg={one(sp.msg)} err={one(sp.err)} />
        <div className="mb-6 grid gap-3 sm:grid-cols-4">
          <Stat label="Awaiting review" value={String(groups[0].rows.length)} />
          <Stat label="Escalated" value={String(groups[1].rows.length)} tone={groups[1].rows.length ? "warn" : undefined} />
          <Stat
            label={mode === "SANDBOX" ? "Sandbox refunds completed" : "Simulated refunds completed"}
            value={<Usd cents={totalCents} />}
            sub={`${completed.length} refund${completed.length === 1 ? "" : "s"}, confirmed ${mode === "SANDBOX" ? "by PayPal sandbox" : "by fixture ledger"}`}
          />
          <Stat label="Pending or uncertain" value={String(unsettled)} sub="Not counted as refunded" tone={unsettled ? "warn" : undefined} />
        </div>

        <div className="space-y-6">
          {groups.map((g) => (
            <section key={g.title}>
              <h2 className="mb-2 text-sm font-semibold text-muted">{g.title}</h2>
              {g.rows.length === 0 ? (
                <p className="card px-4 py-3 text-sm text-muted">None.</p>
              ) : (
                <div className="card divide-y divide-line">
                  {g.rows.map((c) => {
                    const p = c.proposals[0];
                    return (
                      <Link key={c.id} href={`/cases/${c.id}`} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 hover:bg-canvas">
                        <div className="min-w-0 flex-1">
                          <div className="text-sm font-medium">{c.label ?? c.id}</div>
                          <div className="truncate text-xs text-muted">
                            {c.order.orderNumber} · {c.order.customerName} · “{c.complaint.slice(0, 90)}
                            {c.complaint.length > 90 ? "…" : ""}”
                          </div>
                        </div>
                        {!c.order.payment && <span className="text-xs text-amber-700">No capture linked</span>}
                        {p && (
                          <span className="flex items-center gap-2 text-sm">
                            <Badge value={p.action} />
                            <Usd cents={p.amountCents} className="text-muted" />
                          </span>
                        )}
                        <Badge value={c.status} />
                      </Link>
                    );
                  })}
                </div>
              )}
            </section>
          ))}
        </div>
      </main>
    </>
  );
}

function Stat({ label, value, sub, tone }: { label: string; value: React.ReactNode; sub?: string; tone?: "warn" }) {
  return (
    <div className={`card px-4 py-3 ${tone === "warn" ? "border-amber-300" : ""}`}>
      <div className="label">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
      {sub && <div className="mt-0.5 text-xs text-muted">{sub}</div>}
    </div>
  );
}
