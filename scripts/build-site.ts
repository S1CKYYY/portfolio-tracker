/**
 * Sestavení statického webu pro GitHub Pages.
 *
 * Spouští se v GitHub Actions:
 *   1. odemkne ledger (leží v repozitáři zašifrovaný)
 *   2. dotáhne ceny a kurzy
 *   3. přepočítá celou historii a najde výkyvy
 *   4. výsledek zase zamkne a zapíše do docs/data.json
 *
 * Do repozitáře se NIKDY nezapisuje nic čitelného. Pages je veřejný web,
 * i když je repozitář privátní.
 *
 *   npx tsx scripts/build-site.ts
 *   PORTFOLIO_PASSPHRASE=... (z GitHub Secrets)
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { openJson, sealJson, type Vault } from "../lib/vault.ts";
import { checkPassphrase } from "../lib/passphrase.ts";
import { buildDailySeries, twr, twrAnnualized, maxDrawdown, xirr, xirrFlows, buildLots } from "../lib/portfolio/engine.ts";
import { explainMoves, type MarketEvent } from "../lib/portfolio/attribution.ts";
import { fetchDailyHistory } from "../lib/market/prices.ts";
import { backfillFx } from "../lib/market/fx.ts";
import type { FxMap, Instrument, PriceMap, Tx } from "../lib/portfolio/types.ts";

type Ledger = {
  transactions: Tx[];
  instruments: Array<Instrument & { category?: string }>;
  events?: MarketEvent[];
};

const PASS = process.env.PORTFOLIO_PASSPHRASE;
if (!PASS) {
  console.error("Chybí PORTFOLIO_PASSPHRASE. V Actions se bere z GitHub Secrets.");
  process.exit(1);
}

// Kontrola i tady: heslo v GitHub Secrets může být jiné než to,
// kterým se ledger zamykal.
const strength = checkPassphrase(PASS);
if (!strength.ok) {
  console.error(`✗ Heslo v PORTFOLIO_PASSPHRASE není dost silné: ${strength.problems.join(", ")}`);
  process.exit(1);
}

const LEDGER_PATH = "data/ledger.vault.json";
const OUT_DIR = "docs";

function fail(message: string): never {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}

// ---------------------------------------------------------------- 1. ledger
if (!existsSync(LEDGER_PATH)) fail(`Nenalezen ${LEDGER_PATH}. Vytvoř ho skriptem scripts/seal-ledger.ts.`);

let ledger: Ledger;
try {
  ledger = await openJson<Ledger>(JSON.parse(readFileSync(LEDGER_PATH, "utf8")) as Vault, PASS);
} catch (err) {
  fail(`Ledger nejde odemknout: ${(err as Error).message}`);
}
if (!ledger.transactions?.length) fail("Ledger je prázdný.");

const instruments = new Map<string, Instrument>(ledger.instruments.map((i) => [i.symbol, i]));
console.log(`ledger: ${ledger.transactions.length} transakcí, ${instruments.size} instrumentů`);

// ------------------------------------------------------------ 2. tržní data
const prices: PriceMap = new Map();
const priceProblems: string[] = [];
for (const inst of instruments.values()) {
  try {
    const bars = await fetchDailyHistory(inst.yahooSymbol, "5y");
    prices.set(inst.symbol, new Map(bars.map((b) => [b.d, b.close])));
    console.log(`  ${inst.symbol.padEnd(9)} ${bars.length} barů od ${bars[0]?.d ?? "?"}`);
  } catch (err) {
    priceProblems.push(`${inst.symbol}: ${(err as Error).message}`);
  }
}
if (priceProblems.length) {
  // Chybějící ceny znamenají neoceněné pozice a tím zkreslenou celou řadu.
  // Radši build spadne, než aby se publikovalo špatné číslo.
  fail(`Nepodařilo se stáhnout ceny:\n  ${priceProblems.join("\n  ")}`);
}

const fx: FxMap = new Map();
const fromYear = new Date(ledger.transactions.map((t) => t.occurredOn).sort()[0]).getFullYear();

// Výchozí zdroj je ČNB, protože jejími kurzy se počítá daňové přiznání.
// Přepnutí na tržní kurzy z Yahoo musí být vědomé rozhodnutí, ne tichý
// fallback při výpadku — jinak by se čísla měnila podle toho, co zrovna jelo.
const fxSource = process.env.FX_SOURCE ?? "cnb";
if (fxSource === "cnb") {
  for (const row of await backfillFx(fromYear)) {
    if (!fx.has(row.currency)) fx.set(row.currency, new Map());
    fx.get(row.currency)!.set(row.d, row.czkPerUnit);
  }
} else if (fxSource === "yahoo") {
  console.warn("  POZOR: kurzy z Yahoo, ne z ČNB — nepoužitelné jako daňový podklad");
  for (const [currency, symbol] of [["EUR", "EURCZK=X"], ["USD", "USDCZK=X"]]) {
    const bars = await fetchDailyHistory(symbol, "5y");
    fx.set(currency, new Map(bars.map((b) => [b.d, b.close])));
  }
} else {
  fail(`Neznámý FX_SOURCE: ${fxSource}`);
}

for (const c of ["EUR", "USD"]) {
  if (!fx.get(c)?.size) fail(`Chybí kurzy ${c} ze zdroje ${fxSource}.`);
}

// -------------------------------------------------------------- 3. výpočet
const raw = buildDailySeries({
  txs: ledger.transactions,
  instruments,
  prices,
  fx,
  from: ledger.transactions.map((t) => t.occurredOn).sort()[0],
});

// Řadu začínáme až tam, kde mají ceny všechny držené pozice.
const firstComplete = raw.findIndex((r) => r.valuationComplete);
if (firstComplete < 0) fail("Ani jeden den nemá kompletní ocenění.");
const rows = raw.slice(firstComplete);
const last = rows[rows.length - 1];

const gapDays = rows.filter((r) => !r.valuationComplete);
if (gapDays.length) {
  console.warn(`  pozor: ${gapDays.length} dní uvnitř řady nemá ceny na všechny pozice`);
}

const moves = explainMoves({ rows, instruments, events: ledger.events ?? [] });
const lots = buildLots(ledger.transactions);
if (lots.shortfalls.length) {
  console.warn(`  pozor: ${lots.shortfalls.length} prodejů bez krytí — ledger nesahá dost daleko`);
}

const payload = {
  generatedAt: new Date().toISOString(),
  metrics: {
    valueCzk: Math.round(last.marketValueCzk),
    investedCzk: Math.round(last.investedCzk),
    pnlCzk: Math.round(last.marketValueCzk - last.investedCzk),
    twrPct: +twr(rows).toFixed(2),
    twrAnnualizedPct: +twrAnnualized(rows).toFixed(2),
    xirrPct: +(xirr(xirrFlows(ledger.transactions, fx, last.marketValueCzk, last.d)) ?? 0).toFixed(2),
    maxDrawdown: { ...maxDrawdown(rows), pct: +maxDrawdown(rows).pct.toFixed(2) },
    fxEffectCzk: Math.round(rows.reduce((s, r) => s + r.fxEffectCzk, 0)),
    priceEffectCzk: Math.round(rows.reduce((s, r) => s + r.priceEffectCzk, 0)),
    fxSource,
    inceptionDate: rows[0].d,
    asOf: last.d,
    openLots: lots.open.length,
    skippedDays: firstComplete,
    dataGaps: gapDays.length,
  },
  series: rows.map((r) => [
    r.d,
    Math.round(r.marketValueCzk),
    Math.round(r.marketValueConstantFxCzk),
    Math.round(r.investedCzk),
    r.dayReturnPct != null ? +r.dayReturnPct.toFixed(3) : null,
  ]),
  positions: last.positions.map((p) => ({
    symbol: p.symbol,
    name: instruments.get(p.symbol)?.name ?? p.symbol,
    quantity: +p.quantity.toFixed(4),
    valueCzk: Math.round(p.valueCzk),
    weight: +(p.weight * 100).toFixed(1),
    currency: instruments.get(p.symbol)?.currency,
    price: +p.price.toFixed(2),
  })),
  moves: moves.map((m) => ({
    d: m.d,
    returnPct: +m.returnPct.toFixed(2),
    pnlCzk: Math.round(m.pnlCzk),
    zScore: m.zScore != null ? +m.zScore.toFixed(1) : null,
    classification: m.classification,
    priceSharePct: Math.round(m.priceSharePct),
    fxSharePct: Math.round(m.fxSharePct),
    benchmarkReturnPct: m.benchmarkReturnPct,
    drivers: m.drivers.map((d) => ({
      symbol: d.symbol,
      name: d.name,
      contributionCzk: Math.round(d.contributionCzk),
      ownReturnPct: d.ownReturnPct,
      shareOfMove: +d.shareOfMove.toFixed(2),
    })),
    events: m.events,
    summary: m.summary,
  })),
  liveChangePct: last.dayReturnPct ?? 0,
};

// --------------------------------------------------------------- 4. zamčení
mkdirSync(OUT_DIR, { recursive: true });
const vault = await sealJson(payload, PASS);

// Poslední pojistka: nic čitelného se nesmí dostat do výstupu.
const serialized = JSON.stringify(vault);
for (const probe of [...instruments.keys(), String(payload.metrics.valueCzk)]) {
  if (serialized.includes(probe)) fail(`Ve výstupu prosákl čitelný údaj: ${probe}`);
}

writeFileSync(`${OUT_DIR}/data.json`, serialized);

// Veřejně čitelná zůstane jen informace, kdy to naposled běželo.
writeFileSync(`${OUT_DIR}/status.json`, JSON.stringify({
  generatedAt: payload.generatedAt,
  days: payload.series.length,
  encrypted: true,
}));

console.log(`\n✓ ${OUT_DIR}/data.json — ${payload.series.length} dní, ${payload.moves.length} výkyvů, ${(serialized.length / 1024).toFixed(0)} kB zašifrovaně`);
console.log(`  hodnota a všechny detaily jsou uvnitř trezoru, ne v souboru`);
