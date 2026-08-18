import type { DayRow, Instrument } from "./types";

export type Driver = {
  symbol: string;
  name: string;
  contributionCzk: number;      // příspěvek k celkovému pohybu v CZK
  contributionPct: number;      // v procentních bodech výnosu portfolia
  ownReturnPct: number | null;  // jak se hnula samotná pozice
  weight: number;
  shareOfMove: number;          // podíl na absolutní velikosti pohybu (0-1)
};

export type MarketEvent = {
  symbol: string | null;
  d: string;
  kind: "earnings" | "filing" | "insider" | "dividend" | "news" | "macro" | "split";
  headline: string;
  url?: string;
  severity?: number;
};

export type MoveExplanation = {
  d: string;
  returnPct: number;
  pnlCzk: number;
  zScore: number | null;
  classification: "market" | "specific" | "fx" | "flow" | "mixed";
  priceSharePct: number;        // kolik z pohybu udělal pohyb cen
  fxSharePct: number;           // kolik udělal kurz
  benchmarkReturnPct: number | null;
  excessVsBenchmarkPct: number | null;
  breadth: number;              // podíl pozic, které šly stejným směrem (0-1)
  drivers: Driver[];
  events: MarketEvent[];
  summary: string;              // deterministické shrnutí, LLM ho může jen rozvést
};

/** Klouzavá směrodatná odchylka denních výnosů — základ pro "co je ještě normální". */
function rollingStd(values: Array<number | null>, index: number, window = 60): number | null {
  const slice = values.slice(Math.max(0, index - window), index).filter((v): v is number => v != null);
  if (slice.length < 15) return null;
  const mean = slice.reduce((s, v) => s + v, 0) / slice.length;
  const variance = slice.reduce((s, v) => s + (v - mean) ** 2, 0) / (slice.length - 1);
  return Math.sqrt(variance);
}

const fmtCzk = (v: number) =>
  new Intl.NumberFormat("cs-CZ", { style: "currency", currency: "CZK", maximumFractionDigits: 0 }).format(v);
