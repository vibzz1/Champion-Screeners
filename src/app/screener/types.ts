export interface SavedScreener {
  id: string;
  name: string;
  exchange: string;
  formula: string;
  interval?: string; // "1d" (default) | "15min" (NSE/BSE) | "75min" (NSE/BSE) | "78min" (US)
}

export interface OHLCV {
  date: string; open: number; high: number; low: number; close: number; volume: number;
  sma20?: number | null; sma50?: number | null;
}

export interface Result {
  symbol: string; ticker: string; name: string; sector: string; industry: string;
  cap_size: string; market_cap: number | null;
  price: number; change_pct: number; volume: number; avg_vol_20?: number;
  sma20: number | null; sma50: number | null; sma200: number | null;
  rsi: number | null; macd_bullish: boolean;
  high_52w: number | null; pct_from_52w_high: number | null; new_52w_high: boolean;
  sparkline: number[]; ohlcv: OHLCV[];
}
