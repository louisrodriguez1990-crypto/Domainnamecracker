import postgres from "postgres";

import { requireHostedDatabaseUrl } from "@/lib/server/runtime";

declare global {
  var __domainHunterPostgres: postgres.Sql | undefined;
}

export function getPostgresClient() {
  if (!global.__domainHunterPostgres) {
    global.__domainHunterPostgres = postgres(requireHostedDatabaseUrl(), {
      // Keep the pool small for serverless Postgres, but allow enough headroom
      // for concurrent page loads, polling, and workflow writes.
      max: 4,
      ssl: "prefer",
      // Supabase and other hosted poolers do not reliably support prepared statements.
      prepare: false,
    });
  }

  return global.__domainHunterPostgres;
}
