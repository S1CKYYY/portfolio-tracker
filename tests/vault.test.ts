import test from "node:test";
import assert from "node:assert/strict";
import { seal, open, sealJson, openJson, type Vault } from "../lib/vault.ts";

const PASS = "spravne-dlouhe-heslo";
const FAST = 1000; // v testech nechceme 600k iterací

test("co se zamkne, jde odemknout", async () => {
  const v = await seal("tajná data", PASS, FAST);
  assert.equal(await open(v, PASS), "tajná data");
});

test("v zašifrovaném souboru není vidět obsah", async () => {
  const v = await sealJson({ ticker: "BRKB.US", quantity: 5.4653 }, PASS, FAST);
  const raw = JSON.stringify(v);
  assert.ok(!raw.includes("BRKB"), "ticker nesmí prosáknout");
  assert.ok(!raw.includes("5.4653"), "počty kusů nesmí prosáknout");
});

test("špatné heslo neprojde", async () => {
  const v = await seal("tajná data", PASS, FAST);
  await assert.rejects(() => open(v, "jine-dlouhe-heslo"), /Špatné heslo/);
});

test("změněný ciphertext se pozná", async () => {
  const v = await seal("tajná data", PASS, FAST);
  const bytes = atob(v.data).split("");
  bytes[5] = bytes[5] === "A" ? "B" : "A";
  const tampered: Vault = { ...v, data: btoa(bytes.join("")) };
  // AES-GCM ověřuje integritu, takže podvržená data neprojdou ani se správným heslem
  await assert.rejects(() => open(tampered, PASS), /Špatné heslo nebo poškozená data/);
});

test("krátké heslo se odmítne už při zamykání", async () => {
  await assert.rejects(() => seal("data", "kratke", FAST), /aspoň 12 znaků/);
});

test("dva buildy stejných dat vypadají různě", async () => {
  const a = await seal("stejná data", PASS, FAST);
  const b = await seal("stejná data", PASS, FAST);
  assert.notEqual(a.data, b.data, "jinak by šlo z historie commitů poznat, kdy se data nezměnila");
  assert.notEqual(a.salt, b.salt);
  assert.notEqual(a.iv, b.iv);
});

test("JSON přežije cestu tam a zpět", async () => {
  const data = { series: [["2026-01-01", 1000, null]], metrics: { twr: 22.72 }, cs: "příliš žluťoučký kůň" };
  const v = await sealJson(data, PASS, FAST);
  assert.deepEqual(await openJson(v, PASS), data);
});
