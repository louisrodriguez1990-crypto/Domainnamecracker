import { z } from "zod";

import { STYLE_OPTIONS, SUPPORTED_TLDS } from "@/lib/domain/types";

const tldSchema = z.enum(SUPPORTED_TLDS);
const styleSchema = z.enum(STYLE_OPTIONS);

export const runConfigSchema = z.object({
  selectedTlds: z.array(tldSchema).min(1).max(3),
  enabledStyles: z.array(styleSchema).min(1).max(3),
  wordSourceIds: z.array(z.string().min(1)).min(1),
  targetHits: z.number().int().min(1).max(100).default(25),
  concurrency: z.number().int().min(1).max(2).default(2),
  scoreThreshold: z.number().min(0).max(100).optional(),
  manualDomains: z.array(z.string().min(1)).max(50).optional(),
  recheckExisting: z.boolean().optional(),
});

export const uploadSourceSchema = z.object({
  name: z.string().trim().min(2).max(60),
  description: z.string().trim().max(160).optional(),
});
