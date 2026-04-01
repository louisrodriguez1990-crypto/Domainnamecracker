import { defineConfig } from "drizzle-kit";

export default defineConfig({
  out: "./drizzle",
  schema: "./lib/server/db/schema.ts",
  dialect: "sqlite",
  dbCredentials: {
    url: "./data/domain-hunter.sqlite",
  },
});
