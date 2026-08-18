import test from "node:test";
import assert from "node:assert/strict";
import { parseXtbWorkbook, parseCashOperations, parseOpenPositions, parseClosedPositions,
         reconcile, summarize, toYahooSymbol } from "../lib/xtb/parse.ts";
import { quantitiesOn, buildLots } from "../lib/portfolio/engine.ts";

/* Rozvržení odpovídá skutečnému exportu z XTB: metadata nad hlavičkou,
   operace od nejnovější, kusy a cena jen v komentáři. */

const CASH: unknown[][] = [
  ["Account number", "10000001"],
  ["Cash Operations"],
  ["Date from (UTC)", "2006-01-01 00:00:00"],
  ["Date to (UTC)", "2026-08-02 09:37:56.328000"],
  ["Type","Instrument","Ticker","Category","Time","Amount","ID","Comment","Product","Position ID"],
  ["Stock sell","Microsoft","MSFT.US","STOCK","2026-02-03T14:20:00.000Z",200.02,"9003","CLOSE BUY 0.4842 @ 413.10","My Trades","555"],
  ["Stock purchase","Microsoft","MSFT.US","STOCK","2026-02-03T09:15:00.000Z",-413.09,"9002","OPEN BUY 1 @ 413.09","My Trades","556"],
  ["Stock purchase","Xetra-Gold","4GLD.DE","ETC","2026-01-30T16:11:20.714Z",-135.86,"9001","OPEN BUY 1/1.3537 @ 135.8600","My Trades","557"],
  ["Free funds interest tax","","","","2026-01-05T00:58:17.049Z",-0.01,"9000","Free-funds Interest Tax 2026-01","My Trades",""],
  ["Free funds interest","","","","2026-01-05T01:04:46.556Z",0.04,"8999","Free-funds Interest 2026-01","My Trades",""],
  ["Withholding tax","PayPal","PYPL.US","STOCK","2025-12-20T00:00:00.000Z",-0.95,"8998","PYPL.US USD WHT 30%","My Trades",""],
  ["Dividend","PayPal","PYPL.US","STOCK","2025-12-20T00:00:00.000Z",3.16,"8997","PYPL.US USD 0.1400/ SHR","My Trades",""],
  ["Transfer","","","","2025-11-10T00:00:00.000Z",-133.0,"8996","Currency conversion, EUR to USD","My Trades",""],
  ["Deposit","","","","2025-11-10T00:00:00.000Z",133.0,"8995","JP_MORGAN deposit","My Trades",""],
  ["Total","","","","",0.56,"","","",""],
];

const OPEN: unknown[][] = [
  ["Account number","10000001"],
  ["Open Positions"],
  ["Data as of report generated","2026-08-02 09:37:56.981000"],
  ["Product","Metric","Amount","Currency"],
  ["My Trades","Value",1234.56,"EUR"],
  ["My Trades","Profit",123.45,"EUR"],
  [],
  ["Note","Summary values and open positions"],
  ["Product","Instrument/Position","Ticker","Category","Type","Volume","Value","Current price","Open price",
   "Open time (UTC)","Stop Loss","Take Profit","Net Profit %","Net Profit"],
  ["My Trades","Xetra-Gold","4GLD.DE","ETC","",1.0,135.9,"",135.86,"","","",0.03,0.04],
  ["My Trades","557","4GLD.DE","","BUY",1.0,135.9,135.9,135.86,"2026-01-30T16:11:20.714Z","","",0.03,0.04],
  ["My Trades","Microsoft","MSFT.US","STOCK","",0.5158,213.0,"",413.09,"","","",0.5,1.0],
  ["My Trades","556","MSFT.US","","BUY",0.5158,213.0,413.0,413.09,"2026-02-03T09:15:00.000Z","","",0.5,1.0],
];

const CLOSED: unknown[][] = [
  ["Account number","10000001"],
  ["Closed Positions"],
  ["Date from (UTC)","2006-01-01 00:00:00"],
  ["Date to (UTC)","2026-08-02 09:37:56.328000"],
  ["Instrument","Ticker","Category","Type","Volume","Open Price","Open Time (UTC)","Close Price","Close Time (UTC)",
   "Product","Profit/Loss","Gross Profit","Purchase Value","Sale Value"],
  ["Microsoft","MSFT.US","STOCK","BUY",0.4842,413.09,"2026-02-03T09:15:00.000Z",413.10,"2026-02-03T14:20:00.000Z",
   "My Trades",0.0,0.0,200.01,200.02],
];

