"""Catalog registry endpoints — list, upload, delete, kick off background re-indexing."""

import asyncio
import logging
from dataclasses import asdict
from pathlib import Path

from fastapi import APIRouter, HTTPException, UploadFile

from ..models.session import get_session
from ..services import catalog_registry, job_manager

log = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["catalogs"])

_UPLOAD_CHUNK = 4 * 1024 * 1024  # 4 MiB — streams big SDFs without buffering in memory
_SUPPORTED_EXTS = (".sdf", ".sdf.gz", ".csv", ".tsv", ".xlsx")


@router.get("/catalogs")
def list_catalogs():
    """List all compound catalogs available on the server."""
    try:
        catalogs = catalog_registry.list_catalogs()
    except Exception as e:
        log.exception("Failed to list catalogs")
        raise HTTPException(status_code=500, detail=str(e))
    return {
        "catalog_dir": str(catalog_registry.get_catalog_dir()),
        "catalogs": [asdict(c) for c in catalogs],
    }


async def _index_task(job_id: str, name: str):
    job_manager.mark_running(job_id)
    try:
        def _progress(p: float, msg: str):
            job_manager.update_progress(job_id, p, msg)

        await asyncio.to_thread(catalog_registry.index_catalog, name, _progress)
        job_manager.mark_completed(job_id)
    except Exception as e:
        log.exception(f"Indexing catalog '{name}' failed")
        job_manager.mark_failed(job_id, f"{type(e).__name__}: {e}")


@router.post("/sessions/{session_id}/catalogs/{name}/reindex")
async def reindex_catalog(session_id: str, name: str):
    """Kick off a background indexing job for the given catalog.

    Job is owned by the current session (for FK reasons) but the cache it
    produces is global and reusable from any session.
    """
    session = get_session(session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found")
    try:
        catalog_registry._resolve_catalog(name)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=f"Catalog '{name}' not found")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    job = job_manager.start_job(session_id, "catalog_index", {"name": name})
    asyncio.create_task(_index_task(job.id, name))
    return {"job_id": job.id}


def _validate_catalog_filename(name: str) -> str:
    """Strip path components and validate extension; return the safe basename."""
    clean = Path(name).name
    if not clean:
        raise HTTPException(status_code=400, detail="Empty filename")
    if "/" in clean or "\\" in clean or ".." in clean:
        raise HTTPException(status_code=400, detail="Invalid filename")
    lower = clean.lower()
    if ".idx." in lower or lower.endswith((".idx.json", ".idx.parquet", ".idx.fps.npy")):
        raise HTTPException(status_code=400, detail="Reserved filename pattern (.idx.*)")
    if not any(lower.endswith(ext) for ext in _SUPPORTED_EXTS):
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported format. Allowed: {', '.join(_SUPPORTED_EXTS)}",
        )
    return clean


@router.post("/catalogs/upload")
async def upload_catalog(file: UploadFile, overwrite: bool = False):
    """Upload a catalog source file to the configured catalog directory.

    Streams to disk in chunks to handle multi-GB SDFs without buffering in memory.
    Indexing is not started here — call `/sessions/{id}/catalogs/{name}/reindex` after.
    """
    if not file.filename:
        raise HTTPException(status_code=400, detail="No file provided")
    name = _validate_catalog_filename(file.filename)
    dest_dir = catalog_registry.get_catalog_dir()
    dest = dest_dir / name
    if dest.exists() and not overwrite:
        raise HTTPException(
            status_code=409,
            detail=f"Catalog '{name}' already exists. Pass overwrite=true to replace.",
        )

    tmp = dest.with_name(dest.name + ".uploading")
    bytes_written = 0
    try:
        with open(tmp, "wb") as f:
            while True:
                chunk = await file.read(_UPLOAD_CHUNK)
                if not chunk:
                    break
                f.write(chunk)
                bytes_written += len(chunk)
        # Invalidate any stale cache from a prior version with the same name
        for sidecar in (
            catalog_registry._header_path(dest),
            catalog_registry._parquet_path(dest),
            catalog_registry._fps_path(dest),
        ):
            if sidecar.exists():
                sidecar.unlink()
        tmp.replace(dest)
    except Exception as e:
        if tmp.exists():
            tmp.unlink()
        log.exception(f"Catalog upload failed for {name}")
        raise HTTPException(status_code=500, detail=f"{type(e).__name__}: {e}")

    log.info(f"Uploaded catalog '{name}' ({bytes_written} bytes)")
    return {"name": name, "size_bytes": bytes_written, "indexed": False}


@router.delete("/catalogs/{name}")
def delete_catalog(name: str):
    """Delete a catalog source file and its cache sidecars."""
    try:
        source = catalog_registry._resolve_catalog(name)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=f"Catalog '{name}' not found")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    removed = []
    for p in (
        source,
        catalog_registry._header_path(source),
        catalog_registry._parquet_path(source),
        catalog_registry._fps_path(source),
    ):
        if p.exists():
            try:
                p.unlink()
                removed.append(p.name)
            except OSError as e:
                log.warning(f"Failed to remove {p}: {e}")
    return {"name": name, "removed": removed}
