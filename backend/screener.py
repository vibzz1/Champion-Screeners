"""
screener.py — Stock Screener backend

Pipeline:
  1. UNIVERSES loaded from data/nse_tickers.txt / data/bse_tickers.txt
     (one symbol per line; add any NSE/BSE symbol, no code change needed)
  2. Company names pre-loaded from data/nse_names.csv  (2109 NSE EQ stocks)
  3. OHLCV downloaded in batches of 200, cached to cache/ohlcv/<exchange>_<date>.pkl
     — first run: ~2-3 min for 2000+ stocks; same-day repeat: <5 s from disk
  4. Indicators computed for every ticker in the universe
  5. Filters applied → matched tickers only
  6. Matched tickers enriched with sector/industry/cap (from static dict →
     disk info-cache → yfinance fast_info, in that order)
"""

import csv
import pickle
import datetime
import os
import json
import re as _re_module
import concurrent.futures
import yfinance as yf
import pandas as pd
import numpy as np
from pathlib import Path
from typing import Optional, Dict, Any, List
import pytz

# Pre-compiled regex used in the hot apply_filters loop
_NOT_BELOW_RE    = _re_module.compile(r'not_price_below_sma(\d+)_and_trend_dn_(\d+)')
_NOT_SMA_TREND_RE = _re_module.compile(r'not_sma(\d+)_trend_dn_\d+')

# ── Paths ──────────────────────────────────────────────────────────────────
BASE_DIR        = Path(__file__).parent
DATA_DIR        = BASE_DIR / "data"
CACHE_DIR       = Path(os.environ.get("CACHE_DIR", str(BASE_DIR / "cache")))
OHLCV_CACHE_DIR = CACHE_DIR / "ohlcv"
INFO_CACHE_FILE = CACHE_DIR / "info_cache.json"

CACHE_DIR.mkdir(parents=True, exist_ok=True)
OHLCV_CACHE_DIR.mkdir(parents=True, exist_ok=True)

