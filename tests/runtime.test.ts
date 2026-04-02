import { afterEach, describe, expect, it } from "vitest";

import {
  getHostedDatabaseSetupMessage,
  getHostedDatabaseUrl,
  isHostedRuntime,
  requireHostedDatabaseUrl,
} from "@/lib/server/runtime";

const originalEnv = { ...process.env };

function resetHostedEnv() {
  process.env = {
    ...originalEnv,
    POSTGRES_URL_NON_POOLING: undefined,
    POSTGRES_URL: undefined,
    DATABASE_URL: undefined,
    SUPABASE_DB_URL: undefined,
    NEON_DATABASE_URL: undefined,
  };
}

describe("hosted runtime detection", () => {
  afterEach(() => {
    resetHostedEnv();
  });

  it("prefers higher-priority hosted database environment variables", () => {
    resetHostedEnv();
    process.env.POSTGRES_URL_NON_POOLING = "postgres://non-pooling";
    process.env.POSTGRES_URL = "postgres://pooling";
    process.env.DATABASE_URL = "postgres://database-url";
    process.env.SUPABASE_DB_URL = "postgres://supabase";
    process.env.NEON_DATABASE_URL = "postgres://neon";

    expect(getHostedDatabaseUrl()).toBe("postgres://non-pooling");
  });

  it("accepts SUPABASE_DB_URL for hosted mode", () => {
    resetHostedEnv();
    process.env.SUPABASE_DB_URL = "postgres://supabase";

    expect(getHostedDatabaseUrl()).toBe("postgres://supabase");
    expect(isHostedRuntime()).toBe(true);
  });

  it("uses the hosted setup message when no database env var is present", () => {
    resetHostedEnv();

    expect(() => requireHostedDatabaseUrl()).toThrowError(
      getHostedDatabaseSetupMessage(),
    );
  });
});
