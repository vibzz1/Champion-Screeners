"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

const nav = [
  {
    heading: "Analytics Tools",
    items: [
      { label: "Stock Screener", href: "/screener" },
      { label: "Strategy Backtester", href: "/backtester" },
      { label: "Watch Lists", href: "/watchlists" },
      { label: "Portfolio Tracker", href: "/portfolio" },
    ],
  },
];

export default function Sidebar() {
  const pathname = usePathname();

  return (
    <aside
      className="w-40 shrink-0 border-r border-gray-300 bg-[#f0f4f8] min-h-screen text-xs"
      style={{ fontSize: "12px" }}
    >
      {nav.map((section) => (
        <div key={section.heading}>
          <div
            className="px-2 py-1 font-bold text-white text-[11px]"
            style={{ backgroundColor: "#003366" }}
          >
            {section.heading}
          </div>
          {section.items.map((item) => {
            const active = pathname === item.href;
            return (
              <Link
                key={item.href}
                href={item.href}
                className="block px-2 py-[3px] hover:underline"
                style={{ color: active ? "#cc6600" : "#003399", fontWeight: active ? "bold" : "normal" }}
              >
                {item.label}
              </Link>
            );
          })}
        </div>
      ))}
    </aside>
  );
}
