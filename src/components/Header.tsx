"use client";
import Link from "next/link";
import { useEffect, useState } from "react";

export default function Header() {
  const [dark, setDark] = useState(false);

  useEffect(() => {
    const saved = localStorage.getItem("mio_theme");
    if (saved === "dark") { setDark(true); document.documentElement.setAttribute("data-theme", "dark"); }
  }, []);

  function toggleDark() {
    const next = !dark;
    setDark(next);
    if (next) {
      document.documentElement.setAttribute("data-theme", "dark");
      localStorage.setItem("mio_theme", "dark");
    } else {
      document.documentElement.removeAttribute("data-theme");
      localStorage.setItem("mio_theme", "light");
    }
  }

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
      <div className="flex items-center gap-3">
        <button
          onClick={toggleDark}
          title={dark ? "Switch to light mode" : "Switch to dark mode"}
          className="px-2 py-1 rounded border transition-colors text-[11px]"
          style={{
            borderColor: dark ? "#f59e0b" : "#334155",
            color:       dark ? "#f59e0b" : "#64748b",
            backgroundColor: "transparent",
          }}>
          {dark ? "☀ Light" : "◑ Dark"}
        </button>
      </div>
    </div>
  );
}
