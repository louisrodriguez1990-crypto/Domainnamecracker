"use client";

import { startTransition, useEffect, useEffectEvent, useRef, useState } from "react";

import {
  DICTIONARY_SOURCE_ID,
  allowsSourceFreeRun,
  requiresComOnlyStyles,
  type GeneratedCandidateStyle,
  type HistoryPayload,
  type RunSnapshot,
  type SupportedTld,
  type WordSource,
} from "@/lib/domain/types";

const TLD_OPTIONS: SupportedTld[] = ["com", "io", "ai"];
const STYLE_OPTIONS = [
  { id: "keyword" as const, label: "Keyword compounds", description: "Real-word combinations." },
  { id: "brandable" as const, label: "Brandable mashups", description: "Short clipped blends." },
  { id: "single-word-com" as const, label: "Single-word .com", description: "Standalone words checked only on .com." },
  { id: "random-3-com" as const, label: "Pronounceable 3-letter .com", description: "Random 3-letter names built from speakable letter patterns." },
  { id: "random-4-com" as const, label: "Pronounceable 4-letter .com", description: "Random 4-letter names built from speakable letter patterns." },
  { id: "random-5-com" as const, label: "Pronounceable 5-letter .com", description: "Random 5-letter names built from speakable letter patterns." },
];

