import Link from "next/link";
import { redirect } from "next/navigation";
import { RegisterForm } from "@/components/AuthForms";
import { getCurrentUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function RegisterPage() {
  const user = await getCurrentUser();
  if (user) redirect("/");
  return (
    <div className="mx-auto mt-8 max-w-sm rounded-2xl border border-slate-800 bg-slate-900 p-8">
      <h1 className="mb-2 text-2xl font-bold">Create account</h1>
      <p className="mb-6 text-sm text-slate-400">
        Every new player starts with{" "}
        <span className="font-semibold text-[#f0b429]">20,000 points</span> of
        play money.
      </p>
      <RegisterForm />
      <p className="mt-6 text-center text-sm text-slate-400">
        Already playing?{" "}
        <Link href="/login" className="text-emerald-400 hover:underline">
          Sign in
        </Link>
      </p>
    </div>
  );
}