const wb = {
  SheetNames: ["Closed Positions","Cash Operations","Open Positions"],
  Sheets: { "Closed Positions": { r: CLOSED }, "Cash Operations": { r: CASH }, "Open Positions": { r: OPEN } },
} as never;
const utils = { sheet_to_json: (s: any) => s.r } as never;

test("hlavičku najde pod metadaty a přeskočí součtový řádek", () => {
  const r = parseCashOperations(wb, utils, "EUR");
  assert.equal(r.sheet, "Cash Operations");
  assert.equal(r.transactions.length, 9);           // 10 řádků minus Total
  assert.equal(r.unparsed.length, 0);
  assert.ok(!r.transactions.some((t) => /total/i.test(t.comment ?? "")));
});

test("typy operací odpovídají tomu, co XTB skutečně píše", () => {
  const { transactions } = parseCashOperations(wb, utils, "EUR");
  const byId = new Map(transactions.map((t) => [t.id, t]));
  assert.equal(byId.get("9003")?.type, "sell");            // "Stock sell" + CLOSE BUY
  assert.equal(byId.get("9002")?.type, "buy");             // "Stock purchase" + OPEN BUY
  assert.equal(byId.get("9000")?.type, "interest_tax");    // nesmí spadnout pod úrok
  assert.equal(byId.get("8999")?.type, "interest");
  assert.equal(byId.get("8998")?.type, "withholding_tax"); // nesmí spadnout pod dividendu
  assert.equal(byId.get("8997")?.type, "dividend");
  assert.equal(byId.get("8996")?.type, "transfer");        // konverze měny mezi vlastními účty
  assert.equal(byId.get("8995")?.type, "deposit");
});

test("z komentáře se bere dílčí exekuce, ne velikost pokynu", () => {
  const { transactions } = parseCashOperations(wb, utils, "EUR");
  const gold = transactions.find((t) => t.id === "9001");
  assert.equal(gold?.quantity, 1);        // "OPEN BUY 1/1.3537" -> 1, ne 1.3537
  assert.equal(gold?.price, 135.86);
  const msft = transactions.find((t) => t.id === "9002");
  assert.equal(msft?.quantity, 1);        // varianta bez lomítka
  assert.equal(msft?.price, 413.09);
});

test("Open Positions oddělí agregáty od jednotlivých lotů", () => {
  const r = parseOpenPositions(wb, utils);
  assert.equal(r.aggregates.length, 2);
  assert.equal(r.lots.length, 2);
  // bez rozlišení by se každá pozice napočítala dvakrát
  assert.equal(r.aggregates.find((a) => a.ticker === "4GLD.DE")?.quantity, 1);
  assert.equal(r.lots.find((l) => l.ticker === "4GLD.DE")?.openedOn, "2026-01-30");
  assert.equal(r.currency, "EUR");
  assert.equal(r.accountNumber, "10000001");
  assert.equal(r.generatedAt, "2026-08-02");
});

test("nesmí si splést Closed Positions s Open Positions", () => {
  // Sešit začíná uzavřenými pozicemi a obojí jméno obsahuje "Positions".
  // Volné hledání podle podřetězce by vzalo první list a všechny držené
  // kusy by pak vypadaly jako přebytek proti výpisu.
  assert.equal(wb.SheetNames[0], "Closed Positions");
  const open = parseOpenPositions(wb, utils);
  assert.equal(open.sheet, "Open Positions");
  assert.ok(open.aggregates.length > 0, "agregáty se musí najít");

  const closed = parseClosedPositions(wb, utils);
  assert.equal(closed.sheet, "Closed Positions");

  const p = parseXtbWorkbook(wb, utils);
  const issues = reconcile(
    quantitiesOn(p.transactions, "2026-08-02"),
    p.aggregates.map((a) => ({ symbol: a.ticker, quantity: a.quantity })),
  );
  assert.deepEqual(issues, [], "proti správnému listu musí kusy sedět");
});