# ── Load company names from NSE equity CSV ────────────────────────────────
def _load_nse_names() -> Dict[str, str]:
    """symbol.NS / symbol.BO → company name from EQUITY_L.csv export."""
    path = DATA_DIR / "nse_names.csv"
    names: Dict[str, str] = {}
    if not path.exists():
        return names
    with open(path, newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            sym  = row["symbol"].strip()
            name = row["name"].strip().title()   # Title-case the all-caps NSE name
            names[f"{sym}.NS"] = name
            names[f"{sym}.BO"] = name
    return names

_NSE_NAMES: Dict[str, str] = _load_nse_names()   # ~2109 entries

# ── Static info dict (curated: name + sector + industry + cap) ────────────
# Covers Nifty 500 + popular mid/small caps with accurate sector data.
# For any ticker NOT listed here, we fall back to yfinance fast_info.

_STATIC_INFO: Dict[str, Dict] = {
    # ── Mega Caps ─────────────────────────────────────────────────────────
    "RELIANCE.NS":   {"sector":"Energy",           "industry":"Oil & Gas Refining",      "cap_size":"Mega",  "market_cap":1820000},
    "TCS.NS":        {"sector":"Technology",       "industry":"IT Services",             "cap_size":"Mega",  "market_cap":1410000},
    "HDFCBANK.NS":   {"sector":"Financials",       "industry":"Private Banks",           "cap_size":"Mega",  "market_cap":1380000},
    "ICICIBANK.NS":  {"sector":"Financials",       "industry":"Private Banks",           "cap_size":"Mega",  "market_cap":940000},
    "BHARTIARTL.NS": {"sector":"Communication",    "industry":"Telecom",                 "cap_size":"Mega",  "market_cap":920000},
    "INFY.NS":       {"sector":"Technology",       "industry":"IT Services",             "cap_size":"Mega",  "market_cap":720000},
    "LICI.NS":       {"sector":"Financials",       "industry":"Insurance",               "cap_size":"Mega",  "market_cap":620000},
    "ITC.NS":        {"sector":"Consumer Staples", "industry":"FMCG",                    "cap_size":"Mega",  "market_cap":570000},
    # ── Large Caps ────────────────────────────────────────────────────────
    "HINDUNILVR.NS": {"sector":"Consumer Staples", "industry":"FMCG",                    "cap_size":"Large", "market_cap":490000},
    "SBIN.NS":       {"sector":"Financials",       "industry":"Public Banks",            "cap_size":"Large", "market_cap":720000},
    "BAJFINANCE.NS": {"sector":"Financials",       "industry":"NBFC",                    "cap_size":"Large", "market_cap":430000},
    "KOTAKBANK.NS":  {"sector":"Financials",       "industry":"Private Banks",           "cap_size":"Large", "market_cap":400000},
    "LT.NS":         {"sector":"Industrials",      "industry":"Engineering",             "cap_size":"Large", "market_cap":480000},
    "SUNPHARMA.NS":  {"sector":"Healthcare",       "industry":"Pharmaceuticals",         "cap_size":"Large", "market_cap":340000},
    "HCLTECH.NS":    {"sector":"Technology",       "industry":"IT Services",             "cap_size":"Large", "market_cap":470000},
    "MARUTI.NS":     {"sector":"Consumer Disc.",   "industry":"Automobiles",             "cap_size":"Large", "market_cap":380000},
    "TITAN.NS":      {"sector":"Consumer Disc.",   "industry":"Jewellery",               "cap_size":"Large", "market_cap":290000},
    "NTPC.NS":       {"sector":"Utilities",        "industry":"Power Generation",        "cap_size":"Large", "market_cap":330000},
    "AXISBANK.NS":   {"sector":"Financials",       "industry":"Private Banks",           "cap_size":"Large", "market_cap":360000},
    "WIPRO.NS":      {"sector":"Technology",       "industry":"IT Services",             "cap_size":"Large", "market_cap":275000},
    "ASIANPAINT.NS": {"sector":"Materials",        "industry":"Paints",                  "cap_size":"Large", "market_cap":220000},
    "M&M.NS":        {"sector":"Consumer Disc.",   "industry":"Automobiles",             "cap_size":"Large", "market_cap":380000},
    "BAJAJFINSV.NS": {"sector":"Financials",       "industry":"Insurance",               "cap_size":"Large", "market_cap":280000},
    "POWERGRID.NS":  {"sector":"Utilities",        "industry":"Power Transmission",      "cap_size":"Large", "market_cap":265000},
    "ULTRACEMCO.NS": {"sector":"Materials",        "industry":"Cement",                  "cap_size":"Large", "market_cap":240000},
    "NESTLEIND.NS":  {"sector":"Consumer Staples", "industry":"FMCG",                    "cap_size":"Large", "market_cap":220000},
    "ADANIPORTS.NS": {"sector":"Industrials",      "industry":"Ports & Logistics",       "cap_size":"Large", "market_cap":265000},
    "TATAMOTORS.NS": {"sector":"Consumer Disc.",   "industry":"Automobiles",             "cap_size":"Large", "market_cap":265000},
    "TECHM.NS":      {"sector":"Technology",       "industry":"IT Services",             "cap_size":"Large", "market_cap":175000},
    "INDUSINDBK.NS": {"sector":"Financials",       "industry":"Private Banks",           "cap_size":"Large", "market_cap":120000},
    "DIVISLAB.NS":   {"sector":"Healthcare",       "industry":"Pharmaceuticals",         "cap_size":"Large", "market_cap":130000},
    "CIPLA.NS":      {"sector":"Healthcare",       "industry":"Pharmaceuticals",         "cap_size":"Large", "market_cap":150000},
    "DRREDDY.NS":    {"sector":"Healthcare",       "industry":"Pharmaceuticals",         "cap_size":"Large", "market_cap":145000},
    "GRASIM.NS":     {"sector":"Materials",        "industry":"Diversified",             "cap_size":"Large", "market_cap":175000},
    "JSWSTEEL.NS":   {"sector":"Materials",        "industry":"Steel",                   "cap_size":"Large", "market_cap":220000},
    "HINDALCO.NS":   {"sector":"Materials",        "industry":"Aluminium",               "cap_size":"Large", "market_cap":145000},
    "TATASTEEL.NS":  {"sector":"Materials",        "industry":"Steel",                   "cap_size":"Large", "market_cap":190000},
    "COALINDIA.NS":  {"sector":"Energy",           "industry":"Coal Mining",             "cap_size":"Large", "market_cap":230000},
    "ONGC.NS":       {"sector":"Energy",           "industry":"Oil & Gas Exploration",   "cap_size":"Large", "market_cap":320000},
    "BPCL.NS":       {"sector":"Energy",           "industry":"Oil & Gas Refining",      "cap_size":"Large", "market_cap":125000},
    "BRITANNIA.NS":  {"sector":"Consumer Staples", "industry":"FMCG",                    "cap_size":"Large", "market_cap":120000},
    "HEROMOTOCO.NS": {"sector":"Consumer Disc.",   "industry":"Two Wheelers",            "cap_size":"Large", "market_cap":95000},
    "EICHERMOT.NS":  {"sector":"Consumer Disc.",   "industry":"Two Wheelers",            "cap_size":"Large", "market_cap":140000},
    "APOLLOHOSP.NS": {"sector":"Healthcare",       "industry":"Hospitals",               "cap_size":"Large", "market_cap":95000},
    "SBILIFE.NS":    {"sector":"Financials",       "industry":"Insurance",               "cap_size":"Large", "market_cap":140000},
    "BAJAJ-AUTO.NS": {"sector":"Consumer Disc.",   "industry":"Automobiles",             "cap_size":"Large", "market_cap":210000},
    "UPL.NS":        {"sector":"Materials",        "industry":"Agrochemicals",           "cap_size":"Large", "market_cap":35000},
    "TATACONSUM.NS": {"sector":"Consumer Staples", "industry":"FMCG",                    "cap_size":"Large", "market_cap":90000},
    "HDFCLIFE.NS":   {"sector":"Financials",       "industry":"Insurance",               "cap_size":"Large", "market_cap":130000},
    "LTIM.NS":       {"sector":"Technology",       "industry":"IT Services",             "cap_size":"Large", "market_cap":155000},
    "ADANIENT.NS":   {"sector":"Industrials",      "industry":"Diversified",             "cap_size":"Large", "market_cap":380000},
    "ADANIGREEN.NS": {"sector":"Utilities",        "industry":"Renewable Energy",        "cap_size":"Large", "market_cap":350000},
    "SIEMENS.NS":    {"sector":"Industrials",      "industry":"Industrial Equipment",    "cap_size":"Large", "market_cap":130000},
    "ABB.NS":        {"sector":"Industrials",      "industry":"Industrial Equipment",    "cap_size":"Large", "market_cap":110000},
    "HAVELLS.NS":    {"sector":"Consumer Disc.",   "industry":"Electricals",             "cap_size":"Large", "market_cap":100000},
    "DMART.NS":      {"sector":"Consumer Staples", "industry":"Retail",                  "cap_size":"Large", "market_cap":250000},
    "ETERNAL.NS":    {"sector":"Consumer Disc.",   "industry":"Food Delivery",           "cap_size":"Large", "market_cap":200000},
    "TRENT.NS":      {"sector":"Consumer Disc.",   "industry":"Retail",                  "cap_size":"Large", "market_cap":175000},
    "DLF.NS":        {"sector":"Real Estate",      "industry":"Real Estate Dev.",        "cap_size":"Large", "market_cap":190000},
    "PIDILITIND.NS": {"sector":"Materials",        "industry":"Adhesives",               "cap_size":"Large", "market_cap":120000},
    "MARICO.NS":     {"sector":"Consumer Staples", "industry":"FMCG",                    "cap_size":"Large", "market_cap":68000},
    "DABUR.NS":      {"sector":"Consumer Staples", "industry":"FMCG",                    "cap_size":"Large", "market_cap":80000},
    "GODREJCP.NS":   {"sector":"Consumer Staples", "industry":"FMCG",                    "cap_size":"Large", "market_cap":100000},
    "COLPAL.NS":     {"sector":"Consumer Staples", "industry":"FMCG",                    "cap_size":"Large", "market_cap":58000},
    "LUPIN.NS":      {"sector":"Healthcare",       "industry":"Pharmaceuticals",         "cap_size":"Large", "market_cap":85000},
    "AUROPHARMA.NS": {"sector":"Healthcare",       "industry":"Pharmaceuticals",         "cap_size":"Large", "market_cap":62000},
    "TORNTPHARM.NS": {"sector":"Healthcare",       "industry":"Pharmaceuticals",         "cap_size":"Large", "market_cap":85000},
    "BANKBARODA.NS": {"sector":"Financials",       "industry":"Public Banks",            "cap_size":"Large", "market_cap":115000},
    "CANBK.NS":      {"sector":"Financials",       "industry":"Public Banks",            "cap_size":"Large", "market_cap":95000},
    "PNB.NS":        {"sector":"Financials",       "industry":"Public Banks",            "cap_size":"Large", "market_cap":110000},
    "MUTHOOTFIN.NS": {"sector":"Financials",       "industry":"Gold Loans",              "cap_size":"Large", "market_cap":80000},
    "CHOLAFIN.NS":   {"sector":"Financials",       "industry":"NBFC",                    "cap_size":"Large", "market_cap":95000},
    "ICICIPRULI.NS": {"sector":"Financials",       "industry":"Insurance",               "cap_size":"Large", "market_cap":75000},
    "MAXHEALTH.NS":  {"sector":"Healthcare",       "industry":"Hospitals",               "cap_size":"Large", "market_cap":92000},
    "PFC.NS":        {"sector":"Financials",       "industry":"Power Finance",           "cap_size":"Large", "market_cap":130000},
    "RECLTD.NS":     {"sector":"Financials",       "industry":"Power Finance",           "cap_size":"Large", "market_cap":120000},
    "IRFC.NS":       {"sector":"Financials",       "industry":"Railway Finance",         "cap_size":"Large", "market_cap":160000},
    "IRCTC.NS":      {"sector":"Consumer Disc.",   "industry":"Travel Services",         "cap_size":"Large", "market_cap":62000},
    "INDIGO.NS":     {"sector":"Industrials",      "industry":"Airlines",                "cap_size":"Large", "market_cap":62000},
    "TATAPOWER.NS":  {"sector":"Utilities",        "industry":"Power Generation",        "cap_size":"Large", "market_cap":90000},
    "NHPC.NS":       {"sector":"Utilities",        "industry":"Hydro Power",             "cap_size":"Large", "market_cap":65000},
    "VEDL.NS":       {"sector":"Materials",        "industry":"Diversified Metals",      "cap_size":"Large", "market_cap":130000},
    "NMDC.NS":       {"sector":"Materials",        "industry":"Iron Ore Mining",         "cap_size":"Large", "market_cap":60000},
    "SAIL.NS":       {"sector":"Materials",        "industry":"Steel",                   "cap_size":"Large", "market_cap":45000},
    "SHREECEM.NS":   {"sector":"Materials",        "industry":"Cement",                  "cap_size":"Large", "market_cap":90000},
    "AMBUJACEM.NS":  {"sector":"Materials",        "industry":"Cement",                  "cap_size":"Large", "market_cap":130000},
    "SRF.NS":        {"sector":"Materials",        "industry":"Specialty Chemicals",     "cap_size":"Large", "market_cap":55000},
    "PIIND.NS":      {"sector":"Materials",        "industry":"Agrochemicals",           "cap_size":"Large", "market_cap":55000},
    "MPHASIS.NS":    {"sector":"Technology",       "industry":"IT Services",             "cap_size":"Large", "market_cap":52000},
    "PERSISTENT.NS": {"sector":"Technology",       "industry":"IT Services",             "cap_size":"Large", "market_cap":90000},
    "LTTS.NS":       {"sector":"Technology",       "industry":"Engineering Services",    "cap_size":"Large", "market_cap":55000},
    "BOSCHLTD.NS":   {"sector":"Consumer Disc.",   "industry":"Auto Components",         "cap_size":"Large", "market_cap":65000},
    "MOTHERSON.NS":  {"sector":"Industrials",      "industry":"Auto Components",         "cap_size":"Large", "market_cap":88000},
    "MRF.NS":        {"sector":"Consumer Disc.",   "industry":"Tyres",                   "cap_size":"Large", "market_cap":48000},
    "BALKRISIND.NS": {"sector":"Industrials",      "industry":"Tyres",                   "cap_size":"Large", "market_cap":44000},
    "APOLLOTYRE.NS": {"sector":"Consumer Disc.",   "industry":"Tyres",                   "cap_size":"Large", "market_cap":37000},
    "TATACHEM.NS":   {"sector":"Materials",        "industry":"Chemicals",               "cap_size":"Large", "market_cap":27000},
    "GODREJPROP.NS": {"sector":"Real Estate",      "industry":"Real Estate Dev.",        "cap_size":"Large", "market_cap":55000},
    "JSWENERGY.NS":  {"sector":"Utilities",        "industry":"Power Generation",        "cap_size":"Large", "market_cap":90000},
    "BEL.NS":        {"sector":"Industrials",      "industry":"Defense Electronics",     "cap_size":"Large", "market_cap":175000},
    "HAL.NS":        {"sector":"Industrials",      "industry":"Aerospace & Defense",     "cap_size":"Large", "market_cap":235000},
    "VBL.NS":        {"sector":"Consumer Staples", "industry":"Beverages",               "cap_size":"Large", "market_cap":130000},
    "TATAELXSI.NS":  {"sector":"Technology",       "industry":"Design Services",         "cap_size":"Large", "market_cap":38000},
    "DIXON.NS":      {"sector":"Technology",       "industry":"Electronics Mfg.",        "cap_size":"Large", "market_cap":55000},
    "ASTRAL.NS":     {"sector":"Industrials",      "industry":"Plastic Pipes",           "cap_size":"Large", "market_cap":55000},
    "ZYDUSLIFE.NS":  {"sector":"Healthcare",       "industry":"Pharmaceuticals",         "cap_size":"Large", "market_cap":90000},
    "SBICARD.NS":    {"sector":"Financials",       "industry":"Credit Cards",            "cap_size":"Large", "market_cap":55000},
    "NAUKRI.NS":     {"sector":"Communication",    "industry":"Internet",                "cap_size":"Large", "market_cap":80000},
    "POLICYBZR.NS":  {"sector":"Financials",       "industry":"Insurtech",               "cap_size":"Large", "market_cap":55000},
    "ADANIPOWER.NS": {"sector":"Utilities",        "industry":"Power Generation",        "cap_size":"Large", "market_cap":220000},
    "IOC.NS":        {"sector":"Energy",           "industry":"Oil & Gas Refining",      "cap_size":"Large", "market_cap":185000},
    "HINDPETRO.NS":  {"sector":"Energy",           "industry":"Oil & Gas Refining",      "cap_size":"Large", "market_cap":62000},
    "GAIL.NS":       {"sector":"Energy",           "industry":"Gas Transmission",        "cap_size":"Large", "market_cap":125000},
    "IOC.NS":        {"sector":"Energy",           "industry":"Oil & Gas Refining",      "cap_size":"Large", "market_cap":185000},
    "OIL.NS":        {"sector":"Energy",           "industry":"Oil & Gas Exploration",   "cap_size":"Large", "market_cap":55000},
    "PETRONET.NS":   {"sector":"Energy",           "industry":"LNG",                     "cap_size":"Large", "market_cap":38000},
    "IGL.NS":        {"sector":"Utilities",        "industry":"Gas Distribution",        "cap_size":"Large", "market_cap":38000},
    "RVNL.NS":       {"sector":"Industrials",      "industry":"Railway Construction",    "cap_size":"Large", "market_cap":55000},
    "JSWINFRA.NS":   {"sector":"Industrials",      "industry":"Ports & Logistics",       "cap_size":"Large", "market_cap":58000},
    "CONCOR.NS":     {"sector":"Industrials",      "industry":"Logistics",               "cap_size":"Large", "market_cap":50000},
    "HUDCO.NS":      {"sector":"Financials",       "industry":"Housing Finance",         "cap_size":"Large", "market_cap":40000},
    "LTFH.NS":       {"sector":"Financials",       "industry":"NBFC",                    "cap_size":"Large", "market_cap":35000},
    "BAJAJHLDNG.NS": {"sector":"Financials",       "industry":"Investment Holding",      "cap_size":"Large", "market_cap":85000},
    "CUMMINSIND.NS": {"sector":"Industrials",      "industry":"Engines",                 "cap_size":"Large", "market_cap":45000},
    "THERMAX.NS":    {"sector":"Industrials",      "industry":"Energy & Environment",    "cap_size":"Large", "market_cap":32000},
    "SUPREMEIND.NS": {"sector":"Industrials",      "industry":"Plastic Products",        "cap_size":"Large", "market_cap":40000},
    "PAGEIND.NS":    {"sector":"Consumer Disc.",   "industry":"Apparel",                 "cap_size":"Large", "market_cap":45000},
    "MANYAVAR.NS":   {"sector":"Consumer Disc.",   "industry":"Apparel",                 "cap_size":"Large", "market_cap":25000},
    "EMAMILTD.NS":   {"sector":"Consumer Staples", "industry":"FMCG",                    "cap_size":"Large", "market_cap":32000},
    "ABBOTINDIA.NS": {"sector":"Healthcare",       "industry":"Pharmaceuticals",         "cap_size":"Large", "market_cap":35000},
    "NARAYANA.NS":   {"sector":"Healthcare",       "industry":"Hospitals",               "cap_size":"Large", "market_cap":28000},
    "IPCALAB.NS":    {"sector":"Healthcare",       "industry":"Pharmaceuticals",         "cap_size":"Large", "market_cap":30000},
    "GLAND.NS":      {"sector":"Healthcare",       "industry":"Injectables",             "cap_size":"Large", "market_cap":22000},
    # ── Mid Caps ──────────────────────────────────────────────────────────
    "COFORGE.NS":    {"sector":"Technology",       "industry":"IT Services",             "cap_size":"Mid",   "market_cap":47000},
    "KPITTECH.NS":   {"sector":"Technology",       "industry":"Automotive Tech",         "cap_size":"Mid",   "market_cap":40000},
    "BIRLASOFT.NS":  {"sector":"Technology",       "industry":"IT Services",             "cap_size":"Mid",   "market_cap":15000},
    "AFFLE.NS":      {"sector":"Technology",       "industry":"Ad-Tech",                 "cap_size":"Mid",   "market_cap":22000},
    "KAYNES.NS":     {"sector":"Technology",       "industry":"Electronics Mfg.",        "cap_size":"Mid",   "market_cap":22000},
    "HAPPSTMNDS.NS": {"sector":"Technology",       "industry":"IT Services",             "cap_size":"Mid",   "market_cap":12000},
    "INTELLECT.NS":  {"sector":"Technology",       "industry":"Fintech Software",        "cap_size":"Mid",   "market_cap":12000},
    "NEWGEN.NS":     {"sector":"Technology",       "industry":"Enterprise Software",     "cap_size":"Mid",   "market_cap":15000},
    "BIOCON.NS":     {"sector":"Healthcare",       "industry":"Biotechnology",           "cap_size":"Mid",   "market_cap":38000},
    "LAURUSLABS.NS": {"sector":"Healthcare",       "industry":"Pharmaceuticals",         "cap_size":"Mid",   "market_cap":22000},
    "GRANULES.NS":   {"sector":"Healthcare",       "industry":"Pharmaceuticals",         "cap_size":"Mid",   "market_cap":12000},
    "ASTER.NS":      {"sector":"Healthcare",       "industry":"Hospitals",               "cap_size":"Mid",   "market_cap":18000},
    "FORTIS.NS":     {"sector":"Healthcare",       "industry":"Hospitals",               "cap_size":"Mid",   "market_cap":38000},
    "BANDHANBNK.NS": {"sector":"Financials",       "industry":"Private Banks",           "cap_size":"Mid",   "market_cap":30000},
    "AUBANK.NS":     {"sector":"Financials",       "industry":"Small Finance Banks",     "cap_size":"Mid",   "market_cap":35000},
    "IDFCFIRSTB.NS": {"sector":"Financials",       "industry":"Private Banks",           "cap_size":"Mid",   "market_cap":38000},
    "FEDERALBNK.NS": {"sector":"Financials",       "industry":"Private Banks",           "cap_size":"Mid",   "market_cap":28000},
    "PAYTM.NS":      {"sector":"Financials",       "industry":"Fintech",                 "cap_size":"Mid",   "market_cap":40000},
    "CREDITACC.NS":  {"sector":"Financials",       "industry":"Microfinance",            "cap_size":"Mid",   "market_cap":12000},
    "ANGELONE.NS":   {"sector":"Financials",       "industry":"Brokerage",               "cap_size":"Mid",   "market_cap":18000},
    "360ONE.NS":     {"sector":"Financials",       "industry":"Wealth Management",       "cap_size":"Mid",   "market_cap":28000},
    "POONAWALLA.NS": {"sector":"Financials",       "industry":"NBFC",                    "cap_size":"Mid",   "market_cap":25000},
    "KFINTECH.NS":   {"sector":"Financials",       "industry":"Financial Services",      "cap_size":"Mid",   "market_cap":18000},
    "CAMS.NS":       {"sector":"Financials",       "industry":"Financial Services",      "cap_size":"Mid",   "market_cap":22000},
    "MANAPPURAM.NS": {"sector":"Financials",       "industry":"Gold Loans",              "cap_size":"Mid",   "market_cap":16000},
    "IIFL.NS":       {"sector":"Financials",       "industry":"NBFC",                    "cap_size":"Mid",   "market_cap":16000},
    "DEEPAKNTR.NS":  {"sector":"Materials",        "industry":"Specialty Chemicals",     "cap_size":"Mid",   "market_cap":30000},
    "APLAPOLLO.NS":  {"sector":"Materials",        "industry":"Steel Tubes",             "cap_size":"Mid",   "market_cap":38000},
    "RAMCOCEM.NS":   {"sector":"Materials",        "industry":"Cement",                  "cap_size":"Mid",   "market_cap":18000},
    "JKCEMENT.NS":   {"sector":"Materials",        "industry":"Cement",                  "cap_size":"Mid",   "market_cap":20000},
    "NATIONALUM.NS": {"sector":"Materials",        "industry":"Aluminium",               "cap_size":"Mid",   "market_cap":25000},
    "TORNTPOWER.NS": {"sector":"Utilities",        "industry":"Power Generation",        "cap_size":"Mid",   "market_cap":30000},
    "SJVN.NS":       {"sector":"Utilities",        "industry":"Hydro Power",             "cap_size":"Mid",   "market_cap":25000},
    "MGL.NS":        {"sector":"Utilities",        "industry":"Gas Distribution",        "cap_size":"Mid",   "market_cap":18000},
    "CESC.NS":       {"sector":"Utilities",        "industry":"Electric Utilities",      "cap_size":"Mid",   "market_cap":17000},
    "NYKAA.NS":      {"sector":"Consumer Disc.",   "industry":"E-Commerce",              "cap_size":"Mid",   "market_cap":45000},
    "CEAT.NS":       {"sector":"Consumer Disc.",   "industry":"Tyres",                   "cap_size":"Mid",   "market_cap":12000},
    "ABFRL.NS":      {"sector":"Consumer Disc.",   "industry":"Apparel",                 "cap_size":"Mid",   "market_cap":14000},
    "AMBER.NS":      {"sector":"Consumer Disc.",   "industry":"AC Components",           "cap_size":"Mid",   "market_cap":17000},
    "RELAXO.NS":     {"sector":"Consumer Disc.",   "industry":"Footwear",                "cap_size":"Mid",   "market_cap":12000},
    "PVRINOX.NS":    {"sector":"Communication",    "industry":"Movie Exhibition",        "cap_size":"Mid",   "market_cap":15000},
    "INDIAMART.NS":  {"sector":"Communication",    "industry":"B2B Marketplace",         "cap_size":"Mid",   "market_cap":16000},
    "RAILTEL.NS":    {"sector":"Communication",    "industry":"Telecom Infrastructure",  "cap_size":"Mid",   "market_cap":12000},
    "OBEROIRLTY.NS": {"sector":"Real Estate",      "industry":"Real Estate Dev.",        "cap_size":"Mid",   "market_cap":35000},
    "PRESTIGE.NS":   {"sector":"Real Estate",      "industry":"Real Estate Dev.",        "cap_size":"Mid",   "market_cap":62000},
    "IRCON.NS":      {"sector":"Industrials",      "industry":"Railway Construction",    "cap_size":"Mid",   "market_cap":18000},
    "TITAGARH.NS":   {"sector":"Industrials",      "industry":"Rail Wagons",             "cap_size":"Mid",   "market_cap":12000},
    "DELHIVERY.NS":  {"sector":"Industrials",      "industry":"Logistics",               "cap_size":"Mid",   "market_cap":20000},
    "BDL.NS":        {"sector":"Industrials",      "industry":"Defense Missiles",        "cap_size":"Mid",   "market_cap":40000},
    "FINOLEX.NS":    {"sector":"Industrials",      "industry":"Plastic Pipes",           "cap_size":"Mid",   "market_cap":15000},
    "TIMKEN.NS":     {"sector":"Industrials",      "industry":"Bearings",                "cap_size":"Mid",   "market_cap":18000},
    "SCHAEFFLER.NS": {"sector":"Industrials",      "industry":"Auto Components",         "cap_size":"Mid",   "market_cap":30000},
    "JYOTHYLAB.NS":  {"sector":"Consumer Staples", "industry":"FMCG",                    "cap_size":"Mid",   "market_cap":18000},
    # US stocks
    "AAPL":  {"sector":"Technology",       "industry":"Consumer Electronics",    "cap_size":"Mega",  "market_cap":3300000},
    "MSFT":  {"sector":"Technology",       "industry":"Software",                "cap_size":"Mega",  "market_cap":3100000},
    "NVDA":  {"sector":"Technology",       "industry":"Semiconductors",          "cap_size":"Mega",  "market_cap":2900000},
    "AMZN":  {"sector":"Consumer Disc.",   "industry":"E-Commerce",              "cap_size":"Mega",  "market_cap":2200000},
    "GOOGL": {"sector":"Communication",    "industry":"Internet",                "cap_size":"Mega",  "market_cap":2100000},
    "META":  {"sector":"Communication",    "industry":"Social Media",            "cap_size":"Mega",  "market_cap":1400000},
    "TSLA":  {"sector":"Consumer Disc.",   "industry":"Electric Vehicles",       "cap_size":"Mega",  "market_cap":900000},
    "AVGO":  {"sector":"Technology",       "industry":"Semiconductors",          "cap_size":"Mega",  "market_cap":850000},
    "LLY":   {"sector":"Healthcare",       "industry":"Pharmaceuticals",         "cap_size":"Mega",  "market_cap":750000},
    "JPM":   {"sector":"Financials",       "industry":"Banks",                   "cap_size":"Mega",  "market_cap":710000},
    "UNH":   {"sector":"Healthcare",       "industry":"Health Insurance",        "cap_size":"Large", "market_cap":485000},
    "V":     {"sector":"Financials",       "industry":"Payments",                "cap_size":"Large", "market_cap":520000},
    "MA":    {"sector":"Financials",       "industry":"Payments",                "cap_size":"Large", "market_cap":470000},
    "XOM":   {"sector":"Energy",           "industry":"Oil & Gas",               "cap_size":"Large", "market_cap":520000},
    "WMT":   {"sector":"Consumer Staples", "industry":"Retail",                  "cap_size":"Large", "market_cap":780000},
    "NFLX":  {"sector":"Communication",    "industry":"Streaming",               "cap_size":"Large", "market_cap":330000},
    "AMD":   {"sector":"Technology",       "industry":"Semiconductors",          "cap_size":"Large", "market_cap":260000},
    "ORCL":  {"sector":"Technology",       "industry":"Database Software",       "cap_size":"Large", "market_cap":430000},
    "CRM":   {"sector":"Technology",       "industry":"CRM Software",            "cap_size":"Large", "market_cap":320000},
    "PLTR":  {"sector":"Technology",       "industry":"AI/Analytics",            "cap_size":"Large", "market_cap":280000},
    "GE":    {"sector":"Industrials",      "industry":"Aerospace",               "cap_size":"Large", "market_cap":245000},
    "JNJ":   {"sector":"Healthcare",       "industry":"Diversified Pharma",      "cap_size":"Large", "market_cap":385000},
    "PG":    {"sector":"Consumer Staples", "industry":"FMCG",                    "cap_size":"Large", "market_cap":390000},
    "BAC":   {"sector":"Financials",       "industry":"Banks",                   "cap_size":"Large", "market_cap":320000},
    "GS":    {"sector":"Financials",       "industry":"Investment Banking",      "cap_size":"Large", "market_cap":185000},
    "NEE":   {"sector":"Utilities",        "industry":"Electric Utilities",      "cap_size":"Large", "market_cap":135000},
}

# Mirror all .NS static info as .BO
for _k, _v in list(_STATIC_INFO.items()):
    if _k.endswith(".NS"):
        _bo = _k.replace(".NS", ".BO")
        if _bo not in _STATIC_INFO:
            _STATIC_INFO[_bo] = _v

# ── Info disk cache (sector/industry/cap for unknown tickers) ─────────────
def _load_info_cache() -> Dict:
    if INFO_CACHE_FILE.exists():
        try:
            return json.loads(INFO_CACHE_FILE.read_text())
        except Exception:
            pass
    return {}

def _save_info_cache(cache: Dict):
    try:
        INFO_CACHE_FILE.write_text(json.dumps(cache, indent=2))
    except Exception:
        pass

_INFO_CACHE: Dict = _load_info_cache()

# ── Cap classification ─────────────────────────────────────────────────────
def _classify_cap(mcap_raw: float, is_indian: bool) -> tuple:
    """Returns (cap_size, market_cap_in_display_units)."""
    if not mcap_raw or mcap_raw <= 0:
        return "—", None
    if is_indian:
        cr = int(mcap_raw / 1e7)
        if cr >= 500000: return "Mega",  cr
        if cr >= 20000:  return "Large", cr
        if cr >= 5000:   return "Mid",   cr
        return "Small", cr
    else:
        m = int(mcap_raw / 1e6)
        if m >= 1000000: return "Mega",  m
        if m >= 100000:  return "Large", m
        if m >= 10000:   return "Mid",   m
        return "Small", m

# ── Dynamic info fetch ────────────────────────────────────────────────────
# ── Name-based sector inference (fallback when yfinance returns nothing) ────
_NAME_SECTOR: List[tuple] = [
    # pattern (lowercase), sector, industry
    ("bank",        "Financials",       "Banks"),
    ("finance",     "Financials",       "Finance"),
    ("financial",   "Financials",       "Finance"),
    ("insurance",   "Financials",       "Insurance"),
    ("capital",     "Financials",       "Finance"),
    ("invest",      "Financials",       "Finance"),
    ("nbfc",        "Financials",       "NBFC"),
    ("pharma",      "Healthcare",       "Pharmaceuticals"),
    ("health",      "Healthcare",       "Healthcare"),
    ("hospital",    "Healthcare",       "Hospitals"),
    ("medical",     "Healthcare",       "Healthcare"),
    ("life science","Healthcare",       "Pharmaceuticals"),
    ("techno",      "Technology",       "Technology"),
    ("software",    "Technology",       "Software"),
    ("infotech",    "Technology",       "IT Services"),
    ("infosys",     "Technology",       "IT Services"),
    ("digital",     "Technology",       "Technology"),
    ("cyber",       "Technology",       "Technology"),
    ("steel",       "Materials",        "Steel"),
    ("cement",      "Materials",        "Cement"),
    ("metals",      "Materials",        "Metals"),
    ("copper",      "Materials",        "Metals"),
    ("alumin",      "Materials",        "Metals"),
    ("paint",       "Materials",        "Paints"),
    ("chemical",    "Materials",        "Chemicals"),
    ("power",       "Utilities",        "Power"),
    ("electric",    "Utilities",        "Power"),
    ("energy",      "Energy",           "Energy"),
    ("gas",         "Energy",           "Oil & Gas"),
    ("oil",         "Energy",           "Oil & Gas"),
    ("petro",       "Energy",           "Oil & Gas"),
    ("refin",       "Energy",           "Oil & Gas"),
    ("auto",        "Consumer Disc.",   "Automobiles"),
    ("motor",       "Consumer Disc.",   "Automobiles"),
    ("tractor",     "Consumer Disc.",   "Automobiles"),
    ("textile",     "Consumer Disc.",   "Textiles"),
    ("retail",      "Consumer Disc.",   "Retail"),
    ("hotel",       "Consumer Disc.",   "Hotels"),
    ("resort",      "Consumer Disc.",   "Hotels"),
    ("food",        "Consumer Staples", "Food"),
    ("agro",        "Consumer Staples", "Agriculture"),
    ("dairy",       "Consumer Staples", "Food"),
    ("beverage",    "Consumer Staples", "Beverages"),
    ("fmcg",        "Consumer Staples", "FMCG"),
    ("infra",       "Industrials",      "Infrastructure"),
    ("engineer",    "Industrials",      "Engineering"),
    ("construct",   "Industrials",      "Construction"),
    ("logistic",    "Industrials",      "Logistics"),
    ("transport",   "Industrials",      "Transport"),
    ("realty",      "Real Estate",      "Real Estate"),
    ("property",    "Real Estate",      "Real Estate"),
    ("telecom",     "Communication",    "Telecom"),
    ("tele",        "Communication",    "Telecom"),
    ("media",       "Communication",    "Media"),
]

def _infer_sector_from_name(name: str) -> tuple:
    """Return (sector, industry) inferred from company name, or ('', '') if unknown."""
    n = name.lower()
    for pat, sec, ind in _NAME_SECTOR:
        if pat in n:
            return sec, ind
    return "", ""

def _fetch_info_dynamic(ticker: str) -> Dict:
    """Fetch sector/industry/cap from yfinance .info (full, not fast_info).
    Results are persisted to info_cache.json so this only runs once per ticker.
    Falls back to name-based sector inference for NSE stocks.
    """
    global _INFO_CACHE
    try:
        t         = yf.Ticker(ticker)
        info_full: Dict = {}
        try:
            info_full = t.info or {}
        except Exception:
            pass
        fi        = t.fast_info
        mcap_raw  = getattr(fi, "market_cap", None) or info_full.get("marketCap") or 0
        is_indian = ticker.endswith(".NS") or ticker.endswith(".BO")
        cap_size, market_cap = _classify_cap(mcap_raw, is_indian)

        sector   = (info_full.get("sector")   or info_full.get("sectorDisp")   or "").strip()
        industry = (info_full.get("industry") or info_full.get("industryDisp") or "").strip()

        # Fallback: infer from company name when yfinance returns nothing
        if not sector and is_indian:
            name = _NSE_NAMES.get(ticker, ticker.replace(".NS","").replace(".BO",""))
            inferred_sec, inferred_ind = _infer_sector_from_name(name)
            sector   = inferred_sec or "—"
            industry = inferred_ind or industry or "—"
        else:
            sector   = sector   or "—"
            industry = industry or "—"

        result = {
            "sector":     sector,
            "industry":   industry,
            "cap_size":   cap_size,
            "market_cap": market_cap,
        }
    except Exception:
        result = {"sector": "—", "industry": "—", "cap_size": "—", "market_cap": None}

    _INFO_CACHE[ticker] = result
    _save_info_cache(_INFO_CACHE)
    return result

def _get_info(ticker: str) -> Dict:
    """Static → disk cache → yfinance + name inference.  Name from _NSE_NAMES."""
    base = _STATIC_INFO.get(ticker)
    if base is None:
        cached = _INFO_CACHE.get(ticker)
        is_indian = ticker.endswith(".NS") or ticker.endswith(".BO")
        needs_refresh = (
            cached is None or
            cached.get("sector", "—") == "—" or
            # Re-infer NSE stocks that have sector but no industry
            (is_indian and cached.get("industry", "—") == "—")
        )
        if needs_refresh:
            base = _fetch_info_dynamic(ticker)
        else:
            base = cached
    name = (_NSE_NAMES.get(ticker)
            or base.get("name")
            or ticker.replace(".NS", "").replace(".BO", ""))
    return {**base, "name": name}

# ── Load ticker universes ─────────────────────────────────────────────────
def _load_tickers(filename: str, suffix: str) -> List[str]:
    path = DATA_DIR / filename
    tickers, seen = [], set()
    if path.exists():
        for line in path.read_text().splitlines():
            sym = line.strip()
            if not sym or sym.startswith("#"):
                continue
            t = f"{sym}{suffix}"
            if t not in seen:
                seen.add(t)
                tickers.append(t)
    return tickers

_NSE_TICKERS    = _load_tickers("nse_tickers.txt",     ".NS")
_BSE_TICKERS    = _load_tickers("bse_tickers.txt",     ".BO")
_SP500_TICKERS  = _load_tickers("sp500_tickers.txt",   "")    # no suffix — US tickers as-is
_JAPAN_TICKERS  = _load_tickers("japan_tickers.txt",   ".T")  # Tokyo Stock Exchange
_KOREA_TICKERS  = _load_tickers("korea_tickers.txt",   ".KS") # KOSPI
_KOSDAQ_TICKERS = _load_tickers("kosdaq_tickers.txt",  ".KQ") # KOSDAQ
_GERMANY_TICKERS= _load_tickers("germany_tickers.txt", ".DE") # XETRA Frankfurt

UNIVERSES = {
    "NSE":     _NSE_TICKERS,
    "BSE":     _BSE_TICKERS,
    "SP500":   _SP500_TICKERS,
    "NASDAQ":  ["AAPL","MSFT","NVDA","AMZN","META","GOOGL","TSLA","AVGO","COST","NFLX",
                "AMD","ADBE","QCOM","INTC","CSCO","ORCL","PANW","CRWD","PLTR","SHOP",
                "ARM","DASH","NET","DDOG","SNOW","ZS","FTNT","SMCI","MSTR","COIN",
                "ABNB","UBER","LYFT","RIVN","SOFI","HOOD","RBLX","PYPL","SQ","MARVL",
                "SNPS","CDNS","ASML","TXN","MCHP","AMAT","MU","LRCX","KLAC","INTU"],
    "NYSE":    ["JPM","V","MA","UNH","JNJ","WMT","PG","HD","BAC","XOM",
                "CVX","KO","PEP","MRK","LLY","ABT","TMO","DHR","MCD","NKE",
                "DIS","CRM","ACN","IBM","GS","MS","WFC","C","USB","AXP",
                "CAT","DE","HON","MMM","GE","BA","RTX","LMT","NOC","GD",
                "T","VZ","CMCSA","NEE","DUK","SO","D","AEP","EXC","PCG"],
    "TSE":     _JAPAN_TICKERS,   # Tokyo Stock Exchange
    "KOSPI":   _KOREA_TICKERS,   # Korea Stock Exchange (main board)
    "KOSDAQ":  _KOSDAQ_TICKERS,  # Korea KOSDAQ (tech/growth board)
    "XETRA":   _GERMANY_TICKERS, # Frankfurt / Xetra
}

# ── Preset Screens ─────────────────────────────────────────────────────────
PRESETS = {
    "Moving Averages": [
        {"id":"ma_above_sma20",  "label":"Price Above SMA(20)",             "filters":{"sma_condition":"price_above_sma20"}},
        {"id":"ma_above_sma50",  "label":"Price Above SMA(50)",             "filters":{"sma_condition":"price_above_sma50"}},
        {"id":"ma_above_sma200", "label":"Price Above SMA(200)",            "filters":{"sma_condition":"price_above_sma200"}},
        {"id":"ma_golden_zone",  "label":"Golden Zone — SMA(20) > SMA(50)", "filters":{"sma_condition":"sma20_above_sma50"}},
        {"id":"ma_uptrend",      "label":"Uptrend — SMA(50) > SMA(200)",   "filters":{"sma_condition":"sma50_above_sma200"}},
        {"id":"ma_death_zone",   "label":"Death Zone — SMA(20) < SMA(50)", "filters":{"sma_condition":"sma20_below_sma50"}},
        {"id":"ema_bull",        "label":"EMA Bull — EMA(20) > EMA(50)",   "filters":{"ema_condition":"ema20_above_ema50"}},
    ],
    "Oscillators": [
        {"id":"rsi_oversold",    "label":"RSI Oversold — RSI < 30",        "filters":{"rsi_max":30}},
        {"id":"rsi_overbought",  "label":"RSI Overbought — RSI > 70",      "filters":{"rsi_min":70}},
        {"id":"rsi_bullish",     "label":"RSI Bullish Zone — RSI 50–70",   "filters":{"rsi_min":50,"rsi_max":70}},
        {"id":"rsi_neutral",     "label":"RSI Neutral — RSI 40–60",        "filters":{"rsi_min":40,"rsi_max":60}},
        {"id":"rsi_bearish",     "label":"RSI Bearish Zone — RSI 30–50",   "filters":{"rsi_min":30,"rsi_max":50}},
    ],
    "Trend Indicators": [
        {"id":"macd_bull",       "label":"MACD Bullish Signal",             "filters":{"macd_signal":"bullish"}},
        {"id":"macd_bear",       "label":"MACD Bearish Signal",             "filters":{"macd_signal":"bearish"}},
        {"id":"trend_bull",      "label":"Strong Uptrend — SMA50 + MACD Bull",  "filters":{"sma_condition":"price_above_sma50","macd_signal":"bullish"}},
        {"id":"trend_bear",      "label":"Strong Downtrend — SMA50 + MACD Bear","filters":{"sma_condition":"price_below_sma50","macd_signal":"bearish"}},
        {"id":"golden_macd",     "label":"Golden Cross + MACD Bull",        "filters":{"sma_condition":"sma50_above_sma200","macd_signal":"bullish"}},
    ],
    "Bollinger Bands": [
        {"id":"bb_near_upper",   "label":"Near Upper Band — Momentum",      "filters":{"bb_condition":"near_upper"}},
        {"id":"bb_near_lower",   "label":"Near Lower Band — Reversal?",     "filters":{"bb_condition":"near_lower"}},
        {"id":"bb_breakout",     "label":"Above Upper Band — Breakout",     "filters":{"bb_condition":"above_upper"}},
        {"id":"bb_breakdown",    "label":"Below Lower Band — Breakdown",    "filters":{"bb_condition":"below_lower"}},
    ],
    "Chart Patterns": [
        {"id":"cp_52w_high",     "label":"New 52-Week High",                "filters":{"new_52w_high":True}},
        {"id":"cp_near_52h5",    "label":"Within 5% of 52W High",          "filters":{"near_52w_high_pct":5}},
        {"id":"cp_near_52h10",   "label":"Within 10% of 52W High",         "filters":{"near_52w_high_pct":10}},
        {"id":"cp_near_52l",     "label":"Within 20% of 52W Low",          "filters":{"near_52w_low_pct":20}},
        {"id":"cp_gainers",      "label":"Top Gainers — Change > 2%",      "filters":{"change_pct_min":2.0}},
        {"id":"cp_losers",       "label":"Top Losers — Change < −2%",      "filters":{"change_pct_max":-2.0}},
        {"id":"cp_high_volume",  "label":"High Volume Surge",               "filters":{"volume_min":2000000}},
    ],
}

# ── Formula parser ────────────────────────────────────────────────────────
def parse_formula(formula: str) -> Dict:
    """Convert a plain-text formula string into a filter dict.

    Clauses are separated by 'and' (case-insensitive). Supported syntax:

      rsi > 60                           → rsi_min: 60
      rsi < 30                           → rsi_max: 30
      macd = bullish                     → macd_signal: "bullish"
      macd = bearish                     → macd_signal: "bearish"
      price > 100                        → price_min: 100
      price < 500                        → price_max: 500
      change > 2                         → change_pct_min: 2
      change < -2                        → change_pct_max: -2
      volume > 1000000                   → volume_min: 1000000
      advol(20) > 50                     → avg_vol_min: 50000 (MIO uses K units)
      price > c[1]                       → change_pct_min: 0
      price > sma(20)                    → sma_conditions: ["price_above_sma20"]
      sma(10) > sma(20)                  → sma_conditions: ["sma10_above_sma20"]
      sma(50) > sma(200)                 → sma_conditions: ["sma50_above_sma200"]
      price > ema(20)                    → ema_conditions: ["price_above_ema20"]
      ema(20) > ema(50)                  → ema_conditions: ["ema20_above_ema50"]
      atr(1) > atr(20) * 0.6            → atr_ratio_min: 0.6
      price > low + ((high - low) * 0.4) → candle_pos_min: 0.4
      price > bb_upper                   → bb_condition: "above_upper"
      price < bb_lower                   → bb_condition: "below_lower"
      price near bb_upper                → bb_condition: "near_upper"
      price near bb_lower                → bb_condition: "near_lower"
      new_52w_high                       → new_52w_high: True
      near_52h < 5                       → near_52w_high_pct: 5
      near_52l < 20                      → near_52w_low_pct: 20
    """
    import re as _re
    if not formula or not formula.strip():
        return {}

    result: Dict = {}
    unrecognized: list = []
    text = formula.lower().strip()

    # ── Pre-processing ────────────────────────────────────────────────────────
    # 1. Strip one layer of outer parens wrapping the entire formula
    #    (MIO often wraps Block 1 in parentheses: "(exch(nse) and ...)")
    _stripped = text
    while _stripped.startswith('(') and _stripped.endswith(')'):
        # Verify the parens are truly matching (not "(A) and (B)")
        depth = 0
        for i, ch in enumerate(_stripped):
            if ch == '(': depth += 1
            elif ch == ')': depth -= 1
            if depth == 0 and i < len(_stripped) - 1:
                break  # outer ( closes before the end — not a wrapper
        else:
            _stripped = _stripped[1:-1].strip()
            break
        break
    text = _stripped

    # 2. Normalise 'and' spacing — MIO sometimes writes "sma(10)and" without spaces
    text = _re.sub(r'(?<![a-z0-9_])and(?![a-z0-9_])', ' and ', text)
    text = _re.sub(r' {2,}', ' ', text).strip()  # collapse double spaces

    # Paren-aware split on ' and ' — don't break inside !(... and ...)
    def _split_and(s: str):
        clauses, depth, buf = [], 0, []
        i = 0
        while i < len(s):
            if s[i] == '(':
                depth += 1; buf.append(s[i])
            elif s[i] == ')':
                depth -= 1; buf.append(s[i])
            elif depth == 0 and s[i:i+5] == ' and ':
                clauses.append(''.join(buf).strip()); buf = []; i += 5; continue
            else:
                buf.append(s[i])
            i += 1
        if buf: clauses.append(''.join(buf).strip())
        return clauses

    parts = _split_and(text)

    # Clauses that reference MIO-specific functions we intentionally skip
    # (exchange selector handles exch(); lookback @{} notation is stripped then re-parsed)
    _SKIP = _re.compile(r'^exch\s*\(')   # exch(nse) — handled by exchange selector

    for raw in parts:
        # Strip MIO lookback modifier @{N..M} — treat condition as current-state check
        raw = _re.sub(r'@\{\s*\d+\s*\.\.\s*\d+\s*\}', '', raw)

        # Strip at most one layer of enclosing parentheses (not all)
        _r = raw.strip()
        p = _r[1:-1].strip() if _r.startswith('(') and _r.endswith(')') else _r
        if not p:
            continue

        # Skip MIO-specific unsupported clauses silently
        if _SKIP.search(p):
            continue

        matched = False

        # ── OR-group handling ─────────────────────────────────────────────
        # Handles: (price > sma(N1) or price > sma(N2))
        if not matched:
            sma_or_parts = _re.findall(r'price\s*>\s*sma\s*\(\s*(\d+)\s*\)', p)
            if len(sma_or_parts) >= 2 and ' or ' in p:
                result.setdefault('sma_or_conditions', [])
                for n in sma_or_parts:
                    cond = f"price_above_sma{n}"
                    if cond not in result['sma_or_conditions']:
                        result['sma_or_conditions'].append(cond)
                matched = True

        # Handles: (pgo(N1) < X or pgo(N2) < X)
        if not matched:
            pgo_or_parts = _re.findall(r'pgo\s*\(\s*(\d+)\s*\)\s*([<>]=?)\s*([\d.]+)', p)
            if len(pgo_or_parts) >= 2 and ' or ' in p:
                result.setdefault('pgo_or_filters', [])
                for (n, op, val) in pgo_or_parts:
                    result['pgo_or_filters'].append({'n': int(n), 'op': op, 'val': float(val)})
                matched = True

        # Handles: (cvol > avol(N1) * X or cvol > avol(N2) * X or ...)
        if not matched:
            rvol_or = _re.findall(r'cvol\s*>\s*avol\s*\(\s*\d+\s*\)\s*\*\s*([\d.]+)', p)
            if rvol_or and ' or ' in p:
                result['rvol_min'] = max(result.get('rvol_min') or 0, min(float(x) for x in rvol_or))
                matched = True

        # Handles: (atr(1) > atr(N1) * X or atr(1) > atr(N2) * X or ...)
        if not matched:
            atr_or = _re.findall(r'atr\s*\(\s*1\s*\)\s*>\s*atr\s*\(\s*\d+\s*\)\s*\*\s*([\d.]+)', p)
            if atr_or and ' or ' in p:
                result['atr_ratio_min'] = max(result.get('atr_ratio_min') or 0, min(float(x) for x in atr_or))
                matched = True

        # ── Individual matchers (only run when OR-group handlers did not match) ──
        if not matched:
            if _re.search(r'new_?52w?_?high', p):
                result['new_52w_high'] = True; matched = True

            # RSI
            elif (m := _re.match(r'rsi\s*([><=!]+)\s*(-?[\d.]+)', p)):
                op, val = m.group(1), float(m.group(2))
                if '>' in op: result['rsi_min'] = val
                elif '<' in op: result['rsi_max'] = val
                matched = True

            # MACD
            elif (m := _re.match(r'macd\s*[=:]\s*(bullish|bearish)', p)):
                result['macd_signal'] = m.group(1); matched = True
            elif _re.match(r'macd_?bullish', p):
                result['macd_signal'] = 'bullish'; matched = True
            elif _re.match(r'macd_?bearish', p):
                result['macd_signal'] = 'bearish'; matched = True

            # advol(n) > X  — average DOLLAR volume in millions (MIO: price × volume ÷ 1M)
            # advol(20) → dollar_vol_min  |  advol(50) → dollar_vol_50_min
            elif (m := _re.match(r'advol\s*\(\s*(\d+)\s*\)\s*([><=]+)\s*([\d.]+)', p)):
                n_adv, op, val = int(m.group(1)), m.group(2), float(m.group(3))
                if '>' in op:
                    key = 'dollar_vol_50_min' if n_adv == 50 else 'dollar_vol_min'
                    result[key] = max(result.get(key) or 0, val)
                matched = True

            # avol(n) > X  — average SHARE volume in millions
            elif (m := _re.match(r'avol\s*\(\s*\d+\s*\)\s*([><=]+)\s*([\d.]+)', p)):
                op, val = m.group(1), float(m.group(2)) * 1_000_000
                if '>' in op:
                    result['avg_vol_min'] = max(result.get('avg_vol_min') or 0, val)
                matched = True

            # avg((vol * price), N) > X  — MIO raw dollar volume (vol=shares, price=INR)
            # Convert: X rupees → millions (our unit) by dividing by 1_000_000
            elif (m := _re.match(r'avg\s*\(\s*\(\s*vol\s*\*\s*price\s*\)\s*,\s*\d+\s*\)\s*([><=]+)\s*([\d.]+)', p)):
                op, val = m.group(1), float(m.group(2)) / 1_000_000
                if '>' in op:
                    result['dollar_vol_min'] = max(result.get('dollar_vol_min') or 0, val)
                matched = True

            # cvol > avol(N) * X  — relative volume (today > N-day avg × X)
            elif (m := _re.match(r'cvol\s*>\s*avol\s*\(\s*\d+\s*\)\s*\*\s*([\d.]+)', p)):
                result['rvol_min'] = max(result.get('rvol_min') or 0, float(m.group(1)))
                matched = True

            # sma(1) trend_up N  — positive day (price > previous close)
            elif _re.match(r'sma\s*\(\s*1\s*\)\s*trend_up\s+\d+', p):
                result['change_pct_min'] = 0; matched = True

            # sma(1) trend_dn N  — negative day (price < previous close)
            elif _re.match(r'sma\s*\(\s*1\s*\)\s*trend_dn\s+\d+', p):
                result['change_pct_max'] = 0; matched = True

            # pgo(N) < X or pgo(N) > X  — price % change over N bars (individual AND clause)
            elif (m := _re.match(r'pgo\s*\(\s*(\d+)\s*\)\s*([<>]=?)\s*([\d.]+)', p)):
                n, op, val = int(m.group(1)), m.group(2), float(m.group(3))
                result.setdefault('pgo_filters', [])
                result['pgo_filters'].append({'n': n, 'op': op, 'val': val})
                matched = True

            # rvol > X  — relative volume (today / 20-day avg)
            elif (m := _re.match(r'rvol\s*([><=]+)\s*([\d.]+)', p)):
                op, val = m.group(1), float(m.group(2))
                if '>' in op: result['rvol_min'] = val
                matched = True

            # gapup > X  — gap up %
            elif (m := _re.match(r'gapup\s*([><=]+)\s*([\d.]+)', p)):
                op, val = m.group(1), float(m.group(2))
                if '>' in op: result['gapup_min'] = val
                matched = True

            # gapdn > X  — gap down %
            elif (m := _re.match(r'gapdn\s*([><=]+)\s*([\d.]+)', p)):
                op, val = m.group(1), float(m.group(2))
                if '>' in op: result['gapdn_min'] = val
                matched = True

            # chclose / chopen — MIO aliases for change %
            elif (m := _re.match(r'ch(?:close|open)\s*([><=]+)\s*(-?[\d.]+)', p)):
                op, val = m.group(1), float(m.group(2))
                if '>' in op: result['change_pct_min'] = val
                elif '<' in op: result['change_pct_max'] = val
                matched = True

            # crange(0) > arange(0) * X  — today's range vs 21-bar avg range → atr_ratio
            elif (m := _re.match(r'crange\s*\(\s*0\s*\)\s*[>]=?\s*arange\s*\(\s*0\s*\)\s*\*\s*([\d.]+)', p)):
                result['atr_ratio_min'] = float(m.group(1)); matched = True

            # offh_N < X  — distance from N-bar high must be < X%
            elif (m := _re.match(r'offh_(\d+)\s*[<]=?\s*([\d.]+)', p)):
                n, val = int(m.group(1)), float(m.group(2))
                result[f'offh_{n}_max'] = val; matched = True

            # atr(1) > atr(N) * X  — ATR ratio filter
            elif (m := _re.match(r'atr\s*\(\s*1\s*\)\s*[>]=?\s*atr\s*\(\s*\d+\s*\)\s*\*\s*([\d.]+)', p)):
                result['atr_ratio_min'] = float(m.group(1)); matched = True

            # price > low + ((high - low) * X)  — candle position filter
            elif (m := _re.match(r'price\s*[>]=?\s*low\s*\+\s*[\(\s]*(?:high\s*-\s*low)\s*[\)\s]*\*\s*([\d.]+)', p)):
                result['candle_pos_min'] = float(m.group(1)); matched = True

            # price > c[1]  — price above previous close (i.e. positive change)
            elif _re.match(r'price\s*[>]=?\s*c\s*\[\s*1\s*\]', p):
                result['change_pct_min'] = 0; matched = True

            # price vs SMA  — APPEND to sma_conditions list
            elif (m := _re.match(r'(?:price|close)\s*([><=]+)\s*sma\s*\(?\s*(\d+)\s*\)?', p)):
                op, n = m.group(1), m.group(2)
                cond = f"price_{'above' if '>' in op else 'below'}_sma{n}"
                result.setdefault('sma_conditions', [])
                if cond not in result['sma_conditions']:
                    result['sma_conditions'].append(cond)
                matched = True

            # !(price < sma(N) and sma(N) trend_dn M) — MIO combined NOT
            # De Morgan: NOT(A AND B) = NOT A OR NOT B
            # = price >= sma(N) OR sma(N) not falling → reject only if BOTH true
            elif (m := _re.match(
                r'!\s*\(?\s*price\s*<\s*sma\s*\(?\s*(\d+)\s*\)?\s*and\s*sma\s*\(?\s*\1\s*\)?\s*trend_dn\s+(\d+)\s*\)?', p)):
                n_s, bars_s = m.group(1), m.group(2)
                result[f'not_price_below_sma{n_s}_and_trend_dn_{bars_s}'] = True
                matched = True

            # !(sma(N) OP sma(M)) — negation: flip the operator
            # e.g. !(sma(20) < sma(50))  →  sma20 >= sma50  →  sma20_above_sma50
            elif (m := _re.match(r'!\s*\(?\s*sma\s*\(?\s*(\d+)\s*\)?\s*([<>]=?)\s*sma\s*\(?\s*(\d+)\s*\)?\s*\)?', p)):
                n1, op, n2 = m.group(1), m.group(2), m.group(3)
                # Flip: !(N < M) = N >= M = above; !(N > M) = N <= M = below
                cond = f"sma{n1}_{'above' if '<' in op else 'below'}_sma{n2}"
                result.setdefault('sma_conditions', [])
                if cond not in result['sma_conditions']:
                    result['sma_conditions'].append(cond)
                matched = True

            # !(sma(N) trend_dn M) — SMA must NOT be falling
            elif (m := _re.match(r'!\s*\(?\s*sma\s*\(?\s*(\d+)\s*\)?\s*trend_dn\s+(\d+)\s*\)?', p)):
                n_s, bars_s = m.group(1), m.group(2)
                result[f'not_sma{n_s}_trend_dn_{bars_s}'] = True
                matched = True

            # sma(N) trend_dn M — sma(N) now < sma(N) M bars ago (MIO trend direction)
            elif (m := _re.match(r'sma\s*\(?\s*(\d+)\s*\)?\s*trend_dn\s+(\d+)', p)):
                n_s, bars_s = m.group(1), m.group(2)
                result[f'sma{n_s}_trend_dn_{bars_s}'] = True
                matched = True

            # sma(N) trend_up M — sma(N) now > sma(N) M bars ago
            elif (m := _re.match(r'sma\s*\(?\s*(\d+)\s*\)?\s*trend_up\s+(\d+)', p)):
                n_s, bars_s = m.group(1), m.group(2)
                result[f'sma{n_s}_trend_up_{bars_s}'] = True
                matched = True

            # SMA vs SMA  — APPEND to sma_conditions list
            elif (m := _re.match(r'sma\s*\(?\s*(\d+)\s*\)?\s*([><=]+)\s*sma\s*\(?\s*(\d+)\s*\)?', p)):
                n1, op, n2 = m.group(1), m.group(2), m.group(3)
                cond = f"sma{n1}_{'above' if '>' in op else 'below'}_sma{n2}"
                result.setdefault('sma_conditions', [])
                if cond not in result['sma_conditions']:
                    result['sma_conditions'].append(cond)
                matched = True

            # price vs EMA  — APPEND to ema_conditions list
            elif (m := _re.match(r'(?:price|close)\s*([><=]+)\s*ema\s*\(?\s*(\d+)\s*\)?', p)):
                op, n = m.group(1), m.group(2)
                cond = f"price_{'above' if '>' in op else 'below'}_ema{n}"
                result.setdefault('ema_conditions', [])
                if cond not in result['ema_conditions']:
                    result['ema_conditions'].append(cond)
                matched = True

            # EMA vs EMA  — APPEND to ema_conditions list
            elif (m := _re.match(r'ema\s*\(?\s*(\d+)\s*\)?\s*([><=]+)\s*ema\s*\(?\s*(\d+)\s*\)?', p)):
                n1, op, n2 = m.group(1), m.group(2), m.group(3)
                cond = f"ema{n1}_{'above' if '>' in op else 'below'}_ema{n2}"
                result.setdefault('ema_conditions', [])
                if cond not in result['ema_conditions']:
                    result['ema_conditions'].append(cond)
                matched = True

            # Bollinger Bands
            elif _re.search(r'price\s*[>]\s*bb_?upper', p):
                result['bb_condition'] = 'above_upper'; matched = True
            elif _re.search(r'price\s*[<]\s*bb_?lower', p):
                result['bb_condition'] = 'below_lower'; matched = True
            elif _re.search(r'price\s*near\s*bb_?upper|near_?upper', p):
                result['bb_condition'] = 'near_upper'; matched = True
            elif _re.search(r'price\s*near\s*bb_?lower|near_?lower', p):
                result['bb_condition'] = 'near_lower'; matched = True

            # Price / close (must come AFTER sma/ema/atr/c[1] checks)
            elif (m := _re.match(r'(?:price|close)\s*([><=]+)\s*(-?[\d.]+)', p)):
                op, val = m.group(1), float(m.group(2))
                if '>' in op: result['price_min'] = val
                elif '<' in op: result['price_max'] = val
                matched = True

            # Change %
            elif (m := _re.match(r'(?:change|change_pct|chg|pct)\s*([><=]+)\s*(-?[\d.]+)', p)):
                op, val = m.group(1), float(m.group(2))
                if '>' in op: result['change_pct_min'] = val
                elif '<' in op: result['change_pct_max'] = val
                matched = True

            # Volume (raw / with k/m suffix)
            elif (m := _re.match(r'vol(?:ume)?\s*([><=]+)\s*([\d.]+)\s*([mk]?)', p)):
                op, val, suf = m.group(1), float(m.group(2)), m.group(3)
                if suf == 'm': val *= 1_000_000
                elif suf == 'k': val *= 1_000
                if '>' in op: result['volume_min'] = val
                matched = True

            # 52W proximity
            elif (m := _re.match(r'(?:near_?52h|pct_52h|dist_52h)\s*[<>]=?\s*([\d.]+)', p)):
                result['near_52w_high_pct'] = float(m.group(1)); matched = True

            elif (m := _re.match(r'(?:near_?52l|pct_52l|dist_52l)\s*[<>]=?\s*([\d.]+)', p)):
                result['near_52w_low_pct'] = float(m.group(1)); matched = True

        if not matched:
            unrecognized.append(raw.strip())

    if unrecognized:
        print(f"[formula] unrecognized clauses (skipped): {unrecognized}")

    return result

# ── Helpers ────────────────────────────────────────────────────────────────
def _safe(v):
    if v is None: return None
    try:
        if np.isnan(v) or np.isinf(v): return None
    except (TypeError, ValueError): pass
    return v

def _sf(v, d=2):
    r = _safe(v)
    return round(float(r), d) if r is not None else None

# ── DataFrame normalizer ───────────────────────────────────────────────────
def _normalize_df(raw: pd.DataFrame, ticker: str) -> Optional[pd.DataFrame]:
    """Extract one ticker's clean OHLCV from a yfinance raw download.

    Handles three column formats across yfinance versions:
      (a) flat ['Open','High','Low','Close','Volume']  — single-ticker raw
      (b) MultiIndex (Ticker, Metric) via group_by="ticker" — raw[ticker]
      (c) MultiIndex (Metric, Ticker) — newer yfinance (≥0.2.38)
    Returns None when data is missing or too short (<30 rows).
    """
    if raw is None or raw.empty:
        return None
    try:
        if isinstance(raw.columns, pd.MultiIndex):
            lvl0 = raw.columns.get_level_values(0).unique().tolist()
            lvl1 = (raw.columns.get_level_values(1).unique().tolist()
                    if raw.columns.nlevels > 1 else [])
            # (Ticker, Metric) — group_by="ticker" standard layout
            if ticker in lvl0:
                df = raw[ticker].copy()
            # (Metric, Ticker) — some yfinance versions
            elif ticker in lvl1:
                df = raw.xs(ticker, axis=1, level=1).copy()
            else:
                return None
            # After slicing there might still be a MultiIndex; flatten it
            if isinstance(df.columns, pd.MultiIndex):
                df.columns = df.columns.get_level_values(-1)
        else:
            # Single-ticker download — raw IS already the per-ticker df
            df = raw.copy()
            # Single-ticker raw in yfinance 0.2.x sometimes has (Ticker, Metric)
            # columns like ('DRREDDY.NS', 'Open'). Flatten:
            if isinstance(df.columns, pd.MultiIndex):
                df.columns = df.columns.get_level_values(-1)

        # Keep only OHLCV columns
        want = ['Open', 'High', 'Low', 'Close', 'Volume']
        have = [c for c in want if c in df.columns]
        if 'Close' not in have:
            return None
        df = df[have].copy()

        # Drop rows where any OHLC value is NaN (weekends already excluded
        # by yfinance; this removes stale/partial rows)
        df = df.dropna(subset=['Open', 'High', 'Low', 'Close'])
        return df if len(df) >= 30 else None

    except Exception as e:
        print(f"[screener] _normalize_df({ticker}): {type(e).__name__}: {e}")
        return None

# ── OHLCV disk cache ───────────────────────────────────────────────────────
DOWNLOAD_BATCH          = 400   # tickers per yf.download() call (daily)
DOWNLOAD_BATCH_INTRADAY = 50    # tickers per yf.download() call (15min) — smaller = less memory
DOWNLOAD_WORKERS        = 3     # concurrent batch downloads (proven safe vs yf rate-limit)

# ── Global scan progress — polled by GET /api/screener/progress ───────────────
_SCREEN_PROGRESS: dict = {
    "phase":    "idle",   # idle | cache | downloading | filtering
    "done":     0,
    "total":    0,
    "exchange": "",
    "bar_min":  0,        # 0 for daily, 75/78 for intraday
}

# Tracks the last intraday top-up result — readable via /api/angel/status
_LAST_TOPUP: dict = {}

def _ohlcv_cache_path(exchange: str) -> Path:
    return OHLCV_CACHE_DIR / f"{exchange}_{datetime.date.today().isoformat()}.pkl"

def _intraday_bar_minutes(exchange: str) -> int:
    """Return the canonical intraday bar size (minutes) for an exchange.
    NSE/BSE:        9:15–15:30 = 375 min → 5 bars × 75 min
    US:             9:30–16:00 = 390 min → 5 bars × 78 min
    TSE:            9:00–15:30 (lunch 11:30–12:30) = 330 min → use 78 min (4 bars)
    KOSPI/KOSDAQ:   9:00–15:30 = 390 min → 5 bars × 78 min
    XETRA:          9:00–17:30 = 510 min → use 78 min (6 bars)
    """
    if exchange in ("NSE", "BSE"):
        return 75
    return 78  # default for US, Korea, Germany, Japan

def _ohlcv_intraday_cache_path(exchange: str, bar_min: int) -> Path:
    return OHLCV_CACHE_DIR / f"{exchange}_{bar_min}min_{datetime.date.today().isoformat()}.pkl"

def _load_intraday_cache(exchange: str, bar_min: int) -> Optional[Dict[str, pd.DataFrame]]:
    """Load today's intraday cache; fall back to yesterday's if today's doesn't exist yet.
    A 1-day fallback means early morning runs (before the first complete bar) use
    yesterday's complete bars rather than triggering a slow fresh download that
    produces a tiny partial bar which kills the ATR filter.
    The _resample_intraday function drops any partial last bar automatically, so
    yesterday's data arriving here is safe — it will show the most recent complete setup.
    """
    today = datetime.date.today()
    for days_back in range(2):   # today (0) → yesterday (1) only
        d = today - datetime.timedelta(days=days_back)
        p = OHLCV_CACHE_DIR / f"{exchange}_{bar_min}min_{d.isoformat()}.pkl"
        if p.exists():
            try:
                data = pickle.load(open(p, "rb"))
                if days_back > 0:
                    print(f"[screener] {exchange} {bar_min}min: loaded yesterday's cache ({d})")
                return data
            except Exception:
                pass
    return None

def _save_intraday_cache(exchange: str, bar_min: int, data: Dict[str, pd.DataFrame]):
    for old in OHLCV_CACHE_DIR.glob(f"{exchange}_{bar_min}min_*.pkl"):
        try: old.unlink()
        except: pass
    with open(_ohlcv_intraday_cache_path(exchange, bar_min), "wb") as f:
        pickle.dump(data, f, protocol=4)

def _resample_intraday(df_15: pd.DataFrame, exchange: str, bar_min: int, min_bars: int = 20) -> Optional[pd.DataFrame]:
    """Resample 15-min OHLCV to bar_min-min bars aligned to exchange market open.
    NSE/BSE offset: 9h15m (market opens 09:15 IST)
    US offset: 9h30m (market opens 09:30 ET)
    """
    if df_15 is None or df_15.empty:
        return None
    try:
        idx = df_15.index
        if exchange in ("NSE", "BSE"):
            tz_name = "Asia/Kolkata"
            offset  = pd.Timedelta("9h15min")
        elif exchange in ("KOSPI", "KOSDAQ"):
            tz_name = "Asia/Seoul"
            offset  = pd.Timedelta("9h0min")
        elif exchange == "TSE":
            tz_name = "Asia/Tokyo"
            offset  = pd.Timedelta("9h0min")
        elif exchange == "XETRA":
            tz_name = "Europe/Berlin"
            offset  = pd.Timedelta("9h0min")
        else:
            tz_name = "America/New_York"
            offset  = pd.Timedelta("9h30min")

        # Ensure tz-aware
        if idx.tz is None:
            df_15 = df_15.copy()
            df_15.index = idx.tz_localize(tz_name, ambiguous="infer", nonexistent="shift_forward")
        else:
            df_15 = df_15.copy()
            df_15.index = df_15.index.tz_convert(tz_name)

        df_out = df_15.resample(f"{bar_min}min", offset=offset).agg(
            Open=("Open", "first"), High=("High", "max"),
            Low=("Low", "min"),  Close=("Close", "last"),
            Volume=("Volume", "sum"),
        )
        df_out = df_out.dropna(subset=["Open", "Close"])
        df_out = df_out[df_out["Volume"] > 0]

        # Drop the last bar if it's still forming (started < bar_min minutes ago).
        # A partial bar has a tiny ATR that would kill the atr(1) > atr(20)*0.6 filter,
        # producing 0 results until the first complete bar of the day is available.
        if not df_out.empty:
            try:
                now_local  = pd.Timestamp.now(tz=tz_name)
                last_start = df_out.index[-1]  # still tz-aware at this point
                elapsed_min = (now_local - last_start).total_seconds() / 60
                if elapsed_min < bar_min:
                    df_out = df_out.iloc[:-1]
                    print(f"[screener] {exchange}: dropped partial {bar_min}m bar "
                          f"({elapsed_min:.0f}m elapsed, need {bar_min}m)")
            except Exception:
                pass  # tz comparison edge-case — keep all bars

        # Strip timezone for consistency with daily data
        df_out.index = df_out.index.tz_localize(None)
        return df_out if len(df_out) >= min_bars else None
    except Exception as e:
        print(f"[screener] _resample_intraday({bar_min}min) error: {type(e).__name__}: {e}")
        return None


def _load_intraday_cache_prev(exchange: str, bar_min: int) -> Optional[Dict[str, pd.DataFrame]]:
    """Load the most recent intraday cache PRIOR to today (1–7 days back).
    Used by the top-up path to get yesterday's history without a full re-download.
    """
    today = datetime.date.today()
    for days_back in range(1, 8):
        d = today - datetime.timedelta(days=days_back)
        p = OHLCV_CACHE_DIR / f"{exchange}_{bar_min}min_{d.isoformat()}.pkl"
        if p.exists():
            try:
                data = pickle.load(open(p, "rb"))
                print(f"[screener] {exchange} {bar_min}min: loaded {days_back}d-old intraday cache for top-up")
                return data
            except Exception:
                pass
    return None


def _topup_intraday(
    exchange: str,
    prev_data: Dict[str, pd.DataFrame],
    tickers: List[str],
    bar_min: int,
) -> Dict[str, pd.DataFrame]:
    """Download only today's 15-min bars, resample, and stitch onto yesterday's 75-min history.

    For NSE/BSE: tries Angel One SmartAPI first (direct broker API, real-time, reliable).
                 Falls back to yfinance for any symbols Angel One misses.
    For others:  yfinance only.

    Why: a full period='60d' download takes 5-7 min on first daily run.
         today-only gives ~25 15-min bars per ticker in ~20-30s total.
         We concat those resampled bars onto the previous day's history (~295 bars)
         → the combined 296-300 bars pass the ≥20 bar check and cover all SMA windows.
    """
    today_str = datetime.date.today().isoformat()

    # ── Angel One path (NSE/BSE only) ────────────────────────────────────────
    today_bars: Dict[str, pd.DataFrame] = {}
    yf_tickers = list(tickers)

    if exchange in ("NSE", "BSE"):
        try:
            from angel_client import download_nse_ohlcv, is_available
            if is_available():
                print(f"[screener] {exchange} {bar_min}min: top-up via Angel One (today-only, 12 workers)…")
                _SCREEN_PROGRESS.update({"phase": "topup", "done": 0, "total": len(tickers),
                                         "exchange": exchange, "bar_min": bar_min})
                angel_15m = download_nse_ohlcv(tickers, intraday=True, today_only=True, max_workers=12)
                if angel_15m:
                    for ticker, df_15 in angel_15m.items():
                        df_bar = _resample_intraday(df_15, exchange, bar_min, min_bars=1)
                        if df_bar is not None and not df_bar.empty:
                            today_bars[ticker] = df_bar
                    covered = set(today_bars.keys())
                    yf_tickers = [t for t in tickers if t not in covered]
                    print(f"[screener] {exchange} {bar_min}min: Angel One top-up got "
                          f"{len(covered)}/{len(tickers)}; {len(yf_tickers)} to yfinance fallback")
                else:
                    print(f"[screener] {exchange}: Angel One top-up returned empty — falling back to yfinance")
            else:
                print(f"[screener] {exchange}: Angel One unavailable — using yfinance for top-up")
        except Exception as e:
            print(f"[screener] Angel One top-up error ({type(e).__name__}: {e}); using yfinance")

    # ── yfinance for remaining tickers (or all tickers if not NSE/BSE) ───────
    if yf_tickers:
        batches = [yf_tickers[i: i + DOWNLOAD_BATCH_INTRADAY]
                   for i in range(0, len(yf_tickers), DOWNLOAD_BATCH_INTRADAY)]
        n_batches = len(batches)
        _done = [0]

        def _fetch_today_batch(args):
            b_num, batch = args
            try:
                raw = yf.download(
                    batch, period="1d", interval="15m",
                    auto_adjust=True, progress=False,
                    group_by="ticker", threads=True,
                )
                result: Dict[str, pd.DataFrame] = {}
                if raw is None or raw.empty:
                    return result
                for ticker in batch:
                    try:
                        # Direct extraction — _normalize_df requires ≥30 rows; period='1d'
                        # gives ~25 15-min bars for a full NSE session, so bypass it.
                        if isinstance(raw.columns, pd.MultiIndex):
                            lvl0 = raw.columns.get_level_values(0).unique().tolist()
                            lvl1 = (raw.columns.get_level_values(1).unique().tolist()
                                    if raw.columns.nlevels > 1 else [])
                            if ticker in lvl0:
                                df_15 = raw[ticker].copy()
                            elif ticker in lvl1:
                                df_15 = raw.xs(ticker, axis=1, level=1).copy()
                            else:
                                continue
                            if isinstance(df_15.columns, pd.MultiIndex):
                                df_15.columns = df_15.columns.get_level_values(-1)
                        else:
                            df_15 = raw.copy()

                        want = ["Open", "High", "Low", "Close", "Volume"]
                        df_15 = df_15[[c for c in want if c in df_15.columns]].dropna(subset=["Close"])
                        if df_15.empty:
                            continue

                        # Resample to bar_min; allow ≥1 bar (history provides the depth)
                        df_bar = _resample_intraday(df_15, exchange, bar_min, min_bars=1)
                        if df_bar is not None and not df_bar.empty:
                            result[ticker] = df_bar
                    except Exception:
                        continue
                return result
            except Exception as e:
                print(f"[screener] intraday top-up batch {b_num}/{n_batches}: {type(e).__name__}: {e}")
                return {}
            finally:
                _done[0] += 1
                _SCREEN_PROGRESS["done"] = _done[0]

        print(f"[screener] {exchange} {bar_min}min: top-up via yfinance "
              f"({n_batches} batches × {DOWNLOAD_WORKERS} workers)…")
        _SCREEN_PROGRESS.update({"phase": "topup", "done": 0, "total": n_batches,
                                  "exchange": exchange, "bar_min": bar_min})

        with concurrent.futures.ThreadPoolExecutor(max_workers=DOWNLOAD_WORKERS) as pool:
            for bd in pool.map(_fetch_today_batch, enumerate(batches, 1)):
                today_bars.update(bd)

    # ── Record source breakdown for /api/angel/status ────────────────────────
    angel_count = len(today_bars) - len([t for t in today_bars if t in (yf_tickers if exchange in ("NSE","BSE") else tickers)])
    yf_count    = len([t for t in today_bars if t in yf_tickers]) if exchange in ("NSE","BSE") and yf_tickers else (len(today_bars) if exchange not in ("NSE","BSE") else 0)
    used_angel  = exchange in ("NSE", "BSE") and len(today_bars) > 0 and len(yf_tickers) < len(tickers)
    _LAST_TOPUP.update({
        "exchange":     exchange,
        "bar_min":      bar_min,
        "timestamp":    datetime.datetime.now().isoformat(timespec="seconds"),
        "total":        len(tickers),
        "got_today":    len(today_bars),
        "source":       ("angel_one" if used_angel and not yf_tickers else
                         "mixed"     if used_angel and yf_tickers else
                         "yfinance"),
        "angel_count":  len(today_bars) - len([t for t in today_bars if t in set(yf_tickers)]) if yf_tickers else (len(today_bars) if used_angel else 0),
        "yf_count":     len([t for t in today_bars if t in set(yf_tickers)]) if yf_tickers else (0 if used_angel else len(today_bars)),
    })
    src_tag = _LAST_TOPUP["source"].upper()
    print(f"[screener] {exchange} {bar_min}min: top-up got {len(today_bars)}/{len(tickers)} tickers — source: {src_tag}")

    # Stitch today's bars onto the end of each ticker's historical 75-min series
    merged: Dict[str, pd.DataFrame] = {}
    ts_today = pd.Timestamp(today_str)
    for ticker in tickers:
        hist = prev_data.get(ticker)
        td   = today_bars.get(ticker)
        if hist is not None:
            # Guard: strip any stale "today" rows that might linger in prev_data
            try:
                mask = hist.index.normalize() >= ts_today
                hist = hist[~mask]
            except Exception:
                pass
            merged[ticker] = pd.concat([hist, td]) if td is not None else hist
        # Skip tickers with today's bars only — too few rows for SMA(50)
    return merged


def _download_intraday_ohlcv(exchange: str, tickers: List[str], bar_min: int) -> Dict[str, pd.DataFrame]:
    """Download 15-min OHLCV (60 days) and resample to bar_min-min bars; cache to disk.

    For NSE/BSE: tries Angel One SmartAPI first; yfinance fallback for any missed symbols.
    For US exchanges: yfinance only.
    """
    # ── Fast path: today's intraday cache already exists ─────────────────────
    cached = _load_intraday_cache(exchange, bar_min)
    if cached is not None:
        print(f"[screener] {exchange} {bar_min}min: {len(cached)} tickers from cache")
        _SCREEN_PROGRESS.update({"phase": "cache", "done": len(cached), "total": len(cached), "exchange": exchange, "bar_min": bar_min})
        return cached

    # ── Top-up path: yesterday's history + today's 15-min bars ───────────────
    # Avoids a full 60-day re-download (~5-7 min) every morning.
    # Instead: load previous 75-min cache (~instant) + fetch only today's 15-min
    # bars (period='1d', ~25 bars per ticker, ~25-30s in parallel) → resample →
    # stitch onto history → save as today's cache.
    prev_cached = _load_intraday_cache_prev(exchange, bar_min)
    if prev_cached is not None:
        data = _topup_intraday(exchange, prev_cached, tickers, bar_min)
        if len(data) >= max(10, len(tickers) * 0.1):
            _save_intraday_cache(exchange, bar_min, data)
            print(f"[screener] {exchange} {bar_min}min: top-up saved ({len(data)} tickers)")
        _SCREEN_PROGRESS.update({"phase": "cache", "done": len(data), "total": len(data), "exchange": exchange, "bar_min": bar_min})
        return data

    data: Dict[str, pd.DataFrame] = {}
    yf_tickers = list(tickers)   # shrinks as Angel One covers symbols

    # ── Angel One first-pass (NSE/BSE only) ──────────────────────────────
    if exchange in ("NSE", "BSE"):
        try:
            from angel_client import download_nse_ohlcv
            angel_15m = download_nse_ohlcv(tickers, intraday=True, max_workers=6)
            if angel_15m:
                for ticker, df_15 in angel_15m.items():
                    df_bar = _resample_intraday(df_15, exchange, bar_min)
                    if df_bar is not None:
                        data[ticker] = df_bar
                covered = set(data.keys())
                yf_tickers = [t for t in tickers if t not in covered]
                print(f"[screener] Angel One {bar_min}min: {len(covered)}/{len(tickers)} covered; "
                      f"{len(yf_tickers)} falling back to yfinance")
        except Exception as e:
            print(f"[screener] Angel One intraday skipped ({type(e).__name__}: {e}); using yfinance only")

    # ── yfinance for remaining tickers ───────────────────────────────────
    if yf_tickers:
        intra_batches = [yf_tickers[i: i + DOWNLOAD_BATCH_INTRADAY]
                         for i in range(0, len(yf_tickers), DOWNLOAD_BATCH_INTRADAY)]
        n_batches = len(intra_batches)
        print(f"[screener] {exchange} {bar_min}min (yfinance): downloading {len(yf_tickers)} tickers "
              f"in {n_batches} batches × {DOWNLOAD_WORKERS} parallel workers (15m→{bar_min}m)…")
        _SCREEN_PROGRESS.update({"phase": "downloading", "done": 0, "total": n_batches, "exchange": exchange, "bar_min": bar_min})
        _intra_done = [0]

        def _fetch_intraday_batch(args):
            b_num, batch = args
            try:
                raw = yf.download(
                    batch, period="60d", interval="15m", auto_adjust=True,
                    progress=False, group_by="ticker", threads=True,
                )
                if raw is None or raw.empty:
                    print(f"[screener] {bar_min}min batch {b_num}/{n_batches}: empty")
                    _intra_done[0] += 1
                    _SCREEN_PROGRESS["done"] = _intra_done[0]
                    return {}
                result, ok = {}, 0
                for ticker in batch:
                    df_15 = _normalize_df(raw, ticker)
                    if df_15 is None:
                        continue
                    df_bar = _resample_intraday(df_15, exchange, bar_min)
                    if df_bar is not None:
                        result[ticker] = df_bar
                        ok += 1
                print(f"[screener] {bar_min}min batch {b_num}/{n_batches}: {ok}/{len(batch)} OK")
                _intra_done[0] += 1
                _SCREEN_PROGRESS["done"] = _intra_done[0]
                return result
            except Exception as e:
                print(f"[screener] {bar_min}min batch {b_num}/{n_batches} failed: {type(e).__name__}: {e}")
                _intra_done[0] += 1
                _SCREEN_PROGRESS["done"] = _intra_done[0]
                return {}

        with concurrent.futures.ThreadPoolExecutor(max_workers=DOWNLOAD_WORKERS) as pool:
            for batch_data in pool.map(_fetch_intraday_batch, enumerate(intra_batches, 1)):
                data.update(batch_data)

    print(f"[screener] {exchange} {bar_min}min: {len(data)} tickers — saving cache…")
    if len(data) >= max(10, len(tickers) * 0.1):   # save if ≥10% covered
        _save_intraday_cache(exchange, bar_min, data)
    return data

def _load_ohlcv_cache(exchange: str) -> Optional[Dict[str, pd.DataFrame]]:
    """Load today's cache, or fall back to the most recent cache up to 5 days old.
    Stale daily data is fine — live bar injection patches today's bar during market hours,
    and the prewarm job refreshes the cache each morning before market open.
    """
    today = datetime.date.today()
    for days_back in range(6):  # today → 5 trading days back
        d = today - datetime.timedelta(days=days_back)
        p = OHLCV_CACHE_DIR / f"{exchange}_{d.isoformat()}.pkl"
        if p.exists():
            try:
                data = pickle.load(open(p, "rb"))
                if days_back > 0:
                    print(f"[screener] {exchange}: loaded {days_back}d-old cache ({d}) — "
                          f"prewarm will refresh; live bars patch today's prices")
                return data
            except Exception:
                pass
    return None

def _save_ohlcv_cache(exchange: str, data: Dict[str, pd.DataFrame]):
    # Remove old cache files for this exchange
    for old in OHLCV_CACHE_DIR.glob(f"{exchange}_*.pkl"):
        try: old.unlink()
        except: pass
    with open(_ohlcv_cache_path(exchange), "wb") as f:
        pickle.dump(data, f, protocol=4)

def _topup_ohlcv(exchange: str, data: Dict[str, pd.DataFrame], tickers: List[str]) -> Dict[str, pd.DataFrame]:
    """Lightweight parallel top-up: fetch today's partial daily bar for all tickers.

    Called when the stale cache is loaded but doesn't yet contain today's bars.
    Uses period='2d' (yesterday + today) so we only download ~2 rows per ticker.
    Runs with the same parallel worker pool as the full download (~10-15s for 2000 tickers).
    Merges today's row into the existing historical data and saves as today's cache.
    """
    today_str = datetime.date.today().isoformat()
    batches = [tickers[i: i + DOWNLOAD_BATCH] for i in range(0, len(tickers), DOWNLOAD_BATCH)]
    n_batches = len(batches)
    _done_topup = [0]

    def _fetch_topup_batch(args):
        b_num, batch = args
        try:
            raw = yf.download(
                batch, period="2d", auto_adjust=True,
                progress=False, group_by="ticker", threads=True,
            )
            result = {}
            if raw is None or raw.empty:
                return result
            for ticker in batch:
                try:
                    # _normalize_df requires ≥30 rows — bypass it for the 2-row top-up
                    if isinstance(raw.columns, pd.MultiIndex):
                        lvl0 = raw.columns.get_level_values(0).unique().tolist()
                        lvl1 = (raw.columns.get_level_values(1).unique().tolist()
                                if raw.columns.nlevels > 1 else [])
                        if ticker in lvl0:
                            df = raw[ticker].copy()
                        elif ticker in lvl1:
                            df = raw.xs(ticker, axis=1, level=1).copy()
                        else:
                            continue
                        if isinstance(df.columns, pd.MultiIndex):
                            df.columns = df.columns.get_level_values(-1)
                    else:
                        df = raw.copy()

                    want = ["Open", "High", "Low", "Close", "Volume"]
                    df = df[[c for c in want if c in df.columns]].copy()
                    if "Close" not in df.columns or df.empty:
                        continue
                    df = df.dropna(subset=["Open", "High", "Low", "Close"])
                    if df.empty:
                        continue

                    # Only keep today's row
                    last_str = str(df.index[-1])[:10]
                    if last_str == today_str:
                        result[ticker] = df.iloc[[-1]]
                except Exception:
                    continue
            return result
        except Exception as e:
            print(f"[screener] top-up batch {b_num}/{n_batches}: {type(e).__name__}: {e}")
            return {}
        finally:
            _done_topup[0] += 1
            _SCREEN_PROGRESS["done"] = _done_topup[0]

    print(f"[screener] {exchange}: topping up {len(tickers)} tickers with today's bar "
          f"({n_batches} batches × {DOWNLOAD_WORKERS} workers)…")
    _SCREEN_PROGRESS.update({"phase": "topup", "done": 0, "total": n_batches, "exchange": exchange, "bar_min": 0})

    today_bars: Dict[str, pd.DataFrame] = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=DOWNLOAD_WORKERS) as pool:
        for batch_data in pool.map(_fetch_topup_batch, enumerate(batches, 1)):
            today_bars.update(batch_data)

    print(f"[screener] {exchange}: top-up got {len(today_bars)}/{len(tickers)} tickers for {today_str}")

    # Merge today's row into the historical data
    for ticker, day_df in today_bars.items():
        # Ensure tz-naive index so concat doesn't raise on mixed-tz frames
        try:
            if getattr(day_df.index, "tz", None) is not None:
                day_df = day_df.copy()
                day_df.index = day_df.index.tz_localize(None)
        except Exception:
            pass

        if ticker in data:
            df_old = data[ticker]
            # Drop any existing today row from the cached data
            try:
                mask = df_old.index.normalize().tz_localize(None) >= pd.Timestamp(today_str)
            except TypeError:
                mask = df_old.index.normalize() >= pd.Timestamp(today_str)
            data[ticker] = pd.concat([df_old[~mask], day_df])
        else:
            data[ticker] = day_df

    return data


