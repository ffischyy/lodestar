"""Default stock universe, sector map and market reference instruments."""
from __future__ import annotations

# Liquid US large caps spread across sectors. Users can replace this list in Settings.
DEFAULT_UNIVERSE: dict[str, tuple[str, str]] = {
    "AAPL": ("Apple Inc.", "Technology"),
    "MSFT": ("Microsoft Corp.", "Technology"),
    "NVDA": ("NVIDIA Corp.", "Technology"),
    "AVGO": ("Broadcom Inc.", "Technology"),
    "ORCL": ("Oracle Corp.", "Technology"),
    "AMD": ("Advanced Micro Devices", "Technology"),
    "CRM": ("Salesforce Inc.", "Technology"),
    "GOOGL": ("Alphabet Inc. Class A", "Communication"),
    "META": ("Meta Platforms", "Communication"),
    "NFLX": ("Netflix Inc.", "Communication"),
    "DIS": ("Walt Disney Co.", "Communication"),
    "AMZN": ("Amazon.com Inc.", "Consumer Disc."),
    "TSLA": ("Tesla Inc.", "Consumer Disc."),
    "HD": ("Home Depot", "Consumer Disc."),
    "MCD": ("McDonald's Corp.", "Consumer Disc."),
    "NKE": ("Nike Inc.", "Consumer Disc."),
    "WMT": ("Walmart Inc.", "Consumer Staples"),
    "COST": ("Costco Wholesale", "Consumer Staples"),
    "PG": ("Procter & Gamble", "Consumer Staples"),
    "KO": ("Coca-Cola Co.", "Consumer Staples"),
    "JPM": ("JPMorgan Chase", "Financials"),
    "BAC": ("Bank of America", "Financials"),
    "GS": ("Goldman Sachs", "Financials"),
    "V": ("Visa Inc.", "Financials"),
    "MA": ("Mastercard Inc.", "Financials"),
    "UNH": ("UnitedHealth Group", "Health Care"),
    "LLY": ("Eli Lilly & Co.", "Health Care"),
    "JNJ": ("Johnson & Johnson", "Health Care"),
    "MRK": ("Merck & Co.", "Health Care"),
    "ABBV": ("AbbVie Inc.", "Health Care"),
    "XOM": ("Exxon Mobil", "Energy"),
    "CVX": ("Chevron Corp.", "Energy"),
    "COP": ("ConocoPhillips", "Energy"),
    "CAT": ("Caterpillar Inc.", "Industrials"),
    "GE": ("GE Aerospace", "Industrials"),
    "UNP": ("Union Pacific", "Industrials"),
    "HON": ("Honeywell", "Industrials"),
    "LIN": ("Linde plc", "Materials"),
    "NEE": ("NextEra Energy", "Utilities"),
    "PLD": ("Prologis Inc.", "Real Estate"),
}

INDEXES: dict[str, str] = {
    "SPY": "S&P 500 ETF",
    "QQQ": "Nasdaq-100 ETF",
    "IWM": "Russell 2000 ETF",
    "DIA": "Dow Jones ETF",
}

SECTOR_ETFS: dict[str, str] = {
    "XLK": "Technology",
    "XLC": "Communication",
    "XLY": "Consumer Disc.",
    "XLP": "Consumer Staples",
    "XLF": "Financials",
    "XLV": "Health Care",
    "XLE": "Energy",
    "XLI": "Industrials",
    "XLB": "Materials",
    "XLU": "Utilities",
    "XLRE": "Real Estate",
}

BENCHMARK = "SPY"

_extra_meta: dict[str, tuple[str, str]] = {}


def universe(settings: dict) -> list[str]:
    syms = [s.upper().strip() for s in settings.get("universe", {}).get("symbols", []) if s.strip()]
    return syms or list(DEFAULT_UNIVERSE.keys())


def meta(symbol: str) -> tuple[str, str]:
    s = symbol.upper()
    if s in DEFAULT_UNIVERSE:
        return DEFAULT_UNIVERSE[s]
    if s in INDEXES:
        return INDEXES[s], "Index"
    if s in SECTOR_ETFS:
        return f"{SECTOR_ETFS[s]} Sector SPDR", "Sector ETF"
    return _extra_meta.get(s, (s, "Unclassified"))


def register_meta(symbol: str, name: str, sector: str) -> None:
    _extra_meta[symbol.upper()] = (name, sector or "Unclassified")


def sector_of(symbol: str) -> str:
    return meta(symbol)[1]


def sector_etf_for(sector: str) -> str | None:
    for etf, sec in SECTOR_ETFS.items():
        if sec == sector:
            return etf
    return None
