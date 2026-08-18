/**
 * Finnhub — události k jednotlivým akciím.
 *
 * Doplňuje Yahoo (ceny) a ČNB (kurzy): odsud berem earnings, insider
 * transakce, filings a zprávy, tedy to, čím se dají odůvodnit výkyvy
 * označené jako „pozice“.
 *
 * ROZSAH POKRYTÍ: Finnhub je silný na US akcie. Evropské ETF listované
 * na Xetře (VUAA.DE, XNAS.DE…) tady insider ani earnings mít nebudou —
 * a nemají je mít, ETF nemá vedení ani výsledovku. Volá se proto jen
 * pro instrumenty s kind = 'stock'.
 *
 * KLÍČ: process.env.FINNHUB_API_KEY, nikdy v klientském kódu.
 */

const BASE = "https://finnhub.io/api/v1";

export type FinnhubErrorKind = "auth" | "premium" | "rate_limit" | "not_found" | "network" | "unknown";

export class FinnhubError extends Error {
  kind: FinnhubErrorKind;
  status: number | null;
  constructor(kind: FinnhubErrorKind, message: string, status: number | null = null) {
    super(message);
    this.name = "FinnhubError";
    this.kind = kind;
    this.status = status;
  }
}

/** Free tier má limit na počet volání za minutu — držíme se pod ním sami. */
class RateLimiter {
  private times: number[] = [];
  private max: number;
  private windowMs: number;
  constructor(max: number, windowMs: number) {
    this.max = max;
    this.windowMs = windowMs;
  }
  async take() {
    for (;;) {
      const now = Date.now();
      this.times = this.times.filter((t) => now - t < this.windowMs);
      if (this.times.length < this.max) {
        this.times.push(now);
        return;
      }
      await new Promise((r) => setTimeout(r, this.windowMs - (now - this.times[0]) + 50));
    }
  }
}

const limiter = new RateLimiter(50, 60_000);

async function call<T>(path: string, params: Record<string, string>): Promise<T> {
  const key = process.env.FINNHUB_API_KEY;
  if (!key) throw new FinnhubError("auth", "Chybí FINNHUB_API_KEY");

  await limiter.take();
  const url = `${BASE}${path}?${new URLSearchParams({ ...params, token: key })}`;

  let res: Response;
  try {
    res = await fetch(url, { headers: { Accept: "application/json" } });
  } catch (err) {
    throw new FinnhubError("network", (err as Error).message);
  }

  // Chyby rozlišujeme, protože každá znamená něco jiného: špatný klíč se
  // musí opravit hned, placený endpoint se má přeskočit, limit počkat.
  if (res.status === 401) throw new FinnhubError("auth", "Neplatný API klíč", 401);
  if (res.status === 403) throw new FinnhubError("premium", `Endpoint ${path} není v tomto tarifu`, 403);
  if (res.status === 429) throw new FinnhubError("rate_limit", "Překročen limit volání", 429);
  if (res.status === 404) throw new FinnhubError("not_found", `Nenalezeno: ${path}`, 404);
  if (!res.ok) throw new FinnhubError("unknown", `HTTP ${res.status} na ${path}`, res.status);

  return (await res.json()) as T;
}

const ymd = (d: Date) => d.toISOString().slice(0, 10);
const daysAgo = (n: number) => ymd(new Date(Date.now() - n * 86_400_000));

/* ------------------------------------------------------------------ *
 * Insider transakce
 * ------------------------------------------------------------------ */

/**
 * Kódy transakcí podle formuláře 4. Většina Form 4 je šum a tohle je
 * jediné místo, kde se šum odděluje od signálu:
 *   P — nákup na otevřeném trhu za vlastní peníze (jediný silný signál)
 *   S — prodej
 *   A — přidělení akcií (odměna, ne rozhodnutí)
 *   M — uplatnění opcí
 *   F — odvod akcií na daň při vestingu (automatické, nic neznamená)
 *   G — dar
 */
