"use client";

import { useActionState } from "react";
import { changePasswordAction, type FormState } from "@/lib/actions";

export default function ChangePasswordForm() {
  const [state, formAction, pending] = useActionState<FormState, FormData>(
    changePasswordAction,
    {}
  );
  return (
    <form action={formAction} className="space-y-3">
      {(
        [
          ["current", "Current password"],
          ["next", "New password"],
          ["confirm", "Confirm new password"],
        ] as const
      ).map(([name, label]) => (
        <div key={name}>
          <label
            htmlFor={`pw-${name}`}
            className="mb-1 block text-sm font-semibold text-slate-300"
          >
            {label}
          </label>
          <input
            id={`pw-${name}`}
            name={name}
            type="password"
            required
            autoComplete={name === "current" ? "current-password" : "new-password"}
            className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 focus:border-emerald-500 focus:outline-none"
          />
        </div>
      ))}
      {state.error && <p className="text-sm text-rose-400">{state.error}</p>}
      {state.success && (
        <p className="text-sm text-emerald-400">{state.success}</p>
      )}
      <button
        type="submit"
        disabled={pending}
        className="rounded-lg bg-slate-700 px-4 py-2 text-sm font-semibold text-white transition hover:bg-slate-600 disabled:opacity-50"
      >
        {pending ? "Updating…" : "Update password"}
      </button>
    </form>
  );
}