const fmtPct = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(2).replace(".", ",")} %`;

export type ExplainOptions = {
  rows: DayRow[];
  instruments: Map<string, Instrument>;
  events?: MarketEvent[];
  /** Práh v násobcích směrodatné odchylky, od kterého je den "výkyv". */
  zThreshold?: number;
  /** Absolutní práh v %, aby se chytly i velké dny v klidném období. */
  absThreshold?: number;
  /** Symbol benchmarku pro rozlišení "trh vs. moje pozice". */
  benchmarkSymbol?: string;
};

/**
 * Najde dny, které se vymykají, a ke každému vyrobí odůvodnění.
 * Vše deterministicky z dat — LLM se pouští až nad hotovým rozkladem,
 * aby nemohl vymyslet čísla.
 */
export function explainMoves(opts: ExplainOptions): MoveExplanation[] {
  const { rows, instruments } = opts;
  const zThreshold = opts.zThreshold ?? 2;
  const absThreshold = opts.absThreshold ?? 1.5;
  const benchmark = opts.benchmarkSymbol
    ?? [...instruments.values()].find((i) => i.isBenchmark)?.symbol
    ?? null;

  const returns = rows.map((r) => r.dayReturnPct);
  const out: MoveExplanation[] = [];

  rows.forEach((row, i) => {
    const ret = row.dayReturnPct;
    if (ret == null || i === 0) return;

    const sd = rollingStd(returns, i);
    const z = sd && sd > 0 ? ret / sd : null;
    const isOutlier = (z != null && Math.abs(z) >= zThreshold) || Math.abs(ret) >= absThreshold;
    if (!isOutlier) return;

    // Den, kdy se objevila nebo zmizela cena, není výkyv trhu, ale díra v datech.
    const gapAppeared = !row.valuationComplete || !rows[i - 1].valuationComplete;
    if (gapAppeared) {
      out.push({
        d: row.d, returnPct: ret, pnlCzk: row.dayPnlCzk, zScore: z,
        classification: "mixed", priceSharePct: 0, fxSharePct: 0,
        benchmarkReturnPct: null, excessVsBenchmarkPct: null, breadth: 0,
        drivers: [], events: [],
        summary: `Pozor: v tento den chybí ceny pro ${row.missing.join(", ") || "část pozic"}. ` +
          `Skok o ${fmtPct(ret)} je artefakt dat, ne pohyb trhu — dokud se cena nedoplní, tenhle den neinterpretuj.`,
      });
      return;
    }

    const prevValue = rows[i - 1].marketValueCzk;
    const totalAbs = row.positions.reduce((s, p) => s + Math.abs(p.dayPnlCzk), 0) || 1;

    const drivers: Driver[] = row.positions
      .filter((p) => Math.abs(p.dayPnlCzk) > 0)
      .map((p) => ({
        symbol: p.symbol,
        name: instruments.get(p.symbol)?.name ?? p.symbol,
        contributionCzk: p.dayPnlCzk,
        contributionPct: prevValue > 0 ? (p.dayPnlCzk / prevValue) * 100 : 0,
        ownReturnPct: p.dayReturnPct,
        weight: p.weight,
        shareOfMove: Math.abs(p.dayPnlCzk) / totalAbs,
      }))
      .sort((a, b) => Math.abs(b.contributionCzk) - Math.abs(a.contributionCzk));

    const totalEffect = Math.abs(row.priceEffectCzk) + Math.abs(row.fxEffectCzk) || 1;
    const priceShare = (Math.abs(row.priceEffectCzk) / totalEffect) * 100;
    const fxShare = (Math.abs(row.fxEffectCzk) / totalEffect) * 100;

    const benchPos = benchmark ? row.positions.find((p) => p.symbol === benchmark) : undefined;
    const benchReturn = benchPos?.dayReturnPct ?? null;

    const sameDirection = row.positions.filter(
      (p) => p.dayReturnPct != null && Math.sign(p.dayReturnPct) === Math.sign(ret),
    ).length;
    const breadth = row.positions.length ? sameDirection / row.positions.length : 0;

    // --- klasifikace: co ten den doopravdy hnulo -----------------------------
    // "Trh" znamená: šly stejným směrem skoro všechny pozice A benchmark
    // vysvětluje aspoň polovinu velikosti pohybu. Bez druhé podmínky by se
    // jako "plošné" označilo i to, když portfolio udělá trojnásobek indexu.
    const benchExplains =
      benchReturn != null && Math.abs(ret) > 0
        ? Math.min(Math.abs(benchReturn) / Math.abs(ret), 1)
        : null;

    let classification: MoveExplanation["classification"] = "mixed";
    if (fxShare > 60) classification = "fx";
    else if (Math.abs(row.netFlowCzk) > Math.abs(row.dayPnlCzk) * 2 && Math.abs(row.netFlowCzk) > 0) classification = "flow";
    else if (breadth >= 0.7 && (benchExplains == null || benchExplains >= 0.5)) classification = "market";
    else if (drivers[0] && drivers[0].shareOfMove >= 0.5) classification = "specific";
    else if (drivers[0] && drivers[0].shareOfMove >= 0.35 && breadth < 0.7) classification = "specific";

    const dayEvents = (opts.events ?? []).filter((e) => {
      const gap = Math.abs(Date.parse(`${e.d}T00:00:00Z`) - Date.parse(`${row.d}T00:00:00Z`)) / 86_400_000;
      if (gap > 1) return false;
      return e.symbol == null || drivers.slice(0, 4).some((dr) => dr.symbol === e.symbol);
    });

    out.push({
      d: row.d,
      returnPct: ret,
      pnlCzk: row.dayPnlCzk,
      zScore: z,
      classification,
      priceSharePct: priceShare,
      fxSharePct: fxShare,
      benchmarkReturnPct: benchReturn,
      excessVsBenchmarkPct: benchReturn != null ? ret - benchReturn : null,
      breadth,
      drivers: drivers.slice(0, 5),
      events: dayEvents,
      summary: buildSummary({ row, ret, z, classification, drivers, fxShare, benchReturn, breadth, events: dayEvents }),
    });
  });

  return out.sort((a, b) => b.d.localeCompare(a.d));
}

function buildSummary(args: {
  row: DayRow;
  ret: number;
  z: number | null;
  classification: MoveExplanation["classification"];
  drivers: Driver[];
  fxShare: number;
  benchReturn: number | null;
  breadth: number;
  events: MarketEvent[];
}): string {
  const { row, ret, z, classification, drivers, fxShare, benchReturn, breadth, events } = args;
  const parts: string[] = [];

  parts.push(
    `Portfolio ${ret >= 0 ? "posílilo" : "oslabilo"} o ${fmtPct(ret)} (${fmtCzk(row.dayPnlCzk)})` +
      (z != null ? `, což je ${Math.abs(z).toFixed(1)}× běžná denní odchylka.` : "."),
  );

  if (classification === "market") {
    parts.push(
      `Šlo o plošný pohyb — stejným směrem se hnulo ${Math.round(breadth * 100)} % pozic` +
        (benchReturn != null ? `, benchmark ${fmtPct(benchReturn)}` : "") +
        `. Nehledej příčinu u jedné firmy.`,
    );
  } else if (classification === "specific" && drivers[0]) {
    parts.push(
      `Pohyb je z ${Math.round(drivers[0].shareOfMove * 100)} % způsoben jedinou pozicí: ` +
        `${drivers[0].name} ${drivers[0].ownReturnPct != null ? fmtPct(drivers[0].ownReturnPct) : ""} ` +
        `(${fmtCzk(drivers[0].contributionCzk)}, ${fmtPct(drivers[0].contributionPct)} na úrovni portfolia).`,
    );
  } else if (classification === "fx") {
    parts.push(
      `Pozor: ${Math.round(fxShare)} % pohybu nedělaly ceny akcií, ale kurz koruny ` +
        `(${fmtCzk(row.fxEffectCzk)}). V měně instrumentů se skoro nic nestalo.`,
    );
  } else if (classification === "flow") {
    parts.push(`Většinu změny hodnoty tvoří vklad/výběr (${fmtCzk(row.netFlowCzk)}), ne výnos.`);
  } else if (drivers.length) {
    const top = drivers.slice(0, 3).map((d) => `${d.symbol} ${fmtCzk(d.contributionCzk)}`).join(", ");
    parts.push(`Nejvíc přispěly: ${top}.`);
    if (benchReturn != null) {
      parts.push(
        `Benchmark ${fmtPct(benchReturn)}, takže ${fmtPct(ret - benchReturn)} jde nad rámec trhu — ` +
          `část pohybu je specifická pro tvoje pozice.`,
      );
    }
  }

  if (Math.abs(row.fxEffectCzk) > Math.abs(row.dayPnlCzk) * 0.25 && classification !== "fx") {
    parts.push(`Z toho ${fmtCzk(row.fxEffectCzk)} je čistě kurzový efekt.`);
  }

  if (events.length) {
    parts.push(`Události k tomuto dni: ${events.map((e) => e.headline).join(" · ")}.`);
  } else if (classification === "specific") {
    parts.push(`K tomuto dni zatím nemám žádnou událost — stojí za dohledání.`);
  }

  return parts.join(" ");
}

/**
 * Podklad pro LLM. Posílá se JEN tohle — spočítaná čísla, žádné volné pole
 * k dovyprávění. Model má za úkol interpretovat, ne dopočítávat.
 */
export function toLlmContext(move: MoveExplanation) {
  return {
    datum: move.d,
    vynos_pct: Number(move.returnPct.toFixed(3)),
    pnl_czk: Math.round(move.pnlCzk),
    nasobek_bezne_odchylky: move.zScore != null ? Number(move.zScore.toFixed(2)) : null,
    klasifikace: move.classification,
    podil_cena_pct: Math.round(move.priceSharePct),
    podil_kurz_pct: Math.round(move.fxSharePct),
    benchmark_pct: move.benchmarkReturnPct,
    sirka_pohybu: Number(move.breadth.toFixed(2)),
    hybatele: move.drivers.map((d) => ({
      ticker: d.symbol,
      nazev: d.name,
      vlastni_pohyb_pct: d.ownReturnPct,
      prispevek_czk: Math.round(d.contributionCzk),
      podil_na_pohybu: Number(d.shareOfMove.toFixed(2)),
    })),
    udalosti: move.events.map((e) => ({ druh: e.kind, titulek: e.headline, url: e.url })),
    instrukce:
      "Vysvětli tento pohyb portfolia 2-3 větami česky. Používej VÝHRADNĚ čísla uvedená výše, " +
      "nedopočítávej ani neodhaduj. Pokud k pohybu nejsou události, napiš to otevřeně místo spekulace.",
  };
}
