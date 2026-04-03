import { z } from "zod";

import {
  STYLE_OPTIONS,
  SUPPORTED_TLDS,
  allowsSourceFreeRun,
  expandLegacyEnabledStyles,
} from "@/lib/domain/types";

const tldSchema = z.enum(SUPPORTED_TLDS);
const styleSchema = z.enum(STYLE_OPTIONS);
const enabledStylesSchema = z.preprocess(
  (value) => Array.isArray(value) ? expandLegacyEnabledStyles(value.map(String)) : value,
  z.array(styleSchema).min(1).max(STYLE_OPTIONS.length),
);

export const runConfigSchema = z.object({
  selectedTlds: z.array(tldSchema).min(1).max(3),
  enabledStyles: enabledStylesSchema,
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
});

export const uploadSourceSchema = z.object({
  name: z.string().trim().min(2).max(60),
  description: z.string().trim().max(160).optional(),
});
