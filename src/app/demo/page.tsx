import { prisma } from "@/lib/db";
import { requireMerchantPage } from "@/lib/session";
import { config } from "@/lib/config";
import { Nav } from "@/components/Nav";
import { Badge, CsrfField, Flash, one, Section, Usd, type SearchParams } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function DemoSetup({ searchParams }: { searchParams: SearchParams }) {
  const { csrf } = await requireMerchantPage();
  const sp = await searchParams;
  const cfg = config();
  const sandbox = cfg.PAYMENTS_MODE === "sandbox";
  const orders = await prisma.order.findMany({ orderBy: { orderNumber: "asc" }, include: { lineItems: true, payment: true, cases: true } });
  const events = await prisma.webhookEvent.findMany({ orderBy: { receivedAt: "desc" }, take: 10 });

  return (
    <>
      <Nav csrf={csrf} active="demo" />
      <main className="mx-auto max-w-6xl space-y-5 px-4 py-6">
        <Flash msg={one(sp.msg)} err={one(sp.err)} />
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Demo setup</h1>
          <p className="mt-1 max-w-3xl text-sm text-muted">
            Each seeded order needs a PayPal capture before a refund can be approved. ResolvePay verifies every capture server-side
            (status COMPLETED, currency USD, amount equal to the order total) before linking it.
          </p>
        </div>

        <Section title={sandbox ? "How to create a real sandbox payment" : "Fixture mode"}>
          {sandbox ? (
            <ol className="list-decimal space-y-1.5 pl-5 text-sm">
              <li>
                Recommended: click <strong>Pay with PayPal sandbox</strong> on an order below. ResolvePay creates a real sandbox order for the exact total,
                you sign in with a <em>sandbox personal (buyer)</em> account from developer.paypal.com → Testing tools → Sandbox accounts, and on return the
                app captures it and links the capture ID.
              </li>
              <li>
                Alternative: paste a capture ID from a payment you already made to <em>this app&apos;s sandbox business account</em> for exactly the order total
                in USD. Find it in the sandbox business account&apos;s activity, or in the Orders API capture response at
                <span className="font-mono"> purchase_units[0].payments.captures[0].id</span>.
              </li>
              <li>Webhook URL to register on your sandbox app: <span className="font-mono">{cfg.APP_BASE_URL}/api/webhooks/paypal</span> (events: Payment capture refunded, Payment capture reversed).</li>
            </ol>
          ) : (
            <p className="text-sm">
              PAYMENTS_MODE=fixture. <strong>No PayPal API is called.</strong> &ldquo;Create simulated capture&rdquo; writes a fake capture to a local
              fixture ledger with an ID starting <span className="font-mono">FIXTURE-CAP-</span>. These are never presented as PayPal payments. Switch to
              PAYMENTS_MODE=sandbox with sandbox credentials for the real integration.
            </p>
          )}
        </Section>

        <div className="grid gap-4 md:grid-cols-3">
          {orders.map((o) => (
            <div key={o.id} className="card flex flex-col p-4">
              <div className="flex items-baseline justify-between">
                <div className="font-semibold">{o.orderNumber}</div>
                <Usd cents={o.totalCents} className="font-semibold" />
              </div>
              <div className="text-xs text-muted">{o.customerName} · {o.lineItems.length} item(s) + shipping</div>
              <div className="mt-1 text-xs text-muted">Cases: {o.cases.map((c) => c.label ?? c.id).join(", ")}</div>
              <div className="mt-3 flex-1 text-sm">
                {o.payment ? (
                  <div className="rounded-md bg-emerald-50 p-2 text-xs text-emerald-900">
                    <div className="font-semibold">{o.payment.mode === "FIXTURE" ? "Simulated capture linked" : "Sandbox capture verified and linked"}</div>
                    <div className="mt-0.5 break-all font-mono">{o.payment.captureId}</div>
                    <div className="mt-0.5">Status at link time: {o.payment.captureStatus} · <Usd cents={o.payment.capturedCents} /> USD</div>
                  </div>
                ) : (
                  <div className="rounded-md bg-amber-50 p-2 text-xs text-amber-900">No capture linked.</div>
                )}
              </div>
              <div className="mt-3 space-y-2">
                {sandbox ? (
                  <form action="/api/demo/checkout" method="post">
                    <CsrfField csrf={csrf} />
                    <input type="hidden" name="orderId" value={o.id} />
                    <button className="btn-primary w-full" disabled={!!o.payment}>Pay with PayPal sandbox</button>
                  </form>
                ) : (
                  <form action="/api/demo/fixture-capture" method="post">
                    <CsrfField csrf={csrf} />
                    <input type="hidden" name="orderId" value={o.id} />
                    <button className="btn-secondary w-full">Create simulated capture</button>
                  </form>
                )}
                <form action="/api/demo/link-capture" method="post" className="flex gap-2">
                  <CsrfField csrf={csrf} />
                  <input type="hidden" name="orderId" value={o.id} />
                  <input name="captureId" placeholder={sandbox ? "Paste sandbox capture ID" : "FIXTURE-CAP-…"} className="input min-w-0 flex-1 font-mono text-xs" required />
                  <button className="btn-secondary">Verify &amp; link</button>
                </form>
              </div>
            </div>
          ))}
        </div>

        <Section title="Recent webhook events" aside={<span className="text-xs text-muted">signature-verified PayPal events and labeled simulator events</span>}>
          {events.length === 0 ? (
            <p className="text-sm text-muted">None received yet.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-muted">
                  <th className="pb-1 font-medium">Received</th>
                  <th className="pb-1 font-medium">Source</th>
                  <th className="pb-1 font-medium">Type</th>
                  <th className="pb-1 font-medium">Outcome</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {events.map((e) => (
                  <tr key={e.id}>
                    <td className="py-1.5 text-xs">{e.receivedAt.toISOString().slice(11, 19)} UTC</td>
                    <td className="py-1.5"><Badge value={e.source === "paypal" ? "PAYPAL_VERIFIED" : "SIMULATED"} /></td>
                    <td className="py-1.5 font-mono text-xs">{e.eventType}</td>
                    <td className="py-1.5 text-xs">{e.outcome ?? "processing"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Section>

        <Section title="Reset">
          <form action="/api/demo/reset" method="post" className="flex items-center gap-3">
            <CsrfField csrf={csrf} />
            <button className="btn-danger">Reset demo data</button>
            <span className="text-xs text-muted">Re-seeds the merchant, orders and cases, and removes capture links and history. It does not touch PayPal.</span>
          </form>
        </Section>
      </main>
    </>
  );
}
