/**
 * Kurzy ČNB. Používáme je záměrně místo tržních kurzů — jsou to kurzy,
 * kterými se počítá daňové přiznání, takže historie sedí s tím,
 * co pak reálně vykážeš.
 *
 * Denní lístek:  .../denni_kurz.txt?date=DD.MM.YYYY
 * Celý rok:      .../rok.txt?rok=YYYY   (pro backfill jedním requestem)
 */

const BASE = "https://www.cnb.cz/cs/financni-trhy/devizovy-trh/kurzy-devizoveho-trhu/kurzy-devizoveho-trhu";

export type FxRow = { d: string; currency: string; czkPerUnit: number };

const num = (s: string) => Number(s.trim().replace(/\s/g, "").replace(",", "."));
const toIso = (ddmmyyyy: string) => {
  const [dd, mm, yyyy] = ddmmyyyy.trim().split(".");
  return `${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
};

/**
 * Denní kurzovní lístek.
 * Formát: hlavička s datem, pak `země|měna|množství|kód|kurz`.
 * Pozor na `množství` — JPY se kotuje na 100 jednotek.
 */
export async function fetchDailyFx(date: Date = new Date()): Promise<FxRow[]> {
  const dd = String(date.getDate()).padStart(2, "0");
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const url = `${BASE}/denni_kurz.txt?date=${dd}.${mm}.${date.getFullYear()}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`ČNB: HTTP ${res.status}`);
  const text = await res.text();

  const lines = text.trim().split("\n");
  const header = lines[0] ?? "";
  const d = toIso(header.split(" ")[0]);

  const rows: FxRow[] = [];
  for (const line of lines.slice(2)) {
    const cols = line.split("|");
    if (cols.length < 5) continue;
    const amount = num(cols[2]);
    const code = cols[3].trim();
    const rate = num(cols[4]);
    if (!amount || !rate) continue;
    rows.push({ d, currency: code, czkPerUnit: rate / amount });
  }
  return rows;
}

/** Celý rok najednou — pro první naplnění historie. */
export async function fetchYearFx(year: number, currencies = ["EUR", "USD"]): Promise<FxRow[]> {
  const res = await fetch(`${BASE}/rok.txt?rok=${year}`);
  if (!res.ok) throw new Error(`ČNB rok ${year}: HTTP ${res.status}`);
  const text = await res.text();
  const lines = text.trim().split("\n");

  // Hlavička: "Datum|1 AUD|1 BRL|...|1 EUR|...|1 USD|..."
  const headers = lines[0].split("|").slice(1).map((h) => {
    const [amount, code] = h.trim().split(/\s+/);
    return { amount: Number(amount) || 1, code: (code ?? "").trim() };
  });

  const wanted = new Set(currencies);
  const rows: FxRow[] = [];
  for (const line of lines.slice(1)) {
    const cols = line.split("|");
    if (cols.length < 2) continue;
    const d = toIso(cols[0]);
    headers.forEach((h, i) => {
      if (!wanted.has(h.code)) return;
      const rate = num(cols[i + 1] ?? "");
      if (rate) rows.push({ d, currency: h.code, czkPerUnit: rate / h.amount });
    });
  }
  return rows;
}

/** Backfill od zadaného roku po současnost. */
export async function backfillFx(fromYear: number, currencies = ["EUR", "USD"]): Promise<FxRow[]> {
  const now = new Date().getFullYear();
  const all: FxRow[] = [];
  for (let y = fromYear; y <= now; y++) {
    try {
      all.push(...(await fetchYearFx(y, currencies)));
    } catch (err) {
      console.warn(`[fx] rok ${y} selhal:`, (err as Error).message);
    }
  }
  return all;
}
