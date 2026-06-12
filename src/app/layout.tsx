import type { Metadata } from "next";
import "./globals.css";
import BetSlipProvider from "@/components/BetSlip";
import NavBar from "@/components/NavBar";
import { getCurrentUser } from "@/lib/auth";

export const metadata: Metadata = {
  title: "WC26BET — World Cup 2026 betting with friends",
  description:
    "Play-money betting on FIFA World Cup 2026: Asian handicap, over/under, correct score and more. New accounts get 20,000 points. No real money.",
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await getCurrentUser();
  return (
    <html lang="en">
      <body className="min-h-screen bg-[#081120] text-slate-100 antialiased">
        <NavBar user={user} />
        <BetSlipProvider balancePoints={user?.balance_points ?? 0} loggedIn={!!user}>
          <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
        </BetSlipProvider>
        <footer className="border-t border-[#13233f] py-6 pb-28 text-center text-xs text-slate-600 sm:pb-6">
          Play money only — for fun between friends. No real gambling. ⚽
        </footer>
      </body>
    </html>
  );
}
