import { z } from "zod";

import {
  STYLE_OPTIONS,
  SUPPORTED_TLDS,
  allowsSourceFreeRun,
  requiresComOnlyStyles,
} from "@/lib/domain/types";

const tldSchema = z.enum(SUPPORTED_TLDS);
const styleSchema = z.enum(STYLE_OPTIONS);

export const runConfigSchema = z.object({
  selectedTlds: z.array(tldSchema).min(1).max(3),
  enabledStyles: z.array(styleSchema).min(1).max(STYLE_OPTIONS.length),
  wordSourceIds: z.array(z.string().min(1)).max(64),
  targetHits: z.number().int().min(1).max(100).default(25),
  concurrency: z.number().int().min(1).max(2).default(2),
  scoreThreshold: z.number().min(0).max(100).optional(),
  manualDomains: z.array(z.string().min(1)).max(50).optional(),
  recheckExisting: z.boolean().optional(),
}).superRefine((config, context) => {
  if (!allowsSourceFreeRun(config) && config.wordSourceIds.length === 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["wordSourceIds"],
      message: "Select at least one word source before starting a scan.",
    });
  }

  if (requiresComOnlyStyles(config) && !config.selectedTlds.includes("com")) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["selectedTlds"],
      message: "Enable .com when you run single-word or short random .com scans.",
    });
  }
});

export const uploadSourceSchema = z.object({
  name: z.string().trim().min(2).max(60),
  description: z.string().trim().max(160).optional(),
});
