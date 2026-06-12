import type { Tip } from "@/lib/types";

// "Expert opinion" cards: AI agents that read the news (source=openai) and
// statistical model personas (source=model).
export default function TipsPanel({ tips }: { tips: Tip[] }) {
  if (tips.length === 0) return null;
  return (
    <section className="overflow-hidden rounded-lg border border-[#1b2c4a]">
      <h3 className="bg-[#13243f] px-3 py-2 text-xs font-bold uppercase tracking-wider text-[#f0b429]">
        Expert Opinion & Tips
      </h3>
      <div className="grid gap-3 bg-[#0e1c33] p-3 sm:grid-cols-2">
        {tips.map((t) => (
          <article
            key={t.id}
            className="rounded-md border border-[#1b2c4a] bg-[#0a1628] p-3"
          >
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className="text-xl">{t.avatar}</span>
                <div>
                  <div className="text-sm font-bold text-slate-100">{t.expert}</div>
                  <div className="text-[10px] uppercase tracking-wide text-slate-500">
                    {t.source === "openai" ? "AI agent · news analysis" : "Statistical model"}
                  </div>
                </div>
              </div>
              <span
                className="font-mono text-sm text-[#f0b429]"
                title={`Confidence ${t.confidence}/5`}
              >
                {"★".repeat(t.confidence)}
                <span className="text-slate-700">{"★".repeat(5 - t.confidence)}</span>
              </span>
            </div>
            <div className="mt-2 rounded bg-[#13243f] px-2 py-1.5 text-sm font-semibold text-[#ffd166]">
              {t.label}
            </div>
            <p className="mt-2 text-xs leading-relaxed text-slate-300">{t.rationale}</p>
          </article>
        ))}
      </div>
    </section>
  );
}