def _download_ohlcv(exchange: str, tickers: List[str]) -> Dict[str, pd.DataFrame]:
    """Download 1Y OHLCV for all tickers in batches; cache to disk.

    Each stored DataFrame has flat columns [Open, High, Low, Close, Volume]
    with NaN rows already dropped — safe to iterate directly.

    For NSE/BSE: tries Angel One SmartAPI first (400 days); yfinance fallback for any missed symbols.
    For US exchanges: yfinance only.

    Cache strategy:
      - Today's cache exists  → return instantly (already has today's bars)
      - Stale cache (≤5 days) → load it, run a fast parallel period='2d' top-up to add
                                 today's partial bar, save as today's cache, return
      - No cache              → full cold-start download (period='1y'), save, return
    """
    cached = _load_ohlcv_cache(exchange)
    if cached is not None:
        # Check whether the cache already contains today's bars.
        # Sample up to 10 tickers; if any has today's date we're fresh.
        today_str = datetime.date.today().isoformat()
        has_today = False
        for t in list(cached.keys())[:10]:
            df = cached.get(t)
            if df is not None and not df.empty:
                if str(df.index[-1])[:10] == today_str:
                    has_today = True
                    break

        if not has_today:
            # Stale cache — top-up with today's bars.
            # Only save (and rename to today's file) if top-up actually got bars.
            # If top-up fails (yfinance down etc.) keep the old file intact so
            # the 5-day stale window still expires normally → cold-start triggers.
            cached = _topup_ohlcv(exchange, cached, tickers)
            # Re-check: did top-up succeed for at least some tickers?
            got_today = any(
                (df := cached.get(t)) is not None and not df.empty
                and str(df.index[-1])[:10] == today_str
                for t in list(cached.keys())[:20]
            )
            if got_today:
                _save_ohlcv_cache(exchange, cached)
                print(f"[screener] {exchange}: top-up succeeded — saved as today's cache")
            else:
                print(f"[screener] {exchange}: top-up got 0 bars — keeping old cache file intact")

        print(f"[screener] {exchange}: {len(cached)} tickers from cache")
        _SCREEN_PROGRESS.update({"phase": "cache", "done": len(cached), "total": len(cached), "exchange": exchange, "bar_min": 0})
        return cached

    data: Dict[str, pd.DataFrame] = {}
    yf_tickers = list(tickers)   # shrinks as Angel One covers symbols

    # ── Angel One first-pass (NSE/BSE only) ──────────────────────────────
    if exchange in ("NSE", "BSE"):
        try:
            from angel_client import download_nse_ohlcv
            angel_data = download_nse_ohlcv(tickers, intraday=False, max_workers=6)
            if angel_data:
                data.update(angel_data)
                covered = set(angel_data.keys())
                yf_tickers = [t for t in tickers if t not in covered]
                print(f"[screener] Angel One daily: {len(covered)}/{len(tickers)} covered; "
                      f"{len(yf_tickers)} falling back to yfinance")
        except Exception as e:
            print(f"[screener] Angel One daily skipped ({type(e).__name__}: {e}); using yfinance only")

    # ── yfinance for remaining tickers ───────────────────────────────────
    if yf_tickers:
        batches = [yf_tickers[i: i + DOWNLOAD_BATCH] for i in range(0, len(yf_tickers), DOWNLOAD_BATCH)]
        n_batches = len(batches)
        print(f"[screener] {exchange} (yfinance): downloading {len(yf_tickers)} tickers in "
              f"{n_batches} batches × {DOWNLOAD_WORKERS} parallel workers…")
        _SCREEN_PROGRESS.update({"phase": "downloading", "done": 0, "total": n_batches, "exchange": exchange, "bar_min": 0})
        _done_count = [0]   # mutable counter for closure

        def _fetch_batch(args):
            b_num, batch = args
            for attempt in range(1, 3):          # up to 2 attempts per batch
                try:
                    raw = yf.download(
                        batch, period="1y", auto_adjust=True,
                        progress=False, group_by="ticker", threads=True,
                    )
                    if raw is None or raw.empty:
                        print(f"[screener] batch {b_num}/{n_batches} attempt {attempt}: empty")
                        continue
                    result = {}
                    for ticker in batch:
                        df = _normalize_df(raw, ticker)
                        if df is not None:
                            result[ticker] = df
                    print(f"[screener] batch {b_num}/{n_batches}: {len(result)}/{len(batch)} OK")
                    _done_count[0] += 1
                    _SCREEN_PROGRESS["done"] = _done_count[0]
                    return result
                except Exception as e:
                    print(f"[screener] batch {b_num}/{n_batches} attempt {attempt} failed: {type(e).__name__}: {e}")
            _done_count[0] += 1
            _SCREEN_PROGRESS["done"] = _done_count[0]
            return {}  # both attempts failed

        with concurrent.futures.ThreadPoolExecutor(max_workers=DOWNLOAD_WORKERS) as pool:
            for batch_data in pool.map(_fetch_batch, enumerate(batches, 1)):
                data.update(batch_data)

    print(f"[screener] {exchange}: {len(data)} tickers downloaded — saving cache…")
    if len(data) >= max(50, len(tickers) * 0.5):
        _save_ohlcv_cache(exchange, data)
    else:
        print(f"[screener] {exchange}: skipping cache save ({len(data)}/{len(tickers)})")
    return data

