import type { Tx, TxType } from "../portfolio/types";

/**
 * Čtení výpisu z XTB.
 *
 * Skutečný export má tři listy a všechny jsou k něčemu dobré:
 *   Cash Operations  — úplný proud událostí, jediný zdroj pravdy pro ledger
 *   Open Positions   — agregáty + jednotlivé loty s datem a cenou pořízení
 *   Closed Positions — uzavřené obchody s oběma nohami
 *
 * Ledger stavíme z Cash Operations, zbylé dva listy slouží ke kontrole.
 * Kdyby se nesešly, je to signál, že výpis nesahá dost daleko do minulosti.
 */

type SheetLike = { [cell: string]: unknown };
type WorkbookLike = { SheetNames: string[]; Sheets: Record<string, SheetLike> };
type XlsxUtils = { sheet_to_json: <T>(sheet: SheetLike, opts: Record<string, unknown>) => T[] };

export type XtbAccount = { number: string | null; currency: "EUR" | "USD" | null; generatedAt: string | null };

export type XtbLot = {
  ticker: string; positionId: string; quantity: number;
  openPrice: number; openedOn: string; value: number;
};

export type XtbClosed = {
  ticker: string; name: string; category: string; quantity: number;
  openPrice: number; openedOn: string; closePrice: number; closedOn: string;
  profit: number; purchaseValue: number; saleValue: number; positionId: string;
};

export type XtbAggregate = {
  ticker: string; name: string; category: string;
  quantity: number; value: number; profit: number; profitPct: number;
};

export type InstrumentHint = {
  ticker: string; name: string; category: string;
  currency: "EUR" | "USD"; yahooSymbol: string; certain: boolean;
};

export type ParsedWorkbook = {
  account: XtbAccount;
  transactions: Tx[];
  unparsed: Array<{ row: unknown[]; reason: string }>;
  aggregates: XtbAggregate[];
  lots: XtbLot[];
  closed: XtbClosed[];
  instruments: InstrumentHint[];
  sheets: { cash: string | null; open: string | null; closed: string | null };
};

/* ------------------------------------------------------------------ *
 * Drobnosti
 * ------------------------------------------------------------------ */

const num = (v: unknown): number | undefined => {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v !== "string") return undefined;
  const cleaned = v.trim().replace(/\s/g, "").replace(/,(?=\d{1,2}$)/, ".").replace(/,/g, "");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : undefined;
};

/** XTB píše časy v UTC jako ISO řetězec nebo Date. Bereme jen datum. */
const toIsoDate = (v: unknown): string | undefined => {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "number") return new Date(Math.round((v - 25569) * 86_400_000)).toISOString().slice(0, 10);
  if (typeof v === "string") {
    const ymd = v.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (ymd) return ymd[0];
    const dmy = v.match(/^(\d{1,2})[.\/](\d{1,2})[.\/](\d{4})/);
    if (dmy) return `${dmy[3]}-${dmy[2].padStart(2, "0")}-${dmy[1].padStart(2, "0")}`;
  }
  return undefined;
};

const text = (v: unknown) => String(v ?? "").trim();

/** Plné razítko pro řazení — datum samotné na uspořádání obchodů nestačí. */
const toIsoStamp = (v: unknown): string | undefined => {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}[T ]/.test(v)) return v.replace(" ", "T");
  const d = toIsoDate(v);
  return d ? `${d}T00:00:00.000Z` : undefined;
};

/**
 * Listy hledáme uspořádanými vzory od nejpřesnějšího po nejvolnější,
 * a každý vzor projde celý sešit dřív, než se sáhne po dalším.
 *
 * Volný podřetězec "positions" tu nestačí: sešit začíná listem
 * "Closed Positions", takže by se jako otevřené pozice vzaly uzavřené
 * obchody a všechny držené kusy by vypadaly jako přebytek proti výpisu.
 */
function findSheet(workbook: WorkbookLike, patterns: RegExp[]): string | null {
  for (const p of patterns) {
    const hit = workbook.SheetNames.find((n) => p.test(n));
    if (hit) return hit;
  }
  return null;
}

