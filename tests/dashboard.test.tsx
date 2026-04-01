// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Dashboard } from "@/components/dashboard";
import type { HistoryPayload, RunSnapshot } from "@/lib/domain/types";

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

const startedRun: RunSnapshot = {
  run: {
    id: "run-1",
    status: "running",
    selectedTlds: ["com", "io", "ai"],
    enabledStyles: ["keyword", "brandable"],
    wordSourceIds: ["builtin-ai", "upload-1"],
    targetHits: 25,
    concurrency: 2,
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
    vi.unstubAllGlobals();
  });

  it("uploads a source and starts a run", async () => {
    const uploadedSource = {
      ...baseHistory.wordSources[0],
      id: "upload-1",
      name: "Custom Upload",
      kind: "upload" as const,
    };

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
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
      <Dashboard initialHistory={baseHistory} initialRun={null} />,
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
      expect(screen.getByText(/Added Custom Upload as a reusable local source/i)).toBeInTheDocument(),
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
});
