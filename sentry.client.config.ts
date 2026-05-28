import * as Sentry from "@sentry/nextjs";

// Only initialise when DSN is present — no-op in local dev without it
const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV,
    tracesSampleRate: 0.1,
    // Capture replays for all errors, 5% of regular sessions
    replaysOnErrorSampleRate: 1.0,
    replaysSessionSampleRate: 0.05,
    integrations: [Sentry.replayIntegration()],
    // Ignore benign browser noise
    ignoreErrors: [
      "ResizeObserver loop limit exceeded",
      "Non-Error exception captured",
    ],
  });
}
