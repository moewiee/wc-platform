import Link from "next/link";
import { redirect } from "next/navigation";
import { LoginForm } from "@/components/AuthForms";
import { getCurrentUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  const user = await getCurrentUser();
  if (user) redirect("/");
  return (
    <div className="mx-auto mt-8 max-w-sm rounded-2xl border border-slate-800 bg-slate-900 p-8">
      <h1 className="mb-6 text-2xl font-bold">Sign in</h1>
      <LoginForm />
      <p className="mt-6 text-center text-sm text-slate-400">
        No account?{" "}
        <Link href="/register" className="text-[#f0b429] hover:underline">
          Join and get 20,000 pts free
        </Link>
      </p>
    </div>
  );
}
