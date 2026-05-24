"use client";
import Link from "next/link";

export default function Header() {
  return (
    <div className="flex items-center justify-between px-4 py-2.5 border-b border-white/5" style={{ backgroundColor: "#0f172a" }}>
      <Link href="/" className="flex items-center gap-2.5">
        <span className="text-xl font-bold tracking-tight text-white">
          Market In<span style={{ color: "#f59e0b" }}>O</span>ut
        </span>
        <span className="text-[10px] tracking-widest font-medium" style={{ color: "#475569" }}>
          STOCK SCREENER
        </span>
      </Link>
      <div className="text-xs">
        <Link href="/account" className="transition-colors" style={{ color: "#64748b" }}
          onMouseEnter={e => (e.currentTarget.style.color = "#e2e8f0")}
          onMouseLeave={e => (e.currentTarget.style.color = "#64748b")}>
          My Account
        </Link>
      </div>
    </div>
  );
}