export const INSIDER_CODES: Record<string, { label: string; signal: "strong" | "weak" | "noise" }> = {
  P: { label: "nákup na trhu", signal: "strong" },
  S: { label: "prodej", signal: "weak" },
  A: { label: "přidělení akcií", signal: "noise" },
  M: { label: "uplatnění opcí", signal: "noise" },
  F: { label: "odvod na daň", signal: "noise" },
  G: { label: "dar", signal: "noise" },
  C: { label: "konverze", signal: "noise" },
  X: { label: "uplatnění opce", signal: "noise" },
};

export type InsiderTrade = {
  name: string; share: number; change: number;
  filingDate: string; transactionDate: string;
  transactionCode: string; transactionPrice: number;
};

export async function fetchInsiderTransactions(symbol: string, days = 180): Promise<InsiderTrade[]> {
  const data = await call<{ data?: InsiderTrade[] }>("/stock/insider-transactions", {
    symbol, from: daysAgo(days), to: ymd(new Date()),
  });
  return data.data ?? [];
}

export type InsiderCluster = {
  symbol: string;
  windowFrom: string; windowTo: string;
  buyers: string[]; trades: number;
  shares: number; valueUsd: number;
  strength: "silný" | "slabý";
};

/**
 * Klastr nákupů: víc insiderů nakupuje na otevřeném trhu v krátkém okně.
 * Jediný insider, který kupuje, je historka. Čtyři najednou je signál.
 * Prodeje se schválně neagregují — ty se dělají z tisíce důvodů.
 */
export function findInsiderClusters(symbol: string, trades: InsiderTrade[], windowDays = 30): InsiderCluster[] {
  const buys = trades
    .filter((t) => t.transactionCode?.toUpperCase() === "P" && t.change > 0)
    .sort((a, b) => a.transactionDate.localeCompare(b.transactionDate));
  if (buys.length === 0) return [];

  const clusters: InsiderCluster[] = [];
  let bucket: InsiderTrade[] = [];

  const flush = () => {
    const names = [...new Set(bucket.map((t) => t.name))];
    if (names.length >= 2) {
      clusters.push({
        symbol,
        windowFrom: bucket[0].transactionDate,
        windowTo: bucket[bucket.length - 1].transactionDate,
        buyers: names,
        trades: bucket.length,
        shares: bucket.reduce((s, t) => s + t.change, 0),
        valueUsd: bucket.reduce((s, t) => s + t.change * (t.transactionPrice || 0), 0),
        strength: names.length >= 3 ? "silný" : "slabý",
      });
    }
    bucket = [];
  };

  for (const t of buys) {
    if (bucket.length === 0) { bucket = [t]; continue; }
    const gap = (Date.parse(t.transactionDate) - Date.parse(bucket[0].transactionDate)) / 86_400_000;
    if (gap <= windowDays) bucket.push(t);
    else { flush(); bucket = [t]; }
  }
  flush();
  return clusters;
}

/* ------------------------------------------------------------------ *
 * Earnings, filings, zprávy
 * ------------------------------------------------------------------ */

export type EarningsRow = {
  symbol: string; date: string; hour: string;
  epsActual: number | null; epsEstimate: number | null;
  revenueActual: number | null; revenueEstimate: number | null;
};

export async function fetchEarnings(symbol: string, fromDays = 400, toDays = 120): Promise<EarningsRow[]> {
  const data = await call<{ earningsCalendar?: EarningsRow[] }>("/calendar/earnings", {
    symbol, from: daysAgo(fromDays), to: ymd(new Date(Date.now() + toDays * 86_400_000)),
  });
  return data.earningsCalendar ?? [];
}

export type Filing = { accessNumber: string; symbol: string; form: string; filedDate: string; acceptedDate: string; reportUrl: string; filingUrl: string };

export async function fetchFilings(symbol: string, days = 180): Promise<Filing[]> {
  return call<Filing[]>("/stock/filings", { symbol, from: daysAgo(days), to: ymd(new Date()) });
}

export type NewsItem = { id: number; datetime: number; headline: string; source: string; url: string; related: string };

export async function fetchCompanyNews(symbol: string, days = 14): Promise<NewsItem[]> {
  return call<NewsItem[]>("/company-news", { symbol, from: daysAgo(days), to: ymd(new Date()) });
}

/* ------------------------------------------------------------------ *
 * Převod na řádky do market_events
 * ------------------------------------------------------------------ */

