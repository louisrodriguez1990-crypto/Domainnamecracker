const HOSTED_DATABASE_ENV_VARS = [
  "POSTGRES_URL_NON_POOLING",
  "POSTGRES_URL",
  "DATABASE_URL",
  "SUPABASE_DB_URL",
  "NEON_DATABASE_URL",
] as const;

export function getHostedDatabaseUrl(): string | null {
  for (const envVar of HOSTED_DATABASE_ENV_VARS) {
    const value = process.env[envVar];

    if (value) {
      return value;
    }
  }

  return null;
}

export function isVercelDeployment(): boolean {
  return process.env.VERCEL === "1";
}

export function isHostedRuntime(): boolean {
  return Boolean(getHostedDatabaseUrl());
}

export function getHostedDatabaseSetupMessage(): string {
  return "This Vercel deployment is online, but it still needs a hosted Postgres connection before scans can run. Add a Supabase pooled connection string as DATABASE_URL or SUPABASE_DB_URL and redeploy.";
}

export function requireHostedDatabaseUrl(): string {
  const url = getHostedDatabaseUrl();

  if (!url) {
    throw new Error(getHostedDatabaseSetupMessage());
  }

  return url;
}
