import Link from "next/link";

export default function Home() {
  return (
    <div className="p-6 max-w-2xl">
      <h1 className="text-2xl font-bold mb-2" style={{ color: "#003366" }}>
        Welcome to MarketInOut
      </h1>
      <p className="text-gray-600 mb-6 text-sm">
        A powerful platform for strategy backtesting and portfolio management.
      </p>
      <div className="flex flex-col gap-3">
        {[
          { href: "/backtester", label: "Strategy Backtester", desc: "Backtest your entry/exit rules and review performance stats." },
          { href: "/watchlists", label: "Watch Lists", desc: "Create and manage lists of stocks you are tracking." },
          { href: "/portfolio", label: "Portfolio Tracker", desc: "Track your open positions and overall P&L." },
        ].map((t) => (
          <Link
            key={t.href}
            href={t.href}
            className="border border-gray-300 rounded px-4 py-3 hover:bg-blue-50 transition-colors"
          >
            <div className="font-semibold" style={{ color: "#003399" }}>{t.label}</div>
            <div className="text-gray-500 text-xs mt-0.5">{t.desc}</div>
          </Link>
        ))}
      </div>
    </div>
  );
}
