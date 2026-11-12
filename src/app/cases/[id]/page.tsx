import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { requireMerchantPage } from "@/lib/session";
import { config } from "@/lib/config";
import { Nav } from "@/components/Nav";
import { Badge, CsrfField, Flash, one, Section, Usd, type SearchParams } from "@/components/ui";
import type { AiAnalysis } from "@/lib/ai/schema";
import type { EvidenceCheck } from "@/lib/ai/guards";
import { checkApprovalBinding } from "@/lib/approval";
import { formatUSD } from "@/lib/money";
import { remainingForOrder } from "@/lib/services/cases";
import { LOCKED_STATES, TERMINAL_OP_STATES, type CaseStatus, type RefundOpState } from "@/lib/stateMachine";

export const dynamic = "force-dynamic";

export default async function CasePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SearchParams }) {
  const { csrf } = await requireMerchantPage();
  const { id } = await params;
  const sp = await searchParams;
  const cfg = config();
  const fixture = cfg.PAYMENTS_MODE === "fixture";

  const c = await prisma.case.findUnique({
    where: { id },
    include: {
      order: { include: { lineItems: true, payment: true } },
      merchant: { include: { policies: true } },
      analyses: { orderBy: { createdAt: "desc" }, take: 1 },
      proposals: { orderBy: { version: "desc" } },
      approvals: { orderBy: { createdAt: "desc" } },
      refundOps: { orderBy: { createdAt: "desc" } },
      audit: { orderBy: { createdAt: "asc" } },
    },
  });
  if (!c) notFound();

  const status = c.status as CaseStatus;
  const analysis = c.analyses[0];
  const parsed = (analysis?.parsed ?? null) as unknown as AiAnalysis | null;
  const proposal = c.proposals[0];
  const pReasons = (proposal?.reasons ?? { reasons: [], evidence: [] }) as unknown as { reasons: string[]; evidence: EvidenceCheck[] };
  const items = new Map(c.order.lineItems.map((li) => [li.id, li]));
  const proposalItems = (proposal?.items ?? []) as unknown as { lineItemId: string; quantity: number }[];
  const remaining = await remainingForOrder(prisma, c.orderId);
  const activeApproval = c.approvals.find((a) => !a.invalidatedAt);
  const binding =
    activeApproval &&
    checkApprovalBinding(activeApproval, {
      caseId: c.id,
      latestProposal: proposal
        ? { id: proposal.id, version: proposal.version, action: proposal.action, amountCents: proposal.amountCents, currency: proposal.currency, supersededAt: proposal.supersededAt }
        : null,
      payment: c.order.payment ? { captureId: c.order.payment.captureId, currency: c.order.payment.currency } : null,
    });
  const locked = LOCKED_STATES.includes(status);
  const canApprove = (status === "AWAITING_REVIEW" || status === "ESCALATED") && proposal?.action === "REFUND" && !!c.order.payment;
  const evidenceByQuote = new Map(pReasons.evidence.map((e) => [`${e.policyKey}::${e.quote}`, e]));

  return (
    <>
      <Nav csrf={csrf} active="case" />
      <main className="mx-auto max-w-6xl px-4 py-6">
        <Flash msg={one(sp.msg)} err={one(sp.err)} />
        <div className="mb-5 flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{c.label ?? c.id}</h1>
          <Badge value={c.status} />
          <span className="text-sm text-muted">
            {c.order.orderNumber} · {c.order.customerName}
          </span>
        </div>

        <div className="grid gap-5 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
          {/* ------------------------------------------------ left: evidence */}
          <div className="space-y-5">
            <Section title="Customer complaint" aside={<span className="text-[11px] font-medium text-amber-700">UNTRUSTED INPUT</span>}>
              <p className="whitespace-pre-wrap rounded-md bg-canvas p-3 text-sm leading-relaxed">{c.complaint}</p>
              <p className="mt-2 text-xs text-muted">Shown as plain text. It is passed to the model only as delimited data, never as instructions.</p>
            </Section>

            <Section title="Order" aside={<span className="text-xs text-muted">trusted store data</span>}>
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-muted">
                    <th className="pb-1 font-medium">Item</th>
                    <th className="pb-1 text-right font-medium">Qty</th>
                    <th className="pb-1 text-right font-medium">Unit</th>
                    <th className="pb-1 text-right font-medium">Total</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {c.order.lineItems.map((li) => (
                    <tr key={li.id}>
                      <td className="py-1.5">
                        {li.name}
                        <div className="font-mono text-[11px] text-muted">{li.sku}</div>
                      </td>
                      <td className="py-1.5 text-right">{li.quantity}</td>
                      <td className="py-1.5 text-right"><Usd cents={li.unitCents} /></td>
                      <td className="py-1.5 text-right"><Usd cents={li.unitCents * li.quantity} /></td>
                    </tr>
                  ))}
                  <tr>
                    <td className="py-1.5 text-muted" colSpan={3}>Shipping (non-refundable per policy)</td>
                    <td className="py-1.5 text-right"><Usd cents={c.order.shippingCents} /></td>
                  </tr>
                  <tr className="font-semibold">
                    <td className="py-1.5" colSpan={3}>Order total</td>
                    <td className="py-1.5 text-right"><Usd cents={c.order.totalCents} /></td>
                  </tr>
                </tbody>
              </table>
              <dl className="mt-3 grid grid-cols-2 gap-2 text-xs">
                <div><dt className="text-muted">Placed</dt><dd>{c.order.placedAt.toISOString().slice(0, 10)}</dd></div>
                <div><dt className="text-muted">Delivered</dt><dd>{c.order.deliveredAt?.toISOString().slice(0, 10) ?? "unknown"}</dd></div>
                <div className="col-span-2">
                  <dt className="text-muted">PayPal capture</dt>
                  <dd>
                    {c.order.payment ? (
                      <span className="font-mono">
                        {c.order.payment.captureId} <span className="font-sans text-muted">({c.order.payment.mode === "FIXTURE" ? "SIMULATED" : "sandbox"}, verified {c.order.payment.verifiedAt.toISOString().slice(0, 16).replace("T", " ")} UTC)</span>
                      </span>
                    ) : (
                      <a href="/demo" className="text-amber-700 underline">Not linked: link one in Demo setup</a>
                    )}
                  </dd>
                </div>
                {remaining !== null && (
                  <div className="col-span-2"><dt className="text-muted">Remaining refundable on capture</dt><dd><Usd cents={remaining} /></dd></div>
                )}
              </dl>
            </Section>

            <Section title="Store policy">
              <div className="space-y-3">
                {c.merchant.policies.map((p) => (
                  <div key={p.id}>
                    <div className="text-xs font-semibold">{p.title} <span className="font-mono font-normal text-muted">[{p.key}]</span></div>
                    <p className="mt-0.5 text-sm text-muted">{p.text}</p>
                  </div>
                ))}
              </div>
            </Section>
          </div>

          {/* ------------------------------------------------ right: decision */}
          <div className="space-y-5">
            <Section
              title="AI analysis"
              aside={
                <form action={`/api/cases/${c.id}/analyze`} method="post">
                  <CsrfField csrf={csrf} />
                  <button className="btn-secondary" disabled={locked}>{analysis ? "Re-run analysis" : "Run analysis"}</button>
                </form>
              }
            >
              {!analysis && <p className="text-sm text-muted">Not analyzed yet. The model reads the complaint, order items (without prices) and policy text, and returns structured output that is validated before use.</p>}
              {analysis && !analysis.valid && (
                <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">
                  <div className="font-semibold">Model output rejected</div>
                  <ul className="mt-1 list-disc pl-5 text-xs">
                    {(analysis.errors as unknown as string[]).map((e, i) => <li key={i}>{e}</li>)}
                  </ul>
                </div>
              )}
              {parsed && (
                <div className="space-y-4 text-sm">
                  <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
                    <span>Source: <span className="font-mono">{analysis.source === "fixture" ? "simulated (fixture)" : analysis.source}</span></span>
                    <span>·</span>
                    <span>Intent: {parsed.intent.replace(/_/g, " ").toLowerCase()}</span>
                    <span>·</span>
                    <span>Model recommended</span> <Badge value={parsed.recommendation} />
                  </div>
                  <p>{parsed.summary}</p>

                  {parsed.injectionSuspected && (
                    <div className="rounded-md border border-red-200 bg-red-50 p-3 text-red-900">
                      <div className="text-xs font-semibold uppercase tracking-wide">Possible prompt injection</div>
                      <p className="mt-1 text-sm">{parsed.injectionNotes}</p>
                    </div>
                  )}

                  <div>
                    <div className="label mb-1">Customer claims</div>
                    <ul className="space-y-1">
                      {parsed.customerClaims.map((cl, i) => (
                        <li key={i} className="flex gap-2">
                          <span className="mt-0.5 shrink-0 rounded bg-slate-100 px-1 text-[10px] font-semibold text-slate-600">UNVERIFIED</span>
                          {cl.claim}
                        </li>
                      ))}
                      {parsed.customerClaims.length === 0 && <li className="text-muted">None listed.</li>}
                    </ul>
                  </div>

                  <div>
                    <div className="label mb-1">Policy evidence quoted by the model</div>
                    <ul className="space-y-2">
                      {parsed.policyEvidence.map((e, i) => {
                        const check = evidenceByQuote.get(`${e.policyKey}::${e.quote}`);
                        const ok = check?.verified;
                        return (
                          <li key={i} className={`rounded-md border p-2 ${ok ? "border-emerald-200 bg-emerald-50/60" : "border-red-200 bg-red-50"}`}>
                            <div className="flex items-center gap-2 text-[11px] font-semibold">
                              <span className={ok ? "text-emerald-700" : "text-red-700"}>{ok ? "✓ Found verbatim in policy" : `✗ ${check?.reason ?? "Not verified"}`}</span>
                              <span className="font-mono font-normal text-muted">[{e.policyKey}]</span>
                            </div>
                            <blockquote className="mt-1 border-l-2 border-line pl-2 italic">“{e.quote}”</blockquote>
                            <div className="mt-1 text-xs text-muted">{e.supports}</div>
                          </li>
                        );
                      })}
                    </ul>
                  </div>

                  {parsed.missingFacts.length > 0 && (
                    <div>
                      <div className="label mb-1">Missing facts</div>
                      <ul className="list-disc pl-5">{parsed.missingFacts.map((f, i) => <li key={i}>{f}</li>)}</ul>
                    </div>
                  )}

                  <details className="rounded-md border border-line p-2">
                    <summary className="cursor-pointer text-xs font-medium">Draft customer reply (review before sending; not sent automatically)</summary>
                    <p className="mt-2 whitespace-pre-wrap">{parsed.customerReply}</p>
                  </details>
                  <details className="rounded-md border border-line p-2">
                    <summary className="cursor-pointer text-xs font-medium">Model rationale</summary>
                    <p className="mt-2">{parsed.rationale}</p>
                  </details>
                </div>
              )}
            </Section>

            {proposal && (
              <Section
                title={`Proposal v${proposal.version}`}
                aside={<span className="text-xs text-muted">{proposal.source === "AI" ? "computed by app code from AI-selected items" : "edited by merchant"}</span>}
              >
                <div className="flex flex-wrap items-baseline gap-3">
                  <Badge value={proposal.action} />
                  <Usd cents={proposal.amountCents} className="text-2xl font-semibold" />
                  <span className="text-sm text-muted">of <Usd cents={c.order.totalCents} /> order total</span>
                </div>
                {proposalItems.length > 0 && (
                  <ul className="mt-2 text-sm">
                    {proposalItems.map((it) => {
                      const li = items.get(it.lineItemId);
                      return (
                        <li key={it.lineItemId}>
                          {it.quantity} × {li?.name ?? it.lineItemId} @ <Usd cents={li?.unitCents ?? 0} />
                        </li>
                      );
                    })}
                  </ul>
                )}
                {pReasons.reasons.length > 0 && (
                  <div className={`mt-3 rounded-md border p-3 ${proposal.action === "ESCALATE" ? "border-orange-200 bg-orange-50" : "border-line bg-canvas"}`}>
                    <div className="label mb-1">{proposal.action === "ESCALATE" ? "Why this needs a human" : "Notes for the reviewer"}</div>
                    <ul className="list-disc space-y-0.5 pl-5 text-sm">{pReasons.reasons.map((r, i) => <li key={i}>{r}</li>)}</ul>
                  </div>
                )}

                {/* ---- approval */}
                {canApprove && (
                  <form action={`/api/cases/${c.id}/approve`} method="post" className="mt-4 rounded-md border border-accent/30 bg-blue-50/50 p-3">
                    <CsrfField csrf={csrf} />
                    <input type="hidden" name="proposalId" value={proposal.id} />
                    <input type="hidden" name="proposalVersion" value={proposal.version} />
                    <input type="hidden" name="amountCents" value={proposal.amountCents} />
                    <label className="flex items-start gap-2 text-sm">
                      <input type="checkbox" name="confirm" value="yes" required className="mt-1" />
                      <span>
                        I approve refunding <strong><Usd cents={proposal.amountCents} /></strong> USD to capture{" "}
                        <span className="font-mono">{c.order.payment!.captureId}</span> for proposal v{proposal.version}.
                      </span>
                    </label>
                    <button className="btn-primary mt-3">Approve refund</button>
                  </form>
                )}
                {(status === "AWAITING_REVIEW" || status === "ESCALATED") && proposal.action === "REFUND" && !c.order.payment && (
                  <p className="mt-3 text-sm text-amber-700">Link a verified PayPal capture in Demo setup before approving.</p>
                )}

                {/* ---- execute */}
                {status === "APPROVED" && activeApproval && (
                  <div className="mt-4 rounded-md border border-indigo-200 bg-indigo-50/60 p-3">
                    <div className="text-sm">
                      Approved by <span className="font-mono">{activeApproval.approvedBy}</span> for <Usd cents={activeApproval.amountCents} /> · binding{" "}
                      {binding?.ok ? <span className="font-medium text-emerald-700">valid</span> : <span className="font-medium text-red-700">invalid: {binding && !binding.ok ? binding.reason : ""}</span>}
                    </div>
                    <form action={`/api/cases/${c.id}/execute`} method="post" className="mt-3 flex flex-wrap items-center gap-2">
                      <CsrfField csrf={csrf} />
                      <input type="hidden" name="approvalId" value={activeApproval.id} />
                      <button className="btn-primary" disabled={!binding?.ok}>
                        {fixture ? "Execute SIMULATED refund" : "Send refund via PayPal sandbox"}
                      </button>
                      <span className="text-xs text-muted">Re-checks the capture with PayPal first. Runs at most once.</span>
                    </form>
                    {fixture && (
                      <form action="/api/demo/fixture-fault" method="post" className="mt-3 flex flex-wrap items-center gap-2 border-t border-indigo-200 pt-3 text-xs">
                        <CsrfField csrf={csrf} />
                        <input type="hidden" name="returnTo" value={`/cases/${c.id}`} />
                        <span className="text-muted">Failure drill (simulated only):</span>
                        <select name="fault" className="input py-1 text-xs">
                          <option value="timeout_after_commit">Timeout after PayPal processed</option>
                          <option value="timeout_before_commit">Timeout before PayPal received</option>
                          <option value="server_error">PayPal 503</option>
                          <option value="pending">Refund returns PENDING</option>
                          <option value="none">No fault</option>
                        </select>
                        <button className="btn-secondary py-1 text-xs">Arm</button>
                      </form>
                    )}
                  </div>
                )}

                {/* ---- edit / decline */}
                {!locked && (
                  <details className="mt-4 rounded-md border border-line p-3">
                    <summary className="cursor-pointer text-sm font-medium">Edit proposal or decline</summary>
                    <form action={`/api/cases/${c.id}/revise`} method="post" className="mt-3 space-y-3">
                      <CsrfField csrf={csrf} />
                      <p className="text-xs text-muted">Choose quantities. The amount is recalculated by the app from order prices; saving creates a new version and invalidates any approval.</p>
                      <div className="space-y-1">
                        {c.order.lineItems.map((li) => (
                          <label key={li.id} className="flex items-center gap-3 text-sm">
                            <input
                              type="number"
                              name={`qty_${li.id}`}
                              min={0}
                              max={li.quantity}
                              defaultValue={proposalItems.find((p) => p.lineItemId === li.id)?.quantity ?? 0}
                              className="input w-16 py-1"
                            />
                            <span>{li.name} (max {li.quantity}, <Usd cents={li.unitCents} /> each)</span>
                          </label>
                        ))}
                      </div>
                      <input name="note" placeholder="Note for the audit trail (optional)" className="input w-full" maxLength={500} />
                      <div className="flex gap-2">
                        <button name="action" value="REFUND" className="btn-secondary">Save as refund proposal</button>
                        <button name="action" value="ESCALATE" className="btn-secondary">Save as escalation</button>
                      </div>
                    </form>
                    <form action={`/api/cases/${c.id}/decline`} method="post" className="mt-3 flex gap-2 border-t border-line pt-3">
                      <CsrfField csrf={csrf} />
                      <input name="note" placeholder="Reason for declining" className="input flex-1" maxLength={500} />
                      <button className="btn-danger">Decline case</button>
                    </form>
                  </details>
                )}
              </Section>
            )}

            {c.refundOps.length > 0 && (
              <Section title="Execution">
                <div className="space-y-3">
                  {c.refundOps.map((op) => {
                    const terminal = TERMINAL_OP_STATES.includes(op.state as RefundOpState);
                    return (
                      <div key={op.id} className="rounded-md border border-line p-3 text-sm">
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge value={op.state} />
                          <Usd cents={op.amountCents} className="font-medium" />
                          <span className="text-xs text-muted">{op.mode === "FIXTURE" ? "SIMULATED" : "PayPal sandbox"} · attempts {op.attempts}</span>
                        </div>
                        <dl className="mt-2 grid gap-1 text-xs sm:grid-cols-2">
                          <div><dt className="text-muted">PayPal refund ID</dt><dd className="font-mono">{op.paypalRefundId ?? "unknown yet"}</dd></div>
                          <div><dt className="text-muted">PayPal status</dt><dd>{op.paypalStatus ?? "n/a"}</dd></div>
                          <div className="sm:col-span-2"><dt className="text-muted">PayPal-Request-Id (idempotency key)</dt><dd className="break-all font-mono">{op.paypalRequestId}</dd></div>
                          {op.lastError && <div className="sm:col-span-2"><dt className="text-muted">Last error</dt><dd className="text-red-700">{op.lastError}</dd></div>}
                        </dl>
                        {op.state === "UNKNOWN" && (
                          <p className="mt-2 rounded bg-yellow-50 p-2 text-xs text-yellow-900">
                            We could not confirm whether PayPal processed this refund. ResolvePay will not create a new refund. Reconcile replays the same request ID (PayPal returns the original result) or reads the refund by ID.
                            {op.attempts > 1 && " If this stays uncertain, check the PayPal sandbox dashboard before taking any manual action."}
                          </p>
                        )}
                        {!terminal && (
                          <div className="mt-3 flex flex-wrap gap-2">
                            <form action={`/api/refunds/${op.id}/reconcile`} method="post">
                              <CsrfField csrf={csrf} />
                              <input type="hidden" name="caseId" value={c.id} />
                              <button className="btn-secondary">Reconcile with PayPal</button>
                            </form>
                            {fixture && op.state === "PAYPAL_PENDING" && (
                              <form action="/api/demo/simulate-webhook" method="post" className="flex gap-2">
                                <CsrfField csrf={csrf} />
                                <input type="hidden" name="caseId" value={c.id} />
                                <input type="hidden" name="opId" value={op.id} />
                                <button name="status" value="COMPLETED" className="btn-secondary">Simulate webhook: completed</button>
                                <button name="status" value="FAILED" className="btn-secondary">Simulate: failed</button>
                              </form>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </Section>
            )}

            <Section title="Audit timeline" aside={<span className="text-xs text-muted">append-only</span>}>
              <ol className="relative space-y-3 border-l border-line pl-4">
                {c.audit.map((a) => (
                  <li key={a.id} className="text-sm">
                    <span className="absolute -left-[5px] mt-1.5 h-2.5 w-2.5 rounded-full border-2 border-white bg-accent" />
                    <div className="flex flex-wrap items-baseline gap-2">
                      <span className="font-mono text-xs font-semibold">{a.type}</span>
                      <span className="text-xs text-muted">{a.actor} · {a.createdAt.toISOString().slice(11, 19)} UTC</span>
                    </div>
                    <AuditDetail data={a.data as Record<string, unknown>} />
                  </li>
                ))}
              </ol>
            </Section>
          </div>
        </div>
      </main>
    </>
  );
}

function AuditDetail({ data }: { data: Record<string, unknown> }) {
  const entries = Object.entries(data).filter(([, v]) => v !== null && v !== undefined && !(Array.isArray(v) && v.length === 0));
  if (!entries.length) return null;
  return (
    <div className="mt-0.5 text-xs text-muted">
      {entries.map(([k, v]) => (
        <span key={k} className="mr-3 inline-block">
          {k}: <span className="text-ink">{k.endsWith("Cents") && typeof v === "number" ? formatUSD(v) : typeof v === "object" ? JSON.stringify(v).slice(0, 140) : String(v).slice(0, 140)}</span>
        </span>
      ))}
    </div>
  );
}
