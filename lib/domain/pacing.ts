import {
  DICTIONARY_SOURCE_ID,
  type AvailabilityResult,
  type RunConfig,
} from "@/lib/domain/types";

type ScanPacing = {
  workerCount: number;
  interTaskDelayBaseMs: number;
  interTaskDelayVariationMs: number;
  unknownRetryBaseMs: number;
  unknownRetryVariationMs: number;
  baseCooldownMs: number;
};

const STANDARD_PACING = {
  interTaskDelayBaseMs: 320,
  interTaskDelayVariationMs: 240,
  unknownRetryBaseMs: 450,
  unknownRetryVariationMs: 250,
  baseCooldownMs: 60_000,
};

const DICTIONARY_PACING = {
  interTaskDelayBaseMs: 1_250,
  interTaskDelayVariationMs: 750,
  unknownRetryBaseMs: 1_200,
  unknownRetryVariationMs: 500,
  baseCooldownMs: 120_000,
};

export function isDictionarySweep(
  config: Pick<RunConfig, "enabledStyles" | "wordSourceIds">,
) {
  return (
    config.enabledStyles.includes("single-word-com") &&
    config.wordSourceIds.includes(DICTIONARY_SOURCE_ID)
  );
}

export function getScanPacing(
  config: Pick<RunConfig, "concurrency" | "enabledStyles" | "wordSourceIds">,
): ScanPacing {
  const dictionarySweep = isDictionarySweep(config);
  const pacing = dictionarySweep ? DICTIONARY_PACING : STANDARD_PACING;

  return {
    workerCount: Math.min(config.concurrency, dictionarySweep ? 1 : 2),
    ...pacing,
  };
}

export function getRetryAfterMs(result: AvailabilityResult): number | null {
  if (
    typeof result.retryAfterMs !== "number" ||
    !Number.isFinite(result.retryAfterMs) ||
    result.retryAfterMs <= 0
  ) {
    return null;
  }

  return Math.ceil(result.retryAfterMs);
}

export function getCooldownDelayMs(
  retryAfterMs: number | null,
  consecutiveRateLimits: number,
  baseCooldownMs: number,
) {
  const requestedDelay = retryAfterMs ?? baseCooldownMs;
  const escalationFloor =
    consecutiveRateLimits >= 3
      ? baseCooldownMs * 5
      : consecutiveRateLimits === 2
        ? baseCooldownMs * 2
        : baseCooldownMs;

  return Math.max(requestedDelay, escalationFloor);
}

export function formatCooldownMessage(note: string, cooldownMs: number) {
  const seconds = Math.ceil(cooldownMs / 1000);
  return `${note} Cooling down for ${seconds}s before continuing.`;
}
