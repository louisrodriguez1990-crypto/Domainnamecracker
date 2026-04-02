import postgres from "postgres";

import { requireHostedDatabaseUrl } from "@/lib/server/runtime";

declare global {
  var __domainHunterPostgres: postgres.Sql | undefined;
}

export function getPostgresClient() {
  if (!global.__domainHunterPostgres) {
    global.__domainHunterPostgres = postgres(requireHostedDatabaseUrl(), {
      max: 1,
      ssl: "prefer",
      // Supabase and other hosted poolers do not reliably support prepared statements.
      prepare: false,
    });
  }

  return global.__domainHunterPostgres;
}
