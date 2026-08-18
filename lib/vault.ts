/**
 * Trezor pro data, která leží na veřejné adrese.
 *
 * GitHub Pages servíruje všechno komukoli, takže ledger ani spočítaná řada
 * nesmí odejít v čitelné podobě. Šifruje se heslem: v GitHub Actions při
 * sestavení, v prohlížeči při odemčení.
 *
 * AES-GCM (šifra i kontrola integrity v jednom) + PBKDF2-SHA256 na odvození
 * klíče z hesla. Používá se WebCrypto, které je stejné v Node 22 i v prohlížeči,
 * takže tenhle soubor běží na obou stranách beze změny.
 */

export type Vault = {
  v: 1;
  kdf: "PBKDF2-SHA256";
  iterations: number;
  salt: string;      // base64
  iv: string;        // base64
  data: string;      // base64, AES-GCM ciphertext + tag
};

/** Vyšší číslo = pomalejší útok hrubou silou. Odemčení v prohlížeči trvá zlomek sekundy. */
const DEFAULT_ITERATIONS = 600_000;

const enc = new TextEncoder();
const dec = new TextDecoder();

const toB64 = (buf: ArrayBuffer | Uint8Array): string => {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
};

const fromB64 = (s: string): Uint8Array => {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

async function deriveKey(passphrase: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey("raw", enc.encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt as BufferSource, iterations, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function seal(plaintext: string, passphrase: string, iterations = DEFAULT_ITERATIONS): Promise<Vault> {
  if (!passphrase || passphrase.length < 12) {
    // Heslo je jediná ochrana veřejně dostupného souboru. Krátké nemá smysl.
    throw new Error("Heslo musí mít aspoň 12 znaků");
  }
  // Sůl i IV musí být pokaždé jiné, jinak se opakovaným buildem prozradí,
  // co se mezi dvěma verzemi změnilo.
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt, iterations);
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource }, key, enc.encode(plaintext));
  return { v: 1, kdf: "PBKDF2-SHA256", iterations, salt: toB64(salt), iv: toB64(iv), data: toB64(data) };
}

export async function open(vault: Vault, passphrase: string): Promise<string> {
  if (vault?.v !== 1 || vault.kdf !== "PBKDF2-SHA256") throw new Error("Neznámý formát trezoru");
  const key = await deriveKey(passphrase, fromB64(vault.salt), vault.iterations);
  try {
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromB64(vault.iv) as BufferSource },
      key,
      fromB64(vault.data) as BufferSource,
    );
    return dec.decode(plain);
  } catch {
    // AES-GCM ověřuje i integritu, takže sem spadne špatné heslo i poškozený soubor.
    throw new Error("Špatné heslo nebo poškozená data");
  }
}

export const sealJson = async (value: unknown, passphrase: string, iterations?: number) =>
  seal(JSON.stringify(value), passphrase, iterations);

export const openJson = async <T,>(vault: Vault, passphrase: string): Promise<T> =>
  JSON.parse(await open(vault, passphrase)) as T;