# ── Indicator Computation ──────────────────────────────────────────────────
def compute_indicators(ticker: str, df: pd.DataFrame, as_of_date: str = None, intraday: bool = False, include_ohlcv: bool = True) -> Optional[Dict[str, Any]]:
    """Returns OHLCV-based indicators. Info (name/sector/cap) added later.

    Expects a clean DataFrame from _normalize_df (flat columns, NaN rows
    already dropped). Applies an additional safety normalisation just in case
    the caller passes a raw/un-normalised frame.
    """
    min_bars = 20 if intraday else 30
    try:
        if df is None or df.empty or len(df) < min_bars:
            return None

        # ── Safety normalisation (no-op when df is already clean) ──────────
        if isinstance(df.columns, pd.MultiIndex):
            df = df.copy()
            df.columns = df.columns.get_level_values(-1)

        need = ['Open', 'High', 'Low', 'Close', 'Volume']
        if not all(c in df.columns for c in need):
            return None

        df = df.dropna(subset=['Open', 'High', 'Low', 'Close'])
        if len(df) < min_bars:
            return None

        # Historical scan: slice to as_of_date so iloc[-1] = that day
        if as_of_date:
            try:
                cutoff = pd.Timestamp(as_of_date)
                idx = df.index
                # yfinance can return tz-aware DatetimeIndex; normalize both sides
                if hasattr(idx, "tz") and idx.tz is not None:
                    cutoff = cutoff.tz_localize(idx.tz)
                df = df[idx <= cutoff]
            except Exception as e:
                print(f"[screener] as_of_date slice error for {ticker}: {e}")
                return None          # fail loudly instead of silently using full data
            if df is None or len(df) < min_bars:
                return None

        # ── Core series ────────────────────────────────────────────────────
        close = df["Close"]
        high  = df["High"]
        low   = df["Low"]
        vol   = df["Volume"]
        open_ = df["Open"]

        price      = float(close.iloc[-1])
        prev_close = float(close.iloc[-2])
        if prev_close == 0 or np.isnan(price) or np.isnan(prev_close):
            return None

        change_pct = round((price - prev_close) / prev_close * 100, 2)

        vol_last   = vol.iloc[-1]
        volume     = int(vol_last)   if not np.isnan(float(vol_last))   else 0
        vol20      = vol.tail(20).dropna()
        avg_vol_20 = int(vol20.mean()) if len(vol20) else 0

        def sma(n): return _sf(close.rolling(n).mean().iloc[-1]) if len(close) >= n else None

        sma5   = sma(5);  sma10 = sma(10)
        sma20  = sma(20); sma50 = sma(50); sma100 = sma(100); sma200 = sma(200)
        ema20  = _sf(close.ewm(span=20).mean().iloc[-1])
        ema50  = _sf(close.ewm(span=50).mean().iloc[-1])

        # True Range = max(H-L, |H-prevClose|, |L-prevClose|) — handles gaps correctly
        prev_close_s = close.shift(1)
        tr = pd.concat([
            high - low,
            (high - prev_close_s).abs(),
            (low  - prev_close_s).abs(),
        ], axis=1).max(axis=1)
        atr1_true   = float(tr.iloc[-1])
        atr20_mean  = float(tr.rolling(20).mean().iloc[-1])
        atr_ratio   = _sf(atr1_true / atr20_mean, 4) if atr20_mean and atr20_mean > 0 else None

        # Candle position: where did price close in today's range (0=at low, 1=at high)
        hi_last   = float(high.iloc[-1])
        lo_last   = float(low.iloc[-1])
        day_range = hi_last - lo_last
        candle_pos = _sf((price - lo_last) / day_range, 4) if day_range > 0 else None

        # Dollar volume (advol): avg(price × volume) over N bars, in millions — MIO standard
        dv_series     = close * vol
        dollar_vol_20 = _sf(float(dv_series.tail(20).mean()) / 1_000_000, 3)
        dollar_vol_50 = _sf(float(dv_series.tail(50).mean()) / 1_000_000, 3) if len(dv_series) >= 50 else None

        # SMA trend: is sma(N) currently trending up or down vs M bars ago?
        # sma(50) trend_dn 20  →  sma50_now < sma50_20_bars_ago  (MIO semantics)
        #
        # For intraday (75min/78min) bars we scale all lookbacks by 5 so that
        # "trend_dn 10" means "10 day-equivalents" (50 bars ≈ 2 weeks) just like
        # it does on a daily chart.  Without scaling, 10 bars = only 2 trading
        # days on 75min — too short to catch stocks in multi-week downtrends.
        _T = 5 if intraday else 1          # intraday scale factor

        sma50_series     = close.rolling(50).mean()
        sma50_20bars_ago = float(sma50_series.iloc[-(20*_T + 1)]) if len(sma50_series) >= 50*_T + 1 else None
        sma50_5bars_ago  = float(sma50_series.iloc[-(5*_T  + 1)]) if len(sma50_series) >= 50*_T + 6 else None
        sma50_trend_dn_5  = bool(sma50 is not None and sma50_5bars_ago is not None
                                  and sma50 < sma50_5bars_ago)
        sma50_trend_dn_20 = bool(sma50 is not None and (
            (sma50_20bars_ago is not None and sma50 < sma50_20bars_ago) or sma50_trend_dn_5
        ))

        # sma(20) trend direction — scaled lookback for intraday
        sma20_series     = close.rolling(20).mean()
        sma20_10bars_ago = float(sma20_series.iloc[-(10*_T + 1)]) if len(sma20_series) >= 20 + 10*_T + 1 else None
        sma20_5bars_ago  = float(sma20_series.iloc[-(5*_T  + 1)]) if len(sma20_series) >= 20 + 5*_T  + 1 else None
        sma20_trend_dn_5  = bool(sma20 is not None and sma20_5bars_ago is not None
                                  and sma20 < sma20_5bars_ago)
        sma20_trend_dn_10 = bool(sma20 is not None and (
            (sma20_10bars_ago is not None and sma20 < sma20_10bars_ago) or sma20_trend_dn_5
        ))
        sma20_trend_dn_20 = bool(sma20 is not None and (
            (len(sma20_series) >= 20 + 20*_T + 1 and sma20 < float(sma20_series.iloc[-(20*_T + 1)])) or sma20_trend_dn_5
        ))

        # Relative volume: today's volume vs 20-day average
        rvol = _sf(float(vol.iloc[-1]) / avg_vol_20, 2) if avg_vol_20 > 0 else None

        # Gap %: open vs previous close
        gap_pct = _sf((float(open_.iloc[-1]) - prev_close) / prev_close * 100, 2)

        # Distance from N-bar highs (offh): 0 = at the high, positive = below high
        offh_21  = _sf((float(high.tail(21).max()) - price) / float(high.tail(21).max()) * 100, 2) if len(high) >= 21 else None
        offh_50  = _sf((float(high.tail(50).max()) - price) / float(high.tail(50).max()) * 100, 2) if len(high) >= 50 else None
        offh_100 = _sf((float(high.tail(100).max()) - price) / float(high.tail(100).max()) * 100, 2) if len(high) >= 100 else None

        # pgo(N): price % change over N bars (Percent Gain Over)
        def _pgo(n):
            if len(close) <= n: return None
            base = float(close.iloc[-(n+1)])
            return _sf((price - base) / base * 100, 2) if base != 0 else None
        pgo_20  = _pgo(20)
        pgo_50  = _pgo(50)
        pgo_100 = _pgo(100)

        # RSI(14)
        delta  = close.diff()
        gain   = delta.clip(lower=0).rolling(14).mean()
        loss   = (-delta.clip(upper=0)).rolling(14).mean()
        rs     = gain / loss.replace(0, np.nan)
        rsi    = _sf((100 - 100 / (1 + rs)).iloc[-1], 1) if len(close) >= 15 else None

        # MACD(12,26,9)
        ema12  = close.ewm(span=12).mean()
        ema26  = close.ewm(span=26).mean()
        macd_l = ema12 - ema26
        sig_l  = macd_l.ewm(span=9).mean()
        macd_v = _sf(macd_l.iloc[-1], 4)
        sig_v  = _sf(sig_l.iloc[-1], 4)

        # Bollinger Bands(20,2)
        sma20s = close.rolling(20).mean()
        std20  = close.rolling(20).std()
        bb_up  = _sf((sma20s + 2*std20).iloc[-1]) if len(close) >= 20 else None
        bb_lo  = _sf((sma20s - 2*std20).iloc[-1]) if len(close) >= 20 else None

        # 52W high / low
        bars         = min(len(high), 252)
        h52          = _sf(high.tail(bars).max())
        l52          = _sf(low.tail(bars).min())
        pct_h52      = _sf((price - h52) / h52 * 100) if h52 else None
        pct_l52      = _sf((price - l52) / l52 * 100) if l52 else None
        new_52w_high = bool(pct_h52 is not None and pct_h52 >= -0.5)

        # ── OHLCV — last N bars with per-bar SMA20/50 for interactive chart ──
        if include_ohlcv:
            chart_bars = 300 if intraday else 252  # 60d×5bars for 75min, 1y for daily
            date_fmt   = "%Y-%m-%d %H:%M" if intraday else "%Y-%m-%d"
            sma20_rolling = close.rolling(20).mean()
            sma50_rolling = close.rolling(50).mean()
            df_tail = df.tail(chart_bars)
            ohlcv: list = []
            for ts, row in df_tail.iterrows():
                try:
                    o  = float(row["Open"])
                    h  = float(row["High"])
                    lo = float(row["Low"])
                    c  = float(row["Close"])
                    if any(np.isnan(x) for x in [o, h, lo, c]):
                        continue
                    v_raw = row.get("Volume", 0)
                    v = int(float(v_raw)) if v_raw is not None and not np.isnan(float(v_raw)) else 0
                    s20_raw = sma20_rolling.get(ts)
                    s50_raw = sma50_rolling.get(ts)
                    ohlcv.append({
                        "date":   ts.strftime(date_fmt),
                        "open":   round(o,  2),
                        "high":   round(h,  2),
                        "low":    round(lo, 2),
                        "close":  round(c,  2),
                        "volume": v,
                        "sma20":  round(float(s20_raw), 2) if s20_raw is not None and not np.isnan(float(s20_raw)) else None,
                        "sma50":  round(float(s50_raw), 2) if s50_raw is not None and not np.isnan(float(s50_raw)) else None,
                    })
                except Exception:
                    continue
            sparkline = [round(float(x), 2) for x in close.tail(60).tolist()
                         if _safe(x) is not None]
        else:
            ohlcv = []
            sparkline = []

        display = ticker.replace(".NS", "").replace(".BO", "")
        return {
            "symbol":            display,
            "ticker":            ticker,
            "price":             _sf(price),
            "change_pct":        _safe(change_pct),
            "volume":            volume,
            "avg_vol_20":        avg_vol_20,
            "sma5":   sma5,    "sma10":  sma10,
            "sma20":  sma20,   "sma50":  sma50,  "sma100": sma100,  "sma200": sma200,
            "ema20":  ema20,   "ema50":  ema50,
            "atr_ratio":         atr_ratio,
            "candle_pos":        candle_pos,
            "dollar_vol_20":     dollar_vol_20,
            "dollar_vol_50":     dollar_vol_50,
            "sma50_trend_dn_5":  sma50_trend_dn_5,
            "sma50_trend_dn_20": sma50_trend_dn_20,
            "sma20_trend_dn_5":  sma20_trend_dn_5,
            "sma20_trend_dn_10": sma20_trend_dn_10,
            "sma20_trend_dn_20": sma20_trend_dn_20,
            "rvol":              rvol,
            "gap_pct":           gap_pct,
            "offh_21":           offh_21,
            "offh_50":           offh_50,
            "offh_100":          offh_100,
            "pgo_20":            pgo_20,
            "pgo_50":            pgo_50,
            "pgo_100":           pgo_100,
            "rsi":               rsi,
            "macd":              macd_v,
            "macd_signal_val":   sig_v,
            "macd_bullish":      bool(macd_v is not None and sig_v is not None and macd_v > sig_v),
            "bb_upper":          bb_up,
            "bb_lower":          bb_lo,
            "high_52w":          h52,
            "low_52w":           l52,
            "pct_from_52w_high": pct_h52,
            "pct_from_52w_low":  pct_l52,
            "new_52w_high":      new_52w_high,
            "sparkline":         sparkline,
            "ohlcv":             ohlcv,
        }
    except Exception as e:
        print(f"[screener] compute_indicators({ticker}): {type(e).__name__}: {e}")
        return None

