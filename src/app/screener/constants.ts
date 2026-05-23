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
