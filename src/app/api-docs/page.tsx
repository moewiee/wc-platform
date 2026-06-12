import Link from "next/link";

export const metadata = {
  title: "API — WC26BET",
  description: "REST API documentation: check rates and place bets from code.",
};

function Code({ children }: { children: string }) {
  return (
    <pre className="overflow-x-auto rounded-lg border border-[#13233f] bg-[#0a1426] p-4 font-mono text-xs leading-relaxed text-slate-300">
      {children}
    </pre>
  );
}

function Endpoint({
  method,
  path,
  auth,
  children,
}: {
  method: string;
  path: string;
  auth?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-[#13233f] bg-[#0e1c33] p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded bg-[#13243f] px-2 py-0.5 font-mono text-xs font-bold text-[#f0b429]">
          {method}
        </span>
        <span className="font-mono text-sm text-slate-100">{path}</span>
        {auth && (
          <span className="rounded bg-rose-950 px-2 py-0.5 text-[10px] font-bold uppercase text-rose-300">
            auth required
          </span>
        )}
      </div>
      <div className="mt-2 space-y-2 text-sm text-slate-300">{children}</div>
    </div>
  );
}

const BASE = "https://wc26.ankai.uk";

export default function ApiDocsPage() {
  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <div>
        <h1 className="text-2xl font-black tracking-tight">
          <span className="text-[#f0b429]">WC26BET</span>{" "}
          <span className="text-slate-200">REST API</span>
        </h1>
        <p className="mt-2 text-sm text-slate-300">
          Everything the site does — checking rates, placing and cancelling
          bets — works over a JSON API too. Base URL:{" "}
          <code className="rounded bg-[#13243f] px-1.5 py-0.5 font-mono text-xs text-[#f0b429]">
            {BASE}
          </code>
          . Play money only: every account starts with 20,000 points.
        </p>
      </div>

      <section className="space-y-3">
        <h2 className="text-sm font-bold uppercase tracking-wider text-slate-400">
          Quick start
        </h2>
        <Code>{`# 1. register (or login) → bearer token
tok=$(curl -s -X POST ${BASE}/api/auth/register \\
  -H 'Content-Type: application/json' \\
  -d '{"username":"alice","password":"secret"}' | jq -r .token)

# 2. check rates — all matches, every market, current odds
curl -s ${BASE}/api/matches | jq .

# 3. place a bet: 500 pts on Canada -0.5 (Asian handicap)
curl -s -X POST ${BASE}/api/bets \\
  -H "Authorization: Bearer $tok" -H 'Content-Type: application/json' \\
  -d '{"match_id":3,"market":"ah_goals","line":-0.5,"selection":"home","stake_points":500}'

# 4. my bets + balance
curl -s ${BASE}/api/bets -H "Authorization: Bearer $tok" | jq .

# 5. changed your mind? cancel before kickoff for a full refund
curl -s -X DELETE ${BASE}/api/bets/7 -H "Authorization: Bearer $tok"`}</Code>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-bold uppercase tracking-wider text-slate-400">
          Authentication
        </h2>
        <p className="text-sm text-slate-300">
          <code className="font-mono text-xs">POST /api/auth/register</code> and{" "}
          <code className="font-mono text-xs">POST /api/auth/login</code> take{" "}
          <code className="font-mono text-xs">
            {"{"}&quot;username&quot;, &quot;password&quot;{"}"}
          </code>{" "}
          and return{" "}
          <code className="font-mono text-xs">
            {"{"}&quot;token&quot;, &quot;expires&quot;, &quot;user&quot;{"}"}
          </code>
          . Send the token on protected endpoints as{" "}
          <code className="font-mono text-xs">Authorization: Bearer &lt;token&gt;</code>.
          Reading matches and odds needs no authentication.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-bold uppercase tracking-wider text-slate-400">
          Endpoints
        </h2>
        <Endpoint method="GET" path="/api/matches">
          All matches with status, scores and — while the counter is open — every
          market and its current odds. Finished matches include{" "}
          <code className="font-mono text-xs">result</code>,{" "}
          <code className="font-mono text-xs">corners_home/away</code> and{" "}
          <code className="font-mono text-xs">cards_total</code>.
        </Endpoint>
        <Endpoint method="GET" path="/api/matches/{id}">
          One match, same shape, plus expert tips.
        </Endpoint>
        <Endpoint method="POST" path="/api/bets" auth>
          <p>
            Body:{" "}
            <code className="font-mono text-xs">
              {"{"}&quot;match_id&quot;, &quot;market&quot;, &quot;line&quot;,
              &quot;selection&quot;, &quot;stake_points&quot;{"}"}
            </code>
            . <code className="font-mono text-xs">line</code> is required for
            handicap and over/under markets (take it from the match&apos;s market
            list) and omitted for <code className="font-mono text-xs">h2h</code> /{" "}
            <code className="font-mono text-xs">correct_score</code>. Returns the
            created bet with the odds you locked in. The server always prices from
            its own current odds — odds sent by clients are ignored.
          </p>
        </Endpoint>
        <Endpoint method="GET" path="/api/bets" auth>
          Your balance and all your bets, newest first.
        </Endpoint>
        <Endpoint method="DELETE" path="/api/bets/{id}" auth>
          Cancel one of your open bets and refund the stake. Only works before
          the match kicks off.
        </Endpoint>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-bold uppercase tracking-wider text-slate-400">
          Markets
        </h2>
        <div className="overflow-x-auto rounded-lg border border-[#13233f]">
          <table className="w-full text-left text-sm">
            <thead className="bg-[#0a1426] text-xs uppercase text-slate-400">
              <tr>
                <th className="px-4 py-2">market</th>
                <th className="px-4 py-2">selections</th>
                <th className="px-4 py-2">line</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#13233f] bg-[#0e1c33] font-mono text-xs text-slate-300">
              <tr>
                <td className="px-4 py-2">h2h</td>
                <td className="px-4 py-2">home · draw · away</td>
                <td className="px-4 py-2">—</td>
              </tr>
              <tr>
                <td className="px-4 py-2">ah_goals</td>
                <td className="px-4 py-2">home · away</td>
                <td className="px-4 py-2">quarter steps, e.g. -0.75</td>
              </tr>
              <tr>
                <td className="px-4 py-2">ou_goals</td>
                <td className="px-4 py-2">over · under</td>
                <td className="px-4 py-2">quarter ladder, e.g. 2.25</td>
              </tr>
              <tr>
                <td className="px-4 py-2">ah_corners</td>
                <td className="px-4 py-2">home · away</td>
                <td className="px-4 py-2">quarter steps</td>
              </tr>
              <tr>
                <td className="px-4 py-2">ou_corners</td>
                <td className="px-4 py-2">over · under</td>
                <td className="px-4 py-2">quarter ladder</td>
              </tr>
              <tr>
                <td className="px-4 py-2">ou_cards</td>
                <td className="px-4 py-2">over · under</td>
                <td className="px-4 py-2">3.5 / 4.5 / 5.5</td>
              </tr>
              <tr>
                <td className="px-4 py-2">correct_score</td>
                <td className="px-4 py-2">&quot;2-1&quot; … · other_home · other_draw · other_away</td>
                <td className="px-4 py-2">—</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-bold uppercase tracking-wider text-slate-400">
          Conventions
        </h2>
        <ul className="list-inside list-disc space-y-1.5 text-sm text-slate-300">
          <li>
            Odds are decimal <strong>×1000 integers</strong>: <code className="font-mono text-xs">1845</code>{" "}
            means 1.845. Payout = ⌊stake × odds / 1000⌋ points.
          </li>
          <li>
            Stakes, balances and payouts are whole points; minimum stake 10.
          </li>
          <li>
            The counter closes at kickoff — no bets or cancellations after that,
            and odds disappear from match payloads.
          </li>
          <li>
            Asian quarter lines split your stake across the two adjacent lines
            (half win / half loss possible). Integer lines push (refund) on an
            exact hit.
          </li>
          <li>
            Cards count yellow = 1, red = 2. Scores settle automatically within
            ~10 minutes of full time; corners/cards markets may settle a little
            later.
          </li>
          <li>
            Bet status: <code className="font-mono text-xs">pending → won / lost / void / cancelled</code>.
            Void (match postponed) and cancelled bets refund the stake.
          </li>
        </ul>
      </section>

      <p className="text-sm text-slate-400">
        Questions or odd behaviour? Ping the admin.{" "}
        <Link href="/" className="text-[#f0b429] hover:text-[#ffd166]">
          ← Back to the lobby
        </Link>
      </p>
    </div>
  );
}