def _enrich(result: Dict) -> Dict:
    """Add name / sector / industry / cap_size / market_cap to a matched result."""
    info = _get_info(result["ticker"])
    result["name"]       = info.get("name",       result["symbol"])
    result["sector"]     = info.get("sector",     "—")
    result["industry"]   = info.get("industry",   "—")
    result["cap_size"]   = info.get("cap_size",   "—")
    result["market_cap"] = info.get("market_cap")
    return result

# ── Dynamic SMA / EMA evaluators ──────────────────────────────────────────
import re as _re2

def _eval_sma(ind: Dict, cond: str) -> bool:
    """Evaluate a single SMA condition string against indicator dict."""
    p = ind["price"]
    m = _re2.match(r'price_(above|below)_sma(\d+)$', cond)
    if m:
        d, n = m.group(1), int(m.group(2))
        v = ind.get(f"sma{n}")
        if v is None: return False
        return p > v if d == 'above' else p < v
    m = _re2.match(r'sma(\d+)_(above|below)_sma(\d+)$', cond)
    if m:
        n1, d, n2 = int(m.group(1)), m.group(2), int(m.group(3))
        v1, v2 = ind.get(f"sma{n1}"), ind.get(f"sma{n2}")
        if v1 is None or v2 is None: return False
        return v1 > v2 if d == 'above' else v1 < v2
    return True  # unknown condition — pass through

