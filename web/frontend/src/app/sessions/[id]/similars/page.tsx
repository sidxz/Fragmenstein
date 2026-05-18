"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { useParams, useRouter } from "next/navigation";
import { Button } from "primereact/button";
import { InputNumber } from "primereact/inputnumber";
import { InputTextarea } from "primereact/inputtextarea";
import { Dropdown } from "primereact/dropdown";
import { FileUpload, FileUploadHandlerEvent } from "primereact/fileupload";
import { Checkbox } from "primereact/checkbox";
import { MultiSelect } from "primereact/multiselect";
import { Slider } from "primereact/slider";
import { TabView, TabPanel } from "primereact/tabview";
import { Message } from "primereact/message";
import { JobProgress } from "@/components/jobs/JobProgress";
import { SimilarsTable, type SimilarRow } from "@/components/results/SimilarsTable";
import { DownloadPanel } from "@/components/results/DownloadPanel";
import { useSessionStore } from "@/stores/sessionStore";
import { SmilesImage } from "@/components/viewer/SmilesImage";
import * as api from "@/services/api";
import type { CatalogInfo } from "@/services/types";

export default function SimilarsPage() {
  const params = useParams();
  const router = useRouter();
  const sessionId = params.id as string;
  const { combineJobId, similarsJobId, setSimilarsJobId } = useSessionStore();

  const [swConfig, setSwConfig] = useState({ top_n: 100, dist: 25, length: 200, db: "REAL_dataset", outcome_filter: "acceptable" });
  const [pcConfig, setPcConfig] = useState({ top_n: 50, threshold: 80, max_per_query: 20, outcome_filter: "acceptable" });
  const [csConfig, setCsConfig] = useState({ top_n: 50, categories: ["CSSS", "CSMS"] as string[], outcome_filter: "acceptable" });
  const [mpConfig, setMpConfig] = useState({ top_n: 50, threshold: 0.8, outcome_filter: "acceptable" });
  const [catConfig, setCatConfig] = useState<{ name: string | null; top_n: number; outcome_filter: string }>({ name: null, top_n: 200, outcome_filter: "acceptable" });
  const [catalogs, setCatalogs] = useState<CatalogInfo[]>([]);
  const [catalogDir, setCatalogDir] = useState<string>("");
  const [reindexJobId, setReindexJobId] = useState<string | null>(null);
  const [autoIndexAfterUpload, setAutoIndexAfterUpload] = useState<boolean>(true);
  const [uploading, setUploading] = useState<boolean>(false);
  const catalogUploadRef = useRef<FileUpload>(null);
  const [smilesText, setSmilesText] = useState("");
  const [filterTopN, setFilterTopN] = useState(200);
  const [filterOutcome, setFilterOutcome] = useState("acceptable");
  const [useFilter, setUseFilter] = useState(true);
  const [useMwFilter, setUseMwFilter] = useState(true);
  const [minMw, setMinMw] = useState<number | null>(200);
  const [maxMw, setMaxMw] = useState<number | null>(600);
  const mwParams = () => useMwFilter ? { min_mw: minMw, max_mw: maxMw } : { min_mw: null, max_mw: null };
  const fileUploadRef = useRef<FileUpload>(null);
  const [backends, setBackends] = useState<{ chemspace: boolean; molport: boolean }>({ chemspace: false, molport: false });

  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<SimilarRow[]>([]);
  const [selectedRow, setSelectedRow] = useState<SimilarRow | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [inputTab, setInputTab] = useState(0);

  const handleComplete = useCallback(async () => {
    const jobId = useSessionStore.getState().similarsJobId;
    if (!jobId) return;
    try {
      const res = await api.getJobResults(jobId);
      setResults(res.results as unknown as SimilarRow[]);
    } catch { setStatusMsg("Failed to load results"); }
    setRunning(false);
  }, []);

  useEffect(() => {
    api.getAvailableBackends().then(setBackends).catch(() => {});
  }, []);

  const refreshCatalogs = useCallback(async () => {
    try {
      const res = await api.listCatalogs();
      setCatalogs(res.catalogs);
      setCatalogDir(res.catalog_dir);
      setCatConfig((c) => (c.name && res.catalogs.some((k) => k.name === c.name)) ? c : { ...c, name: res.catalogs[0]?.name ?? null });
    } catch {}
  }, []);

  useEffect(() => { refreshCatalogs(); }, [refreshCatalogs]);

  useEffect(() => {
    if (similarsJobId && results.length === 0) {
      api.getJobStatus(similarsJobId).then((job) => {
        if (job.status === "completed") handleComplete();
        else if (job.status === "running") setRunning(true);
      }).catch(() => {});
    }
  }, [similarsJobId, results.length, handleComplete]);

  const handleSmallWorld = async () => {
    setRunning(true); setResults([]); setStatusMsg(null);
    try {
      const cjid = useSessionStore.getState().combineJobId;
      const { job_id } = await api.startSimilars(sessionId, { combine_job_id: cjid, ...swConfig, ...mwParams() });
      setSimilarsJobId(job_id);
    } catch (e: unknown) {
      setStatusMsg(e instanceof Error ? e.message : "Search failed");
      setRunning(false);
    }
  };

  const handleManualPaste = async () => {
    if (!smilesText.trim()) return;
    setRunning(true); setResults([]); setStatusMsg(null);
    try {
      const res = await api.manualSmiles(sessionId, smilesText);
      setSimilarsJobId(res.job_id);
      setStatusMsg(res.message);
      await handleComplete();
    } catch (e: unknown) {
      setStatusMsg(e instanceof Error ? e.message : "Failed");
      setRunning(false);
    }
  };

  const handleFileUpload = async (e: FileUploadHandlerEvent) => {
    if (e.files.length === 0) return;
    setRunning(true); setResults([]); setStatusMsg(null);
    try {
      let res;
      const mw = mwParams();
      if (useFilter && combineJobId) {
        res = await api.uploadAndFilterSimilars(sessionId, e.files[0], filterTopN, filterOutcome, mw.min_mw, mw.max_mw);
      } else {
        res = await api.uploadSimilars(sessionId, e.files[0]);
      }
      setSimilarsJobId(res.job_id);
      setStatusMsg(res.message);
      fileUploadRef.current?.clear();
      await handleComplete();
    } catch (err: unknown) {
      setStatusMsg(err instanceof Error ? err.message : "Upload failed");
      setRunning(false);
    }
  };

  const handlePubChem = async () => {
    setRunning(true); setResults([]); setStatusMsg(null);
    try {
      const cjid = useSessionStore.getState().combineJobId;
      const { job_id } = await api.startPubChem(sessionId, { combine_job_id: cjid, ...pcConfig, ...mwParams() });
      setSimilarsJobId(job_id);
    } catch (e: unknown) {
      setStatusMsg(e instanceof Error ? e.message : "Search failed");
      setRunning(false);
    }
  };

  const handleChemSpace = async () => {
    setRunning(true); setResults([]); setStatusMsg(null);
    try {
      const cjid = useSessionStore.getState().combineJobId;
      const { job_id } = await api.startChemSpace(sessionId, { combine_job_id: cjid, top_n: csConfig.top_n, categories: csConfig.categories.join(","), outcome_filter: csConfig.outcome_filter, ...mwParams() });
      setSimilarsJobId(job_id);
    } catch (e: unknown) {
      setStatusMsg(e instanceof Error ? e.message : "Search failed");
      setRunning(false);
    }
  };

  const handleMolPort = async () => {
    setRunning(true); setResults([]); setStatusMsg(null);
    try {
      const cjid = useSessionStore.getState().combineJobId;
      const { job_id } = await api.startMolPort(sessionId, { combine_job_id: cjid, ...mpConfig, ...mwParams() });
      setSimilarsJobId(job_id);
    } catch (e: unknown) {
      setStatusMsg(e instanceof Error ? e.message : "Search failed");
      setRunning(false);
    }
  };

  const handleCatalog = async () => {
    if (!catConfig.name) return;
    setRunning(true); setResults([]); setStatusMsg(null);
    try {
      const cjid = useSessionStore.getState().combineJobId;
      const { job_id } = await api.startCatalogSearch(sessionId, { combine_job_id: cjid, name: catConfig.name, top_n: catConfig.top_n, outcome_filter: catConfig.outcome_filter, ...mwParams() });
      setSimilarsJobId(job_id);
    } catch (e: unknown) {
      setStatusMsg(e instanceof Error ? e.message : "Search failed");
      setRunning(false);
    }
  };

  const handleReindex = async () => {
    if (!catConfig.name) return;
    setStatusMsg(null);
    try {
      const { job_id } = await api.reindexCatalog(sessionId, catConfig.name);
      setReindexJobId(job_id);
    } catch (e: unknown) {
      setStatusMsg(e instanceof Error ? e.message : "Re-index failed");
    }
  };

  const onReindexComplete = useCallback(async () => {
    setReindexJobId(null);
    await refreshCatalogs();
  }, [refreshCatalogs]);

  const handleCatalogUpload = async (e: FileUploadHandlerEvent) => {
    if (e.files.length === 0) return;
    const file = e.files[0];
    const exists = catalogs.some((c) => c.name === file.name);
    if (exists && !window.confirm(`Catalog "${file.name}" already exists. Overwrite (and discard its index)?`)) {
      catalogUploadRef.current?.clear();
      return;
    }
    setUploading(true);
    setStatusMsg(null);
    try {
      const res = await api.uploadCatalog(file, exists);
      catalogUploadRef.current?.clear();
      await refreshCatalogs();
      setCatConfig((c) => ({ ...c, name: res.name }));
      setStatusMsg(`Uploaded ${res.name} (${(res.size_bytes / 1024 / 1024).toFixed(1)} MB)`);
      if (autoIndexAfterUpload) {
        try {
          const { job_id } = await api.reindexCatalog(sessionId, res.name);
          setReindexJobId(job_id);
        } catch (err: unknown) {
          setStatusMsg(err instanceof Error ? err.message : "Auto-index failed");
        }
      }
    } catch (err: unknown) {
      setStatusMsg(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  };

  const handleDeleteCatalog = async () => {
    if (!catConfig.name) return;
    if (!window.confirm(`Delete catalog "${catConfig.name}" and its index files?`)) return;
    try {
      await api.deleteCatalog(catConfig.name);
      setStatusMsg(`Deleted ${catConfig.name}`);
      setCatConfig((c) => ({ ...c, name: null }));
      await refreshCatalogs();
    } catch (err: unknown) {
      setStatusMsg(err instanceof Error ? err.message : "Delete failed");
    }
  };

  const resetResults = () => { setResults([]); setSelectedRow(null); setStatusMsg(null); setRunning(false); setSimilarsJobId(null); };

  return (
    <div className="max-w-7xl">
      <div className="flex items-center gap-3 mb-6">
        <div className="w-8 h-8 rounded-lg flex items-center justify-center bg-indigo-50 border border-indigo-200 text-indigo-500">
          <i className="pi pi-search text-sm" />
        </div>
        <div>
          <h2 className="text-lg font-bold text-slate-800">Find Analogs</h2>
          <p className="text-xs text-slate-400">Search databases, paste SMILES, or upload a compound list for placement</p>
        </div>
      </div>

      {/* Input modes */}
      {!running && results.length === 0 && (
        <div className="panel p-5 mb-6">
          {/* Shared MW filter — applies to all DB searches and library filter */}
          <div className="mb-5 p-3 rounded-lg bg-slate-50 border border-slate-200">
            <label className="flex items-center gap-2 cursor-pointer mb-2">
              <Checkbox checked={useMwFilter} onChange={(e) => setUseMwFilter(e.checked ?? false)} />
              <span className="text-xs font-semibold text-slate-600">Filter analogs by molecular weight</span>
            </label>
            <p className="text-[10px] text-slate-400 mb-2">
              Drops small fragments and overly large compounds returned by the similarity search. MW is computed from SMILES via RDKit when the source does not provide it. Leave a bound empty for no limit on that side.
            </p>
            {useMwFilter && (
              <div className="grid grid-cols-2 gap-3">
                <div className="flex flex-col gap-1">
                  <label className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Min MW (Da)</label>
                  <InputNumber value={minMw} onValueChange={(e) => setMinMw(e.value ?? null)} min={0} max={2000} maxFractionDigits={1} showButtons={false} placeholder="No min" />
                </div>
                <div className="flex flex-col gap-1">
                  <label className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Max MW (Da)</label>
                  <InputNumber value={maxMw} onValueChange={(e) => setMaxMw(e.value ?? null)} min={0} max={2000} maxFractionDigits={1} showButtons={false} placeholder="No max" />
                </div>
              </div>
            )}
          </div>

          <TabView activeIndex={inputTab} onTabChange={(e) => setInputTab(e.index)}>
            {/* SmallWorld */}
            <TabPanel header="SmallWorld">
              {!combineJobId ? (
                <div className="text-center py-6">
                  <p className="text-sm text-slate-400 mb-3">Complete the Combine step first to search SmallWorld.</p>
                  <Button label="Go to Combine" icon="pi pi-arrow-left" size="small" onClick={() => router.push(`/sessions/${sessionId}/combine`)} />
                </div>
              ) : (
                <div className="mt-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div className="flex flex-col gap-1.5">
                      <label className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Top N Mergers</label>
                      <InputNumber value={swConfig.top_n} onValueChange={(e) => setSwConfig(c => ({ ...c, top_n: e.value ?? 100 }))} min={1} max={1000} />
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <label className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Max Edit Distance</label>
                      <InputNumber value={swConfig.dist} onValueChange={(e) => setSwConfig(c => ({ ...c, dist: e.value ?? 25 }))} min={1} max={100} />
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <label className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Max Results per Query</label>
                      <InputNumber value={swConfig.length} onValueChange={(e) => setSwConfig(c => ({ ...c, length: e.value ?? 200 }))} min={1} max={1000} />
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <label className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Outcome Filter</label>
                      <Dropdown value={swConfig.outcome_filter} options={["acceptable", "deviant", "equally sized", ""].map(v => ({ label: v || "All", value: v }))} onChange={(e) => setSwConfig(c => ({ ...c, outcome_filter: e.value }))} />
                    </div>
                  </div>
                  <div className="mt-4">
                    <Button label="Search SmallWorld" icon="pi pi-search" size="small" onClick={handleSmallWorld} />
                  </div>
                </div>
              )}
            </TabPanel>

            {/* Paste SMILES */}
            <TabPanel header="Paste SMILES">
              <div className="mt-4">
                <InputTextarea
                  value={smilesText}
                  onChange={(e) => setSmilesText(e.target.value)}
                  rows={8}
                  className="w-full font-mono text-xs"
                  placeholder={"c1ccccc1 benzene\nCC(=O)O acetic_acid\nCCO ethanol\n\nFormat: SMILES <space/tab> name (one per line).\nName is optional."}
                />
                <div className="mt-3">
                  <Button label="Load SMILES" icon="pi pi-check" size="small" onClick={handleManualPaste} disabled={!smilesText.trim()} />
                </div>
              </div>
            </TabPanel>

            {/* Upload File */}
            <TabPanel header="Upload File">
              <div className="mt-4">
                <p className="text-xs text-slate-400 mb-3">
                  Upload a CSV, TSV, or Excel (.xlsx) file with a <span className="font-mono font-semibold">smiles</span> column.
                  Optional: <span className="font-mono">name</span>, <span className="font-mono">id</span>, <span className="font-mono">vendor_id</span>.
                  Extra columns are preserved.
                </p>

                {/* Similarity filter options */}
                {combineJobId && (
                  <div className="mb-4 p-3 rounded-lg bg-slate-50 border border-slate-200">
                    <label className="flex items-center gap-2 cursor-pointer mb-2">
                      <Checkbox checked={useFilter} onChange={(e) => setUseFilter(e.checked ?? true)} />
                      <span className="text-xs font-semibold text-slate-600">Filter by similarity to mergers</span>
                    </label>
                    <p className="text-[10px] text-slate-400 mb-2">
                      For large libraries (1K+ compounds): uses Morgan fingerprint Tanimoto similarity to keep only the top N most similar to your mergers.
                    </p>
                    {useFilter && (
                      <div className="grid grid-cols-2 gap-3">
                        <div className="flex flex-col gap-1">
                          <label className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Top N to Keep</label>
                          <InputNumber value={filterTopN} onValueChange={(e) => setFilterTopN(e.value ?? 200)} min={10} max={5000} />
                        </div>
                        <div className="flex flex-col gap-1">
                          <label className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Merger Outcome Filter</label>
                          <Dropdown value={filterOutcome} options={["acceptable", "deviant", "equally sized", ""].map(v => ({ label: v || "All", value: v }))} onChange={(e) => setFilterOutcome(e.value)} />
                        </div>
                      </div>
                    )}
                  </div>
                )}

                <FileUpload
                  ref={fileUploadRef}
                  mode="advanced"
                  accept=".csv,.tsv,.xlsx"
                  maxFileSize={200 * 1024 * 1024}
                  customUpload
                  uploadHandler={handleFileUpload}
                  chooseLabel="Select File"
                  uploadLabel={useFilter && combineJobId ? "Upload & Filter" : "Upload"}
                  auto={false}
                  chooseOptions={{ className: "p-button-sm" }}
                  uploadOptions={{ className: "p-button-sm" }}
                  cancelOptions={{ className: "p-button-sm" }}
                  emptyTemplate={<p className="text-sm p-4 text-slate-400">Drag and drop a CSV, TSV, or Excel file here (up to 200 MB).</p>}
                />
              </div>
            </TabPanel>

            {/* Catalog (server-side, pre-indexed) */}
            <TabPanel header="Catalog">
              {!combineJobId ? (
                <div className="text-center py-6">
                  <p className="text-sm text-slate-400 mb-3">Complete the Combine step first to rank a catalog against your mergers.</p>
                  <Button label="Go to Combine" icon="pi pi-arrow-left" size="small" onClick={() => router.push(`/sessions/${sessionId}/combine`)} />
                </div>
              ) : (
                <div className="mt-4">
                  <p className="text-xs text-slate-400 mb-3">
                    Tanimoto-rank a pre-indexed compound library (e.g. ChemBridge EXPRESS-Pick, DIVERSet, Hit2Lead) against your mergers.
                    Upload SDF/SDF.gz/CSV/TSV/XLSX catalogs once, index them, then re-use across sessions.
                    Server location: <span className="font-mono text-slate-500">{catalogDir || "(loading)"}</span>.
                  </p>

                  {/* Upload widget */}
                  <div className="mb-4 p-3 rounded-lg bg-slate-50 border border-slate-200">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-xs font-semibold text-slate-600">Upload a new catalog</span>
                      <label className="flex items-center gap-2 cursor-pointer">
                        <Checkbox checked={autoIndexAfterUpload} onChange={(e) => setAutoIndexAfterUpload(e.checked ?? false)} />
                        <span className="text-xs text-slate-600">Index after upload</span>
                      </label>
                    </div>
                    <FileUpload
                      ref={catalogUploadRef}
                      mode="advanced"
                      accept=".sdf,.gz,.csv,.tsv,.xlsx"
                      maxFileSize={5 * 1024 * 1024 * 1024}
                      customUpload
                      uploadHandler={handleCatalogUpload}
                      auto={false}
                      disabled={uploading || !!reindexJobId}
                      chooseLabel="Select catalog"
                      uploadLabel={uploading ? "Uploading…" : "Upload"}
                      chooseOptions={{ className: "p-button-sm" }}
                      uploadOptions={{ className: "p-button-sm" }}
                      cancelOptions={{ className: "p-button-sm" }}
                      emptyTemplate={<p className="text-xs p-3 text-slate-400">Drag a SDF, SDF.gz, CSV, TSV, or XLSX file here (up to 5 GB).</p>}
                    />
                  </div>

                  {catalogs.length === 0 ? (
                    <div className="flex items-center gap-2 p-3 rounded-md bg-amber-50 border border-amber-200">
                      <i className="pi pi-info-circle text-amber-600" />
                      <span className="text-xs text-amber-800">No catalogs yet. Upload one above to get started.</span>
                      <Button label="Refresh" icon="pi pi-refresh" size="small" severity="secondary" onClick={refreshCatalogs} className="ml-auto" />
                    </div>
                  ) : (
                    <>
                      <div className="grid grid-cols-2 gap-4">
                        <div className="flex flex-col gap-1.5">
                          <label className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Catalog</label>
                          <Dropdown
                            value={catConfig.name}
                            options={catalogs.map((c) => ({
                              label: `${c.name} ${c.indexed ? `· ${c.compound_count?.toLocaleString() ?? "?"} cmpds` : "· not indexed"}`,
                              value: c.name,
                            }))}
                            onChange={(e) => setCatConfig((c) => ({ ...c, name: e.value }))}
                            placeholder="Select a catalog"
                          />
                        </div>
                        <div className="flex flex-col gap-1.5">
                          <label className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Top N to Keep</label>
                          <InputNumber value={catConfig.top_n} onValueChange={(e) => setCatConfig((c) => ({ ...c, top_n: e.value ?? 200 }))} min={1} max={10000} />
                        </div>
                        <div className="flex flex-col gap-1.5">
                          <label className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Merger Outcome Filter</label>
                          <Dropdown value={catConfig.outcome_filter} options={["acceptable", "deviant", "equally sized", ""].map(v => ({ label: v || "All", value: v }))} onChange={(e) => setCatConfig(c => ({ ...c, outcome_filter: e.value }))} />
                        </div>
                      </div>

                      {/* Selected catalog metadata */}
                      {catConfig.name && (() => {
                        const sel = catalogs.find((c) => c.name === catConfig.name);
                        if (!sel) return null;
                        return (
                          <div className="mt-4 grid grid-cols-4 gap-2">
                            <div className="stat-card"><div className="stat-label">Format</div><div className="stat-value text-sm uppercase">{sel.format}</div></div>
                            <div className="stat-card"><div className="stat-label">Size</div><div className="stat-value text-sm">{(sel.size_bytes / 1024 / 1024).toFixed(1)} MB</div></div>
                            <div className="stat-card"><div className="stat-label">Compounds</div><div className="stat-value text-sm">{sel.indexed ? sel.compound_count?.toLocaleString() : "—"}</div></div>
                            <div className="stat-card">
                              <div className="stat-label">Indexed</div>
                              <div className={`stat-value text-sm ${sel.indexed ? "text-emerald-700" : "text-amber-700"}`}>{sel.indexed ? "Yes" : "No"}</div>
                            </div>
                          </div>
                        );
                      })()}

                      <div className="mt-4 flex items-center gap-2">
                        <Button
                          label="Run Search"
                          icon="pi pi-search"
                          size="small"
                          onClick={handleCatalog}
                          disabled={!catConfig.name || !!reindexJobId || !catalogs.find((c) => c.name === catConfig.name)?.indexed}
                        />
                        <Button
                          label={catalogs.find((c) => c.name === catConfig.name)?.indexed ? "Re-index" : "Index"}
                          icon="pi pi-database"
                          severity="secondary"
                          size="small"
                          onClick={handleReindex}
                          disabled={!catConfig.name || !!reindexJobId}
                        />
                        <Button label="Refresh list" icon="pi pi-refresh" severity="secondary" size="small" outlined onClick={refreshCatalogs} />
                        <Button
                          label="Delete"
                          icon="pi pi-trash"
                          severity="danger"
                          size="small"
                          outlined
                          onClick={handleDeleteCatalog}
                          disabled={!catConfig.name || !!reindexJobId}
                          className="ml-auto"
                        />
                      </div>

                      {reindexJobId && (
                        <div className="mt-4">
                          <p className="text-xs text-slate-500 mb-2">Indexing {catConfig.name}… progress streams below. You can navigate away.</p>
                          <JobProgress jobId={reindexJobId} onComplete={onReindexComplete} onCancel={() => setReindexJobId(null)} onRerun={() => setReindexJobId(null)} />
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}
            </TabPanel>

            {/* PubChem */}
            <TabPanel header="PubChem">
              {!combineJobId ? (
                <div className="text-center py-6">
                  <p className="text-sm text-slate-400 mb-3">Complete the Combine step first to search PubChem.</p>
                  <Button label="Go to Combine" icon="pi pi-arrow-left" size="small" onClick={() => router.push(`/sessions/${sessionId}/combine`)} />
                </div>
              ) : (
                <div className="mt-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div className="flex flex-col gap-1.5">
                      <label className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Top N Mergers to Query</label>
                      <InputNumber value={pcConfig.top_n} onValueChange={(e) => setPcConfig(c => ({ ...c, top_n: e.value ?? 50 }))} min={1} max={500} />
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <label className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Tanimoto Threshold (%)</label>
                      <InputNumber value={pcConfig.threshold} onValueChange={(e) => setPcConfig(c => ({ ...c, threshold: e.value ?? 80 }))} min={50} max={100} />
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <label className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Max Results per Query</label>
                      <InputNumber value={pcConfig.max_per_query} onValueChange={(e) => setPcConfig(c => ({ ...c, max_per_query: e.value ?? 20 }))} min={1} max={100} />
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <label className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Outcome Filter</label>
                      <Dropdown value={pcConfig.outcome_filter} options={["acceptable", "deviant", "equally sized", ""].map(v => ({ label: v || "All", value: v }))} onChange={(e) => setPcConfig(c => ({ ...c, outcome_filter: e.value }))} />
                    </div>
                  </div>
                  <div className="mt-4">
                    <Button label="Search PubChem" icon="pi pi-search" size="small" onClick={handlePubChem} />
                  </div>
                </div>
              )}
            </TabPanel>

            {/* ChemSpace */}
            <TabPanel header="ChemSpace" disabled={!backends.chemspace} headerClassName={!backends.chemspace ? "chemspace-disabled-tab" : ""}>
              {!combineJobId ? (
                <div className="text-center py-6">
                  <p className="text-sm text-slate-400 mb-3">Complete the Combine step first to search ChemSpace.</p>
                  <Button label="Go to Combine" icon="pi pi-arrow-left" size="small" onClick={() => router.push(`/sessions/${sessionId}/combine`)} />
                </div>
              ) : (
                <div className="mt-4">
                  <p className="text-xs text-slate-400 mb-3">
                    Search 1.7B+ compounds from multiple vendors (Enamine, BLD, PharmaBlock, UORSY).
                    Requires <span className="font-mono">CHEMSPACE_API_KEY</span> env var.
                  </p>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="flex flex-col gap-1.5">
                      <label className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Top N Mergers to Query</label>
                      <InputNumber value={csConfig.top_n} onValueChange={(e) => setCsConfig(c => ({ ...c, top_n: e.value ?? 50 }))} min={1} max={500} />
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <label className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Product Categories</label>
                      <MultiSelect
                        value={csConfig.categories}
                        options={[
                          { label: "In-stock Screening", value: "CSSS" },
                          { label: "In-stock Building Blocks", value: "CSSB" },
                          { label: "Make-on-demand Screening", value: "CSMS" },
                          { label: "Make-on-demand Building Blocks", value: "CSMB" },
                        ]}
                        onChange={(e) => setCsConfig(c => ({ ...c, categories: e.value }))}
                        display="chip"
                        placeholder="Select categories"
                        className="w-full"
                      />
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <label className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Outcome Filter</label>
                      <Dropdown value={csConfig.outcome_filter} options={["acceptable", "deviant", "equally sized", ""].map(v => ({ label: v || "All", value: v }))} onChange={(e) => setCsConfig(c => ({ ...c, outcome_filter: e.value }))} />
                    </div>
                  </div>
                  <div className="mt-4">
                    <Button label="Search ChemSpace" icon="pi pi-search" size="small" onClick={handleChemSpace} />
                  </div>
                </div>
              )}
            </TabPanel>

            {/* MolPort */}
            <TabPanel header="MolPort" disabled={!backends.molport} headerClassName={!backends.molport ? "molport-disabled-tab" : ""}>
              {!combineJobId ? (
                <div className="text-center py-6">
                  <p className="text-sm text-slate-400 mb-3">Complete the Combine step first to search MolPort.</p>
                  <Button label="Go to Combine" icon="pi pi-arrow-left" size="small" onClick={() => router.push(`/sessions/${sessionId}/combine`)} />
                </div>
              ) : (
                <div className="mt-4">
                  <p className="text-xs text-slate-400 mb-3">
                    Search 8M+ in-stock compounds from aggregated chemical suppliers.
                    Requires <span className="font-mono">MOLPORT_API_KEY</span> env var.
                  </p>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="flex flex-col gap-1.5">
                      <label className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Top N Mergers to Query</label>
                      <InputNumber value={mpConfig.top_n} onValueChange={(e) => setMpConfig(c => ({ ...c, top_n: e.value ?? 50 }))} min={1} max={500} />
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <label className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Tanimoto Threshold</label>
                      <div className="flex items-center gap-3">
                        <Slider value={mpConfig.threshold * 100} onChange={(e) => setMpConfig(c => ({ ...c, threshold: (e.value as number) / 100 }))} min={50} max={100} className="flex-1" />
                        <span className="font-mono text-xs text-slate-600 w-10 text-right">{Math.round(mpConfig.threshold * 100)}%</span>
                      </div>
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <label className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Outcome Filter</label>
                      <Dropdown value={mpConfig.outcome_filter} options={["acceptable", "deviant", "equally sized", ""].map(v => ({ label: v || "All", value: v }))} onChange={(e) => setMpConfig(c => ({ ...c, outcome_filter: e.value }))} />
                    </div>
                  </div>
                  <div className="mt-4">
                    <Button label="Search MolPort" icon="pi pi-search" size="small" onClick={handleMolPort} />
                  </div>
                </div>
              )}
            </TabPanel>
          </TabView>
        </div>
      )}

      {statusMsg && <Message severity="info" text={statusMsg} className="mb-4 w-full" />}

      {similarsJobId && running && (
        <div className="mb-6">
          <JobProgress jobId={similarsJobId} onComplete={handleComplete} onCancel={() => setRunning(false)} onRerun={resetResults} />
        </div>
      )}

      {results.length > 0 && (
        <>
          <div className="mb-4 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="font-mono text-lg font-bold text-indigo-600">{results.length}</span>
              <span className="text-xs uppercase tracking-wider text-slate-400">analogs loaded</span>
            </div>
            <div className="flex gap-2">
              {similarsJobId && <DownloadPanel jobId={similarsJobId} showSdf={false} />}
              <Button label="New Search" icon="pi pi-refresh" severity="secondary" size="small" onClick={resetResults} />
            </div>
          </div>

          <div className="grid grid-cols-3 gap-5">
            <div className="col-span-2">
              <SimilarsTable results={results} onRowSelect={setSelectedRow} selectedRow={selectedRow} />
            </div>
            <div>
              {selectedRow ? (
                <div className="panel p-4 space-y-4 sticky top-4">
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500">Analog Detail</h3>
                  {selectedRow.smiles && (
                    <div className="flex justify-center bg-white rounded-lg border border-slate-200 p-2">
                      <SmilesImage smiles={selectedRow.smiles} width={300} height={220} style={{ maxWidth: "100%", height: "auto" }} />
                    </div>
                  )}
                  <div className="grid grid-cols-2 gap-2">
                    <div className="stat-card">
                      <div className="stat-label">Name / ID</div>
                      <div className="stat-value text-sm">{selectedRow.name || "-"}</div>
                    </div>
                    {selectedRow.topodist != null && <div className="stat-card"><div className="stat-label">Topo Distance</div><div className="stat-value text-blue-700">{selectedRow.topodist}</div></div>}
                    {selectedRow.ecfp4 != null && <div className="stat-card"><div className="stat-label">ECFP4</div><div className="stat-value">{selectedRow.ecfp4.toFixed(3)}</div></div>}
                    {selectedRow.daylight != null && <div className="stat-card"><div className="stat-label">Tanimoto</div><div className="stat-value">{selectedRow.daylight.toFixed(3)}</div></div>}
                    {selectedRow.similarity_index != null && <div className="stat-card"><div className="stat-label">Similarity</div><div className="stat-value text-emerald-600">{Math.round(selectedRow.similarity_index * 100)}%</div></div>}
                    {(selectedRow as Record<string, unknown>).molecular_weight != null && <div className="stat-card"><div className="stat-label">MW</div><div className="stat-value">{String((selectedRow as Record<string, unknown>).molecular_weight)}</div></div>}
                    {selectedRow.logP != null && <div className="stat-card"><div className="stat-label">logP</div><div className="stat-value">{selectedRow.logP.toFixed(2)}</div></div>}
                    {selectedRow.TPSA != null && <div className="stat-card"><div className="stat-label">TPSA</div><div className="stat-value">{selectedRow.TPSA.toFixed(1)}</div></div>}
                  </div>
                  <div className="stat-card">
                    <div className="stat-label">SMILES</div>
                    <div className="text-[10px] font-mono break-all mt-1 text-slate-500">{selectedRow.smiles || "-"}</div>
                  </div>
                  {selectedRow.query_smiles && (
                    <div className="stat-card">
                      <div className="stat-label">Source Query</div>
                      <div className="flex items-center gap-2 mt-1">
                        <SmilesImage smiles={selectedRow.query_smiles} width={150} height={100} className="rounded border border-slate-100" style={{ width: 75, height: 50, objectFit: "contain", background: "#fff" }} />
                        <span className="text-[9px] font-mono text-slate-400 break-all">{selectedRow.query_smiles}</span>
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <div className="panel p-8 flex flex-col items-center justify-center text-center" style={{ minHeight: "300px" }}>
                  <i className="pi pi-eye text-2xl mb-3 text-slate-300" />
                  <p className="text-xs text-slate-400">Select an analog to view details</p>
                </div>
              )}
            </div>
          </div>

          <div className="mt-6 flex justify-end">
            <Button label="Place Analogs" icon="pi pi-arrow-right" iconPos="right" size="small" onClick={() => router.push(`/sessions/${sessionId}/place`)} />
          </div>
        </>
      )}
    </div>
  );
}
