import { describe, expect, it } from "vitest";

import type { AvailabilityProvider } from "@/lib/domain/availability";
import {
  DICTIONARY_SOURCE_ID,
  type AvailabilityResult,
} from "@/lib/domain/types";
import { RunManager } from "@/lib/server/run-manager";
import { DomainHunterStore } from "@/lib/server/store";

class MockProvider implements AvailabilityProvider {
  readonly name = "mock-rdap";

  constructor(
    private readonly responder: (domain: string) => AvailabilityResult | Promise<AvailabilityResult>,
  ) {}

  async checkDomain(domain: string) {
    return this.responder(domain);
  }
}

async function waitForRun(manager: RunManager, runId: string) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const snapshot = manager.getRunSnapshot(runId);

    if (snapshot && snapshot.run.status !== "running") {
      return snapshot;
    }

    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  throw new Error("Run did not finish in time.");
}

describe("run manager", () => {
  it("stops automatically when the hit target is reached", async () => {
    const store = new DomainHunterStore(":memory:");
    const manager = new RunManager({
      store,
      provider: new MockProvider((domain) => ({
        domain,
        status: domain === "signalforge.com" ? "available" : "taken",
        provider: "mock-rdap",
        checkedAt: new Date().toISOString(),
        confidence: 0.95,
        note: "mocked result",
      })),
      sleeper: async () => undefined,
    });

    const snapshot = await manager.startRun({
      selectedTlds: ["com"],
      enabledStyles: ["keyword"],
      wordSourceIds: [],
      targetHits: 1,
      concurrency: 1,
      scoreThreshold: 0,
      manualDomains: ["signalforge.com", "growthpilot.com"],
      recheckExisting: true,
    });

    const finished = await waitForRun(manager, snapshot.run.id);

    expect(finished.run.status).toBe("completed");
    expect(finished.run.availableCount).toBe(1);

    store.close();
  });

  it("honors stop requests on long-running manual scans", async () => {
    const store = new DomainHunterStore(":memory:");
    const manager = new RunManager({
      store,
      provider: new MockProvider(async (domain) => {
        await new Promise((resolve) => setTimeout(resolve, 35));

        return {
          domain,
          status: "taken",
          provider: "mock-rdap",
          checkedAt: new Date().toISOString(),
          confidence: 0.88,
          note: "still taken",
        };
      }),
    });

    const snapshot = await manager.startRun({
      selectedTlds: ["com"],
      enabledStyles: ["keyword"],
      wordSourceIds: [],
      targetHits: 3,
      concurrency: 1,
      scoreThreshold: 0,
      manualDomains: ["alpha.com", "beta.com", "gamma.com"],
      recheckExisting: true,
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    manager.stopRun(snapshot.run.id);

    const stopped = await waitForRun(manager, snapshot.run.id);

    expect(stopped.run.status).toBe("stopped");

    store.close();
  });

  it("skips previously checked generated domains on later runs", async () => {
    const store = new DomainHunterStore(":memory:");
    const manager = new RunManager({
      store,
      provider: new MockProvider((domain) => ({
        domain,
        status: "taken",
        provider: "mock-rdap",
        checkedAt: new Date().toISOString(),
        confidence: 0.9,
        note: "taken",
      })),
      sleeper: async () => undefined,
    });

    const source = manager.createUploadSource({
      name: "Tiny Source",
      description: "Small deterministic set.",
      words: ["growth", "pilot", "forge", "signal"],
    });

    const firstRun = await manager.startRun({
      selectedTlds: ["com"],
      enabledStyles: ["keyword"],
      wordSourceIds: [source.id],
      targetHits: 25,
      concurrency: 1,
      scoreThreshold: 70,
    });
    const firstFinished = await waitForRun(manager, firstRun.run.id);

    const secondRun = await manager.startRun({
      selectedTlds: ["com"],
      enabledStyles: ["keyword"],
      wordSourceIds: [source.id],
      targetHits: 25,
      concurrency: 1,
      scoreThreshold: 70,
    });
    const secondFinished = await waitForRun(manager, secondRun.run.id);

    expect(firstFinished.run.checkedCount).toBeGreaterThan(0);
    expect(secondFinished.run.skippedCount).toBeGreaterThan(0);
    expect(secondFinished.run.checkedCount).toBe(0);

    store.close();
  });

  it("applies a long cooldown when dictionary sweeps hit rate limits", async () => {
    const store = new DomainHunterStore(":memory:");
    const sleepCalls: number[] = [];
    let checks = 0;
    const manager = new RunManager({
      store,
      provider: new MockProvider((domain) => {
        checks += 1;

        if (checks === 1) {
          return {
            domain,
            status: "unknown",
            provider: "mock-rdap",
            checkedAt: new Date().toISOString(),
            confidence: 0.2,
            note: "RDAP rate limited the request.",
            retryAfterMs: 5_000,
          };
        }

        return {
          domain,
          status: "taken",
          provider: "mock-rdap",
          checkedAt: new Date().toISOString(),
          confidence: 0.9,
          note: "taken",
        };
      }),
      sleeper: async (ms) => {
        sleepCalls.push(ms);
      },
    });

    const snapshot = await manager.startRun({
      selectedTlds: ["com"],
      enabledStyles: ["single-word-com"],
      wordSourceIds: [DICTIONARY_SOURCE_ID],
      targetHits: 1,
      concurrency: 2,
      scoreThreshold: 0,
      manualDomains: ["alpha.com", "beta.com"],
      recheckExisting: true,
    });

    const finished = await waitForRun(manager, snapshot.run.id);
    const totalCooldownSleepMs = sleepCalls
      .filter((ms) => ms >= 1_000)
      .reduce((total, ms) => total + ms, 0);

    expect(finished.run.status).toBe("exhausted");
    expect(totalCooldownSleepMs).toBeGreaterThanOrEqual(120_000);
    expect(sleepCalls.some((ms) => ms >= 1_250 && ms < 5_000)).toBe(true);

    store.close();
  });
});
