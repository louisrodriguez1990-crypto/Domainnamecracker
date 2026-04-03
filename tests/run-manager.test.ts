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

class MockHybridProvider implements AvailabilityProvider {
  readonly name = "mock-namecom";

  constructor(
    private readonly options: {
      screenDomains: (domains: string[]) => AvailabilityResult[] | Promise<AvailabilityResult[]>;
      checkDomains: (domains: string[]) => AvailabilityResult[] | Promise<AvailabilityResult[]>;
    },
  ) {}

  async checkDomain(domain: string) {
    const [result] = await this.options.checkDomains([domain]);

    return result ?? {
      domain,
      status: "unknown",
      provider: this.name,
      checkedAt: new Date().toISOString(),
      confidence: 0.2,
      note: "missing live result",
      stage: "definitive",
    };
  }

  async screenDomains(domains: string[]) {
    return this.options.screenDomains(domains);
  }

  async checkDomains(domains: string[]) {
    return this.options.checkDomains(domains);
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

  it("counts hybrid Name.com scans once per screened domain and only counts live-confirmed hits", async () => {
    const store = new DomainHunterStore(":memory:");
    const manager = new RunManager({
      store,
      provider: new MockHybridProvider({
        screenDomains: (domains) =>
          domains.map((domain) => ({
            domain,
            status: "available",
            provider: "mock-namecom",
            checkedAt: new Date().toISOString(),
            confidence: 0.82,
            note: "screened as promising",
            stage: "preliminary",
          })),
        checkDomains: (domains) =>
          domains.map((domain) => ({
            domain,
            status: domain === "signalforge.com" ? "available" : "taken",
            provider: "mock-namecom",
            checkedAt: new Date().toISOString(),
            confidence: 0.99,
            note: "live result",
            stage: "definitive",
          })),
      }),
      sleeper: async () => undefined,
    });

    const source = manager.createUploadSource({
      name: "Hybrid Source",
      description: "Two words for a small hybrid batch.",
      words: ["signal", "forge"],
    });

    const run = await manager.startRun({
      selectedTlds: ["com"],
      enabledStyles: ["keyword"],
      wordSourceIds: [source.id],
      targetHits: 1,
      concurrency: 1,
      scoreThreshold: 0,
    });

    const finished = await waitForRun(manager, run.run.id);

    expect(finished.run.status).toBe("completed");
    expect(finished.run.checkedCount).toBeGreaterThan(0);
    expect(finished.run.availableCount).toBe(1);
    expect(finished.recentResults.every((result) => result.provider === "mock-namecom")).toBe(true);

    store.close();
  });

  it("expires preliminary negatives so later runs can re-screen them", async () => {
    const store = new DomainHunterStore(":memory:");
    const checkedAt = new Date(Date.now() - 1000 * 60 * 60 * 20).toISOString();

    store.recordPreliminaryBatch({
      runId: store.createRun({
        selectedTlds: ["com"],
        enabledStyles: ["keyword"],
        wordSourceIds: [],
        targetHits: 1,
        concurrency: 1,
      }, 0).id,
      screens: [
        {
          candidate: {
            label: "alpha",
            style: "keyword",
            sourceWords: ["alpha"],
            score: 80,
            fullDomains: ["alpha.com"],
          },
          domain: "alpha.com",
          result: {
            domain: "alpha.com",
            status: "taken",
            provider: "mock-namecom",
            checkedAt,
            confidence: 0.78,
            note: "cached preliminary negative",
            stage: "preliminary",
            expiresAt: new Date(Date.now() - 1000).toISOString(),
          },
        },
      ],
      checkedCountIncrement: 1,
      currentCandidate: "alpha.com",
    });

    expect(store.getCheckedDomain("alpha.com")).toBeUndefined();

    store.close();
  });

  it("bypasses preliminary screening for manual rechecks on hybrid providers", async () => {
    const store = new DomainHunterStore(":memory:");
    let screenCalls = 0;
    let liveCalls = 0;
    const manager = new RunManager({
      store,
      provider: new MockHybridProvider({
        screenDomains: (domains) => {
          screenCalls += domains.length;
          return [];
        },
        checkDomains: (domains) => {
          liveCalls += domains.length;
          return domains.map((domain) => ({
            domain,
            status: "taken",
            provider: "mock-namecom",
            checkedAt: new Date().toISOString(),
            confidence: 0.99,
            note: "manual live result",
            stage: "definitive",
          }));
        },
      }),
      sleeper: async () => undefined,
    });

    const snapshot = await manager.startRun({
      selectedTlds: ["com"],
      enabledStyles: ["keyword"],
      wordSourceIds: [],
      targetHits: 1,
      concurrency: 1,
      scoreThreshold: 0,
      manualDomains: ["alpha.com"],
      recheckExisting: true,
    });

    await waitForRun(manager, snapshot.run.id);

    expect(screenCalls).toBe(0);
    expect(liveCalls).toBe(1);

    store.close();
  });
});
