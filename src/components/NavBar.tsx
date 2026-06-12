import Link from "next/link";
import { logoutAction } from "@/lib/actions";
import { fmtPts } from "@/lib/money";
import type { User } from "@/lib/types";

export default function NavBar({ user }: { user: User | null }) {
  return (
    <header className="sticky top-0 z-30 border-b-2 border-[#f0b429]/60 bg-[#0a1426]/95 backdrop-blur">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2.5">
        <Link href="/" className="text-lg font-black tracking-tight">
          ⚽ <span className="text-[#f0b429]">WC26</span>
          <span className="text-slate-100">BET</span>
        </Link>
        <nav className="flex items-center gap-3 text-sm font-semibold text-slate-300">
          <Link href="/" className="hover:text-[#ffd166]">Sports</Link>
          {user && (
            <Link href="/my-bets" className="hover:text-[#ffd166]">My Bets</Link>
          )}
          <Link href="/leaderboard" className="hover:text-[#ffd166]">Leaderboard</Link>
          <Link href="/api-docs" className="hover:text-[#ffd166]">API</Link>
          {user && (
            <Link href="/account" className="hover:text-[#ffd166]">Account</Link>
          )}
          {user?.is_admin ? (
            <Link href="/admin" className="text-amber-400 hover:text-amber-300">Admin</Link>
          ) : null}
        </nav>
        <div className="ml-auto flex items-center gap-3">
          {user ? (
            <>
              <span className="rounded-full border border-[#f0b429]/50 bg-[#13243f] px-3 py-1 font-mono text-sm font-bold text-[#f0b429]">
                {fmtPts(user.balance_points)} pts
              </span>
              <span className="hidden text-sm text-slate-400 sm:inline">
                {user.username}
              </span>
              <form action={logoutAction}>
                <button className="text-sm text-slate-400 hover:text-white">
                  Sign out
                </button>
              </form>
            </>
          ) : (
            <>
              <Link href="/login" className="text-sm font-semibold text-slate-300 hover:text-white">
                Sign in
              </Link>
              <Link
                href="/register"
                className="rounded-md bg-[#f0b429] px-3 py-1.5 text-sm font-bold text-[#081120] hover:bg-[#ffd166]"
              >
                Join — 20,000 pts
              </Link>
            </>
          )}
        </div>
      </div>
    </header>
  );
}