def _eval_ema(ind: Dict, cond: str) -> bool:
    """Evaluate a single EMA condition string against indicator dict."""
    p = ind["price"]
    m = _re2.match(r'price_(above|below)_ema(\d+)$', cond)
    if m:
        d, n = m.group(1), int(m.group(2))
        v = ind.get(f"ema{n}")
        if v is None: return False
        return p > v if d == 'above' else p < v
    m = _re2.match(r'ema(\d+)_(above|below)_ema(\d+)$', cond)
    if m:
        n1, d, n2 = int(m.group(1)), m.group(2), int(m.group(3))
        v1, v2 = ind.get(f"ema{n1}"), ind.get(f"ema{n2}")
        if v1 is None or v2 is None: return False
        return v1 > v2 if d == 'above' else v1 < v2
    return True  # unknown condition — pass through

# ── Filter Application ─────────────────────────────────────────────────────
def apply_filters(ind: Dict, f: Dict) -> bool:
    p = ind["price"]
    if p is None: return False

    # Price range
    if f.get("price_min") is not None and p < f["price_min"]: return False
    if f.get("price_max") is not None and p > f["price_max"]: return False

    # Change %
    chg = ind["change_pct"]
    if f.get("change_pct_min") is not None and (chg is None or chg < f["change_pct_min"]): return False
    if f.get("change_pct_max") is not None and (chg is None or chg > f["change_pct_max"]): return False

    # Volume: last day
    if f.get("volume_min") is not None and ind["volume"] < f["volume_min"]: return False
    # Volume: 20-day average (advol)
    if f.get("avg_vol_min") is not None and ind["avg_vol_20"] < f["avg_vol_min"]: return False

    # RSI
    rsi = ind["rsi"]
    if f.get("rsi_min") is not None and (rsi is None or rsi < f["rsi_min"]): return False
    if f.get("rsi_max") is not None and (rsi is None or rsi > f["rsi_max"]): return False

    # MACD
    if f.get("macd_signal") == "bullish" and not ind["macd_bullish"]: return False
    if f.get("macd_signal") == "bearish" and ind["macd_bullish"]: return False

    # SMA — list of conditions (all must pass)
    for cond in f.get("sma_conditions", []):
        if not _eval_sma(ind, cond): return False
    # Legacy single sma_condition key
    if f.get("sma_condition") and not _eval_sma(ind, f["sma_condition"]): return False

    # EMA — list of conditions
    for cond in f.get("ema_conditions", []):
        if not _eval_ema(ind, cond): return False
    if f.get("ema_condition") and not _eval_ema(ind, f["ema_condition"]): return False

    # SMA OR conditions — at least ONE must pass
    sma_or = f.get("sma_or_conditions", [])
    if sma_or:
        if not any(_eval_sma(ind, cond) for cond in sma_or):
            return False

    # pgo filters — ALL must pass (individual AND clauses)
    for pf in f.get("pgo_filters", []):
        n, op, val = pf['n'], pf['op'], pf['val']
        pv = ind.get(f"pgo_{n}")
        if pv is None: return False
        if '>' in op and pv < val: return False
        if '<' in op and pv > val: return False

    # pgo OR filters — at least ONE must pass
    pgo_or = f.get("pgo_or_filters", [])
    if pgo_or:
        def _pgo_check(pf):
            n, op, val = pf['n'], pf['op'], pf['val']
            pv = ind.get(f"pgo_{n}")
            if pv is None: return False
            if '>' in op: return pv > val
            if '<' in op: return pv < val
            return False
        if not any(_pgo_check(pf) for pf in pgo_or):
            return False

    # Bollinger Bands
    bb_c = f.get("bb_condition")
    if bb_c:
        bbu, bbl = ind["bb_upper"], ind["bb_lower"]
        if bb_c == "near_upper"  and (bbu is None or p < bbu * 0.98): return False
        if bb_c == "near_lower"  and (bbl is None or p > bbl * 1.02): return False
        if bb_c == "above_upper" and (bbu is None or p <= bbu):        return False
        if bb_c == "below_lower" and (bbl is None or p >= bbl):        return False

    # 52-Week
    pfh = ind["pct_from_52w_high"]; pfl = ind["pct_from_52w_low"]
    if f.get("new_52w_high") and not ind["new_52w_high"]: return False
    if f.get("near_52w_high_pct") is not None and (pfh is None or pfh < -f["near_52w_high_pct"]): return False
    if f.get("near_52w_low_pct")  is not None and (pfl is None or pfl >  f["near_52w_low_pct"]):  return False

    # ATR ratio: atr(1)/atr(20) — active candle filter
    if f.get("atr_ratio_min") is not None:
        ar = ind.get("atr_ratio")
        if ar is None or ar < f["atr_ratio_min"]: return False

    # Candle position: where did price close in today's range (0=bottom, 1=top)
    if f.get("candle_pos_min") is not None:
        cp = ind.get("candle_pos")
        if cp is None or cp < f["candle_pos_min"]: return False

    # Dollar volume (advol): avg daily dollar volume in millions
    if f.get("dollar_vol_min") is not None:
        dv = ind.get("dollar_vol_20")
        if dv is None or dv < f["dollar_vol_min"]: return False

    # Dollar volume over 50 bars (advol(50))
    if f.get("dollar_vol_50_min") is not None:
        dv50 = ind.get("dollar_vol_50")
        if dv50 is None or dv50 < f["dollar_vol_50_min"]: return False

    # !(price < sma(N) and sma(N) trend_dn M) — reject only when BOTH conditions true
    # i.e. keep the stock unless price is below a falling sma(N)
    for fkey, fval in f.items():
        if fval is True and fkey.startswith('not_price_below_sma'):
            m = _NOT_BELOW_RE.match(fkey)
            if m:
                n_s, bars_s = int(m.group(1)), int(m.group(2))
                sma_val = ind.get(f"sma{n_s}")
                trend_dn = ind.get(f"sma{n_s}_trend_dn_{bars_s}", False)
                if sma_val is not None and ind["price"] < sma_val and trend_dn:
                    return False

    # !(sma(N) trend_dn M) — SMA must NOT be falling: reject if it IS falling
    # Also checks the precomputed 5-bar short slope so stocks that just started turning
    # down are caught even when sma_now > sma_M_bars_ago (peaked recently, M-bar still net up)
    for fkey, fval in f.items():
        if fval is True and fkey.startswith('not_sma') and '_trend_dn_' in fkey:
            actual_key = fkey[4:]  # strip leading "not_" → e.g. sma20_trend_dn_10
            if ind.get(actual_key, False):
                return False
            # Short-slope safety net: also reject if SMA declined over last 5 bars
            sma_n_match = _NOT_SMA_TREND_RE.match(fkey)
            if sma_n_match:
                short_key = f"sma{sma_n_match.group(1)}_trend_dn_5"
                if ind.get(short_key, False):
                    return False

    # SMA trend direction — any sma{N}_trend_dn_{M} or sma{N}_trend_up_{M} key
    for fkey, fval in f.items():
        if fval is True and ('_trend_dn_' in fkey or '_trend_up_' in fkey) and not fkey.startswith('not_'):
            if not ind.get(fkey): return False

    # Relative volume
    if f.get("rvol_min") is not None:
        rv = ind.get("rvol")
        if rv is None or rv < f["rvol_min"]: return False

    # Gap up %
    if f.get("gapup_min") is not None:
        gp = ind.get("gap_pct")
        if gp is None or gp < f["gapup_min"]: return False

    # Gap down %
    if f.get("gapdn_min") is not None:
        gp = ind.get("gap_pct")
        if gp is None or (-gp) < f["gapdn_min"]: return False

    # offh_N_max: price must be within N% of N-bar high
    for fkey, threshold in f.items():
        if fkey.startswith("offh_") and fkey.endswith("_max"):
            try:
                n = int(fkey.split("_")[1])
                val = ind.get(f"offh_{n}")
                if val is None or val > threshold: return False
            except (ValueError, IndexError):
                pass

    return True

