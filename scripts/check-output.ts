/**
 * Poslední kontrola před publikací na veřejnou adresu.
 *
 * Běží v CI po sestavení. Hledá ve výstupu vzory, které tam nemají co dělat:
 * čísla účtů, tickery, jména listů z XTB, klíče. Když něco najde, build spadne
 * a na Pages se nic nenahraje.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const OUT_DIR = "docs";

const FORBIDDEN: Array<{ re: RegExp; what: string }> = [
  { re: /\b\d{8}\b/, what: "číslo účtu (8 číslic)" },
  { re: /\.(US|DE|UK)\b/, what: "ticker z XTB" },
  { re: /Cash Operations|Open Positions|Closed Positions/i, what: "název listu z výpisu" },
  { re: /OPEN BUY|CLOSE BUY/i, what: "komentář obchodu" },
  { re: /eyJ[A-Za-z0-9_-]{20,}/, what: "JWT (klíč Supabase)" },
  { re: /\bsb_secret_|\bservice_role\b/, what: "service-role klíč" },
  { re: /"transactions"\s*:/, what: "otevřený ledger" },
];

// index.html smí obsahovat kód aplikace; kontrolují se datové soubory.
const DATA_FILES = /\.json$/;

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });

/** Klíče, které smí zašifrovaný soubor obsahovat. Cokoli navíc je podezřelé. */
const VAULT_KEYS = ["v", "kdf", "iterations", "salt", "iv", "data"];

const isVault = (o: unknown): boolean =>
  !!o && typeof o === "object" &&
  (o as Record<string, unknown>).v === 1 &&
  typeof (o as Record<string, unknown>).data === "string" &&
  typeof (o as Record<string, unknown>).salt === "string";

let problems = 0;
for (const file of walk(OUT_DIR).filter((f) => DATA_FILES.test(f))) {
  const content = readFileSync(file, "utf8");

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    console.error(`✗ ${file}: není platný JSON`);
    problems++;
    continue;
  }

  if (isVault(parsed)) {
    // Šifrotext je náhodný base64 a na náhodná data se textové vzory
    // pouštět nesmí — dřív nebo později v nich "eyJ" nebo osm číslic
    // vyjde náhodou a build spadne na falešný poplach.
    // Kontroluje se proto tvar: jen očekávané klíče, nic navíc.
    const extra = Object.keys(parsed as object).filter((k) => !VAULT_KEYS.includes(k));
    if (extra.length) {
      console.error(`✗ ${file}: trezor obsahuje klíče navíc → ${extra.join(", ")}`);
      problems++;
    }
    const v = parsed as Record<string, number>;
    if (typeof v.iterations !== "number" || v.iterations < 100_000) {
      console.error(`✗ ${file}: příliš málo iterací KDF (${v.iterations})`);
      problems++;
    }
    console.log(`  ${file}: trezor v pořádku (${v.iterations.toLocaleString("cs-CZ")} iterací)`);
    continue;
  }

  // Nešifrované soubory se prohledávají celé.
  if (file.endsWith("data.json")) {
    console.error(`✗ ${file}: měl by být zašifrovaný trezor, ale není`);
    problems++;
  }
  for (const { re, what } of FORBIDDEN) {
    const hit = content.match(re);
    if (hit) {
      console.error(`✗ ${file}: nalezeno ${what} → ${JSON.stringify(hit[0].slice(0, 40))}`);
      problems++;
    }
  }
}

if (problems) {
  console.error(`\n${problems} problémů — publikace zastavena.\n`);
  process.exit(1);
}
console.log("✓ ve výstupu nejsou otevřená data");
