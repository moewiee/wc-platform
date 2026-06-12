import ChangePasswordForm from "@/components/ChangePasswordForm";
import LocalTime from "@/components/LocalTime";
import { requireUser } from "@/lib/auth";
import { fmtPts } from "@/lib/money";
import { listTransactions } from "@/lib/users";

export const dynamic = "force-dynamic";

const TXN_LABELS: Record<string, string> = {
  signup_bonus: "Welcome bonus",
  bet_stake: "Bet placed",
  bet_payout: "Bet won",
  bet_refund: "Refund",
};

export default async function AccountPage() {
  const user = await requireUser();
  const txns = listTransactions(user.id);
  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <div className="rounded-xl border border-[#1b2c4a] bg-[#0e1c33] p-6">
        <h1 className="text-2xl font-bold">{user.username}</h1>
        <p className="mt-1 text-sm text-slate-400">
          Member since <LocalTime iso={user.created_at} />
          {user.is_admin ? " · admin" : ""}
        </p>
        <p className="mt-3 font-mono text-2xl font-bold text-[#f0b429]">
          {fmtPts(user.balance_points)} pts
        </p>
      </div>

      <section className="rounded-xl border border-[#1b2c4a] bg-[#0e1c33] p-6">
        <h2 className="mb-4 font-bold">Change password</h2>
        <div className="max-w-sm">
          <ChangePasswordForm />
        </div>
      </section>

      <section>
        <h2 className="mb-3 font-bold">Transaction history</h2>
        <div className="overflow-x-auto rounded-xl border border-[#1b2c4a]">
          <table className="w-full text-sm">
            <thead className="bg-[#13243f] text-left text-xs uppercase tracking-wide text-slate-400">
              <tr>
                <th className="px-4 py-3">When</th>
                <th className="px-4 py-3">Type</th>
                <th className="px-4 py-3">Detail</th>
                <th className="px-4 py-3 text-right">Points</th>
                <th className="px-4 py-3 text-right">Balance</th>
              </tr>
            </thead>
            <tbody>
              {txns.map((t) => (
                <tr
                  key={t.id}
                  className="border-t border-[#13233f] odd:bg-[#0a1628] even:bg-[#0e1c33]"
                >
                  <td className="whitespace-nowrap px-4 py-2.5 text-slate-400">
                    <LocalTime iso={t.created_at} />
                  </td>
                  <td className="whitespace-nowrap px-4 py-2.5">
                    {TXN_LABELS[t.type] ?? t.type}
                  </td>
                  <td className="max-w-60 truncate px-4 py-2.5 text-slate-400">
                    {t.note}
                  </td>
                  <td
                    className={`whitespace-nowrap px-4 py-2.5 text-right font-mono font-semibold ${
                      t.amount_points >= 0 ? "text-emerald-400" : "text-rose-400"
                    }`}
                  >
                    {t.amount_points >= 0 ? "+" : ""}
                    {fmtPts(t.amount_points)}
                  </td>
                  <td className="whitespace-nowrap px-4 py-2.5 text-right font-mono text-slate-400">
                    {fmtPts(t.balance_after_points)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
