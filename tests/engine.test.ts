import test from "node:test";
import assert from "node:assert/strict";
import { buildDailySeries, buildLots, quantitiesOn, twr, xirr, xirrFlows, maxDrawdown, lastKnown } from "../lib/portfolio/engine.ts";
import { explainMoves } from "../lib/portfolio/attribution.ts";
import type { FxMap, Instrument, PriceMap, Tx } from "../lib/portfolio/types.ts";

const instruments = new Map<string, Instrument>([
  ["MSFT.US", { symbol: "MSFT.US", yahooSymbol: "MSFT", name: "Microsoft", currency: "USD", kind: "stock" }],
  ["VUAA.DE", { symbol: "VUAA.DE", yahooSymbol: "VUAA.DE", name: "S&P 500", currency: "EUR", kind: "etf", isBenchmark: true }],
]);

function series(entries: Array<[string, number]>) {
  return new Map(entries);
}

test("lastKnown přenáší poslední cenu přes víkend", () => {
  const s = series([["2026-01-02", 100], ["2026-01-05", 102]]);
  assert.equal(lastKnown(s, "2026-01-03"), 100); // sobota
  assert.equal(lastKnown(s, "2026-01-04"), 100); // neděle
  assert.equal(lastKnown(s, "2026-01-05"), 102);
});

test("FIFO loty počítají realizovaný zisk a dobu držení", () => {
  const txs: Tx[] = [
    { occurredOn: "2023-01-10", type: "buy", symbol: "MSFT.US", quantity: 10, price: 200, amount: -2000, accountCurrency: "USD" },
    { occurredOn: "2024-06-01", type: "buy", symbol: "MSFT.US", quantity: 10, price: 300, amount: -3000, accountCurrency: "USD" },
    { occurredOn: "2026-02-01", type: "sell", symbol: "MSFT.US", quantity: 15, price: 400, amount: 6000, accountCurrency: "USD" },
  ];
  const { open, realized } = buildLots(txs);

  assert.equal(realized.length, 2);
  assert.equal(realized[0].cost, 10 * 200);            // nejdřív nejstarší lot
  assert.equal(realized[1].cost, 5 * 300);
  assert.ok(realized[0].heldDays > 1095, "první lot prošel tříletým testem");
  assert.ok(realized[1].heldDays < 1095, "druhý lot ne");
  assert.equal(open.reduce((s, l) => s + l.quantity, 0), 5);
});

test("split přepočítá kusy i cost basis", () => {
  const txs: Tx[] = [
    { occurredOn: "2024-01-02", type: "buy", symbol: "MSFT.US", quantity: 10, price: 100, amount: -1000, accountCurrency: "USD" },
    { occurredOn: "2025-01-02", type: "split", symbol: "MSFT.US", quantity: 2, amount: 0, accountCurrency: "USD" },
  ];
  const { open } = buildLots(txs);
  assert.equal(open[0].quantity, 20);
  assert.equal(open[0].costPerUnit, 50);
  assert.equal(quantitiesOn(txs, "2025-06-01").get("MSFT.US"), 20);
});

test("denní řada odděluje cenový a měnový efekt", () => {
  const txs: Tx[] = [
    { occurredOn: "2026-01-01", type: "buy", symbol: "MSFT.US", quantity: 10, price: 100, amount: -1000, accountCurrency: "USD" },
  ];
  const prices: PriceMap = new Map([["MSFT.US", series([
    ["2026-01-01", 100], ["2026-01-02", 110], ["2026-01-03", 110],
  ])]]);
  const fx: FxMap = new Map([["USD", series([
    ["2026-01-01", 20], ["2026-01-02", 20], ["2026-01-03", 22],
  ])]]);

  const rows = buildDailySeries({ txs, instruments, prices, fx, from: "2026-01-01", to: "2026-01-03" });

  // den 2: cena +10 USD × 10 ks × kurz 20 = +2000 CZK, kurz beze změny
  assert.equal(Math.round(rows[1].priceEffectCzk), 2000);
  assert.equal(Math.round(rows[1].fxEffectCzk), 0);

  // den 3: cena stojí, kurz +2 CZK × 10 ks × 110 USD = +2200 CZK
  assert.equal(Math.round(rows[2].priceEffectCzk), 0);
  assert.equal(Math.round(rows[2].fxEffectCzk), 2200);
  assert.equal(Math.round(rows[2].marketValueCzk), 24_200);
});

