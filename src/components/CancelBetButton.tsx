"use client";

import { useActionState } from "react";
import { cancelBetAction, type FormState } from "@/lib/actions";

export default function CancelBetButton({ betId }: { betId: number }) {
  const [state, formAction, pending] = useActionState<FormState, FormData>(
    cancelBetAction,
    {}
  );
  return (
    <form action={formAction} className="flex items-center gap-2">
      <input type="hidden" name="betId" value={betId} />
      <button
        type="submit"
        disabled={pending}
        className="rounded-md border border-rose-900 px-2.5 py-1 text-xs font-semibold text-rose-400 transition hover:border-rose-600 hover:text-rose-300 disabled:opacity-50"
      >
        {pending ? "Cancelling…" : "Cancel & refund"}
      </button>
      {state.error && <span className="text-xs text-rose-400">{state.error}</span>}
    </form>
  );
}
