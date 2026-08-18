# Portfolio tracker — datová vrstva v2

Co přibylo: transakční ledger, denní ceny a kurzy, rekonstrukce historie
a rozklad výkyvů. Snapshot v `holdings` zůstává jako kontrola proti dopočtu.

## 1. Databáze

Spusť `supabase/schema_v2.sql` v SQL editoru Supabase. Přidá tabulky
`instruments`, `transactions`, `prices`, `fx_rates`, `portfolio_snapshots`,
`snapshot_positions`, `market_events`, `portfolio_moves` a nastaví RLS.

Mapování XTB → Yahoo je naseedované pro tvých 12 pozic. Pozor na to,
že se tickery liší (`BRKB.US` u XTB je `BRK-B` u Yahoo) — u nového
nákupu je potřeba přidat řádek do `instruments`.

## 2. Proměnné prostředí

```
NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...      # jen server, nikdy do klienta
CRON_SECRET=...                    # náhodný řetězec pro /api/cron/ingest
```

## 3. První naplnění

```bash
curl -X POST "https://<app>/api/cron/ingest?backfill=1" -H "x-cron-secret: $CRON_SECRET"
```

Stáhne 5 let kurzů ČNB a cen z Yahoo a přepočítá snapshoty. Trvá to
řádově minuty. Pak stačí denní běh (bez `?backfill=1`) — nastav ho na
~18:30 SEČ, po fixingu ČNB, ale evropské burzy už mají po close.

## 4. Naplnění ledgeru

`lib/xtb/parse.ts` čte list s hotovostními operacemi a skládá z něj
transakce. XTB nemá kusy a cenu ve sloupcích — jsou v komentáři
(`OPEN BUY 2 @ 123.45`), takže co parser nerozluští, vrací v `unparsed`.

**Nepřeskakuj kontrolu:** funkce `reconcile()` porovná dopočtené kusy
proti listu Open Positions. Dokud tam něco nesedí, je historie posunutá
a všechna čísla nad ní jsou špatně. Rozdíl obvykle znamená transakci
starší než dosažitelný výpis — doplň ji ručně se `source: 'manual'`.

## 5. Zapojení komponenty

```tsx
import PortfolioHistory from "./components/PortfolioHistory";
// v app/page.tsx nahradit statickou <section className="hero-card">
```

## Co je v tom schválně

- **Kurzy z ČNB, ne z trhu.** Historie pak sedí s tím, čím se počítá
  daňové přiznání. Na intraday se používá Yahoo, protože ČNB fixuje
  jednou denně.
- **Snapshoty jsou přepočitatelné.** Jediný zdroj pravdy je
  `transactions`; `portfolio_snapshots` se dají kdykoli zahodit
  a postavit znovu. Když se opraví chybná transakce, historie se
  spraví sama.
- **TWR i XIRR vedle sebe.** TWR ignoruje načasování vkladů, XIRR ne.
  Když se rozcházejí, je to informace, ne chyba — u pravidelných nákupů
  do rostoucího trhu bude XIRR nižší.
- **XIRR pod 30 dní vrací `null`.** Anualizovat dvoudenní výnos dává
  nesmysly a často ani nemá numerické řešení.
- **Odděluje se cenový a měnový efekt.** U portfolia v EUR a USD
  s korunou jako základem je pohyb kurzu často větší než pohyb akcií.
  Přepínač „bez měnového vlivu" ukáže křivku při zafixovaném kurzu
  z prvního dne.

## Klasifikace výkyvů

Každý den, který se vymyká (2× klouzavá směrodatná odchylka nebo 1,5 %
absolutně), dostane štítek:

| štítek | znamená |
|---|---|
| `trh` | stejným směrem šlo ≥ 70 % pozic a benchmark vysvětluje aspoň polovinu pohybu |
| `pozice` | jedna pozice udělala většinu pohybu |
| `kurz` | > 60 % pohybu je měna, ne ceny |
| `vklad` | změnu hodnoty způsobil vklad/výběr, ne výnos |
| `smíšené` | nic z toho jednoznačně |

Shrnutí je **deterministické** — počítá se z čísel, ne z jazykového
modelu. `toLlmContext()` v `attribution.ts` vyrábí payload, kde LLM
dostane jen hotová čísla a pokyn nedopočítávat. Bez toho model dřív
nebo později vymyslí procento, které nikde není.

