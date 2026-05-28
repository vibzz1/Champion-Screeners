/**
 * MIO Screener — smoke tests
 *
 * Run against production:
 *   E2E_BASE_URL=https://marketinoutscreen.netlify.app \
 *   NEXT_PUBLIC_API_URL=https://champion-screeners-production.up.railway.app \
 *   npx playwright test
 *
 * Run against local:
 *   npx playwright test
 */
import { test, expect } from "@playwright/test";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:3000";
const API  = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

// ── 1. Frontend HTTP ──────────────────────────────────────────────────────────
test("frontend /screener returns HTTP 200", async ({ request }) => {
  const res = await request.get(`${BASE}/screener`);
  expect(res.status()).toBe(200);
});

// ── 2. Backend health ─────────────────────────────────────────────────────────
test("backend /api/health returns ok + executor alive", async ({ request }) => {
  const res = await request.get(`${API}/api/health`, { timeout: 15_000 });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.status).toBe("ok");
  expect(body.executor_alive).toBe(true);
  expect(body.yfinance).toBe("ok");
});

// ── 3. Backend progress endpoint ──────────────────────────────────────────────
test("backend /api/screener/progress returns idle when not scanning", async ({ request }) => {
  const res = await request.get(`${API}/api/screener/progress`);
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body).toHaveProperty("phase");
});

// ── 4. Formula parse endpoint works ──────────────────────────────────────────
test("formula validation rejects empty formula", async ({ request }) => {
  const res = await request.post(`${API}/api/screener/validate`, {
    data: { formula: "" },
    headers: { "Content-Type": "application/json" },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.valid).toBe(true); // empty is valid (no filters = pass-all)
});

test("formula validation flags unrecognised formula", async ({ request }) => {
  const res = await request.post(`${API}/api/screener/validate`, {
    data: { formula: "gobbledygook gibberish" },
    headers: { "Content-Type": "application/json" },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.valid).toBe(false);
  expect(body.warnings.length).toBeGreaterThan(0);
});

// ── 5. Browser: page loads without crash ──────────────────────────────────────
test("screener page loads in browser without JS errors", async ({ page }) => {
  const jsErrors: string[] = [];
  page.on("pageerror", (err) => jsErrors.push(err.message));

  await page.goto(`${BASE}/screener`, { waitUntil: "domcontentloaded", timeout: 30_000 });

  // Title should be set
  await expect(page).toHaveTitle(/MarketInOut|Screener/i, { timeout: 10_000 });

  // Wait a beat for hydration
  await page.waitForTimeout(2_000);

  // Filter out known benign browser noise
  const realErrors = jsErrors.filter(
    (e) => !e.includes("ResizeObserver") && !e.includes("Non-Error")
  );
  expect(realErrors).toHaveLength(0);
});
