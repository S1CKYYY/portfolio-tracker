export type TxType =
  | "buy" | "sell" | "dividend" | "withholding_tax" | "interest_tax" | "fee"
  | "interest" | "transfer" | "deposit" | "withdrawal" | "split" | "other";

export type Tx = {
  id?: string;
  occurredOn: string;        // YYYY-MM-DD
  /** Plné časové razítko. XTB exportuje od nejnovější a v jednom dni se běžně
   *  potkají nákup i prodej — bez času by FIFO seřadilo obchody pozpátku. */
  occurredAt?: string;
  type: TxType;
  symbol?: string;           // xtb_symbol
  quantity?: number;         // vždy kladné, směr určuje `type`
  price?: number;            // v měně instrumentu
  amount: number;            // peněžní tok na účtu, záporný = peníze ven
  accountCurrency: "EUR" | "USD";
  comment?: string;
};

export type Instrument = {
  symbol: string;            // xtb_symbol
  yahooSymbol: string;
  name: string;
  currency: "EUR" | "USD" | "CZK" | "GBP";
  kind: "stock" | "etf" | "etc" | "other";
  isBenchmark?: boolean;
};

/** symbol -> "YYYY-MM-DD" -> close */
export type PriceMap = Map<string, Map<string, number>>;
/** currency -> "YYYY-MM-DD" -> CZK za jednotku */
export type FxMap = Map<string, Map<string, number>>;

export type PositionRow = {
  symbol: string;
  quantity: number;
  price: number;             // v měně instrumentu
  fx: number;                // CZK za jednotku měny
  valueCzk: number;
  weight: number;
  dayPnlCzk: number;
  priceEffectCzk: number;
  fxEffectCzk: number;
  dayReturnPct: number | null;
};

export type DayRow = {
  d: string;
  marketValueCzk: number;
  /** Hodnota při zafixovaném kurzu z prvního dne — kolik z křivky je koruna a ne akcie. */
  marketValueConstantFxCzk: number;
  investedCzk: number;
  netFlowCzk: number;        // čistý vklad do CP v ten den (nákupy - prodeje - dividendy)
  dayPnlCzk: number;
  dayReturnPct: number | null;
  twrIndex: number;
  priceEffectCzk: number;
  fxEffectCzk: number;
  /** Držené instrumenty, pro které v tento den chyběla cena nebo kurz — jejich hodnota NENÍ v součtu. */
  missing: string[];
  /** Byly k dispozici ceny pro všechny držené pozice? Jen takový den smí vstoupit do TWR. */
  valuationComplete: boolean;
  positions: PositionRow[];
};

export type Lot = { symbol: string; openedOn: string; quantity: number; costPerUnit: number; currency: string };
