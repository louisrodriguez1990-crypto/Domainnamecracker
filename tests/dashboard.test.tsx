// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Dashboard } from "@/components/dashboard";
import type {
  AvailabilityProviderStatus,
  HistoryPayload,
  RunSnapshot,
} from "@/lib/domain/types";

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });
}

const baseHistory: HistoryPayload = {
  wordSources: [
    {
      id: "builtin-ai",
      name: "AI Momentum",
      kind: "builtin",
      description: "Built-in words",
      wordCount: 10,
      buckets: {
        adjectives: [],
        nouns: [],
        verbs: [],
        modifiers: [],
        cores: [],
        general: [],
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  ],
  recentRuns: [],
  recentHits: [],
};

const baseProviderStatus: AvailabilityProviderStatus = {
  nameComConfigured: true,
  nameComSetupMessage: null,
  externalCheckerConfigured: false,
  defaultProvider: "namecom",
  fallbackProvider: "rdap",
};

const startedRun: RunSnapshot = {
  run: {
    id: "run-1",
    status: "running",
    selectedTlds: ["com", "io", "ai"],
    enabledStyles: ["keyword", "brandable"],
    wordSourceIds: ["builtin-ai", "upload-1"],
    targetHits: 25,
    concurrency: 2,
    preferNameCom: true,
    scoreThreshold: 58,
    generatedCount: 320,
    checkedCount: 0,
    skippedCount: 0,
    availableCount: 0,
    currentCandidate: "signalforge.com",
    lastError: null,
    stopRequested: false,
    manualDomains: [],
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    finishedAt: null,
  },
  topHits: [],
  recentResults: [],
};

describe("dashboard", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("uploads a source and starts a run", async () => {
    const uploadedSource = {
      ...baseHistory.wordSources[0],
      id: "upload-1",
      name: "Custom Upload",
      kind: "upload" as const,
    };

    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);

      if (url === "/api/word-sources") {
        return jsonResponse(uploadedSource, 201);
      }

      if (url === "/api/runs") {
        return jsonResponse(startedRun, 201);
      }

      if (url === "/api/history") {
        return jsonResponse({
          ...baseHistory,
          wordSources: [...baseHistory.wordSources, uploadedSource],
        });
      }

      if (url === "/api/runs/run-1") {
        return jsonResponse({
          ...startedRun,
          run: { ...startedRun.run, status: "completed", availableCount: 1 },
        });
      }

      throw new Error(`Unexpected fetch call to ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    const { container } = render(
      <Dashboard
        initialHistory={baseHistory}
        initialRun={null}
        providerStatus={baseProviderStatus}
      />,
    );

    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(["signal\nforge\ngrowth"], "custom.txt", {
      type: "text/plain",
    });

    fireEvent.change(screen.getByPlaceholderText(/crypto slang/i), {
      target: { value: "Custom Upload" },
    });
    fireEvent.change(fileInput, { target: { files: [file] } });
    fireEvent.click(screen.getByRole("button", { name: /add source/i }));

    await waitFor(() =>
      expect(screen.getByText(/Added Custom Upload as a reusable source/i)).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: /start search/i }));

    await waitFor(() =>
      expect(screen.getByText(/Scan started\. The worker is cycling through fresh candidates\./i)).toBeInTheDocument(),
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/runs",
      expect.objectContaining({
        method: "POST",
      }),
    );
  });

  it("allows pronounceable 4-letter runs without any word source selected", async () => {
    const shortRun: RunSnapshot = {
      ...startedRun,
      run: {
        ...startedRun.run,
        id: "run-short",
        status: "completed",
        enabledStyles: ["random-4-com"],
        wordSourceIds: [],
        selectedTlds: ["com"],
      },
    };

    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);

      if (url === "/api/runs") {
        return jsonResponse(shortRun, 201);
      }

      if (url === "/api/history") {
        return jsonResponse(baseHistory);
      }

      throw new Error(`Unexpected fetch call to ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    render(
      <Dashboard
        initialHistory={baseHistory}
        initialRun={null}
        providerStatus={baseProviderStatus}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /keyword compounds/i }));
    fireEvent.click(screen.getByRole("button", { name: /brandable mashups/i }));
    fireEvent.click(screen.getByRole("button", { name: /pronounceable 4-letter/i }));
    fireEvent.click(screen.getByRole("button", { name: /ai momentum/i }));
    fireEvent.click(screen.getByRole("button", { name: /start search/i }));

    await waitFor(() =>
      expect(screen.getByText(/Scan started\. The worker is cycling through fresh candidates\./i)).toBeInTheDocument(),
    );

    const runRequest = fetchMock.mock.calls.find(
      ([url]) => String(url) === "/api/runs",
    );

    expect(runRequest).toBeTruthy();
    expect(runRequest?.[1]).toEqual(
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          selectedTlds: ["com", "io", "ai"],
          enabledStyles: ["random-4-com"],
          wordSourceIds: [],
          targetHits: 25,
          concurrency: 2,
          preferNameCom: true,
          scoreThreshold: 58,
        }),
      }),
    );
  });

  it("normalizes legacy short-name styles from a saved run before starting again", async () => {
    const legacyRun: RunSnapshot = {
      ...startedRun,
      run: {
        ...startedRun.run,
        id: "run-legacy",
        status: "completed",
        enabledStyles: ["random-3-com", "random-4-com", "random-5-com"],
        wordSourceIds: [],
        selectedTlds: ["com"],
      },
    };

    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);

      if (url === "/api/runs") {
        return jsonResponse(legacyRun, 201);
      }

      if (url === "/api/history") {
        return jsonResponse(baseHistory);
      }

      throw new Error(`Unexpected fetch call to ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    render(
      <Dashboard
        initialHistory={baseHistory}
        initialRun={{
          ...legacyRun,
          run: {
            ...legacyRun.run,
            enabledStyles: ["random-short-com" as never],
          },
        }}
        providerStatus={baseProviderStatus}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /start search/i }));

    await waitFor(() =>
      expect(screen.getByText(/Scan started\. The worker is cycling through fresh candidates\./i)).toBeInTheDocument(),
    );

    const runRequest = fetchMock.mock.calls.find(
      ([url]) => String(url) === "/api/runs",
    );

    expect(runRequest?.[1]).toEqual(
      expect.objectContaining({
        body: JSON.stringify({
          selectedTlds: ["com"],
          enabledStyles: ["random-3-com", "random-4-com", "random-5-com"],
          wordSourceIds: [],
          targetHits: 25,
          concurrency: 2,
          preferNameCom: true,
          scoreThreshold: 58,
        }),
      }),
    );
  });

  it("lets you disable Name.com per run when credentials are configured", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);

      if (url === "/api/runs") {
        return jsonResponse(startedRun, 201);
      }

      if (url === "/api/history") {
        return jsonResponse(baseHistory);
      }

      if (url === "/api/runs/run-1") {
        return jsonResponse({
          ...startedRun,
          run: { ...startedRun.run, status: "completed" },
        });
      }

      throw new Error(`Unexpected fetch call to ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    render(
      <Dashboard
        initialHistory={baseHistory}
        initialRun={null}
        providerStatus={baseProviderStatus}
      />,
    );

    fireEvent.click(screen.getByRole("switch", { name: /use name\.com when available/i }));
    fireEvent.click(screen.getByRole("button", { name: /start search/i }));

    await waitFor(() =>
      expect(screen.getByText(/Scan started\. The worker is cycling through fresh candidates\./i)).toBeInTheDocument(),
    );

    const runRequest = fetchMock.mock.calls.find(
      ([url]) => String(url) === "/api/runs",
    );

    expect(runRequest?.[1]).toEqual(
      expect.objectContaining({
        body: JSON.stringify({
          selectedTlds: ["com", "io", "ai"],
          enabledStyles: ["keyword", "brandable"],
          wordSourceIds: ["builtin-ai"],
          targetHits: 25,
          concurrency: 2,
          preferNameCom: false,
          scoreThreshold: 58,
        }),
      }),
    );
  });
});
