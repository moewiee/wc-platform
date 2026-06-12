"use client";

import { useActionState } from "react";
import {
  loginAction,
  registerAction,
  type FormState,
} from "@/lib/actions";

function Field({
  label,
  name,
  type = "text",
  autoComplete,
}: {
  label: string;
  name: string;
  type?: string;
  autoComplete?: string;
}) {
  return (
    <div>
      <label
        htmlFor={name}
        className="mb-1 block text-sm font-semibold text-slate-300"
      >
        {label}
      </label>
      <input
        id={name}
        name={name}
        type={type}
        required
        autoComplete={autoComplete}
        className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 focus:border-emerald-500 focus:outline-none"
      />
    </div>
  );
}

function SubmitButton({ pending, label }: { pending: boolean; label: string }) {
  return (
    <button
      type="submit"
      disabled={pending}
      className="w-full rounded-lg bg-emerald-600 py-2.5 font-semibold text-white transition hover:bg-emerald-500 disabled:bg-slate-700"
    >
      {pending ? "…" : label}
    </button>
  );
}

export function LoginForm() {
  const [state, formAction, pending] = useActionState<FormState, FormData>(
    loginAction,
    {}
  );
  return (
    <form action={formAction} className="space-y-4">
      <Field label="Username" name="username" autoComplete="username" />
      <Field
        label="Password"
        name="password"
        type="password"
        autoComplete="current-password"
      />
      {state.error && <p className="text-sm text-rose-400">{state.error}</p>}
      <SubmitButton pending={pending} label="Sign in" />
    </form>
  );
}

export function RegisterForm() {
  const [state, formAction, pending] = useActionState<FormState, FormData>(
    registerAction,
    {}
  );
  return (
    <form action={formAction} className="space-y-4">
      <Field label="Username" name="username" autoComplete="username" />
      <Field
        label="Password"
        name="password"
        type="password"
        autoComplete="new-password"
      />
      <Field
        label="Confirm password"
        name="confirm"
        type="password"
        autoComplete="new-password"
      />
      {state.error && <p className="text-sm text-rose-400">{state.error}</p>}
      <SubmitButton pending={pending} label="Create account — get 20,000 pts" />
    </form>
  );
}
