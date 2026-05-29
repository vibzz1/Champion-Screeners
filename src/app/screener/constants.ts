import type { SavedScreener } from "./types";

export const EXCHANGES = ["NSE", "BSE", "SP500", "NASDAQ", "NYSE", "TSE", "KOSPI", "KOSDAQ", "XETRA"];
export const PAGE_SIZES = [20, 50, 100];

export const CHIPS = [
  "rsi > 60", "rsi < 30", "rsi > 50 and rsi < 70",
  "macd = bullish", "macd = bearish",
  "price > sma(20)", "price > sma(50)", "price > sma(200)",
  "sma(20) > sma(50)", "sma(50) > sma(200)",
  "near_52h < 5", "near_52h < 10", "new_52w_high",
  "change > 2", "change < -2",
  "volume > 1000000",
  "price > ema(20)", "ema(20) > ema(50)",
  "price > bb_upper", "price < bb_lower",
];

export const SCREENER_LS_KEY = "mio_screeners_v6";

export const DEFAULTS: SavedScreener[] = [
  { id: "d1", name: "India Setup Scan", exchange: "NSE",   formula: "advol(20) > 500 and advol(50) > 500 and sma(10) > sma(50) and !(sma(20) trend_dn 10) and !(price < sma(50) and sma(50) trend_dn 20) and price > sma(10) and price > sma(20) and sma(10) > sma(20) and price > c[1] and atr(1) > atr(20) * 0.6 and price > low + ((high - low) * 0.4)" },
  { id: "d2", name: "NPC",             exchange: "NSE",   formula: "avg((vol * price),100) > 100000000 and avg((vol * price),20) > 100000000 and (cvol > avol(20) * 1.5 or cvol > avol(100) * 1.5 or cvol > avol(5) * 1.5) and (atr(1) > atr(20) * 1.5 or atr(1) > atr(100) * 1.5 or atr(1) > atr(5) * 1.5) and sma(1) trend_dn 1" },
  { id: "d3", name: "PPC",             exchange: "NSE",   formula: "avg((vol * price),100) > 100000000 and avg((vol * price),20) > 100000000 and (price > sma(100) or price > sma(200)) and (pgo(50) < 4 or pgo(20) < 4) and (cvol > avol(20) * 1.5 or cvol > avol(100) * 1.5 or cvol > avol(5) * 1.5) and (atr(1) > atr(20) * 1.5 or atr(1) > atr(100) * 1.5 or atr(1) > atr(5) * 1.5) and sma(1) trend_up 1" },
  { id: "d4", name: "US Setup Scan",        exchange: "SP500", formula: "advol(20) > 200 and advol(50) > 200 and sma(10) > sma(50) and !(sma(20) trend_dn 10) and !(price < sma(50) and sma(50) trend_dn 20) and price > sma(10) and price > sma(20) and sma(10) > sma(20) and price > c[1] and atr(1) > atr(20) * 0.6 and price > low + ((high - low) * 0.4)" },
  { id: "d5", name: "India Setup Scan 75m", exchange: "NSE",   interval: "75min", formula: "advol(20) > 300 and advol(50) > 300 and sma(10) > sma(50) and !(sma(20) trend_dn 10) and !(price < sma(50) and sma(50) trend_dn 20) and price > sma(10) and price > sma(20) and sma(10) > sma(20) and price > c[1] and atr(1) > atr(20) * 0.6 and price > low + ((high - low) * 0.4)" },
  { id: "d6", name: "US Setup Scan 78m",    exchange: "SP500", interval: "78min", formula: "advol(20) > 100 and advol(50) > 100 and sma(10) > sma(50) and !(sma(20) trend_dn 10) and !(price < sma(50) and sma(50) trend_dn 20) and price > sma(10) and price > sma(20) and sma(10) > sma(20) and price > c[1] and atr(1) > atr(20) * 0.6 and price > low + ((high - low) * 0.4)" },
  { id: "d7", name: "Japan Setup Scan",     exchange: "TSE",   formula: "advol(20) > 1000 and advol(50) > 1000 and sma(10) > sma(50) and !(sma(20) trend_dn 10) and !(price < sma(50) and sma(50) trend_dn 20) and price > sma(10) and price > sma(20) and sma(10) > sma(20) and price > c[1] and atr(1) > atr(20) * 0.6 and price > low + ((high - low) * 0.4)" },
  { id: "d8", name: "Korea Setup Scan (KOSPI)",  exchange: "KOSPI",  formula: "advol(20) > 5000 and advol(50) > 5000 and sma(10) > sma(50) and !(sma(20) trend_dn 10) and !(price < sma(50) and sma(50) trend_dn 20) and price > sma(10) and price > sma(20) and sma(10) > sma(20) and price > c[1] and atr(1) > atr(20) * 0.6 and price > low + ((high - low) * 0.4)" },
  { id: "d10", name: "Korea Setup Scan (KOSDAQ)", exchange: "KOSDAQ", formula: "advol(20) > 2000 and advol(50) > 2000 and sma(10) > sma(50) and !(sma(20) trend_dn 10) and !(price < sma(50) and sma(50) trend_dn 20) and price > sma(10) and price > sma(20) and sma(10) > sma(20) and price > c[1] and atr(1) > atr(20) * 0.6 and price > low + ((high - low) * 0.4)" },
  { id: "d9", name: "Germany Setup Scan",    exchange: "XETRA",  formula: "advol(20) > 10 and advol(50) > 10 and sma(10) > sma(50) and !(sma(20) trend_dn 10) and !(price < sma(50) and sma(50) trend_dn 20) and price > sma(10) and price > sma(20) and sma(10) > sma(20) and price > c[1] and atr(1) > atr(20) * 0.6 and price > low + ((high - low) * 0.4)" },
];
