// Different data sources spell team names differently ("USA" vs "United States",
// "Korea Republic" vs "South Korea"). Normalize before comparing.
const ALIASES: Record<string, string> = {
  usa: "united states",
  "united states of america": "united states",
  "korea republic": "south korea",
  korea: "south korea",
  "ir iran": "iran",
  "cote divoire": "ivory coast",
  "cabo verde": "cape verde",
  "congo dr": "dr congo",
  "democratic republic of the congo": "dr congo",
  "czech republic": "czechia",
  bosnia: "bosnia and herzegovina",
  "bosnia herzegovina": "bosnia and herzegovina",
  turkiye: "turkey",
};

export function normTeam(name: string): string {
  let n = name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/['’]/g, "") // "Côte d'Ivoire" → "cote divoire", not "cote d ivoire"
    .replace(/&/g, "and")
    .replace(/[^a-z ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (n in ALIASES) n = ALIASES[n];
  return n;
}

export function teamPairKey(home: string, away: string): string {
  return `${normTeam(home)}|${normTeam(away)}`;
}
