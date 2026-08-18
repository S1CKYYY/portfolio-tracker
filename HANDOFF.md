# Předání do Claude Code

Přečti si to celé, než začneš. Rozhodnutí níž nejsou libovolná — každé
vzniklo z chyby, která se v tomhle projektu už jednou stala.

## Co to je

Tracker portfolia z XTB. Ledger transakcí je jediný zdroj pravdy, historie
i výkyvy se z něj dopočítávají. Hostuje se staticky na GitHub Pages,
publikovaná data jsou zašifrovaná heslem.

Bez serveru: GitHub Actions dělají cron, `docs/` je výstup.

## Co udělat

1. **package.json** — dependency `xlsx@0.18.5`, `engines.node >= 22`,
   `"test": "node --test --experimental-strip-types tests/*.test.ts"`
2. `npm install`, pak `npm test` — musí projít **49 testů**
3. `node --experimental-strip-types scripts/seal-ledger.ts vypisy/*.xlsx`
4. `node --experimental-strip-types scripts/build-site.ts`
5. `node --experimental-strip-types scripts/check-output.ts`
6. `git init`, první commit — **před commitem ukaž `git status`** a ověř,
   že tam není žádný `.xlsx` ani nic ze složky `vypisy/`

Heslo je v proměnné `PORTFOLIO_PASSPHRASE`. **Nevypisuj ho, nelogguj ho,
nedávej ho do souborů.** Skripty si ho přečtou samy.

Nastavení GitHub Secret, zapnutí Pages a spuštění workflow dělá uživatel
sám v prohlížeči. Ty to nedělej a nežádej o přihlašovací údaje.

## Co v tom projektu nejde vidět na první pohled

**XTB exportuje operace od nejnovější.** V jednom dni se běžně potká nákup
i prodej téže akcie. Řazení jen podle data (bez času) posunulo prodej před
jeho nákupy, FIFO nenašlo lot a obchod tiše zahodilo. Proto `Tx.occurredAt`
a `byTime()` v `engine.ts`. Neřaď nikde podle `occurredOn`.

**Neoceněná pozice se počítá jako nulová.** Yahoo nemá pro `VUAA.DE` data
před 30. 12. 2024. Den, kdy cena „naskočila", vypadal jako obří výnos
a přes součin nafoukl TWR na 133 %. Proto `DayRow.missing`,
`valuationComplete` a to, že takové dny do TWR nevstupují. Nikdy z chybějící
ceny nedělej nulu.

**Sešit má tři listy a dva se jmenují podobně.** `Closed Positions` je
v sešitu první a taky obsahuje podřetězec „positions". Hledání listu podle
volného podřetězce vzalo špatný list a všechny držené kusy pak vypadaly
jako přebytek. Listy se hledají uspořádanými vzory od nejpřesnějšího.

**Open Positions mají pod jednou hlavičkou dva druhy řádků** — agregát za
instrument (vyplněná Category, prázdný Type) a jednotlivé loty (Type=BUY).
Kdo je nerozliší, napočítá si portfolio dvakrát.

**Denní změna se nepočítá z `chartPreviousClose`.** To je cena před
začátkem vyžádaného okna, u `range=5d` tedy šest seancí stará. Bere se
poslední dvojice barů ze série, viz `derivePreviousClose()`.

**Kurzy z ČNB, ne tržní.** Jejími kurzy se počítá daňové přiznání, takže
historie sedí s tím, co se pak reálně vykazuje. `FX_SOURCE=yahoo` existuje,
ale je to vědomé rozhodnutí, ne fallback při výpadku.

**Do `docs/` nesmí nic čitelného.** Pages je veřejný web i u privátního
repozitáře. `check-output.ts` to hlídá — u zašifrovaného souboru kontroluje
tvar, ne obsah, protože textové vzory na náhodném base64 dřív nebo později
vyhodí falešný poplach.

## Neověřené

**Kurzy ČNB nikdy neběžely proti živému API.** Parser v `lib/market/fx.ts`
je psaný podle formátu `denni_kurz.txt` a `rok.txt`, ale netestovaný.
Krok 4 je jeho první ostrý běh. Když spadne, ukaž syrovou odpověď
a oprav parser — neobcházej to přepnutím na Yahoo.

**Finnhub** (`lib/market/finnhub.ts`, `app/api/cron/events/`) je napsaný,
ale nevolaný. Patří k serverové variantě na Vercelu, ne k této statické.
Nech ho být, dokud na něj nedojde.

## Čeho se držet

- Testy jsou v `tests/`, je jich 49 a jedou na fixture v reálném rozvržení
  z XTB. Když měníš parser nebo engine, pusť je.
- Nikdy nedělej z chybějících dat nulu. Radši nech build spadnout —
  tichá nula je v tomhle projektu hlavní nepřítel.
- Fixture v testech je anonymizovaná. Nedávej do ní reálná čísla účtů
  ani částky.