# ── Live market-hours data ──────────────────────────────────────────────────

def _is_market_open(exchange: str) -> bool:
    """Return True if the exchange is currently within trading hours."""
    now_utc = datetime.datetime.now(tz=pytz.utc)
    if exchange in ("NSE", "BSE"):
        tz   = pytz.timezone("Asia/Kolkata")
        now  = now_utc.astimezone(tz)
        open_, close_ = datetime.time(9, 15), datetime.time(15, 30)
    elif exchange in ("SP500", "NASDAQ", "NYSE"):
        tz   = pytz.timezone("America/New_York")
        now  = now_utc.astimezone(tz)
        open_, close_ = datetime.time(9, 30), datetime.time(16, 0)
    elif exchange == "TSE":
        tz   = pytz.timezone("Asia/Tokyo")
        now  = now_utc.astimezone(tz)
        # TSE: 09:00–11:30 morning, 12:30–15:30 afternoon (lunch break skipped)
        t    = now.time()
        return now.weekday() < 5 and (
            datetime.time(9, 0) <= t <= datetime.time(11, 30) or
            datetime.time(12, 30) <= t <= datetime.time(15, 30)
        )
    elif exchange in ("KOSPI", "KOSDAQ"):
        tz   = pytz.timezone("Asia/Seoul")
        now  = now_utc.astimezone(tz)
        open_, close_ = datetime.time(9, 0), datetime.time(15, 30)
    elif exchange == "XETRA":
        tz   = pytz.timezone("Europe/Berlin")
        now  = now_utc.astimezone(tz)
        open_, close_ = datetime.time(9, 0), datetime.time(17, 30)
    else:
        return False
    return now.weekday() < 5 and open_ <= now.time() <= close_