## Testy

```bash
node --test --experimental-strip-types tests/engine.test.ts
```

Pokrývá víkendové mezery v cenách, FIFO loty včetně tříletého testu,
splity, oddělení cenového a měnového efektu, to že dokup není výnos,
rozdíl TWR vs. XIRR a klasifikaci tří typů výkyvu.

## Co chybí a je na řadě

1. Události do `market_events` — earnings, 8-K, Form 4. Teprve pak
   mají výkyvy u štítku `pozice` konkrétní příčinu.
2. Look-through do ETF (překryv VUAA / XNAS / VWCE s přímo drženými
   MSFT a META).
3. Nákupní kurzy v `transactions.fx_czk` pro daňové podklady.

---

## Finnhub — události k akciím

### Napojení do aplikace

Klíč patří do proměnných prostředí na serveru, nikdy do klientského kódu
(vše s prefixem `NEXT_PUBLIC_` skončí v prohlížeči):

```
FINNHUB_API_KEY=...
```

Ve Vercelu: Settings → Environment Variables → Production. Lokálně do
`.env.local`, které je v `.gitignore`.

První naplnění a pak denní běh:

```bash
curl -X POST "https://<app>/api/cron/events?backfill=1" -H "x-cron-secret: $CRON_SECRET"
curl -X POST "https://<app>/api/cron/events"            -H "x-cron-secret: $CRON_SECRET"
```

Pouštět **až po** `/api/cron/ingest`, ne souběžně — události se navazují
na dny, které už mají ocenění.

### Co se odsud bere

| zdroj | k čemu |
|---|---|
| insider transakce | klastry nákupů kódem `P` (nákup na trhu za vlastní peníze) |
| earnings | skutečné EPS proti odhadu, překvapení nad 10 % dostane vyšší závažnost |
| filings | jen 8-K, 10-Q, 10-K, S-1, S-3, SC 13D — zbytek je administrativa |
| zprávy | pouze titulek a odkaz, max 3 denně; obsah článků se nekopíruje |

Volá se **jen pro `kind = 'stock'`**. VUAA, XNAS, 4GLD a spol. nemají
vedení ani výsledovku, takže by šlo o plýtvání limitem.

### Na co si dát pozor

- **Tichý úspěch je horší než chyba.** Endpointy, které tarif nepokrývá,
  vracejí 403. Kdyby se to spolklo, vypadalo by to, že insideři nic
  nedělají. Route proto vrací pole `failures` s rozlišením
  `auth` / `premium` / `rate_limit` a při špatném klíči odpoví 401.
- **Insider data jsou zdarma i z EDGARu** (Form 4). Když je u Finnhubu
  ten endpoint placený, vyplatí se ho nahradit — `INSIDER_CODES`
  a `findInsiderClusters()` na zdroji nezávisí.
- Volání se samo drží pod 50 za minutu.

### Napojení do konverzace s Claudem

Do chatu se API klíč nedává a nedá. Aby šlo Finnhub data použít
v konverzaci, musí nad nimi běžet MCP server na veřejné adrese, který se
přidá jako custom konektor (Settings → Connectors → Add custom connector).
Připojení navazuje Anthropic ze svých serverů, takže localhost nestačí.

Jednodušší cesta: nechat data téct do Supabase přes cron výš a použít
Supabase konektor, který už připojený je. Pak jde nad `market_events`
a `portfolio_moves` rovnou konverzovat bez psaní vlastního serveru.

---

## Varianta bez serveru: GitHub Actions + Pages

Pro jednoho uživatele nepotřebuješ ani Supabase, ani Vercel. Actions se
postarají o cron, Pages o hosting, a obojí je zdarma.

### Past, kterou je potřeba znát

**GitHub Pages je vždycky veřejný web.** Na free plánu jde Pages jen
z veřejného repozitáře; Pro sice umožní Pages i z privátního, ale
publikovaná stránka zůstává veřejná. Soukromě publikovat jde jen
v Enterprise Cloud organizaci.

