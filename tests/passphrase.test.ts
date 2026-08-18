import test from "node:test";
import assert from "node:assert/strict";
import { checkPassphrase } from "../lib/passphrase.ts";

test("krátké heslo neprojde", () => {
  const r = checkPassphrase("Kratke1!");
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => /kratší než 16/.test(p)));
});

test("heslo související s tím, co chrání, neprojde", () => {
  assert.ok(checkPassphrase("mojePortfolioXTB2026!").problems.some((p) => /souvisej/.test(p)));
  assert.ok(checkPassphrase("SuperTajneHeslo2025").problems.some((p) => /letopočet/.test(p)));
});

test("opakovaný znak není síla, i když je dlouhý", () => {
  const r = checkPassphrase("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => /málo různých znaků/.test(p)));
});

test("opakující se blok se odhalí", () => {
  assert.ok(checkPassphrase("abcdefabcdefabcdefabcdef").problems.some((p) => /opakující se blok/.test(p)));
});

test("fráze z náhodných slov projde", () => {
  const r = checkPassphrase("vrtule kaktus ledovec pomeranc trumpeta");
  assert.equal(r.ok, true, r.problems.join(", "));
  assert.ok(r.bits >= 55, `bitů: ${r.bits}`);
});

test("dlouhé náhodné heslo projde", () => {
  const r = checkPassphrase("7Kx#pQ2vLm9$WzR4tYbN");
  assert.equal(r.ok, true, r.problems.join(", "));
});

test("odhad doby prolomení se počítá", () => {
  assert.match(checkPassphrase("vrtule kaktus ledovec pomeranc trumpeta").crackEstimate, /let|nekoneč/);
  assert.match(checkPassphrase("aaa").crackEstimate, /hodinu|dní/);
});

test("uhodnutelný vzor entropii srazí, ne jen přidá poznámku", () => {
  // Naivní vzoreček by tomuhle dal přes 100 bitů, protože počítá slovníková
  // slova jako náhodné znaky. Útočník se seznamem slov je trefí mezi prvními.
  const weak = checkPassphrase("mojePortfolio2026");
  assert.equal(weak.ok, false);
  assert.ok(weak.bits < 70, `srážka se neuplatnila, bitů: ${weak.bits}`);

  // Stejně dlouhé, ale bez rozpoznatelného vzoru
  const strong = checkPassphrase("7Kx#pQ2vLm9$WzR4t");
  assert.ok(strong.bits > weak.bits, "náhodné heslo musí vyjít líp než slovníkové");
});
