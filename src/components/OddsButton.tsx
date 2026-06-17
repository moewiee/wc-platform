"use client";

import { fmtOdds } from "@/lib/money";
import { useBetSlip, type SlipSelection } from "./BetSlip";

// One clickable odds cell, bookmaker style: small label on top, gold price
// below. Clicking loads the selection into the bet slip.
export default function OddsButton({
  sel,
  sub,
  disabled = false,
  wide = false,
}: {
  sel: SlipSelection;
  sub?: string;
  disabled?: boolean;
  wide?: boolean;
}) {
  const { isSelected, toggle } = useBetSlip();
  const active = isSelected(sel);
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => toggle(sel)}
      title={`${sel.marketName} · ${sel.selectionLabel}`}
      className={`flex flex-col items-center justify-center rounded-md border px-1.5 py-1 transition ${
        wide ? "w-full" : "w-[4.5rem]"
      } ${
        active
          ? "border-[#f0b429] bg-[#f0b429]/15"
          : disabled
            ? "cursor-not-allowed border-[#15233d] bg-[#0a1628] text-slate-600"
            : "border-[#1b2c4a] bg-[#13243f] hover:border-[#f0b429]/70 hover:bg-[#1a2f52]"
      }`}
    >
      {sub && (
        <span className="max-w-full truncate text-[10px] leading-tight text-slate-400">
          {sub}
        </span>
      )}
      <span
        className={`font-mono text-sm font-bold leading-tight ${
          active ? "text-[#ffd166]" : "text-[#f0b429]"
        }`}
      >
        {fmtOdds(sel.odds)}
      </span>
    </button>
  );
}