function cn(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

function formatDateTime(value: string | null) {
  if (!value) return "Not finished";
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function statusTone(status: string) {
  if (status === "completed") return "border-emerald-200 bg-emerald-50 text-emerald-900";
  if (status === "running") return "border-amber-200 bg-amber-50 text-amber-900";
  if (status === "stopped") return "border-stone-300 bg-stone-100 text-stone-800";
  if (status === "interrupted") return "border-rose-200 bg-rose-50 text-rose-900";
  return "border-sky-200 bg-sky-50 text-sky-900";
}

function Metric(props: { label: string; value: number; accent?: string; note: string }) {
  return (
    <article className="glass-panel rounded-[28px] p-5">
      <p className="font-mono text-xs uppercase tracking-[0.26em] text-stone-500">{props.label}</p>
      <p className={cn("mt-3 text-3xl font-semibold", props.accent)}>{props.value.toLocaleString("en-US")}</p>
      <p className="mt-2 text-sm leading-6 text-stone-600">{props.note}</p>
    </article>
  );
}

function toggleValue<T>(list: T[], value: T) {
  return list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
}

function exportCsv(rows: string[][]) {
  const csv = rows.map((row) => row.map((field) => `"${field.replaceAll('"', '""')}"`).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.download = "domain-hits.csv";
  anchor.click();
  URL.revokeObjectURL(href);
}

export function Dashboard(props: { initialHistory: HistoryPayload; initialRun: RunSnapshot | null; setupMessage?: string | null }) {
  const [history, setHistory] = useState(props.initialHistory);
  const [currentRun, setCurrentRun] = useState(props.initialRun);
  const [selectedTlds, setSelectedTlds] = useState<SupportedTld[]>(
    props.initialRun?.run.selectedTlds.length ? props.initialRun.run.selectedTlds : TLD_OPTIONS,
  );
  const [selectedStyles, setSelectedStyles] = useState<GeneratedCandidateStyle[]>(
    props.initialRun?.run.enabledStyles.length ? props.initialRun.run.enabledStyles : ["keyword", "brandable"],
  );
  const [selectedSources, setSelectedSources] = useState<string[]>(
    props.initialRun?.run.wordSourceIds.length
      ? props.initialRun.run.wordSourceIds
      : props.initialHistory.wordSources
          .filter(
            (source) =>
              source.kind === "builtin" && source.id !== DICTIONARY_SOURCE_ID,
          )
          .map((source) => source.id),
  );
  const [targetHits, setTargetHits] = useState(props.initialRun?.run.targetHits ?? 25);
  const [scoreThreshold, setScoreThreshold] = useState(props.initialRun?.run.scoreThreshold ?? 58);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadName, setUploadName] = useState("");
  const [uploadDescription, setUploadDescription] = useState("");
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const activeRun = currentRun?.run.status === "running" ? currentRun : null;
  const builtinSources = history.wordSources.filter((source) => source.kind === "builtin");
  const uploadedSources = history.wordSources.filter((source) => source.kind === "upload");
  const hitFeed = currentRun?.topHits.length ? currentRun.topHits : history.recentHits.slice(0, 12);

  async function refreshHistory() {
    const response = await fetch("/api/history", { cache: "no-store" });
    if (!response.ok) return;
    const payload = (await response.json()) as HistoryPayload;
    startTransition(() => setHistory(payload));
  }

  const pollRun = useEffectEvent(async (runId: string) => {
    const response = await fetch(`/api/runs/${runId}`, { cache: "no-store" });
    if (!response.ok) return;
    const payload = (await response.json()) as RunSnapshot;
    startTransition(() => setCurrentRun(payload));
    if (payload.run.status !== "running") await refreshHistory();
  });

  useEffect(() => {
    if (!activeRun) return;
    void pollRun(activeRun.run.id);
    const interval = window.setInterval(() => void pollRun(activeRun.run.id), 1500);
    return () => window.clearInterval(interval);
  }, [activeRun]);

  async function postJson(url: string, body: unknown) {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error ?? "Request failed.");
    return payload;
  }

  async function startRun() {
    setStatusMessage(null);
    setErrorMessage(null);
    if (!selectedTlds.length) return setErrorMessage("Pick at least one TLD.");
    if (!selectedStyles.length) return setErrorMessage("Enable at least one name style.");
    if (requiresComOnlyStyles({ enabledStyles: selectedStyles }) && !selectedTlds.includes("com")) {
      return setErrorMessage("Enable .com when you run single-word or pronounceable 3, 4, or 5 letter .com scans.");
    }
    if (!selectedSources.length && !allowsSourceFreeRun({ enabledStyles: selectedStyles })) {
      return setErrorMessage("Select at least one word source.");
    }
    setIsSubmitting(true);
    try {
      const payload = (await postJson("/api/runs", {
        selectedTlds,
        enabledStyles: selectedStyles,
        wordSourceIds: selectedSources,
        targetHits,
        concurrency: 2,
        scoreThreshold,
      })) as RunSnapshot;
      startTransition(() => setCurrentRun(payload));
      setStatusMessage("Scan started. The worker is cycling through fresh candidates.");
      await refreshHistory();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Unable to start the scan.");
    } finally {
      setIsSubmitting(false);
    }
  }

  async function stopRun() {
    if (!activeRun) return;
    setStatusMessage(null);
    setErrorMessage(null);
    try {
      const payload = (await postJson(`/api/runs/${activeRun.run.id}/stop`, {})) as RunSnapshot;
      startTransition(() => setCurrentRun(payload));
      setStatusMessage("Stop requested. The worker will halt after its current checks.");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Unable to stop the scan.");
    }
  }

  async function uploadSource() {
    const file = fileInputRef.current?.files?.[0];
    if (!file) return setErrorMessage("Choose a TXT or CSV file first.");
    setIsUploading(true);
    setStatusMessage(null);
    setErrorMessage(null);
    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("name", uploadName || file.name.replace(/\.[^.]+$/, ""));
      formData.append("description", uploadDescription || "Uploaded custom word list.");
      const response = await fetch("/api/word-sources", { method: "POST", body: formData });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Upload failed.");
      const source = payload as WordSource;
      startTransition(() => {
        setHistory((current) => ({ ...current, wordSources: [...current.wordSources, source] }));
        setSelectedSources((current) => [...new Set([...current, source.id])]);
      });
      setUploadName("");
      setUploadDescription("");
      if (fileInputRef.current) fileInputRef.current.value = "";
      setStatusMessage(`Added ${source.name} as a reusable source.`);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Upload failed.");
    } finally {
      setIsUploading(false);
    }
  }

  async function recheckDomain(domain: string) {
    setIsSubmitting(true);
    setStatusMessage(null);
    setErrorMessage(null);
    try {
      const payload = (await postJson("/api/runs", {
        selectedTlds,
        enabledStyles: selectedStyles.length ? selectedStyles : ["keyword"],
        wordSourceIds: selectedSources.length ? selectedSources : builtinSources.map((source) => source.id),
        targetHits: 1,
        concurrency: 1,
        scoreThreshold: 0,
        manualDomains: [domain],
        recheckExisting: true,
      })) as RunSnapshot;
      startTransition(() => setCurrentRun(payload));
      setStatusMessage(`Manual recheck started for ${domain}.`);
      await refreshHistory();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Recheck failed.");
    } finally {
      setIsSubmitting(false);
    }
  }

  const setupLocked = Boolean(props.setupMessage);

  return (
    <main className="noise-grid min-h-screen px-4 py-6 sm:px-6 lg:px-10">
      <div className="mx-auto flex max-w-7xl flex-col gap-6">
        {props.setupMessage ? <div className="rounded-[24px] border border-sky-200 bg-sky-50 px-5 py-4 text-sm text-sky-950">{props.setupMessage}</div> : null}
        <section className="glass-panel rounded-[36px] p-6 sm:p-8 lg:p-10">
          <div className="grid gap-8 lg:grid-cols-[1.15fr_0.85fr]">
            <div className="space-y-5">
              <p className="font-mono text-xs uppercase tracking-[0.34em] text-stone-500">Domain Hunter</p>
              <h1 className="max-w-3xl text-4xl font-semibold tracking-[-0.04em] text-stone-950 sm:text-5xl lg:text-6xl">
                Generate valuable domain combinations and sift live availability without an LLM in the loop.
              </h1>
              <p className="max-w-2xl text-base leading-7 text-stone-700 sm:text-lg">
                Keyword compounds, brandable mashups, pronounceable 3, 4, and 5 letter `.com` names, and single-word `.com` ideas are built in-app, scored locally, then checked against RDAP with conservative retries and persistent history.
              </p>
              <div className="flex flex-wrap gap-3 text-sm text-stone-800">
                <span className="rounded-full border border-amber-200 bg-amber-100 px-4 py-2">Pure code generation</span>
                <span className="rounded-full border border-teal-200 bg-teal-50 px-4 py-2">Persistent history and dedupe</span>
                <span className="rounded-full border border-stone-300 bg-white/75 px-4 py-2">Best-effort RDAP checks</span>
              </div>
            </div>
            <div className="rounded-[32px] border border-white/50 bg-[color:var(--panel-strong)] p-6">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <p className="font-mono text-xs uppercase tracking-[0.28em] text-stone-500">Current Status</p>
                  <h2 className="mt-2 text-2xl font-semibold text-stone-900">{currentRun ? "Search telemetry" : "Ready for a new scan"}</h2>
                </div>
                {currentRun ? <span className={cn("rounded-full border px-4 py-2 text-sm font-medium capitalize", statusTone(currentRun.run.status))}>{currentRun.run.status}</span> : null}
              </div>
              <div className="mt-6 grid gap-4 sm:grid-cols-2">
                <Metric label="Candidate Pool" value={currentRun?.run.generatedCount ?? 0} note="Scored labels ready for this run." />
                <Metric label="Checked" value={currentRun?.run.checkedCount ?? 0} note="Network checks completed." accent="text-[color:var(--teal)]" />
                <Metric label="Skipped" value={currentRun?.run.skippedCount ?? 0} note="Previously seen domains skipped." />
                <Metric label="Available" value={currentRun?.run.availableCount ?? 0} note="Fresh hits found this run." accent="text-[color:var(--accent)]" />
              </div>
              <div className="mt-6 rounded-[28px] border border-stone-200 bg-white/75 p-5">
                <p className="font-mono text-xs uppercase tracking-[0.28em] text-stone-500">Worker pulse</p>
                <p className="mt-3 text-sm leading-6 text-stone-700">{currentRun?.run.currentCandidate ? `Currently checking ${currentRun.run.currentCandidate}` : "No active candidate right now."}</p>
                <p className="mt-2 text-sm leading-6 text-stone-600">{currentRun?.run.lastError ?? "Rate limits and uncertain RDAP responses will show up here if they happen."}</p>
                <p className="mt-3 font-mono text-xs uppercase tracking-[0.24em] text-stone-500">Started {formatDateTime(currentRun?.run.startedAt ?? null)}</p>
              </div>
            </div>
          </div>
        </section>

        {statusMessage ? <div className="rounded-[24px] border border-emerald-200 bg-emerald-50 px-5 py-4 text-sm text-emerald-950">{statusMessage}</div> : null}
        {errorMessage ? <div className="rounded-[24px] border border-rose-200 bg-rose-50 px-5 py-4 text-sm text-rose-950">{errorMessage}</div> : null}

        <div className="grid gap-6 xl:grid-cols-[1fr_1fr]">
          <section className="glass-panel rounded-[32px] p-6 sm:p-8">
            <div className="flex flex-wrap items-end justify-between gap-4 border-b border-[color:var(--line)] pb-5">
              <div>
                <p className="font-mono text-xs uppercase tracking-[0.3em] text-stone-500">Scan Controls</p>
                <h2 className="mt-2 text-2xl font-semibold text-stone-900">Configure the search space</h2>
              </div>
              <div className="flex flex-wrap gap-3">
                <button type="button" onClick={startRun} disabled={setupLocked || Boolean(activeRun) || isSubmitting} className="rounded-full bg-[color:var(--accent)] px-5 py-3 text-sm font-medium text-white transition hover:bg-[color:var(--accent-deep)] disabled:cursor-not-allowed disabled:opacity-50">{isSubmitting ? "Starting..." : "Start Search"}</button>
                <button type="button" onClick={stopRun} disabled={setupLocked || !activeRun} className="rounded-full border border-stone-300 bg-white/75 px-5 py-3 text-sm font-medium text-stone-800 transition hover:border-stone-500 disabled:cursor-not-allowed disabled:opacity-50">Stop Search</button>
              </div>
            </div>
            <div className="mt-6 space-y-8">
              <div>
                <p className="text-sm font-semibold text-stone-900">TLD focus</p>
                <div className="mt-3 flex flex-wrap gap-3">
                  {TLD_OPTIONS.map((tld) => <button key={tld} type="button" disabled={setupLocked || Boolean(activeRun)} onClick={() => setSelectedTlds((current) => toggleValue(current, tld))} className={cn("rounded-full border px-4 py-2 text-sm transition", selectedTlds.includes(tld) ? "border-stone-900 bg-stone-900 text-white" : "border-stone-300 bg-white/70 text-stone-700", (activeRun || setupLocked) && "cursor-not-allowed opacity-60")}>.{tld}</button>)}
                </div>
              </div>
              <div>
                <p className="text-sm font-semibold text-stone-900">Name styles</p>
                <div className="mt-3 grid gap-3">
                  {STYLE_OPTIONS.map((style) => <button key={style.id} type="button" disabled={setupLocked || Boolean(activeRun)} onClick={() => setSelectedStyles((current) => toggleValue(current, style.id))} className={cn("rounded-[24px] border p-4 text-left transition", selectedStyles.includes(style.id) ? "border-stone-900 bg-stone-900 text-white" : "border-stone-200 bg-white/70 text-stone-800", (activeRun || setupLocked) && "cursor-not-allowed opacity-60")}><p className="font-medium">{style.label}</p><p className={cn("mt-2 text-sm leading-6", selectedStyles.includes(style.id) ? "text-white/80" : "text-stone-600")}>{style.description}</p></button>)}
                </div>
              </div>
              <div>
                <p className="text-sm font-semibold text-stone-900">Word sources</p>
                <div className="mt-3 grid gap-3">
                  {[...builtinSources, ...uploadedSources].map((source) => <button key={source.id} type="button" disabled={setupLocked || Boolean(activeRun)} onClick={() => setSelectedSources((current) => toggleValue(current, source.id))} className={cn("rounded-[24px] border p-4 text-left transition", selectedSources.includes(source.id) ? "border-[color:var(--teal)] bg-teal-50 text-stone-900" : "border-stone-200 bg-white/70 text-stone-800", (activeRun || setupLocked) && "cursor-not-allowed opacity-60")}><div className="flex items-center justify-between gap-3"><p className="font-medium">{source.name}</p><span className="rounded-full border border-stone-200 bg-white px-3 py-1 font-mono text-xs uppercase tracking-[0.2em] text-stone-500">{source.kind}</span></div><p className="mt-2 text-sm leading-6 text-stone-600">{source.description}</p><p className="mt-3 font-mono text-xs uppercase tracking-[0.2em] text-stone-500">{source.wordCount.toLocaleString("en-US")} words</p></button>)}
                </div>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="space-y-2"><span className="text-sm font-semibold text-stone-900">Target hits</span><input type="number" min={1} max={100} value={targetHits} disabled={setupLocked || Boolean(activeRun)} onChange={(event) => setTargetHits(Number(event.target.value))} className="w-full rounded-2xl border border-stone-300 bg-white/80 px-4 py-3 text-sm outline-none focus:border-stone-500" /></label>
                <label className="space-y-2"><span className="text-sm font-semibold text-stone-900">Minimum score</span><input type="number" min={0} max={100} value={scoreThreshold} disabled={setupLocked || Boolean(activeRun)} onChange={(event) => setScoreThreshold(Number(event.target.value))} className="w-full rounded-2xl border border-stone-300 bg-white/80 px-4 py-3 text-sm outline-none focus:border-stone-500" /></label>
              </div>
            </div>
          </section>
          <section className="glass-panel rounded-[32px] p-6 sm:p-8">
            <div className="border-b border-[color:var(--line)] pb-5">
              <p className="font-mono text-xs uppercase tracking-[0.3em] text-stone-500">Uploads</p>
              <h2 className="mt-2 text-2xl font-semibold text-stone-900">Bring your own word list</h2>
              <p className="mt-2 text-sm leading-6 text-stone-600">TXT and CSV uploads become reusable sources. They are normalized, deduplicated, and folded into future runs.</p>
            </div>
            <div className="mt-6 space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="space-y-2"><span className="text-sm font-semibold text-stone-900">Source name</span><input value={uploadName} onChange={(event) => setUploadName(event.target.value)} placeholder="Crypto slang, robotics, creator tools..." className="w-full rounded-2xl border border-stone-300 bg-white/80 px-4 py-3 text-sm outline-none focus:border-stone-500" /></label>
                <label className="space-y-2"><span className="text-sm font-semibold text-stone-900">Short description</span><input value={uploadDescription} onChange={(event) => setUploadDescription(event.target.value)} placeholder="Optional notes for future-you" className="w-full rounded-2xl border border-stone-300 bg-white/80 px-4 py-3 text-sm outline-none focus:border-stone-500" /></label>
              </div>
              <label className="flex min-h-36 cursor-pointer flex-col items-center justify-center rounded-[28px] border border-dashed border-stone-300 bg-white/75 px-6 py-8 text-center">
                <span className="text-sm font-semibold text-stone-900">Upload a `.txt` or `.csv` word list</span>
                <span className="mt-2 max-w-lg text-sm leading-6 text-stone-600">One word per line works well, but commas and whitespace are fine too. The uploader strips punctuation and keeps up to 500 unique terms.</span>
                <input ref={fileInputRef} type="file" accept=".txt,.csv,text/plain,text/csv" className="mt-5 block text-sm text-stone-700" />
              </label>
              <button type="button" onClick={uploadSource} disabled={setupLocked || isUploading} className="rounded-full border border-stone-300 bg-white/75 px-5 py-3 text-sm font-medium text-stone-800 transition hover:border-stone-500 disabled:cursor-not-allowed disabled:opacity-50">{isUploading ? "Uploading..." : "Add Source"}</button>
            </div>
          </section>
        </div>

        <div className="grid gap-6 xl:grid-cols-[1.05fr_0.95fr]">
          <section className="glass-panel rounded-[32px] p-6 sm:p-8">
            <div className="flex flex-wrap items-end justify-between gap-4 border-b border-[color:var(--line)] pb-5">
              <div>
                <p className="font-mono text-xs uppercase tracking-[0.3em] text-stone-500">Live Hits</p>
                <h2 className="mt-2 text-2xl font-semibold text-stone-900">Top available domains</h2>
                <p className="mt-2 text-sm leading-6 text-stone-600">Fresh finds from the current run appear here first. Use manual recheck when one feels worth confirming.</p>
              </div>
              <button type="button" onClick={() => exportCsv([["domain", "score", "status", "checkedAt", "provider", "note"], ...hitFeed.map((hit) => [hit.domain, hit.score.toString(), hit.status, hit.checkedAt, hit.provider, hit.note])])} className="rounded-full border border-stone-300 bg-white/75 px-5 py-3 text-sm font-medium text-stone-800 transition hover:border-stone-500">Export CSV</button>
            </div>
            <div className="mt-6 space-y-3">
              {hitFeed.length > 0 ? hitFeed.map((hit) => <article key={`${hit.runId}-${hit.id}`} className="rounded-[26px] border border-stone-200 bg-white/78 p-5"><div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between"><div><p className="text-xl font-semibold tracking-tight text-stone-950">{hit.domain}</p><p className="mt-2 text-sm leading-6 text-stone-600">Score {hit.score} | {hit.provider} | checked {formatDateTime(hit.checkedAt)}</p><p className="mt-2 text-sm leading-6 text-stone-600">{hit.note}</p></div><div className="flex items-center gap-3"><span className="rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-sm text-emerald-900">{hit.status}</span><button type="button" disabled={setupLocked || Boolean(activeRun) || isSubmitting} onClick={() => recheckDomain(hit.domain)} className="rounded-full border border-stone-300 px-4 py-2 text-sm text-stone-800 transition hover:border-stone-500 disabled:cursor-not-allowed disabled:opacity-50">Recheck</button></div></div></article>) : <div className="rounded-[28px] border border-dashed border-stone-300 bg-white/70 px-6 py-10 text-center text-sm leading-7 text-stone-600">Start a run to populate this board with available names.</div>}
            </div>
          </section>
          <section className="glass-panel rounded-[32px] p-6 sm:p-8">
            <div className="border-b border-[color:var(--line)] pb-5">
              <p className="font-mono text-xs uppercase tracking-[0.3em] text-stone-500">Recent Checks</p>
              <h2 className="mt-2 text-2xl font-semibold text-stone-900">What the worker is seeing</h2>
              <p className="mt-2 text-sm leading-6 text-stone-600">This stream shows the latest domains that were checked, including uncertain RDAP responses.</p>
            </div>
            <div className="mt-6 space-y-3">
              {currentRun?.recentResults.length ? currentRun.recentResults.map((result) => <article key={result.id} className="rounded-[24px] border border-stone-200 bg-white/74 px-4 py-4"><div className="flex items-center justify-between gap-3"><p className="font-medium text-stone-950">{result.domain}</p><span className={cn("rounded-full border px-3 py-1 text-xs uppercase tracking-[0.18em]", result.status === "available" ? "border-emerald-200 bg-emerald-50 text-emerald-900" : result.status === "taken" ? "border-stone-200 bg-stone-100 text-stone-700" : "border-amber-200 bg-amber-50 text-amber-900")}>{result.status}</span></div><p className="mt-2 text-sm leading-6 text-stone-600">Score {result.score} | {result.note}</p></article>) : <div className="rounded-[28px] border border-dashed border-stone-300 bg-white/70 px-6 py-10 text-center text-sm leading-7 text-stone-600">Recent checks will appear here once the worker starts moving.</div>}
            </div>
          </section>
        </div>

        <section className="glass-panel rounded-[32px] p-6 sm:p-8">
          <div className="border-b border-[color:var(--line)] pb-5">
            <p className="font-mono text-xs uppercase tracking-[0.3em] text-stone-500">History</p>
            <h2 className="mt-2 text-2xl font-semibold text-stone-900">Past runs and finish lines</h2>
            <p className="mt-2 text-sm leading-6 text-stone-600">Every run is persisted in the active runtime so tomorrow&apos;s search does not recycle today&apos;s checked domains.</p>
          </div>
          <div className="mt-6 grid gap-4 lg:grid-cols-2">
            {history.recentRuns.length > 0 ? history.recentRuns.map((run) => <article key={run.id} className="rounded-[28px] border border-stone-200 bg-white/75 p-5"><div className="flex items-start justify-between gap-3"><div><p className="font-mono text-xs uppercase tracking-[0.24em] text-stone-500">{run.selectedTlds.map((tld) => `.${tld}`).join(" ")}</p><p className="mt-2 text-xl font-semibold text-stone-950">{run.status === "exhausted" ? "Search space exhausted" : run.status}</p></div><span className={cn("rounded-full border px-3 py-1 text-sm capitalize", statusTone(run.status))}>{run.availableCount}/{run.targetHits}</span></div><div className="mt-4 grid grid-cols-3 gap-3 text-sm text-stone-600"><div><p className="font-mono text-xs uppercase tracking-[0.18em] text-stone-500">Generated</p><p className="mt-1 text-base font-medium text-stone-900">{run.generatedCount.toLocaleString("en-US")}</p></div><div><p className="font-mono text-xs uppercase tracking-[0.18em] text-stone-500">Checked</p><p className="mt-1 text-base font-medium text-stone-900">{run.checkedCount.toLocaleString("en-US")}</p></div><div><p className="font-mono text-xs uppercase tracking-[0.18em] text-stone-500">Skipped</p><p className="mt-1 text-base font-medium text-stone-900">{run.skippedCount.toLocaleString("en-US")}</p></div></div><p className="mt-4 text-sm leading-6 text-stone-600">Started {formatDateTime(run.startedAt)} | Finished {formatDateTime(run.finishedAt)}</p>{run.lastError ? <p className="mt-2 text-sm leading-6 text-stone-600">Last note: {run.lastError}</p> : null}</article>) : <div className="rounded-[28px] border border-dashed border-stone-300 bg-white/70 px-6 py-10 text-center text-sm leading-7 text-stone-600">Your run history will show up here after the first search completes or stops.</div>}
          </div>
        </section>
      </div>
    </main>
  );
}
