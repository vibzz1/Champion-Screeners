// Next.js 15+ server instrumentation hook — runs once on server startup.
// Sentry is initialised here for the Node.js runtime (API routes, RSC).
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const dsn = process.env.SENTRY_DSN ?? process.env.NEXT_PUBLIC_SENTRY_DSN;
    if (dsn) {
      const { init } = await import("@sentry/nextjs");
      init({
        dsn,
        environment: process.env.NODE_ENV,
        tracesSampleRate: 0.1,
      });
    }
  }
}