/** Hlavička není na pevném řádku — nad ní bývá blok s číslem účtu a obdobím. */
function findHeader(rows: unknown[][], required: RegExp[], optional: Record<string, RegExp>) {
  for (let i = 0; i < Math.min(rows.length, 60); i++) {
    const cells = (rows[i] ?? []).map((c) => text(c).toLowerCase());
    if (!required.every((re) => cells.some((c) => re.test(c)))) continue;
    const cols: Record<string, number> = {};
    for (const [key, re] of Object.entries(optional)) {
      const idx = cells.findIndex((c) => re.test(c));
      if (idx >= 0) cols[key] = idx;
    }
    return { index: i, cols };
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Mapování tickerů XTB -> Yahoo
 * ------------------------------------------------------------------ */

/** Přípony burz: XTB používá vlastní, Yahoo jiné. */
const SUFFIX_MAP: Record<string, string> = {
  US: "", DE: ".DE", UK: ".L", FR: ".PA", NL: ".AS", IT: ".MI", ES: ".MC",
  CH: ".SW", PT: ".LS", BE: ".BR", PL: ".WA", CZ: ".PR", SE: ".ST", NO: ".OL", FI: ".HE",
};

/** Tickery, kde se zápis liší i po odstranění přípony (třídy akcií). */
const TICKER_FIXES: Record<string, string> = {
  BRKB: "BRK-B", BRKA: "BRK-A", BFB: "BF-B", BFA: "BF-A",
};

export function toYahooSymbol(xtbTicker: string): { symbol: string; certain: boolean } {
  const [base, market] = xtbTicker.split(".");
  if (!market) return { symbol: xtbTicker, certain: false };
  const fixed = TICKER_FIXES[base];
  if (fixed) return { symbol: fixed, certain: true };
  const suffix = SUFFIX_MAP[market];
  if (suffix == null) return { symbol: xtbTicker, certain: false };
  return { symbol: `${base}${suffix}`, certain: true };
}

/* ------------------------------------------------------------------ *
 * Cash Operations -> transakce
 * ------------------------------------------------------------------ */

/**
 * Typy operací tak, jak je XTB skutečně píše. Pořadí je významné —
 * "Free funds interest tax" musí spadnout do daně dřív, než ho chytne úrok.
 */
const TYPE_MAP: Array<{ test: RegExp; type: TxType }> = [
  { test: /interest\s*tax/i, type: "interest_tax" },
  { test: /withholding|srážková/i, type: "withholding_tax" },
  { test: /dividend/i, type: "dividend" },
  { test: /commission|poplat|^fee/i, type: "fee" },
  { test: /interest|úrok/i, type: "interest" },
  { test: /transfer|conversion|převod/i, type: "transfer" },
  { test: /deposit|vklad/i, type: "deposit" },
  { test: /withdraw|payout|výběr/i, type: "withdrawal" },
  { test: /split/i, type: "split" },
];

/** "OPEN BUY 1/1.3537 @ 135.8600" — první číslo je tato dílčí exekuce, druhé celý pokyn. */
const COMMENT_RE = /(OPEN|CLOSE)\s+(BUY|SELL)\s+([\d.,]+?)(?:\/([\d.,]+))?\s*@\s*([\d.,]+)/i;

function classify(typeText: string, comment: string): TxType {
  // Obchod poznáme spolehlivě z komentáře, ne z názvu typu:
  // OPEN = otevření pozice (nákup), CLOSE = uzavření (prodej).
  const m = comment.match(COMMENT_RE);
  if (m) return m[1].toUpperCase() === "OPEN" ? "buy" : "sell";

  const t = typeText.toLowerCase();
  if (/stock.*(purchase|buy)/.test(t)) return "buy";
  if (/stock.*(sell|sale)/.test(t)) return "sell";

  for (const { test, type } of TYPE_MAP) {
    if (test.test(typeText) || test.test(comment)) return type;
  }
  return "other";
}

export function parseCashOperations(
  workbook: WorkbookLike,
  utils: XlsxUtils,
  accountCurrency: "EUR" | "USD",
): { sheet: string | null; transactions: Tx[]; unparsed: Array<{ row: unknown[]; reason: string }> } {
  const sheet = findSheet(workbook, [/cash\s*operation/i, /hotovost/i, /cash/i]);
  if (!sheet) {
    return {
      sheet: null, transactions: [],
      unparsed: [{ row: workbook.SheetNames, reason: "Nenalezen list Cash Operations" }],
    };
  }

  const rows = utils.sheet_to_json<unknown[]>(workbook.Sheets[sheet], { header: 1, raw: true });
  const header = findHeader(
    rows,
    [/^type$/, /^time$/, /^amount$/],
    {
      type: /^type$/, name: /^instrument$/, symbol: /^ticker$/, category: /^category$/,
      time: /^time$/, amount: /^amount$/, id: /^id$/, comment: /^comment$/, positionId: /^position id$/,
    },
  );
  if (!header) {
    return { sheet, transactions: [], unparsed: [{ row: rows[0] ?? [], reason: "Nerozpoznaná hlavička listu Cash Operations" }] };
  }

  const { cols } = header;
  const transactions: Tx[] = [];
  const unparsed: Array<{ row: unknown[]; reason: string }> = [];

  for (const row of rows.slice(header.index + 1)) {
    if (!row || row.length === 0) continue;

    const typeText = text(row[cols.type]);
    if (!typeText) continue;
    // Poslední řádek výpisu je součet, ne operace.
    if (/^total$/i.test(typeText)) continue;

    const occurredOn = toIsoDate(row[cols.time]);
    const amount = num(row[cols.amount]);
    if (!occurredOn || amount == null) {
      unparsed.push({ row, reason: `Chybí datum nebo částka (typ „${typeText}“)` });
      continue;
    }

    const comment = text(row[cols.comment]);
    const symbol = cols.symbol != null ? text(row[cols.symbol]) || undefined : undefined;
    const type = classify(typeText, comment);

    let quantity: number | undefined;
    let price: number | undefined;
    const m = comment.match(COMMENT_RE);
    if (m) {
      quantity = num(m[3]);
      price = num(m[5]);
    }

    if ((type === "buy" || type === "sell") && (quantity == null || price == null)) {
      unparsed.push({ row, reason: `Obchod bez kusů/ceny v komentáři: „${comment}“` });
    }

    transactions.push({
      id: cols.id != null ? text(row[cols.id]) || undefined : undefined,
      occurredOn,
      occurredAt: toIsoStamp(row[cols.time]),
      type,
      symbol,
      quantity,
      price,
      amount,
      accountCurrency,
      comment: comment || typeText,
    });
  }

  return { sheet, transactions, unparsed };
}

/* ------------------------------------------------------------------ *
 * Open Positions
 * ------------------------------------------------------------------ */

/**
 * List má dva druhy řádků pod jednou hlavičkou:
 *   agregát  — vyplněná Category, prázdný Type  (souhrn za instrument)
 *   lot      — prázdná Category, Type = BUY     (jednotlivá otevřená pozice)
 * Kdo je nerozliší, napočítá si každou pozici dvakrát.
 */
export function parseOpenPositions(workbook: WorkbookLike, utils: XlsxUtils) {
  const sheet = findSheet(workbook, [/open\s*position/i, /otevřen/i]);
  const empty = {
    sheet: null as string | null, aggregates: [] as XtbAggregate[], lots: [] as XtbLot[],
    currency: null as "EUR" | "USD" | null, generatedAt: null as string | null, accountNumber: null as string | null,
  };
  if (!sheet) return empty;

  const rows = utils.sheet_to_json<unknown[]>(workbook.Sheets[sheet], { header: 1, raw: true });

  // Blok nad tabulkou: číslo účtu, čas generování a souhrn s měnou účtu.
  let currency: "EUR" | "USD" | null = null;
  let generatedAt: string | null = null;
  let accountNumber: string | null = null;
  for (const row of rows.slice(0, 12)) {
    const label = text(row?.[0]).toLowerCase();
    if (/account number/.test(label)) accountNumber = text(row?.[1]) || null;
    if (/data as of|report generate/.test(label)) generatedAt = toIsoDate(row?.[1]) ?? null;
    const ccy = text(row?.[3]).toUpperCase();
    if ((ccy === "EUR" || ccy === "USD") && !currency) currency = ccy;
  }

  const header = findHeader(
    rows,
    [/^ticker$/, /^volume$/],
    {
      name: /^instrument\/position$|^instrument$/, symbol: /^ticker$/, category: /^category$/,
      type: /^type$/, quantity: /^volume$/, value: /^value$/, openPrice: /^open price$/,
      openTime: /^open time/, profit: /^net profit$/, profitPct: /^net profit %$/,
    },
  );
  if (!header) return { ...empty, sheet, currency, generatedAt, accountNumber };

  const { cols } = header;
  const aggregates: XtbAggregate[] = [];
  const lots: XtbLot[] = [];

  for (const row of rows.slice(header.index + 1)) {
    const ticker = text(row?.[cols.symbol]);
    const quantity = num(row?.[cols.quantity]);
    if (!ticker || quantity == null || quantity === 0) continue;

    const category = cols.category != null ? text(row[cols.category]) : "";
    const rowType = cols.type != null ? text(row[cols.type]) : "";

    if (category && !rowType) {
      aggregates.push({
        ticker,
        name: cols.name != null ? text(row[cols.name]) : ticker,
        category,
        quantity,
        value: num(row?.[cols.value]) ?? 0,
        profit: num(row?.[cols.profit]) ?? 0,
        profitPct: num(row?.[cols.profitPct]) ?? 0,
      });
    } else if (rowType) {
      lots.push({
        ticker,
        positionId: cols.name != null ? text(row[cols.name]) : "",
        quantity,
        openPrice: num(row?.[cols.openPrice]) ?? 0,
        openedOn: toIsoDate(row?.[cols.openTime]) ?? "",
        value: num(row?.[cols.value]) ?? 0,
      });
    }
  }

  // Kdyby XTB rozvržení změnilo a agregátní řádky zmizely, poskládáme je
  // z lotů. Lepší než tvrdit, že ve výpisu žádné pozice nejsou.
  if (aggregates.length === 0 && lots.length > 0) {
    const byTicker = new Map<string, number>();
    for (const l of lots) byTicker.set(l.ticker, (byTicker.get(l.ticker) ?? 0) + l.quantity);
    for (const [ticker, quantity] of byTicker) {
      aggregates.push({ ticker, name: ticker, category: "", quantity, value: 0, profit: 0, profitPct: 0 });
    }
  }

  return { sheet, aggregates, lots, currency, generatedAt, accountNumber };
}

/* ------------------------------------------------------------------ *
 * Closed Positions
 * ------------------------------------------------------------------ */

export function parseClosedPositions(workbook: WorkbookLike, utils: XlsxUtils) {
  const sheet = findSheet(workbook, [/closed\s*position/i, /uzavřen/i]);
  if (!sheet) return { sheet: null as string | null, closed: [] as XtbClosed[] };

  const rows = utils.sheet_to_json<unknown[]>(workbook.Sheets[sheet], { header: 1, raw: true });
  const header = findHeader(
    rows,
    [/^ticker$/, /^volume$/, /^close price$/],
    {
      name: /^instrument$/, symbol: /^ticker$/, category: /^category$/, quantity: /^volume$/,
      openPrice: /^open price$/, openTime: /^open time/, closePrice: /^close price$/, closeTime: /^close time/,
      profit: /^profit\/loss$/, purchaseValue: /^purchase value$/, saleValue: /^sale value$/, positionId: /^position id$/,
    },
  );
  if (!header) return { sheet, closed: [] };

  const { cols } = header;
  const closed: XtbClosed[] = [];
  for (const row of rows.slice(header.index + 1)) {
    const ticker = text(row?.[cols.symbol]);
    const quantity = num(row?.[cols.quantity]);
    if (!ticker || quantity == null) continue;
    closed.push({
      ticker,
      name: cols.name != null ? text(row[cols.name]) : ticker,
      category: cols.category != null ? text(row[cols.category]) : "",
      quantity,
      openPrice: num(row?.[cols.openPrice]) ?? 0,
      openedOn: toIsoDate(row?.[cols.openTime]) ?? "",
      closePrice: num(row?.[cols.closePrice]) ?? 0,
      closedOn: toIsoDate(row?.[cols.closeTime]) ?? "",
      profit: num(row?.[cols.profit]) ?? 0,
      purchaseValue: num(row?.[cols.purchaseValue]) ?? 0,
      saleValue: num(row?.[cols.saleValue]) ?? 0,
      positionId: cols.positionId != null ? text(row[cols.positionId]) : "",
    });
  }
  return { sheet, closed };
}

/* ------------------------------------------------------------------ *
 * Celý sešit najednou
 * ------------------------------------------------------------------ */

export function parseXtbWorkbook(
  workbook: WorkbookLike,
  utils: XlsxUtils,
  currencyOverride?: "EUR" | "USD",
): ParsedWorkbook {
  const open = parseOpenPositions(workbook, utils);
  const closedResult = parseClosedPositions(workbook, utils);
  // Měna účtu je přímo ve výpisu — hádat ji z názvu souboru není potřeba.
  const currency = currencyOverride ?? open.currency ?? "EUR";
  const cash = parseCashOperations(workbook, utils, currency);

  // Číselník instrumentů se dá poskládat rovnou z výpisu — název i kategorie tam jsou.
  const hints = new Map<string, InstrumentHint>();
  const addHint = (ticker: string, name: string, category: string) => {
    if (!ticker || hints.has(ticker)) return;
    const y = toYahooSymbol(ticker);
    hints.set(ticker, {
      ticker, name: name || ticker, category: category || "",
      currency, yahooSymbol: y.symbol, certain: y.certain,
    });
  };
  for (const a of open.aggregates) addHint(a.ticker, a.name, a.category);
  for (const c of closedResult.closed) addHint(c.ticker, c.name, c.category);

  return {
    account: { number: open.accountNumber, currency, generatedAt: open.generatedAt },
    transactions: cash.transactions,
    unparsed: cash.unparsed,
    aggregates: open.aggregates,
    lots: open.lots,
    closed: closedResult.closed,
    instruments: [...hints.values()],
    sheets: { cash: cash.sheet, open: open.sheet, closed: closedResult.sheet },
  };
}

/* ------------------------------------------------------------------ *
 * Kontrola
 * ------------------------------------------------------------------ */

export function reconcile(
  computed: Map<string, number>,
  reported: Array<{ symbol: string; quantity: number }>,
  tolerance = 1e-4,
): Array<{ symbol: string; computed: number; reported: number; diff: number }> {
  const issues: Array<{ symbol: string; computed: number; reported: number; diff: number }> = [];
  const seen = new Set<string>();

  for (const r of reported) {
    seen.add(r.symbol);
    const c = computed.get(r.symbol) ?? 0;
    if (Math.abs(c - r.quantity) > tolerance) {
      issues.push({ symbol: r.symbol, computed: c, reported: r.quantity, diff: c - r.quantity });
    }
  }
  for (const [symbol, c] of computed) {
    if (!seen.has(symbol) && Math.abs(c) > tolerance) {
      issues.push({ symbol, computed: c, reported: 0, diff: c });
    }
  }
  return issues;
}

const TYPE_LABELS: Record<string, string> = {
  buy: "nákupy", sell: "prodeje", dividend: "dividendy", withholding_tax: "srážková daň",
  interest: "úroky", interest_tax: "daň z úroků", fee: "poplatky", transfer: "převody mezi účty",
  deposit: "vklady", withdrawal: "výběry", split: "splity", other: "ostatní",
};

export const typeLabel = (t: string) => TYPE_LABELS[t] ?? t;

export function summarize(txs: Tx[]) {
  const byType = new Map<TxType, { count: number; amount: number }>();
  const symbols = new Set<string>();
  let first = "9999-99-99";
  let last = "0000-00-00";

  for (const tx of txs) {
    const entry = byType.get(tx.type) ?? { count: 0, amount: 0 };
    entry.count += 1;
    entry.amount += tx.amount;
    byType.set(tx.type, entry);
    if (tx.symbol) symbols.add(tx.symbol);
    if (tx.occurredOn < first) first = tx.occurredOn;
    if (tx.occurredOn > last) last = tx.occurredOn;
  }

  return {
    total: txs.length,
    from: txs.length ? first : null,
    to: txs.length ? last : null,
    symbols: [...symbols].sort(),
    byType: [...byType.entries()].map(([type, v]) => ({ type, ...v })).sort((a, b) => b.count - a.count),
  };
}
