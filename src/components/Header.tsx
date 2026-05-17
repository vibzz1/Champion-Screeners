"use client";
import Link from "next/link";

export default function Header() {
  return (
    <div className="flex items-center justify-between px-3 py-2 border-b border-gray-300 bg-white">
      <Link href="/" className="flex items-center gap-1">
        <span className="text-2xl font-bold" style={{ color: "#003366" }}>
          Market In
          <span style={{ color: "#cc6600" }}>O</span>
          ut
        </span>
        <span className="text-xs tracking-widest text-gray-500 ml-1 mt-1">STOCK SCREENER</span>
      </Link>
      <div className="text-xs text-gray-600">
        <Link href="/account" className="text-blue-700 hover:underline">My Account</Link>
      </div>
    </div>
  );
}
