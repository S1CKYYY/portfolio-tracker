/**
 * Převod výpisů z XTB na zašifrovaný ledger.
 *
 *   PORTFOLIO_PASSPHRASE=... node --experimental-strip-types scripts/seal-ledger.ts vypisy/*.xlsx
 *
 * Výstup je data/ledger.vault.json — jediný soubor s tvými transakcemi, který
 * se commituje. Samotné .xlsx do repozitáře NEPATŘÍ (jsou v .gitignore).
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import * as XLSX from "xlsx";
import { parseXtbWorkbook, reconcile } from "../lib/xtb/parse.ts";
import { quantitiesOn, buildLots } from "../lib/portfolio/engine.ts";
import { sealJson } from "../lib/vault.ts";
import { checkPassphrase, PASSPHRASE_ADVICE } from "../lib/passphrase.ts";
import type { Instrument, Tx } from "../lib/portfolio/types.ts";

const PASS = process.env.PORTFOLIO_PASSPHRASE;
if (!PASS) { console.error("Chybí PORTFOLIO_PASSPHRASE"); process.exit(1); }

// Zveřejněný soubor jde stahovat a hesla na něj zkoušet offline, bez limitu
// pokusů. Slabé heslo se proto zastaví tady, ne až někde v provozu.
const strength = checkPassphrase(PASS);
if (!strength.ok) {
  console.error(`\n✗ Heslo není dost silné (${strength.bits} bitů):`);
  for (const problem of strength.problems) console.error(`  - ${problem}`);
  console.error(`\n  ${PASSPHRASE_ADVICE}\n`);
  process.exit(1);
}
console.log(`heslo: ${strength.bits} bitů, hrubou silou ${strength.crackEstimate}`);

const files = process.argv.slice(2);
if (!files.length) { console.error("Použití: seal-ledger.ts <soubor.xlsx> [...]"); process.exit(1); }

let transactions: Tx[] = [];
const instruments = new Map<string, Instrument>();
const issues: string[] = [];

for (const path of files) {
  const wb = XLSX.read(readFileSync(path), { type: "buffer", cellDates: true });
  const p = parseXtbWorkbook(wb as never, XLSX.utils as never);
  transactions = transactions.concat(p.transactions);

  for (const i of p.instruments) {
    instruments.set(i.ticker, {
      symbol: i.ticker, yahooSymbol: i.yahooSymbol, name: i.name, currency: i.currency,
      kind: i.category === "ETF" ? "etf" : i.category === "ETC" ? "etc" : "stock",
      isBenchmark: i.ticker === "VUAA.DE",
    });
    if (!i.certain) issues.push(`${i.ticker}: mapování na Yahoo (${i.yahooSymbol}) není jisté — ověř`);
  }

  // Kontrola proti výpisu se dělá TEĎ. Do zašifrovaného ledgeru nemá smysl
  // ukládat data, o kterých se pak nedá zjistit, jestli sedí.
  const computed = quantitiesOn(p.transactions, p.account.generatedAt ?? new Date().toISOString().slice(0, 10));
  for (const bad of reconcile(computed, p.aggregates.map((a) => ({ symbol: a.ticker, quantity: a.quantity })))) {
    issues.push(`${bad.symbol}: z ledgeru ${bad.computed}, výpis hlásí ${bad.reported} (rozdíl ${bad.diff.toFixed(4)})`);
  }
  if (p.unparsed.length) issues.push(`${path}: ${p.unparsed.length} nerozparsovaných řádků`);

  console.log(`${path.split("/").pop()}: účet ${p.account.number} ${p.account.currency}, ${p.transactions.length} operací`);
}

const { shortfalls } = buildLots(transactions);
for (const s of shortfalls) issues.push(`${s.symbol}: prodej ${s.quantity} ks bez odpovídajícího nákupu (${s.closedOn})`);

if (issues.length) {
  console.error("\n✗ Ledger nesedí:\n  " + issues.join("\n  "));
  console.error("\nOprav to dřív, než se z toho začne počítat výnos.");
  if (!process.argv.includes("--force")) process.exit(1);
  console.error("Pokračuji kvůli --force.\n");
}

mkdirSync("data", { recursive: true });
const vault = await sealJson({ transactions, instruments: [...instruments.values()] }, PASS);
writeFileSync("data/ledger.vault.json", JSON.stringify(vault));

console.log(`\n✓ data/ledger.vault.json — ${transactions.length} transakcí, ${instruments.size} instrumentů`);
console.log(`  ${(JSON.stringify(vault).length / 1024).toFixed(0)} kB, zašifrováno`);