test("chybějící agregáty se dopočítají z lotů", () => {
  // Řádky bez vyplněné Category = jen loty, žádné souhrny.
  const lotsOnly = OPEN.filter((r) => !(r[3] && !r[4]));
  const wb2 = {
    SheetNames: ["Open Positions"],
    Sheets: { "Open Positions": { r: lotsOnly } },
  } as never;
  const r = parseOpenPositions(wb2, utils);
  assert.ok(r.aggregates.length > 0, "místo prázdna se agregát poskládá z lotů");
  assert.equal(r.aggregates.find((a) => a.ticker === "4GLD.DE")?.quantity, 1);
});

test("měna účtu se čte z výpisu, ne z názvu souboru", () => {
  const p = parseXtbWorkbook(wb, utils);
  assert.equal(p.account.currency, "EUR");
  assert.ok(p.transactions.every((t) => t.accountCurrency === "EUR"));
});

test("prodej ve stejný den jako nákup se seřadí podle času", () => {
  // XTB exportuje od nejnovější: prodej MSFT je ve výpisu PŘED svými nákupy
  const { transactions } = parseCashOperations(wb, utils, "EUR");
  const { realized, shortfalls } = buildLots(transactions);
  assert.equal(shortfalls.length, 0, "žádný prodej nesmí zůstat bez krytí");
  const msft = realized.filter((r) => r.symbol === "MSFT.US");
  assert.equal(msft.length, 1);
  assert.ok(Math.abs(msft[0].quantity - 0.4842) < 1e-9);
});

test("FIFO souhlasí s listem Closed Positions", () => {
  const p = parseXtbWorkbook(wb, utils);
  const { realized } = buildLots(p.transactions);
  const fifo = realized.filter((r) => r.symbol === "MSFT.US").reduce((s, r) => s + r.quantity, 0);
  const xtb = p.closed.filter((c) => c.ticker === "MSFT.US").reduce((s, c) => s + c.quantity, 0);
  assert.ok(Math.abs(fifo - xtb) < 1e-9, `FIFO ${fifo} vs XTB ${xtb}`);
});

test("kusy z ledgeru sedí na agregáty ve výpisu", () => {
  const p = parseXtbWorkbook(wb, utils);
  const computed = quantitiesOn(p.transactions, "2026-08-02");
  const issues = reconcile(computed, p.aggregates.map((a) => ({ symbol: a.ticker, quantity: a.quantity })));
  assert.deepEqual(issues, []);
});

test("chybějící historie se projeví jako nesrovnalost", () => {
  const p = parseXtbWorkbook(wb, utils);
  const computed = quantitiesOn(p.transactions, "2026-08-02");
  const issues = reconcile(computed, [{ symbol: "4GLD.DE", quantity: 3.5 }]);
  const gold = issues.find((i) => i.symbol === "4GLD.DE");
  assert.ok(gold && gold.diff < 0, "z ledgeru vychází míň kusů, než hlásí XTB");
  // a naopak: pozice v ledgeru, kterou výpis vůbec nezmiňuje, se taky ohlásí
  assert.ok(issues.some((i) => i.symbol === "MSFT.US" && i.reported === 0));
});

test("tickery se mapují na burzovní příponu Yahoo", () => {
  assert.deepEqual(toYahooSymbol("BRKB.US"), { symbol: "BRK-B", certain: true });
  assert.deepEqual(toYahooSymbol("MSFT.US"), { symbol: "MSFT", certain: true });
  assert.deepEqual(toYahooSymbol("VUAA.DE"), { symbol: "VUAA.DE", certain: true });
  assert.deepEqual(toYahooSymbol("EGLN.UK"), { symbol: "EGLN.L", certain: true }); // Londýn není .UK
  assert.equal(toYahooSymbol("NECO.XY").certain, false);                            // neznámou burzu přizná
});

test("číselník instrumentů se poskládá z výpisu", () => {
  const p = parseXtbWorkbook(wb, utils);
  const msft = p.instruments.find((i) => i.ticker === "MSFT.US");
  assert.equal(msft?.yahooSymbol, "MSFT");
  assert.equal(msft?.category, "STOCK");
  assert.equal(msft?.currency, "EUR");
});

test("souhrn dá přehled před uložením", () => {
  const p = parseXtbWorkbook(wb, utils);
  const s = summarize(p.transactions);
  assert.equal(s.total, 9);
  assert.equal(s.from, "2025-11-10");
  assert.equal(s.to, "2026-02-03");
  assert.deepEqual(s.symbols, ["4GLD.DE", "MSFT.US", "PYPL.US"]);
});
