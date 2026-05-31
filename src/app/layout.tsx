import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import Sidebar from "@/components/Sidebar";
import Header from "@/components/Header";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });

export const metadata: Metadata = {
  title: "MarketInOut — Stock Screener & Backtester",
  description: "Stock screener with backtesting and portfolio tracker",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={inter.variable}>
      <body className="min-h-screen" style={{ background: "var(--mio-bg)" }}>
        <Header />
        <div className="flex relative overflow-x-hidden">
          <Sidebar />
          <main className="flex-1 overflow-auto min-w-0 p-0 md:p-4">{children}</main>
        </div>
      </body>
    </html>
  );
}