def _fetch_live_nse_bars(tickers: List[str]) -> Dict[str, Dict]:
    """Live OHLCV for NSE tickers.
    Primary: nselib market_watch (real-time, single API call).
    Fallback: yfinance period=5d interval=1d (today's partial bar, batch download).
    """
    result: Dict[str, Dict] = {}

    # ── Primary: nselib ───────────────────────────────────────────────────────
    try:
        from nselib import capital_market
        df = capital_market.market_watch_all_stocks()
        df.columns = [str(c).strip() for c in df.columns]

        def _col(*names):
            for n in names:
                if n in df.columns: return n
            return None

        sym_col   = _col("symbol",            "Symbol",  "SYMBOL")
        open_col  = _col("open",              "Open",    "openPrice")
        high_col  = _col("dayHigh",           "High",    "highPrice")
        low_col   = _col("dayLow",            "Low",     "lowPrice")
        close_col = _col("lastPrice",         "LTP",     "ltp",  "closePrice")
        vol_col   = _col("totalTradedVolume", "Volume",  "tradedQuantity")

        if all([sym_col, open_col, high_col, low_col, close_col, vol_col]):
            ticker_set = set(tickers)
            for _, row in df.iterrows():
                sym     = str(row[sym_col]).strip()
                ns_tick = f"{sym}.NS"
                if ns_tick not in ticker_set:
                    continue
                try:
                    result[ns_tick] = {
                        "open":   float(row[open_col]),
                        "high":   float(row[high_col]),
                        "low":    float(row[low_col]),
                        "close":  float(row[close_col]),
                        "volume": int(float(str(row[vol_col]).replace(",", "").replace("–", "0") or 0)),
                    }
                except (ValueError, TypeError):
                    continue
            print(f"[screener] NSE live (nselib): {len(result)}/{len(tickers)} bars")
        else:
            print(f"[screener] NSE live: nselib column mismatch {list(df.columns)[:6]}")
    except ImportError:
        print("[screener] nselib not available — using yfinance fallback")
    except Exception as e:
        print(f"[screener] nselib error ({type(e).__name__}) — using yfinance fallback")

    # ── Fallback: yfinance today's bars (parallel) ───────────────────────────
    if not result:
        print("[screener] NSE live fallback: yfinance period=5d parallel …")
        today_str = datetime.date.today().isoformat()
        batches = [tickers[i: i + DOWNLOAD_BATCH] for i in range(0, len(tickers), DOWNLOAD_BATCH)]

        def _live_batch(batch):
            batch_result = {}
            try:
                raw = yf.download(batch, period="5d", interval="1d",
                                  auto_adjust=True, progress=False,
                                  group_by="ticker", threads=True)
                if raw is None or raw.empty:
                    return batch_result
                for ticker in batch:
                    try:
                        # Direct extraction — do NOT use _normalize_df (requires ≥30 rows)
                        if isinstance(raw.columns, pd.MultiIndex):
                            lvl0 = raw.columns.get_level_values(0).unique().tolist()
                            lvl1 = (raw.columns.get_level_values(1).unique().tolist()
                                    if raw.columns.nlevels > 1 else [])
                            if ticker in lvl0:
                                df_t = raw[ticker].copy()
                            elif ticker in lvl1:
                                df_t = raw.xs(ticker, axis=1, level=1).copy()
                            else:
                                continue
                            if isinstance(df_t.columns, pd.MultiIndex):
                                df_t.columns = df_t.columns.get_level_values(-1)
                        else:
                            df_t = raw.copy()

                        df_t = df_t[[c for c in ["Open","High","Low","Close","Volume"]
                                     if c in df_t.columns]].dropna(subset=["Close"])
                        if df_t.empty or "Close" not in df_t.columns:
                            continue
                        if str(df_t.index[-1])[:10] != today_str:
                            continue
                        row = df_t.iloc[-1]
                        batch_result[ticker] = {
                            "open":   float(row["Open"]),
                            "high":   float(row["High"]),
                            "low":    float(row["Low"]),
                            "close":  float(row["Close"]),
                            "volume": int(float(row.get("Volume", 0))),
                        }
                    except Exception:
                        continue
            except Exception:
                pass
            return batch_result

        try:
            with concurrent.futures.ThreadPoolExecutor(max_workers=DOWNLOAD_WORKERS) as pool:
                for batch_result in pool.map(_live_batch, batches):
                    result.update(batch_result)
            print(f"[screener] NSE live (yfinance fallback): {len(result)}/{len(tickers)} bars")
        except Exception as e:
            print(f"[screener] NSE live fallback error: {type(e).__name__}: {e}")

    return result


def _fetch_live_us_bars(tickers: List[str]) -> Dict[str, Dict]:
    """Batch yfinance call for today's partial OHLCV for US tickers."""
    result: Dict[str, Dict] = {}
    try:
        raw = yf.download(
            tickers, period="1d", interval="1d",
            auto_adjust=True, progress=False,
            group_by="ticker", threads=True,
        )
        if raw is None or raw.empty:
            return result

        is_single = len(tickers) == 1

        for ticker in tickers:
            try:
                df_t = raw if is_single else raw.get(ticker)
                if df_t is None or df_t.empty:
                    continue
                df_t = df_t.dropna(how="all")
                if df_t.empty:
                    continue
                row = df_t.iloc[-1]
                # Handle both flat and MultiIndex column names
                def _v(df, *keys):
                    for k in keys:
                        if k in df.columns:
                            return float(df[k].iloc[-1])
                    return 0.0
                result[ticker] = {
                    "open":   _v(df_t, "Open",   "open"),
                    "high":   _v(df_t, "High",   "high"),
                    "low":    _v(df_t, "Low",    "low"),
                    "close":  _v(df_t, "Close",  "close"),
                    "volume": int(_v(df_t, "Volume", "volume") or 0),
                }
            except Exception:
                continue

        print(f"[screener] US live: {len(result)}/{len(tickers)} bars fetched")
    except Exception as e:
        print(f"[screener] US live fetch error: {type(e).__name__}: {e}")
    return result


def _patch_live_bar(df: pd.DataFrame, bar: Dict) -> pd.DataFrame:
    """Append today's live bar, dropping any existing today row from the cache."""
    today = pd.Timestamp.today().normalize()
    # Drop any existing row for today (handles both tz-naive and tz-aware indexes)
    try:
        mask = df.index.normalize().tz_localize(None) == today
    except TypeError:
        mask = df.index.normalize() == today
    df = df[~mask].copy()

    new_row = pd.DataFrame(
        [[bar["open"], bar["high"], bar["low"], bar["close"], bar["volume"]]],
        columns=["Open", "High", "Low", "Close", "Volume"],
        index=[today],
    )
    return pd.concat([df, new_row])


# ── Run Screen ─────────────────────────────────────────────────────────────
def run_screen(exchange: str, filters: Dict, as_of_date: str = None, interval: str = "1d") -> tuple:
    """Returns (results: List[Dict], is_live: bool)."""
    tickers = UNIVERSES.get(exchange, [])
    if not tickers:
        return [], False

    # ── Intraday path (75min for NSE/BSE, 78min for US) ──────────────────
    if interval in ("75min", "78min", "intraday"):
        # Derive bar size: respect explicit interval, fall back to exchange default
        if interval == "75min":
            bar_min = 75
        elif interval == "78min":
            bar_min = 78
        else:
            bar_min = _intraday_bar_minutes(exchange)
        ohlcv_data = _download_intraday_ohlcv(exchange, tickers, bar_min)
        _SCREEN_PROGRESS.update({"phase": "filtering", "done": 0, "total": len(tickers), "exchange": exchange, "bar_min": bar_min})
        matched_tickers_intra: List[str] = []
        for i, ticker in enumerate(tickers):
            df = ohlcv_data.get(ticker)
            if df is None:
                _SCREEN_PROGRESS["done"] = i + 1
                continue
            # Skip OHLCV during filter pass
            ind = compute_indicators(ticker, df, as_of_date=as_of_date, intraday=True, include_ohlcv=False)
            _SCREEN_PROGRESS["done"] = i + 1
            if ind and apply_filters(ind, filters):
                matched_tickers_intra.append(ticker)
        # Rebuild with full OHLCV only for matched tickers
        matched: List[Dict] = []
        for ticker in matched_tickers_intra:
            df = ohlcv_data.get(ticker)
            if df is None:
                continue
            ind = compute_indicators(ticker, df, as_of_date=as_of_date, intraday=True, include_ohlcv=True)
            if ind:
                matched.append(ind)
        matched = [_enrich(r) for r in matched]
        matched.sort(key=lambda x: x.get("change_pct") or 0, reverse=True)
        _SCREEN_PROGRESS["phase"] = "idle"
        return matched, False

    # ── Daily path (default) ──────────────────────────────────────────────
    # Stage 1: Historical OHLCV (cache or download)
    ohlcv_data = _download_ohlcv(exchange, tickers)

    # Stage 2: Live bar injection during market hours (current-day scans only)
    live_bars: Dict[str, Dict] = {}
    if not as_of_date and _is_market_open(exchange):
        print(f"[screener] {exchange}: market open — injecting live bars…")
        if exchange in ("NSE", "BSE"):
            live_bars = _fetch_live_nse_bars(tickers)
        else:
            live_bars = _fetch_live_us_bars(tickers)

    # Stage 3: Compute indicators + filter — parallel across all tickers
    _SCREEN_PROGRESS.update({"phase": "filtering", "done": 0, "total": len(tickers), "exchange": exchange, "bar_min": 0})
    _done_f = [0]
    _lock_f = __import__("threading").Lock()

    def _process(ticker: str):
        try:
            df = ohlcv_data.get(ticker)
            if df is None:
                return None
            if live_bars.get(ticker):
                df = _patch_live_bar(df, live_bars[ticker])
            # Skip heavy OHLCV build during filter scan — add it only for matches
            ind = compute_indicators(ticker, df, as_of_date=as_of_date, include_ohlcv=False)
            if ind and apply_filters(ind, filters):
                return ticker  # return ticker so we can enrich with OHLCV after
            return None
        except Exception as e:
            print(f"[screener] _process({ticker}): {type(e).__name__}: {e}")
            return None
        finally:
            with _lock_f:
                _done_f[0] += 1
                _SCREEN_PROGRESS["done"] = _done_f[0]

    matched_tickers = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
        for result in pool.map(_process, tickers):
            if result is not None:
                matched_tickers.append(result)

    # Build full OHLCV only for matched tickers (typically ~20-100 vs 2109)
    matched = []
    for ticker in matched_tickers:
        try:
            df = ohlcv_data.get(ticker)
            if df is None:
                continue
            if live_bars.get(ticker):
                df = _patch_live_bar(df, live_bars[ticker])
            ind = compute_indicators(ticker, df, as_of_date=as_of_date, include_ohlcv=True)
            if ind:
                matched.append(ind)
        except Exception as e:
            print(f"[screener] ohlcv_enrich({ticker}): {type(e).__name__}: {e}")

    # Stage 4: Enrich matched stocks with name/sector/cap
    matched = [_enrich(r) for r in matched]
    matched.sort(key=lambda x: x.get("change_pct") or 0, reverse=True)
    _SCREEN_PROGRESS["phase"] = "idle"
    return matched, bool(live_bars)


def prewarm_ohlcv_cache(exchanges: List[str] = None) -> None:
    """Pre-download OHLCV for given exchanges if today's cache is missing.
    Safe to call any time — exits immediately if cache is already fresh.
    Designed to run at market open so the first user scan is instant."""
    if exchanges is None:
        exchanges = ["NSE"]
    for exchange in exchanges:
        try:
            tickers = UNIVERSES.get(exchange, [])
            if not tickers:
                continue
            cached = _load_ohlcv_cache(exchange)
            if cached is not None:
                print(f"[prewarm] {exchange}: cache fresh ({len(cached)} tickers) — skip")
                continue
            print(f"[prewarm] {exchange}: cache stale — downloading {len(tickers)} tickers…")
            _download_ohlcv(exchange, tickers)
            print(f"[prewarm] {exchange}: done ✓")
        except Exception as e:
            print(f"[prewarm] {exchange} error: {type(e).__name__}: {e}")


def prewarm_intraday_ohlcv_cache(exchange_bars: List[tuple] = None) -> None:
    """Pre-download intraday (15m→bar_min resampled) OHLCV.
    exchange_bars: list of (exchange, bar_min) pairs.
    Safe to call any time — skips if today's cache already exists.
    Designed to run ~30min after market open so bars are available."""
    if exchange_bars is None:
        exchange_bars = [("NSE", 75)]
    for exchange, bar_min in exchange_bars:
        try:
            tickers = UNIVERSES.get(exchange, [])
            if not tickers:
                continue
            cached = _load_intraday_cache(exchange, bar_min)
            if cached is not None:
                print(f"[prewarm] {exchange} {bar_min}min: cache fresh ({len(cached)} tickers) — skip")
                continue
            print(f"[prewarm] {exchange} {bar_min}min: cache stale — downloading {len(tickers)} tickers…")
            _download_intraday_ohlcv(exchange, tickers, bar_min)
            print(f"[prewarm] {exchange} {bar_min}min: done ✓")
        except Exception as e:
            print(f"[prewarm] {exchange} {bar_min}min error: {type(e).__name__}: {e}")
