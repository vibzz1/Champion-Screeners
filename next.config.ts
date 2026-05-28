import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";

// instrumentationHook is enabled by default in Next.js 15+ (App Router)
const nextConfig: NextConfig = {};

export default withSentryConfig(nextConfig, {
  // Suppress noisy build logs — errors still surface
  silent: true,
  // Don't upload source maps (no SENTRY_AUTH_TOKEN needed)
  sourcemaps: { disable: true },
  // Disable Sentry telemetry from the build plugin
  telemetry: false,
  // Don't auto-instrument routes — we do it manually via sentry.client.config.ts
  autoInstrumentServerFunctions: false,
});
