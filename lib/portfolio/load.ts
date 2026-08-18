import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { FxMap, Instrument, PriceMap, Tx } from "./types";

/** Klient se service-role klíčem — JEN pro serverové routy a cron, nikdy do prohlížeče. */
export function adminClient(): SupabaseClient {
  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Chybí SUPABASE_URL nebo SUPABASE_SERVICE_ROLE_KEY");
  return createClient(url, key, { auth: { persistSession: false } });
}

export async function loadInstruments(db: SupabaseClient) {
  const { data, error } = await db
    .from("instruments")
    .select("id,xtb_symbol,yahoo_symbol,name,currency,kind,is_benchmark");
  if (error) throw error;

  const bySymbol = new Map<string, Instrument>();
  const idBySymbol = new Map<string, string>();
  const symbolById = new Map<string, string>();
  for (const r of data ?? []) {
    bySymbol.set(r.xtb_symbol, {
      symbol: r.xtb_symbol,
      yahooSymbol: r.yahoo_symbol,
      name: r.name,
      currency: r.currency,
      kind: r.kind,
      isBenchmark: r.is_benchmark,
    });
    idBySymbol.set(r.xtb_symbol, r.id);
    symbolById.set(r.id, r.xtb_symbol);
  }
  return { bySymbol, idBySymbol, symbolById };
}

export async function loadTransactions(db: SupabaseClient, userId: string): Promise<Tx[]> {
  const { data, error } = await db
    .from("transactions")
    .select("id,occurred_on,type,quantity,price,amount,account_currency,comment,instrument_id,instruments(xtb_symbol)")
    .eq("user_id", userId)
    .order("occurred_on", { ascending: true });
  if (error) throw error;

  return (data ?? []).map((r: any) => ({
    id: r.id,
    occurredOn: r.occurred_on,
    type: r.type,
    symbol: r.instruments?.xtb_symbol ?? undefined,
    quantity: r.quantity != null ? Number(r.quantity) : undefined,
    price: r.price != null ? Number(r.price) : undefined,
    amount: Number(r.amount),
    accountCurrency: r.account_currency,
    comment: r.comment ?? undefined,
  }));
}

export async function loadPrices(db: SupabaseClient, symbolById: Map<string, string>, from: string): Promise<PriceMap> {
  const out: PriceMap = new Map();
  const pageSize = 1000;
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await db
      .from("prices")
      .select("instrument_id,d,close")
      .gte("d", from)
      .order("d", { ascending: true })
      .range(offset, offset + pageSize - 1);
    if (error) throw error;
    for (const r of data ?? []) {
      const symbol = symbolById.get(r.instrument_id);
      if (!symbol) continue;
      if (!out.has(symbol)) out.set(symbol, new Map());
      out.get(symbol)!.set(r.d, Number(r.close));
    }
    if (!data || data.length < pageSize) break;
  }
  return out;
}

export async function loadFx(db: SupabaseClient, from: string): Promise<FxMap> {
  const out: FxMap = new Map();
  const pageSize = 1000;
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await db
      .from("fx_rates")
      .select("d,currency,czk_per_unit")
      .gte("d", from)
      .order("d", { ascending: true })
      .range(offset, offset + pageSize - 1);
    if (error) throw error;
    for (const r of data ?? []) {
      if (!out.has(r.currency)) out.set(r.currency, new Map());
      out.get(r.currency)!.set(r.d, Number(r.czk_per_unit));
    }
    if (!data || data.length < pageSize) break;
  }
  return out;
}

export async function loadEvents(db: SupabaseClient, symbolById: Map<string, string>, from: string) {
  const { data, error } = await db
    .from("market_events")
    .select("instrument_id,d,kind,headline,url,severity")
    .gte("d", from)
    .order("d", { ascending: false });
  if (error) throw error;
  return (data ?? []).map((r: any) => ({
    symbol: r.instrument_id ? (symbolById.get(r.instrument_id) ?? null) : null,
    d: r.d,
    kind: r.kind,
    headline: r.headline,
    url: r.url ?? undefined,
    severity: r.severity ?? 1,
  }));
}
