import { formatUSD } from "@/lib/money";

export function Flash({ msg, err }: { msg?: string; err?: string }) {
  if (!msg && !err) return null;
  return (
    <div
      role={err ? "alert" : "status"}
      className={`mb-4 rounded-md border px-3 py-2 text-sm ${err ? "border-red-200 bg-red-50 text-red-800" : "border-emerald-200 bg-emerald-50 text-emerald-900"}`}
    >
      {err ?? msg}
    </div>
  );
}

const STATUS_STYLE: Record<string, string> = {
  NEW: "bg-slate-100 text-slate-700",
  ANALYSIS_FAILED: "bg-red-100 text-red-800",
  AWAITING_REVIEW: "bg-blue-100 text-blue-800",
  ESCALATED: "bg-orange-100 text-orange-800",
  APPROVED: "bg-indigo-100 text-indigo-800",
  EXECUTING: "bg-indigo-100 text-indigo-800",
  REFUND_PENDING: "bg-yellow-100 text-yellow-800",
  NEEDS_RECONCILIATION: "bg-yellow-100 text-yellow-900",
  REFUNDED: "bg-emerald-100 text-emerald-800",
  REFUND_FAILED: "bg-red-100 text-red-800",
  DECLINED: "bg-slate-200 text-slate-700",
  REFUND: "bg-emerald-100 text-emerald-800",
  DECLINE: "bg-slate-200 text-slate-700",
  ESCALATE: "bg-orange-100 text-orange-800",
  COMPLETED: "bg-emerald-100 text-emerald-800",
  PAYPAL_PENDING: "bg-yellow-100 text-yellow-800",
  UNKNOWN: "bg-yellow-100 text-yellow-900",
  SUBMITTED: "bg-indigo-100 text-indigo-800",
  CREATED: "bg-slate-100 text-slate-700",
  FAILED: "bg-red-100 text-red-800",
  CANCELLED: "bg-slate-200 text-slate-700",
};

export function Badge({ value }: { value: string }) {
  return (
    <span className={`inline-flex rounded px-1.5 py-0.5 text-[11px] font-semibold tracking-wide ${STATUS_STYLE[value] ?? "bg-slate-100 text-slate-700"}`}>
      {value.replace(/_/g, " ")}
    </span>
  );
}

export function Usd({ cents, className = "" }: { cents: number; className?: string }) {
  return <span className={`tabular-nums ${className}`}>{formatUSD(cents)}</span>;
}

export function Section({ title, children, aside }: { title: string; children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <section className="card">
      <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
        <h2 className="text-sm font-semibold">{title}</h2>
        {aside}
      </div>
      <div className="p-4">{children}</div>
    </section>
  );
}

export function CsrfField({ csrf }: { csrf: string }) {
  return <input type="hidden" name="csrf" value={csrf} />;
}

export type SearchParams = Promise<Record<string, string | string[] | undefined>>;
export const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
