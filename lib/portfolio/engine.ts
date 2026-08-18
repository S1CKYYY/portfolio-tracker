import type { DayRow, FxMap, Instrument, Lot, PositionRow, PriceMap, Tx } from "./types";

/* ------------------------------------------------------------------ *
 * Pomocné funkce nad datumy a řadami
 * ------------------------------------------------------------------ */

export const iso = (d: Date): string => d.toISOString().slice(0, 10);

export function eachDay(from: string, to: string): string[] {
  const out: string[] = [];
  const cur = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (cur <= end) {
    out.push(iso(cur));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

/**
 * Poslední známá hodnota k datu (carry-forward).
 * Nutné: burzy nemají víkendy a svátky, ČNB taky ne. Bez tohohle
 * se portfolio v sobotu "propadne na nulu".
 */
export function lastKnown(series: Map<string, number> | undefined, d: string, maxBackDays = 10): number | null {
  if (!series) return null;
  const cur = new Date(`${d}T00:00:00Z`);
  for (let i = 0; i <= maxBackDays; i++) {
    const key = iso(cur);
    const v = series.get(key);
    if (v != null) return v;
    cur.setUTCDate(cur.getUTCDate() - 1);
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * FIFO loty — potřeba pro cost basis, daňový časový test a realizovaný zisk
 * ------------------------------------------------------------------ */

/** Chronologické řazení. Kde je k dispozici čas, rozhoduje čas — jinak by se
 *  nákup a prodej ve stejném dni seřadily podle pořadí ve výpisu, které je
 *  u XTB obrácené. */
export const byTime = (a: Tx, b: Tx) =>
  (a.occurredAt ?? `${a.occurredOn}T00:00:00.000Z`).localeCompare(b.occurredAt ?? `${b.occurredOn}T00:00:00.000Z`);

export function buildLots(txs: Tx[]): {
  open: Lot[];
  realized: Array<{ symbol: string; closedOn: string; quantity: number; proceeds: number; cost: number; heldDays: number }>;
  shortfalls: Array<{ symbol: string; closedOn: string; quantity: number }>;
} {
  const open: Lot[] = [];
  const realized: Array<{ symbol: string; closedOn: string; quantity: number; proceeds: number; cost: number; heldDays: number }> = [];
  const shortfalls: Array<{ symbol: string; closedOn: string; quantity: number }> = [];
  const sorted = [...txs].sort(byTime);

  for (const tx of sorted) {
    if (!tx.symbol || !tx.quantity) continue;

    if (tx.type === "buy") {
      const gross = Math.abs(tx.amount);
      open.push({
        symbol: tx.symbol,
        openedOn: tx.occurredOn,
        quantity: tx.quantity,
        costPerUnit: tx.price ?? gross / tx.quantity,
        currency: tx.accountCurrency,
      });
    }

    if (tx.type === "sell") {
      let remaining = tx.quantity;
      const unitProceeds = tx.price ?? Math.abs(tx.amount) / tx.quantity;
      while (remaining > 1e-9) {
        const lot = open.find((l) => l.symbol === tx.symbol && l.quantity > 1e-9);
        if (!lot) {
          // Prodej bez krytí = neúplná historie. Nesmí zmizet potichu,
          // jinak vyjde cost basis i realizovaný zisk špatně.
          shortfalls.push({ symbol: tx.symbol, closedOn: tx.occurredOn, quantity: remaining });
          break;
        }
        const take = Math.min(lot.quantity, remaining);
        realized.push({
          symbol: tx.symbol,
          closedOn: tx.occurredOn,
          quantity: take,
          proceeds: take * unitProceeds,
          cost: take * lot.costPerUnit,
          heldDays: Math.round(
            (Date.parse(`${tx.occurredOn}T00:00:00Z`) - Date.parse(`${lot.openedOn}T00:00:00Z`)) / 86_400_000,
          ),
        });
        lot.quantity -= take;
        remaining -= take;
      }
    }

    if (tx.type === "split" && tx.quantity) {
      // quantity = poměr (2 = 2:1). Split neovlivňuje hodnotu, jen kusy a cenu.
      for (const lot of open) {
        if (lot.symbol !== tx.symbol) continue;
        lot.quantity *= tx.quantity;
        lot.costPerUnit /= tx.quantity;
      }
    }
  }

  return { open: open.filter((l) => l.quantity > 1e-9), realized, shortfalls };
}

/** Kusy jednotlivých instrumentů ke konci daného dne. */
export function quantitiesOn(txs: Tx[], d: string): Map<string, number> {
  const qty = new Map<string, number>();
  for (const tx of txs) {
    if (!tx.symbol || tx.occurredOn > d) continue;
    if (tx.type === "buy") qty.set(tx.symbol, (qty.get(tx.symbol) ?? 0) + (tx.quantity ?? 0));
    if (tx.type === "sell") qty.set(tx.symbol, (qty.get(tx.symbol) ?? 0) - (tx.quantity ?? 0));
    if (tx.type === "split") qty.set(tx.symbol, (qty.get(tx.symbol) ?? 0) * (tx.quantity ?? 1));
  }
  for (const [k, v] of qty) if (Math.abs(v) < 1e-9) qty.delete(k);
  return qty;
}

/* ------------------------------------------------------------------ *
 * Denní rekonstrukce portfolia
 * ------------------------------------------------------------------ */

export type BuildOptions = {
  txs: Tx[];
  instruments: Map<string, Instrument>;
  prices: PriceMap;
  fx: FxMap;
  from?: string;
  to?: string;
};

/**
 * Rozklad denní změny hodnoty pozice:
 *   V = qty * P * FX
 *   ΔV ≈ qty·ΔP·FX₀   (cenový efekt)
 *      + qty·P₀·ΔFX   (měnový efekt)
 *      + qty·ΔP·ΔFX   (křížový člen, přičítá se k cenovému)
 * Nákupy/prodeje se do P&L nepočítají — jsou to toky, ne výnos.
 */
export function buildDailySeries(opts: BuildOptions): DayRow[] {
  const { txs, instruments, prices, fx } = opts;
  if (txs.length === 0) return [];

  const sorted = [...txs].sort(byTime);
  const from = opts.from ?? sorted[0].occurredOn;
  const to = opts.to ?? iso(new Date());

  const flowsByDay = new Map<string, number>();   // čistý vklad do CP v CZK
  for (const tx of sorted) {
    const rate = lastKnown(fx.get(tx.accountCurrency), tx.occurredOn) ?? 1;
    let flowCzk = 0;
    if (tx.type === "buy") flowCzk = Math.abs(tx.amount) * rate;
    else if (tx.type === "sell") flowCzk = -Math.abs(tx.amount) * rate;
    else if (tx.type === "dividend") flowCzk = -Math.abs(tx.amount) * rate;
    else if (tx.type === "withholding_tax") flowCzk = Math.abs(tx.amount) * rate;
    else if (tx.type === "fee") flowCzk = Math.abs(tx.amount) * rate;
    // Převod mezi vlastními účty (EUR<->USD) ani vklad hotovosti nejsou
    // vkladem DO cenných papírů — do výnosu portfolia nepatří.
    if (flowCzk !== 0) flowsByDay.set(tx.occurredOn, (flowsByDay.get(tx.occurredOn) ?? 0) + flowCzk);
  }

  // Kurzy prvního dne — referenční bod pro křivku "bez měnového vlivu"
  const baseFx = new Map<string, number>();
  for (const cur of fx.keys()) {
    const r = lastKnown(fx.get(cur), from, 30);
    if (r != null) baseFx.set(cur, r);
  }

  const rows: DayRow[] = [];
  let invested = 0;
  let twrIndex = 1;
  let prev: { value: number; positions: Map<string, PositionRow>; complete: boolean } | null = null;
  let skippedDays = 0;

  for (const d of eachDay(from, to)) {
    const qty = quantitiesOn(sorted, d);
    const positions: PositionRow[] = [];
    const missing: string[] = [];
    let value = 0;
    let valueConstantFx = 0;
    let priceEffect = 0;
    let fxEffect = 0;

    for (const [symbol, quantity] of qty) {
      const inst = instruments.get(symbol);
      if (!inst) { missing.push(symbol); continue; }
      const price = lastKnown(prices.get(symbol), d);
      const rate = inst.currency === "CZK" ? 1 : lastKnown(fx.get(inst.currency), d);
      if (price == null || rate == null) {
        // Chybějící cena se NESMÍ tvářit jako nulová pozice — hodnota portfolia
        // by tiše klesla a výkyv by se svedl na trh. Radši to přiznáme nahoru.
        missing.push(symbol);
        continue;
      }

      const valueCzk = quantity * price * rate;
      value += valueCzk;
      valueConstantFx += quantity * price * (baseFx.get(inst.currency) ?? rate);

      const before = prev?.positions.get(symbol);
      let pe = 0;
      let fe = 0;
      if (before && before.quantity > 0) {
        const heldQty = Math.min(before.quantity, quantity); // dokoupené kusy dnes ještě nevydělaly
        pe = heldQty * (price - before.price) * rate;        // cenový efekt vč. křížového členu
        fe = heldQty * before.price * (rate - before.fx);
      }
      priceEffect += pe;
      fxEffect += fe;

      positions.push({
        symbol,
        quantity,
        price,
        fx: rate,
        valueCzk,
        weight: 0,
        dayPnlCzk: pe + fe,
        priceEffectCzk: pe,
        fxEffectCzk: fe,
        dayReturnPct: before && before.price > 0 ? (price / before.price - 1) * 100 : null,
      });
    }

    for (const p of positions) p.weight = value > 0 ? p.valueCzk / value : 0;
    positions.sort((a, b) => b.valueCzk - a.valueCzk);

    const netFlow = flowsByDay.get(d) ?? 0;
    invested += netFlow;

    const dayPnl = priceEffect + fxEffect;
    const complete = missing.length === 0;

    // TWR: tok považujeme za provedený v průběhu dne, proto se odečítá od koncové hodnoty.
    //
    // Den s chybějící cenou do řetězce NESMÍ. Neoceněná pozice se počítá jako
    // nulová, takže den, kdy cena zmizí nebo se objeví, vypadá jako obří skok —
    // a ten by se v součinu propsal do celého výnosu. Stejně tak první den PO
    // mezeře: výchozí hodnota je nedůvěryhodná.
    let dayReturn: number | null = null;
    if (prev && prev.value > 0 && complete && prev.complete) {
      dayReturn = ((value - netFlow) / prev.value - 1) * 100;
      twrIndex *= 1 + dayReturn / 100;
    } else if (prev) {
      skippedDays++;
    }

    rows.push({
      d,
      marketValueCzk: value,
      marketValueConstantFxCzk: valueConstantFx,
      investedCzk: invested,
      netFlowCzk: netFlow,
      dayPnlCzk: dayPnl,
      dayReturnPct: dayReturn,
      twrIndex,
      priceEffectCzk: priceEffect,
      fxEffectCzk: fxEffect,
      missing,
      valuationComplete: complete,
      positions,
    });

    prev = { value, positions: new Map(positions.map((p) => [p.symbol, p])), complete };
  }

  if (skippedDays > 0) {
    console.warn(`[engine] ${skippedDays} dní vynecháno z TWR kvůli chybějícím cenám`);
  }
  return rows;
}

/* ------------------------------------------------------------------ *
 * Výkonnostní metriky
 * ------------------------------------------------------------------ */

/** Časově vážený výnos v % (nezávislý na načasování vkladů). */
export function twr(rows: DayRow[]): number {
  if (rows.length === 0) return 0;
  return (rows[rows.length - 1].twrIndex - 1) * 100;
}

/** Anualizovaný TWR. */
export function twrAnnualized(rows: DayRow[]): number {
  if (rows.length < 2) return 0;
  const years =
    (Date.parse(`${rows[rows.length - 1].d}T00:00:00Z`) - Date.parse(`${rows[0].d}T00:00:00Z`)) /
    (365.25 * 86_400_000);
  if (years <= 0) return 0;
  return (Math.pow(rows[rows.length - 1].twrIndex, 1 / years) - 1) * 100;
}

/**
 * XIRR — peněžně vážený výnos. Newton s bisekčním záchranným pásem,
 * protože Newton u portfolií s velkými pozdními vklady rád uteče.
 */
export function xirr(
  flows: Array<{ date: string; amount: number }>,
  opts: { guess?: number; minDays?: number } = {},
): number | null {
  const guess = opts.guess ?? 0.1;
  const minDays = opts.minDays ?? 30;
  if (flows.length < 2) return null;

  // Anualizace krátkého období dává nesmyslná čísla (a často ani nemá
  // numerické řešení). Radši nic než "výnos 2 400 000 %".
  const spanDays =
    (Date.parse(`${flows[flows.length - 1].date}T00:00:00Z`) - Date.parse(`${flows[0].date}T00:00:00Z`)) / 86_400_000;
  if (spanDays < minDays) return null;

  const t0 = Date.parse(`${flows[0].date}T00:00:00Z`);
  const years = (d: string) => (Date.parse(`${d}T00:00:00Z`) - t0) / (365.25 * 86_400_000);
  const npv = (r: number) => flows.reduce((s, f) => s + f.amount / Math.pow(1 + r, years(f.date)), 0);

  let rate = guess;
  for (let i = 0; i < 60; i++) {
    const f = npv(rate);
    const df = (npv(rate + 1e-6) - f) / 1e-6;
    if (Math.abs(df) < 1e-12) break;
    const next = rate - f / df;
    if (!Number.isFinite(next)) break;
    if (Math.abs(next - rate) < 1e-9) return next * 100;
    rate = Math.max(next, -0.9999);
  }

  // Newton neuspěl -> bisekce. Horní mez se rozšiřuje, protože u krátkých
  // horizontů vychází anualizovaná sazba klidně v tisících procent.
  const lo0 = -0.9999;
  let lo = lo0;
  let hi = 1;
  for (let i = 0; i < 40 && npv(lo) * npv(hi) > 0; i++) hi *= 2;
  if (npv(lo) * npv(hi) > 0) return null;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (npv(lo) * npv(mid) <= 0) hi = mid;
    else lo = mid;
  }
  return ((lo + hi) / 2) * 100;
}

/** Peněžní toky pro XIRR z transakcí + koncová hodnota portfolia. */
export function xirrFlows(txs: Tx[], fx: FxMap, endValueCzk: number, endDate: string) {
  const flows: Array<{ date: string; amount: number }> = [];
  for (const tx of [...txs].sort(byTime)) {
    const rate = lastKnown(fx.get(tx.accountCurrency), tx.occurredOn) ?? 1;
    if (tx.type === "buy") flows.push({ date: tx.occurredOn, amount: -Math.abs(tx.amount) * rate });
    if (tx.type === "sell") flows.push({ date: tx.occurredOn, amount: Math.abs(tx.amount) * rate });
    if (tx.type === "dividend") flows.push({ date: tx.occurredOn, amount: Math.abs(tx.amount) * rate });
    if (tx.type === "withholding_tax") flows.push({ date: tx.occurredOn, amount: -Math.abs(tx.amount) * rate });
  }
  flows.push({ date: endDate, amount: endValueCzk });
  return flows;
}

/** Maximální propad z lokálního maxima. */
export function maxDrawdown(rows: DayRow[]): { pct: number; from: string; to: string } {
  let peak = -Infinity;
  let peakDate = rows[0]?.d ?? "";
  let worst = { pct: 0, from: "", to: "" };
  for (const r of rows) {
    if (r.twrIndex > peak) {
      peak = r.twrIndex;
      peakDate = r.d;
    }
    const dd = (r.twrIndex / peak - 1) * 100;
    if (dd < worst.pct) worst = { pct: dd, from: peakDate, to: r.d };
  }
  return worst;
}
