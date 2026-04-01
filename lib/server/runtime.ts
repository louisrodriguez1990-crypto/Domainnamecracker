export function getHostedDatabaseUrl(): string | null {
  return (
    process.env.POSTGRES_URL_NON_POOLING ??
    process.env.POSTGRES_URL ??
    process.env.DATABASE_URL ??
    process.env.NEON_DATABASE_URL ??
    null
  );
}

export function isHostedRuntime(): boolean {
  return Boolean(getHostedDatabaseUrl()) || process.env.VERCEL === "1";
}

export function requireHostedDatabaseUrl(): string {
  const url = getHostedDatabaseUrl();

  if (!url) {
    throw new Error(
      "This deployment needs a Postgres Marketplace integration on Vercel. Add one so the app receives POSTGRES_URL or DATABASE_URL.",
    );
  }

  return url;
}
