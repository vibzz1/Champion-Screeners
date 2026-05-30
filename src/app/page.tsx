"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";

// Home redirects straight to the screener — that's the core of the product.
export default function Home() {
  const router = useRouter();
  useEffect(() => { router.replace("/screener"); }, [router]);
  return null;
}