test("dokup v průběhu dne se nepočítá jako výnos", () => {
  const txs: Tx[] = [
    { occurredOn: "2026-01-01", type: "buy", symbol: "MSFT.US", quantity: 10, price: 100, amount: -1000, accountCurrency: "USD" },
    { occurredOn: "2026-01-02", type: "buy", symbol: "MSFT.US", quantity: 10, price: 100, amount: -1000, accountCurrency: "USD" },
  ];
  const prices: PriceMap = new Map([["MSFT.US", series([["2026-01-01", 100], ["2026-01-02", 100]])]]);
  const fx: FxMap = new Map([["USD", series([["2026-01-01", 20], ["2026-01-02", 20]])]]);

  const rows = buildDailySeries({ txs, instruments, prices, fx, from: "2026-01-01", to: "2026-01-02" });
  assert.equal(Math.round(rows[1].marketValueCzk), 40_000);
  assert.equal(Math.round(rows[1].dayPnlCzk), 0);          // hodnota vzrostla, výnos ne
  assert.equal(Math.round(rows[1].dayReturnPct ?? -1), 0);
  assert.equal(Math.round(rows[1].netFlowCzk), 20_000);
});

test("TWR ignoruje načasování vkladů, XIRR ne", () => {
  const txs: Tx[] = [
    { occurredOn: "2026-01-01", type: "buy", symbol: "MSFT.US", quantity: 1, price: 100, amount: -100, accountCurrency: "USD" },
    { occurredOn: "2026-01-02", type: "buy", symbol: "MSFT.US", quantity: 99, price: 100, amount: -9900, accountCurrency: "USD" },
  ];
  const prices: PriceMap = new Map([["MSFT.US", series([
    ["2026-01-01", 100], ["2026-01-02", 100], ["2026-01-03", 110],
  ])]]);
  const fx: FxMap = new Map([["USD", series([["2026-01-01", 20], ["2026-01-02", 20], ["2026-01-03", 20]])]]);

  const rows = buildDailySeries({ txs, instruments, prices, fx, from: "2026-01-01", to: "2026-01-03" });
  assert.ok(Math.abs(twr(rows) - 10) < 0.01, `TWR má být 10 %, je ${twr(rows)}`);

  const end = rows[rows.length - 1];
  const rate = xirr(xirrFlows(txs, fx, end.marketValueCzk, end.d));
  assert.equal(rate, null, "dvoudenní XIRR se nesmí anualizovat — vrací null");
});

test("XIRR na roční periodě sedí", () => {
  const rate = xirr([
    { date: "2024-01-01", amount: -1000 },
    { date: "2025-01-01", amount: 1100 },
  ]);
  assert.ok(rate != null && Math.abs(rate - 10) < 0.5, `čekáno ~10 %, je ${rate}`);
});

test("XIRR zvládne nepravidelné dokupy", () => {
  const rate = xirr([
    { date: "2023-01-01", amount: -10_000 },
    { date: "2023-07-01", amount: -5_000 },
    { date: "2024-03-01", amount: 2_000 },
    { date: "2026-01-01", amount: 18_000 },
  ]);
  assert.ok(rate != null && rate > 0 && rate < 50, `nerealistická sazba: ${rate}`);
});