Takže cokoli ta stránka servíruje si může kdokoli stáhnout na uhodnutelné
adrese. Proto se do `docs/` nezapisuje nic čitelného: ledger i spočítaná
řada jsou zašifrované heslem (AES-GCM, klíč z PBKDF2-SHA256, 600 000
iterací). Bez hesla je soubor náhodný šum.

Veřejně čitelný zůstane jediný soubor — `status.json` s časem posledního
přepočtu a počtem dní. Nic víc.

### Nastavení

```bash
# 1. Heslo. Je to JEDINÁ ochrana — sílu kontroluje seal-ledger a build-site
#    a slabé heslo odmítnou. Čtyři až pět náhodných slov je ideál.
export PORTFOLIO_PASSPHRASE='...'

# 2. Ledger z výpisů (kontroluje kusy proti Open Positions a při
#    nesrovnalosti se zastaví)
node --experimental-strip-types scripts/seal-ledger.ts vypisy/*.xlsx

# 3. Lokální zkouška
node --experimental-strip-types scripts/build-site.ts
node --experimental-strip-types scripts/check-output.ts
```

Na GitHubu: Settings → Secrets and variables → Actions → New secret,
`PORTFOLIO_PASSPHRASE` (a volitelně `FINNHUB_API_KEY`). Pak
Settings → Pages → Source: GitHub Actions.

Workflow běží 18:30 UTC ve všední dny a dá se spustit i ručně přes
workflow_dispatch.

### Pořadí kroků ve workflow je záměrné

1. **Testy před přepočtem.** Rozbitý engine nesmí publikovat čísla.
2. **Přepočet a zašifrování.**
3. **`check-output.ts` před nahráním.** Ověří, že `docs/data.json` je
   opravdu trezor, má jen očekávané klíče a dost iterací; ostatní soubory
   prohledá na čísla účtů, tickery a klíče.
4. Teprve pak commit a deploy.

Textové vzory se schválně nepouštějí na šifrotext. Náhodný base64 dřív
nebo později obsahuje `eyJ` nebo osm číslic za sebou a build by padal na
falešný poplach — u zašifrovaného souboru se proto kontroluje tvar.

### Kurzy

Výchozí zdroj je ČNB, protože jejími kurzy se počítá daňové přiznání.
`FX_SOURCE=yahoo` přepne na tržní kurzy, ale je to vědomé rozhodnutí, ne
tichý fallback — jinak by se čísla měnila podle toho, co zrovna jelo.
Zvolený zdroj je uložený v `metrics.fxSource`.

### Co dát pozor, aby neuniklo

- `.xlsx` výpisy jsou v `.gitignore` a v repozitáři nemají co dělat
- fixture pro testy anonymizuj — čísla účtů a částky tam nejsou potřeba
- heslo nikdy do repozitáře, jen do GitHub Secrets
- když heslo ztratíš, data se nedají obnovit; ledger se dá znovu postavit
  z původních výpisů z XTB

### Proč na hesle záleží víc než jinde

U běžné přihlašovací obrazovky útočník zkouší hesla proti serveru: pomalu,
s limitem pokusů, a někdo si toho všimne. Tady si stáhne `data.json`
a zkouší offline, kolikrát chce a nikdo se to nedozví.

Jediné, co proti tomu stojí, je velikost prostoru možností. Proto:

- 600 000 iterací PBKDF2 — jeden pokus stojí zlomek sekundy místo mikrosekundy
- `seal-ledger.ts` i `build-site.ts` heslo kontrolují a slabé odmítnou
- odhad entropie sráží uhodnutelné vzory: `mojePortfolio2026` vyjde na 31
  bitů, ne na 101, protože slovníkové slovo není náhodných třináct znaků

Doporučení: čtyři až pět náhodných slov z password manageru. Ne věta, ne nic
souvisejícího s portfoliem, ne letopočet.

### Než to poprvé pushneš

1. `git status` — v seznamu nesmí být žádné `.xlsx`
2. `cat docs/data.json | head -c 200` — musí to vypadat jako `{"v":1,"kdf":...}`
3. `node --experimental-strip-types scripts/check-output.ts` — musí projít
4. Heslo je v password manageru, ne v repozitáři ani v poznámkách
5. Po prvním deploy otevři adresu v anonymním okně a zkus zadat špatné heslo
