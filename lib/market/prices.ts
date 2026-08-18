/**
 * Ceny z Yahoo Finance (neoficiální, ale pro EU ETF i US akcie funguje a je zdarma).
 * Až to začne zlobit nebo bude potřeba komerční licence, vyměň jen tenhle soubor
 * za EODHD/FMP — zbytek aplikace o zdroji neví.
 */

const CHART = "https://query1.finance.yahoo.com/v8/finance/chart";
const UA = "Mozilla/5.0 (compatible; portfolio-tracker/1.0)";

export type DailyBar = { d: string; close: number; adjClose: number | null; volume: number | null };

export type Quote = {
  symbol: string;
  price: number;
  previousClose: number | null;
  changePct: number | null;
  currency: string;
  marketState: string | null;
  asOf: string;         // ISO timestamp
};

const iso = (ts: number) => new Date(ts * 1000).toISOString().slice(0, 10);

async function chart(symbol: string, params: Record<string, string>) {
  const url = `${CHART}/${encodeURIComponent(symbol)}?${new URLSearchParams(params)}`;
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
  if (!res.ok) throw new Error(`Yahoo ${symbol}: HTTP ${res.status}`);
  const json = (await res.json()) as any;
  const result = json?.chart?.result?.[0];
  if (!result) throw new Error(`Yahoo ${symbol}: prázdná odpověď (${json?.chart?.error?.description ?? "?"})`);
  return result;
}

/** Denní historie. `range` např. '1y', '5y', 'max'. */
export async function fetchDailyHistory(yahooSymbol: string, range = "5y"): Promise<DailyBar[]> {
  const result = await chart(yahooSymbol, { range, interval: "1d", events: "div,split" });
  const stamps: number[] = result.timestamp ?? [];
  const quote = result.indicators?.quote?.[0] ?? {};
  const adj = result.indicators?.adjclose?.[0]?.adjclose ?? [];

  const bars: DailyBar[] = [];
  for (let i = 0; i < stamps.length; i++) {
    const close = quote.close?.[i];
    if (close == null) continue;                 // Yahoo posílá null pro dny bez obchodování
    bars.push({
      d: iso(stamps[i]),
      close,
      adjClose: adj[i] ?? null,
      volume: quote.volume?.[i] ?? null,
    });
  }
  return bars;
}

/**
 * Předchozí zavírací cena ze série barů.
 *
 * NEPOUŽÍVAT `meta.chartPreviousClose` — to je close PŘED začátkem
 * vyžádaného okna, tedy u range=5d cena stará šest seancí. Denní změna
 * z něj vychází několikanásobně přehnaná.
 */
export function derivePreviousClose(
  bars: Array<{ d: string; close: number }>,
  asOfDate: string,
): number | null {
  const clean = bars.filter((b) => Number.isFinite(b.close));
  if (clean.length === 0) return null;
  const last = clean[clean.length - 1];
  // Poslední bar je dnešní (probíhající) seance -> předchozí close je ten před ním.
  // Mimo obchodní dny je poslední bar už uzavřený a sám je tou předchozí cenou.
  if (last.d === asOfDate) return clean.length >= 2 ? clean[clean.length - 2].close : null;
  return last.close;
}

/** Aktuální kotace. Mimo burzovní seanci vrací poslední close. */
export async function fetchQuote(yahooSymbol: string): Promise<Quote> {
  const result = await chart(yahooSymbol, { range: "5d", interval: "1d" });
  const meta = result.meta ?? {};
  const price = meta.regularMarketPrice;

  const stamps: number[] = result.timestamp ?? [];
  const closes = result.indicators?.quote?.[0]?.close ?? [];
  const bars = stamps
    .map((t, i) => ({ d: iso(t), close: closes[i] }))
    .filter((b) => b.close != null) as Array<{ d: string; close: number }>;

  const asOf = meta.regularMarketTime
    ? new Date(meta.regularMarketTime * 1000).toISOString()
    : new Date().toISOString();
  const prev = derivePreviousClose(bars, asOf.slice(0, 10));

  return {
    symbol: meta.symbol ?? yahooSymbol,
    price,
    previousClose: prev,
    changePct: prev ? (price / prev - 1) * 100 : null,
    currency: meta.currency ?? "USD",
    marketState: meta.marketState ?? null,
    asOf,
  };
}

/** Kotace pro víc symbolů. Omezená paralelita, ať se Yahoo nenaštve. */
export async function fetchQuotes(symbols: string[], concurrency = 4): Promise<Map<string, Quote>> {
  const out = new Map<string, Quote>();
  const queue = [...symbols];
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length) {
      const symbol = queue.shift();
      if (!symbol) break;
      try {
        out.set(symbol, await fetchQuote(symbol));
      } catch (err) {
        console.warn(`[prices] ${symbol} selhalo:`, (err as Error).message);
      }
    }
  });
  await Promise.all(workers);
  return out;
}