test("výkyv se klasifikuje jako plošný, specifický nebo kurzový", () => {
  const txs: Tx[] = [
    { occurredOn: "2025-12-01", type: "buy", symbol: "MSFT.US", quantity: 10, price: 100, amount: -1000, accountCurrency: "USD" },
    { occurredOn: "2025-12-01", type: "buy", symbol: "VUAA.DE", quantity: 10, price: 100, amount: -1000, accountCurrency: "EUR" },
  ];

  const days: string[] = [];
  const d = new Date("2025-12-01T00:00:00Z");
  for (let i = 0; i < 90; i++) { days.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() + 1); }

  // klidné pozadí + tři různé šoky na konci
  const msft = new Map<string, number>();
  const vuaa = new Map<string, number>();
  const usd = new Map<string, number>();
  const eur = new Map<string, number>();
  days.forEach((day, i) => {
    msft.set(day, 100 + Math.sin(i) * 0.3);
    vuaa.set(day, 100 + Math.cos(i) * 0.3);
    usd.set(day, 21);
    eur.set(day, 24);
  });
  const shockSpecific = days[86];
  const shockMarket = days[87];
  const shockFx = days[88];
  msft.set(shockSpecific, 80);                           // jen MSFT -20 %
  msft.set(shockMarket, 76); vuaa.set(shockMarket, 95);  // obojí dolů ~5 %
  msft.set(shockFx, 76); vuaa.set(shockFx, 95);          // ceny stojí
  usd.set(shockFx, 23.5); eur.set(shockFx, 26.5);  // jen kurz nahoru

  const rows = buildDailySeries({
    txs, instruments,
    prices: new Map([["MSFT.US", msft], ["VUAA.DE", vuaa]]),
    fx: new Map([["USD", usd], ["EUR", eur]]),
    from: days[0], to: days[days.length - 1],
  });

  const moves = explainMoves({ rows, instruments, events: [] });
  const byDate = new Map(moves.map((m) => [m.d, m]));

  assert.equal(byDate.get(shockSpecific)?.classification, "specific");
  assert.equal(byDate.get(shockSpecific)?.drivers[0].symbol, "MSFT.US");
  assert.equal(byDate.get(shockMarket)?.classification, "market");
  assert.equal(byDate.get(shockFx)?.classification, "fx");
  assert.match(byDate.get(shockFx)?.summary ?? "", /kurz koruny/);
});

test("max drawdown najde nejhlubší propad", () => {
  const rows = [
    { d: "2026-01-01", twrIndex: 1.0 }, { d: "2026-01-02", twrIndex: 1.2 },
    { d: "2026-01-03", twrIndex: 0.9 }, { d: "2026-01-04", twrIndex: 1.1 },
  ] as any;
  const dd = maxDrawdown(rows);
  assert.ok(Math.abs(dd.pct + 25) < 0.001, `čekáno -25 %, je ${dd.pct}`);
  assert.equal(dd.from, "2026-01-02");
  assert.equal(dd.to, "2026-01-03");
});

import { derivePreviousClose } from "../lib/market/prices.ts";

test("předchozí close se bere ze série, ne z chartPreviousClose", () => {
  const bars = [
    { d: "2026-08-11", close: 516.38 }, { d: "2026-08-12", close: 510 },
    { d: "2026-08-13", close: 506.93 }, { d: "2026-08-14", close: 504.03 },
    { d: "2026-08-17", close: 498.23 },
  ];
  // Během seance je poslední bar dnešní -> předchozí close je včerejšek.
  assert.equal(derivePreviousClose(bars, "2026-08-17"), 504.03);
  // Mimo seanci je poslední bar už uzavřený a sám je referencí.
  assert.equal(derivePreviousClose(bars, "2026-08-18"), 498.23);
  // Yahoo posílá u některých dní null -> nesmí se z toho stát nula.
  assert.equal(derivePreviousClose([{ d: "2026-08-17", close: 498.23 }], "2026-08-17"), null);
  assert.equal(derivePreviousClose([], "2026-08-17"), null);
});
