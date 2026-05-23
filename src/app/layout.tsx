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
      <body className="min-h-screen bg-white">
        <Header />
        <div className="flex">
          <Sidebar />
          <main className="flex-1 p-4 overflow-auto">{children}</main>
        </div>
      </body>
    </html>
  );
}
