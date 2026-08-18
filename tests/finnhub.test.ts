import test from "node:test";
import assert from "node:assert/strict";
import { findInsiderClusters, insiderToEvents, earningsToEvents, filingsToEvents, newsToEvents,
         INSIDER_CODES, type InsiderTrade } from "../lib/market/finnhub.ts";

const trade = (name: string, date: string, code: string, change: number, price = 100): InsiderTrade =>
  ({ name, share: 0, change, filingDate: date, transactionDate: date, transactionCode: code, transactionPrice: price });

test("signál se odděluje od šumu podle kódu transakce", () => {
  assert.equal(INSIDER_CODES.P.signal, "strong");   // nákup za vlastní peníze
  assert.equal(INSIDER_CODES.A.signal, "noise");    // přidělené akcie
  assert.equal(INSIDER_CODES.F.signal, "noise");    // odvod na daň při vestingu
  assert.equal(INSIDER_CODES.M.signal, "noise");    // uplatnění opcí
});

test("klastr vyžaduje víc než jednoho kupujícího", () => {
  const one = findInsiderClusters("X", [trade("Novák","2026-05-01","P",1000), trade("Novák","2026-05-10","P",2000)]);
  assert.equal(one.length, 0, "jeden insider není klastr");

  const many = findInsiderClusters("X", [
    trade("Novák","2026-05-01","P",1000), trade("Svoboda","2026-05-05","P",2000), trade("Dvořák","2026-05-12","P",1500),
  ]);
  assert.equal(many.length, 1);
  assert.equal(many[0].buyers.length, 3);
  assert.equal(many[0].strength, "silný");
  assert.equal(many[0].shares, 4500);
});

test("granty ani odvody na daň klastr netvoří", () => {
  const c = findInsiderClusters("X", [
    trade("Novák","2026-05-01","A",5000), trade("Svoboda","2026-05-02","F",3000),
    trade("Dvořák","2026-05-03","M",9000), trade("Černá","2026-05-04","S",-4000),
  ]);
  assert.deepEqual(c, [], "z odměn a odvodů se nesmí stát nákupní signál");
});

test("nákupy daleko od sebe se nespojí do jednoho klastru", () => {
  const c = findInsiderClusters("X", [
    trade("Novák","2026-01-01","P",1000), trade("Svoboda","2026-01-05","P",1000),
    trade("Dvořák","2026-09-01","P",1000), trade("Černá","2026-09-03","P",1000),
  ]);
  assert.equal(c.length, 2, "osm měsíců není jedno okno");
});

test("velký jednotlivý nákup se ohlásí i bez klastru", () => {
  const events = insiderToEvents("X", [trade("Novák","2026-05-01","P",5000, 200)]);
  assert.equal(events.length, 1);
  assert.match(events[0].headline, /Novák koupil/);
  assert.equal(events[0].kind, "insider");
});

test("drobný nákup se nehlásí", () => {
  assert.equal(insiderToEvents("X", [trade("Novák","2026-05-01","P",10, 50)]).length, 0);
});

test("earnings s velkým překvapením dostanou vyšší závažnost", () => {
  const [big, small, future] = earningsToEvents([
    { symbol:"X", date:"2026-05-01", hour:"amc", epsActual:1.5, epsEstimate:1.0, revenueActual:null, revenueEstimate:null },
    { symbol:"X", date:"2026-02-01", hour:"amc", epsActual:1.02, epsEstimate:1.0, revenueActual:null, revenueEstimate:null },
    { symbol:"X", date:"2026-08-01", hour:"amc", epsActual:null, epsEstimate:1.1, revenueActual:null, revenueEstimate:null },
  ]);
  assert.equal(big.severity, 3);
  assert.match(big.headline, /\+50,0 %|\+50.0 %/);
  assert.equal(small.severity, 2);
  assert.equal(future.severity, 1);
  assert.match(future.headline, /Očekávané/);
});

test("z filings projdou jen formuláře, které něco znamenají", () => {
  const e = filingsToEvents([
    { accessNumber:"1", symbol:"X", form:"8-K", filedDate:"2026-05-01 10:00:00", acceptedDate:"", reportUrl:"", filingUrl:"https://sec.gov/a" },
    { accessNumber:"2", symbol:"X", form:"4", filedDate:"2026-05-02 10:00:00", acceptedDate:"", reportUrl:"", filingUrl:"" },
    { accessNumber:"3", symbol:"X", form:"10-Q", filedDate:"2026-05-03 10:00:00", acceptedDate:"", reportUrl:"", filingUrl:"" },
  ]);
  assert.equal(e.length, 2);
  assert.equal(e[0].d, "2026-05-01");
  assert.equal(e[0].severity, 3);
  assert.equal(e[0].url, "https://sec.gov/a");
});

test("ze zpráv se bere jen titulek a odkaz, omezeně na den", () => {
  const day = Date.parse("2026-05-01T12:00:00Z") / 1000;
  const e = newsToEvents(Array.from({ length: 8 }, (_, i) => ({
    id: i, datetime: day, headline: `Titulek ${i}`, source: "Reuters", url: `https://x/${i}`, related: "X",
  })));
  assert.equal(e.length, 3, "víc než tři zprávy denně je zaplavení, ne informace");
  assert.equal(e[0].kind, "news");
  assert.equal(e[0].severity, 1);
  assert.ok(!("summary" in e[0].payload), "obsah článku se nekopíruje");
});
