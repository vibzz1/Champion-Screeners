"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";

// Home is the market dashboard — regime + breadth before you dive into scans.
export default function Home() {
  const router = useRouter();
  useEffect(() => { router.replace("/dashboard"); }, [router]);
  return null;
}
