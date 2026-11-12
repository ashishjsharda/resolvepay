import Link from "next/link";

export function Nav({ csrf, active }: { csrf: string; active: "dashboard" | "demo" | "case" }) {
  const item = (href: string, label: string, on: boolean) => (
    <Link href={href} className={`rounded-md px-2.5 py-1 text-sm ${on ? "bg-canvas font-medium text-ink" : "text-muted hover:text-ink"}`}>
      {label}
    </Link>
  );
  return (
    <header className="border-b border-line bg-white">
      <div className="mx-auto flex max-w-6xl items-center gap-4 px-4 py-3">
        <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight">
          <span className="grid h-6 w-6 place-items-center rounded bg-accent text-[11px] font-bold text-white">RP</span>
          ResolvePay
        </Link>
        <nav className="flex gap-1">
          {item("/", "Cases", active === "dashboard" || active === "case")}
          {item("/demo", "Demo setup", active === "demo")}
        </nav>
        <form action="/api/auth/logout" method="post" className="ml-auto">
          <input type="hidden" name="csrf" value={csrf} />
          <button className="text-sm text-muted hover:text-ink">Sign out</button>
        </form>
      </div>
    </header>
  );
}
