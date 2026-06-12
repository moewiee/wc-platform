// FIFA World Cup 2026 group stage — all 72 matches, kickoffs in UTC.
// Schedule sourced from Sky Sports / ESPN / Yahoo (June 2026). Odds are
// realistic placeholders; a configured ODDS_API_KEY replaces them with live
// bookmaker odds. The four Group J/K matchday-3 fixtures were not listed in
// the source pages; pairings follow FIFA's standard rotation, times inferred.
// Bump SEED_VERSION when editing so existing databases pick up changes.
export const SEED_VERSION = "wc2026-group-stage-v1";

export interface SeedMatch {
  home: string;
  away: string;
  kickoff: string; // ISO 8601 UTC
  group: string;
  venue: string;
  oddsHome: number; // decimal odds x1000
  oddsDraw: number;
  oddsAway: number;
}

const M = (
  kickoff: string,
  group: string,
  venue: string,
  home: string,
  away: string,
  oddsHome: number,
  oddsDraw: number,
  oddsAway: number
): SeedMatch => ({ home, away, kickoff, group, venue, oddsHome, oddsDraw, oddsAway });

export const SEED_MATCHES: SeedMatch[] = [
  // ── Matchday 1 ──────────────────────────────────────────────────────────
  M("2026-06-11T19:00:00Z", "A", "Mexico City", "Mexico", "South Africa", 1550, 4000, 6500),
  M("2026-06-12T02:00:00Z", "A", "Guadalajara", "South Korea", "Czechia", 2600, 3100, 2800),
  M("2026-06-12T19:00:00Z", "B", "Toronto", "Canada", "Bosnia and Herzegovina", 1850, 3500, 4400),
  M("2026-06-13T01:00:00Z", "D", "Los Angeles", "United States", "Paraguay", 1750, 3600, 5000),
  M("2026-06-13T19:00:00Z", "B", "Santa Clara", "Qatar", "Switzerland", 5500, 3900, 1650),
  M("2026-06-13T22:00:00Z", "C", "New York NJ", "Brazil", "Morocco", 1900, 3400, 4200),
  M("2026-06-14T01:00:00Z", "C", "Boston", "Haiti", "Scotland", 5000, 3800, 1700),
  M("2026-06-14T04:00:00Z", "D", "Vancouver", "Australia", "Turkey", 3400, 3300, 2200),
  M("2026-06-14T17:00:00Z", "E", "Houston", "Germany", "Curacao", 1200, 6500, 13000),
  M("2026-06-14T20:00:00Z", "F", "Dallas", "Netherlands", "Japan", 1950, 3400, 4000),
  M("2026-06-14T23:00:00Z", "E", "Philadelphia", "Ivory Coast", "Ecuador", 2900, 3000, 2600),
  M("2026-06-15T02:00:00Z", "F", "Monterrey", "Sweden", "Tunisia", 2100, 3200, 3700),
  M("2026-06-15T16:00:00Z", "H", "Atlanta", "Spain", "Cape Verde", 1150, 7500, 17000),
  M("2026-06-15T19:00:00Z", "G", "Seattle", "Belgium", "Egypt", 1800, 3500, 4600),
  M("2026-06-15T22:00:00Z", "H", "Miami", "Saudi Arabia", "Uruguay", 4800, 3600, 1750),
  M("2026-06-16T01:00:00Z", "G", "Los Angeles", "Iran", "New Zealand", 2200, 3100, 3500),
  M("2026-06-16T19:00:00Z", "I", "New York NJ", "France", "Senegal", 1700, 3600, 5200),
  M("2026-06-16T22:00:00Z", "I", "Boston", "Iraq", "Norway", 6000, 4200, 1550),
  M("2026-06-17T01:00:00Z", "J", "Kansas City", "Argentina", "Algeria", 1500, 4200, 7000),
  M("2026-06-17T04:00:00Z", "J", "Santa Clara", "Austria", "Jordan", 1650, 3800, 5500),
  M("2026-06-17T17:00:00Z", "K", "Houston", "Portugal", "DR Congo", 1350, 5000, 9000),
  M("2026-06-17T20:00:00Z", "L", "Dallas", "England", "Croatia", 2000, 3300, 3900),
  M("2026-06-17T23:00:00Z", "L", "Toronto", "Ghana", "Panama", 2400, 3200, 3100),
  M("2026-06-18T02:00:00Z", "K", "Mexico City", "Uzbekistan", "Colombia", 4600, 3500, 1800),
  // ── Matchday 2 ──────────────────────────────────────────────────────────
  M("2026-06-18T16:00:00Z", "A", "Atlanta", "Czechia", "South Africa", 2100, 3200, 3600),
  M("2026-06-18T19:00:00Z", "B", "Los Angeles", "Switzerland", "Bosnia and Herzegovina", 2000, 3300, 3900),
  M("2026-06-18T22:00:00Z", "B", "Vancouver", "Canada", "Qatar", 1600, 3900, 5800),
  M("2026-06-19T01:00:00Z", "A", "Guadalajara", "Mexico", "South Korea", 2050, 3300, 3700),
  M("2026-06-19T19:00:00Z", "D", "Seattle", "United States", "Australia", 2100, 3300, 3600),
  M("2026-06-19T22:00:00Z", "C", "Boston", "Scotland", "Morocco", 3800, 3400, 2000),
  M("2026-06-20T00:30:00Z", "C", "Philadelphia", "Brazil", "Haiti", 1180, 7000, 15000),
  M("2026-06-20T03:00:00Z", "D", "Santa Clara", "Turkey", "Paraguay", 2300, 3100, 3300),
  M("2026-06-20T17:00:00Z", "F", "Houston", "Netherlands", "Sweden", 1750, 3500, 4800),
  M("2026-06-20T20:00:00Z", "E", "Toronto", "Germany", "Ivory Coast", 1700, 3700, 5000),
  M("2026-06-21T00:00:00Z", "E", "Kansas City", "Ecuador", "Curacao", 1500, 4000, 7000),
  M("2026-06-21T04:00:00Z", "F", "Monterrey", "Tunisia", "Japan", 4000, 3400, 1950),
  M("2026-06-21T16:00:00Z", "H", "Atlanta", "Spain", "Saudi Arabia", 1250, 6000, 11000),
  M("2026-06-21T19:00:00Z", "G", "Los Angeles", "Belgium", "Iran", 1650, 3800, 5400),
  M("2026-06-21T22:00:00Z", "H", "Miami", "Uruguay", "Cape Verde", 1350, 4800, 9500),
  M("2026-06-22T01:00:00Z", "G", "Vancouver", "New Zealand", "Egypt", 3300, 3200, 2250),
  M("2026-06-22T17:00:00Z", "J", "Dallas", "Argentina", "Austria", 1600, 3900, 5600),
  M("2026-06-22T21:00:00Z", "I", "Philadelphia", "France", "Iraq", 1250, 6000, 11500),
  M("2026-06-23T00:00:00Z", "I", "Toronto", "Norway", "Senegal", 2500, 3200, 2900),
  M("2026-06-23T03:00:00Z", "J", "Santa Clara", "Jordan", "Algeria", 3600, 3300, 2100),
  M("2026-06-23T17:00:00Z", "K", "Houston", "Portugal", "Uzbekistan", 1450, 4400, 7500),
  M("2026-06-23T20:00:00Z", "L", "Boston", "England", "Ghana", 1550, 4000, 6000),
  M("2026-06-23T23:00:00Z", "L", "Boston", "Panama", "Croatia", 5000, 3900, 1700),
  M("2026-06-24T02:00:00Z", "K", "Guadalajara", "Colombia", "DR Congo", 1550, 4000, 6000),
  // ── Matchday 3 (simultaneous kickoffs per group) ────────────────────────
  M("2026-06-24T19:00:00Z", "B", "Vancouver", "Switzerland", "Canada", 2500, 3200, 2900),
  M("2026-06-24T19:00:00Z", "B", "Seattle", "Bosnia and Herzegovina", "Qatar", 2000, 3400, 3800),
  M("2026-06-24T22:00:00Z", "C", "Atlanta", "Morocco", "Haiti", 1300, 5200, 10000),
  M("2026-06-24T22:00:00Z", "C", "Miami", "Scotland", "Brazil", 6500, 4500, 1500),
  M("2026-06-25T01:00:00Z", "A", "Monterrey", "South Africa", "South Korea", 3100, 3200, 2400),
  M("2026-06-25T01:00:00Z", "A", "Mexico City", "Czechia", "Mexico", 3400, 3300, 2200),
  M("2026-06-25T20:00:00Z", "E", "Philadelphia", "Curacao", "Ivory Coast", 4500, 3600, 1800),
  M("2026-06-25T20:00:00Z", "E", "New York NJ", "Ecuador", "Germany", 4200, 3600, 1850),
  M("2026-06-25T23:00:00Z", "F", "Kansas City", "Tunisia", "Netherlands", 5500, 4000, 1600),
  M("2026-06-25T23:00:00Z", "F", "Dallas", "Japan", "Sweden", 2500, 3100, 3000),
  M("2026-06-26T02:00:00Z", "D", "Los Angeles", "Turkey", "United States", 3200, 3300, 2250),
  M("2026-06-26T02:00:00Z", "D", "Santa Clara", "Paraguay", "Australia", 2700, 3100, 2800),
  M("2026-06-26T19:00:00Z", "I", "Boston", "Norway", "France", 3600, 3500, 2050),
  M("2026-06-26T19:00:00Z", "I", "Toronto", "Senegal", "Iraq", 1500, 4200, 7000),
  M("2026-06-27T00:00:00Z", "H", "Houston", "Cape Verde", "Saudi Arabia", 2900, 3100, 2600),
  M("2026-06-27T00:00:00Z", "H", "Guadalajara", "Uruguay", "Spain", 4400, 3700, 1800),
  M("2026-06-27T03:00:00Z", "G", "Vancouver", "New Zealand", "Belgium", 6000, 4200, 1550),
  M("2026-06-27T03:00:00Z", "G", "Seattle", "Egypt", "Iran", 2600, 3000, 2900),
  M("2026-06-27T21:00:00Z", "L", "New York NJ", "Panama", "England", 8000, 4800, 1400),
  M("2026-06-27T21:00:00Z", "L", "Philadelphia", "Croatia", "Ghana", 1900, 3400, 4200),
  M("2026-06-28T00:00:00Z", "J", "Kansas City", "Jordan", "Argentina", 9000, 5000, 1350),
  M("2026-06-28T00:00:00Z", "J", "Dallas", "Algeria", "Austria", 2900, 3100, 2500),
  M("2026-06-28T03:00:00Z", "K", "Miami", "Colombia", "Portugal", 3300, 3300, 2200),
  M("2026-06-28T03:00:00Z", "K", "Seattle", "DR Congo", "Uzbekistan", 2700, 3100, 2700),
];
