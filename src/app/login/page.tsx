import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import { Flash, one, type SearchParams } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function LoginPage({ searchParams }: { searchParams: SearchParams }) {
  if (await getSession()) redirect("/");
  const sp = await searchParams;
  return (
    <main className="mx-auto mt-24 max-w-sm px-4">
      <div className="mb-6 flex items-center gap-2 text-lg font-semibold">
        <span className="grid h-7 w-7 place-items-center rounded bg-accent text-xs font-bold text-white">RP</span>
        ResolvePay
      </div>
      <Flash err={one(sp.err)} />
      <form action="/api/auth/login" method="post" className="card space-y-4 p-5">
        <div>
          <h1 className="text-base font-semibold">Merchant sign-in</h1>
          <p className="mt-1 text-sm text-muted">Single demo merchant. Password is set by MERCHANT_PASSWORD.</p>
        </div>
        <label className="block space-y-1">
          <span className="label">Password</span>
          <input name="password" type="password" required autoFocus className="input w-full" />
        </label>
        <button className="btn-primary w-full">Sign in</button>
      </form>
    </main>
  );
}
