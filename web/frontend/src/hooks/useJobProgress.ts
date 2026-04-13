/** SSE EventSource hook for job progress with polling fallback. */

import { useEffect, useRef, useState, useCallback } from "react";
import { API_BASE_URL } from "@/lib/constants";
import type { JobProgressEvent } from "@/services/types";

interface UseJobProgressReturn {
  progress: number;
  status: string;
  message: string;
  isComplete: boolean;
  isFailed: boolean;
}

export function useJobProgress(jobId: string | null): UseJobProgressReturn {
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState("pending");
  const [message, setMessage] = useState("");
  const sourceRef = useRef<EventSource | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const sseActiveRef = useRef(false);

  const updateState = useCallback((data: JobProgressEvent) => {
    setProgress(data.progress);
    setStatus(data.status);
    setMessage(data.message);
  }, []);

  const isTerminal = useCallback((s: string) => {
    return s === "completed" || s === "failed" || s === "cancelled";
  }, []);

  useEffect(() => {
    if (!jobId) return;

    // --- SSE ---
    const source = new EventSource(`${API_BASE_URL}/api/jobs/${jobId}/stream`);
    sourceRef.current = source;

    source.onmessage = (event) => {
      try {
        sseActiveRef.current = true;
        const data: JobProgressEvent = JSON.parse(event.data);
        updateState(data);
        if (isTerminal(data.status)) {
          source.close();
        }
      } catch {
        // ignore parse errors
      }
    };

    source.onerror = () => {
      source.close();
    };

    // --- Polling fallback (covers multi-worker SSE miss) ---
    pollRef.current = setInterval(async () => {
      try {
        const res = await fetch(`${API_BASE_URL}/api/jobs/${jobId}`);
        if (!res.ok) return;
        const job = await res.json();
        // Only update from poll if SSE hasn't been active recently
        updateState({
          progress: job.progress ?? 0,
          status: job.status,
          message: job.message ?? "",
        });
        if (isTerminal(job.status)) {
          if (pollRef.current) clearInterval(pollRef.current);
          source.close();
        }
      } catch {
        // ignore fetch errors
      }
    }, 3000);

    return () => {
      source.close();
      sourceRef.current = null;
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [jobId, updateState, isTerminal]);

  return {
    progress,
    status,
    message,
    isComplete: status === "completed",
    isFailed: status === "failed",
  };
}