export type EventRow = {
  d: string;
  kind: "earnings" | "filing" | "insider" | "news";
  headline: string;
  url: string | null;
  severity: number;
  payload: Record<string, unknown>;
};

const fmtUsd = (v: number) =>
  new Intl.NumberFormat("cs-CZ", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(v);

export function earningsToEvents(rows: EarningsRow[]): EventRow[] {
  return rows.filter((r) => r.date).map((r) => {
    const surprise = r.epsActual != null && r.epsEstimate
      ? ((r.epsActual - r.epsEstimate) / Math.abs(r.epsEstimate)) * 100
      : null;
    const headline = r.epsActual == null
      ? "Očekávané výsledky"
      : `Výsledky: EPS ${r.epsActual}${r.epsEstimate != null ? ` vs. odhad ${r.epsEstimate}` : ""}` +
        (surprise != null ? ` (${surprise >= 0 ? "+" : ""}${surprise.toFixed(1)} %)` : "");
    return {
      d: r.date, kind: "earnings", headline, url: null,
      // Velké překvapení je pravděpodobnější příčina výkyvu než plánovaný termín.
      severity: surprise != null && Math.abs(surprise) > 10 ? 3 : r.epsActual != null ? 2 : 1,
      payload: { ...r, surprisePct: surprise },
    };
  });
}

/** Formuláře, které stojí za pozornost. Zbytek je administrativa. */
const FORM_SEVERITY: Record<string, number> = { "8-K": 3, "10-Q": 2, "10-K": 2, "S-1": 3, "S-3": 2, "SC 13D": 3, "DEF 14A": 1 };

export function filingsToEvents(filings: Filing[]): EventRow[] {
  return filings
    .filter((f) => FORM_SEVERITY[f.form] != null)
    .map((f) => ({
      d: (f.filedDate ?? "").slice(0, 10),
      kind: "filing" as const,
      headline: `Podán formulář ${f.form}`,
      url: f.filingUrl || f.reportUrl || null,
      severity: FORM_SEVERITY[f.form],
      payload: { form: f.form, accessNumber: f.accessNumber },
    }))
    .filter((e) => e.d);
}

export function insiderToEvents(symbol: string, trades: InsiderTrade[]): EventRow[] {
  const events: EventRow[] = [];

  for (const c of findInsiderClusters(symbol, trades)) {
    events.push({
      d: c.windowTo,
      kind: "insider",
      headline: `${c.buyers.length} insiderů nakupovalo na trhu — ${c.shares.toLocaleString("cs-CZ")} ks` +
                (c.valueUsd ? ` za ${fmtUsd(c.valueUsd)}` : ""),
      url: null,
      severity: c.strength === "silný" ? 3 : 2,
      payload: { buyers: c.buyers, trades: c.trades, shares: c.shares, valueUsd: c.valueUsd, from: c.windowFrom },
    });
  }

  // Jednotlivý velký nákup na trhu stojí za zmínku i bez klastru.
  for (const t of trades) {
    if (t.transactionCode?.toUpperCase() !== "P" || t.change <= 0) continue;
    const value = t.change * (t.transactionPrice || 0);
    if (value < 250_000) continue;
    events.push({
      d: t.transactionDate,
      kind: "insider",
      headline: `${t.name} koupil ${t.change.toLocaleString("cs-CZ")} ks za ${fmtUsd(value)}`,
      url: null,
      severity: 2,
      payload: { name: t.name, code: t.transactionCode, price: t.transactionPrice, filingDate: t.filingDate },
    });
  }

  return events;
}

export function newsToEvents(news: NewsItem[], limitPerDay = 3): EventRow[] {
  const byDay = new Map<string, NewsItem[]>();
  for (const n of news) {
    const d = new Date(n.datetime * 1000).toISOString().slice(0, 10);
    byDay.set(d, [...(byDay.get(d) ?? []), n]);
  }
  const out: EventRow[] = [];
  for (const [d, items] of byDay) {
    for (const n of items.slice(0, limitPerDay)) {
      out.push({
        d, kind: "news",
        headline: n.headline,          // jen titulek a odkaz, obsah článku se nekopíruje
        url: n.url || null,
        severity: 1,
        payload: { source: n.source, id: n.id },
      });
    }
  }
  return out;
}
