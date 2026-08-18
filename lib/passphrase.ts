/**
 * Kontrola síly hesla.
 *
 * U zašifrovaného souboru na veřejné adrese je heslo JEDINÁ ochrana.
 * Útočník si soubor stáhne a zkouší hesla offline — bez limitu pokusů,
 * bez zámku účtu, bez toho, aby se o tom kdokoli dozvěděl. Proti tomu
 * pomáhá jen dost velký prostor možností.
 *
 * Odhad je záměrně konzervativní: raději dobré heslo odmítnout, než
 * slabé pustit.
 */

export type Strength = {
  bits: number;
  ok: boolean;
  problems: string[];
  /** Odhad, jak dlouho by trvalo projít polovinu prostoru při 600k iteracích PBKDF2. */
  crackEstimate: string;
};

/** Vzory, které se v heslech opakují a útočník je zkouší první. */
const WEAK_PATTERNS: Array<{ re: RegExp; why: string }> = [
  { re: /portfolio|invest|akcie|stock|xtb|finance|money|penize|peníze/i, why: "obsahuje slovo související s tím, co chrání" },
  { re: /(19|20)\d{2}/, why: "obsahuje letopočet" },
  { re: /qwert|asdf|yxcv|1234|abcd|heslo|password|admin/i, why: "obsahuje běžnou klávesovou nebo slovníkovou sekvenci" },
  { re: /^(.)\1+$/, why: "je jeden opakovaný znak" },
  { re: /(.{2,})\1{2,}/, why: "obsahuje opakující se blok" },
];

const classSize = (s: string): number => {
  let size = 0;
  if (/[a-z]/.test(s)) size += 26;
  if (/[A-Z]/.test(s)) size += 26;
  if (/[0-9]/.test(s)) size += 10;
  if (/[^a-zA-Z0-9]/.test(s)) size += 20;
  return size || 1;
};

function humanTime(seconds: number): string {
  if (seconds < 3600) return "méně než hodinu";
  const years = seconds / (365.25 * 86_400);
  if (years < 1) return `${Math.round(seconds / 86_400)} dní`;
  if (years < 1e3) return `${Math.round(years)} let`;
  if (years < 1e6) return `${Math.round(years / 1e3)} tisíc let`;
  if (years < 1e9) return `${Math.round(years / 1e6)} milionů let`;
  return "prakticky nekonečně";
}

export function checkPassphrase(pass: string, minBits = 70): Strength {
  const problems: string[] = [];

  // Fráze z několika slov: entropie roste s počtem slov, ne se znaky.
  const words = pass.trim().split(/[\s\-_.]+/).filter((w) => w.length >= 3);
  const unique = new Set(pass);

  // Slovníková fráze: ~11 bitů na slovo u běžné slovní zásoby.
  // Náhodný řetězec: log2(velikost abecedy) na znak, ale zastropováno
  // počtem RŮZNÝCH znaků — "aaaaaaaaaaaaaaaa" není silné heslo.
  const phraseBits = words.length >= 4 ? words.length * 11 : 0;
  const charBits = Math.min(pass.length, unique.size * 2) * Math.log2(classSize(pass));
  let bits = Math.round(Math.max(phraseBits, charBits));

  if (pass.length < 16) problems.push("je kratší než 16 znaků");
  if (unique.size < 8) problems.push("používá příliš málo různých znaků");

  // Každý uhodnutelný vzor prostor hledání drasticky zmenšuje. Naivní vzoreček
  // "délka × velikost abecedy" počítá slovníkové slovo jako náhodné znaky —
  // proto by "mojePortfolio2026" vyšlo na 101 bitů, ačkoli ho útočník
  // se seznamem slov trefí mezi prvními. Za každý vzor proto srážka.
  let matched = 0;
  for (const { re, why } of WEAK_PATTERNS) {
    if (re.test(pass)) { problems.push(why); matched++; }
  }
  bits = Math.max(0, bits - matched * 35);

  if (bits < minBits) problems.push(`odhadovaná entropie ${bits} bitů je pod hranicí ${minBits}`);

  // 600k iterací PBKDF2 ≈ 10k pokusů/s na slušném GPU (konzervativní odhad).
  const seconds = Math.pow(2, bits - 1) / 10_000;

  return { bits, ok: problems.length === 0, problems, crackEstimate: humanTime(seconds) };
}

/** Doporučení, které se vypíše, když heslo neprojde. */
export const PASSPHRASE_ADVICE = [
  "Použij čtyři až pět náhodných slov oddělených mezerou, například vygenerovaných",
  "password managerem. Nesmí to být věta, kterou by šlo uhodnout, ani nic",
  "souvisejícího s portfoliem. Ulož si ho do password manageru — když ho ztratíš,",
  "data se nedají obnovit (ledger se ale dá znovu postavit z výpisů z XTB).",
].join("\n  ");
