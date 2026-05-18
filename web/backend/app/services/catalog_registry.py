"""Server-side catalog registry — pre-indexed compound libraries with cached Morgan fingerprints.

Catalog files are placed in `FRAGMENSTEIN_CATALOG_DIR` (default: web/backend/data/catalogs/).
On first use each file is parsed and its fingerprints are cached alongside the source as:
  - `<source>.idx.json`     — small header (version, mtime, size, compound_count, ...)
  - `<source>.idx.parquet`  — compounds DataFrame (smiles, name, extra props)
  - `<source>.idx.fps.npy`  — uint8 packed fingerprint bits, shape (N, nBits/8)

Cache is invalidated when source mtime or size changes, or when the version bumps.

Supported source formats: .sdf, .sdf.gz, .csv, .tsv, .xlsx
"""

import gzip
import json
import logging
import os
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Callable, Optional

import numpy as np
import pandas as pd

log = logging.getLogger(__name__)

_FP_RADIUS = 2
_FP_NBITS = 2048
_CACHE_VERSION = 1


def get_catalog_dir() -> Path:
    """Resolve the configured catalog directory, creating it if missing."""
    env = os.environ.get("FRAGMENSTEIN_CATALOG_DIR")
    if env:
        d = Path(env).expanduser().resolve()
    else:
        d = (Path(__file__).resolve().parents[3] / "data" / "catalogs").resolve()
    d.mkdir(parents=True, exist_ok=True)
    return d


def _format_for(path: Path) -> str:
    n = path.name.lower()
    if n.endswith(".sdf.gz"):
        return "sdf.gz"
    if n.endswith(".sdf"):
        return "sdf"
    if n.endswith(".csv"):
        return "csv"
    if n.endswith(".tsv"):
        return "tsv"
    if n.endswith(".xlsx"):
        return "xlsx"
    return "unknown"


def _is_supported_source(path: Path) -> bool:
    n = path.name.lower()
    if ".idx." in n:
        return False
    return _format_for(path) != "unknown"


def _header_path(source: Path) -> Path:
    return source.with_name(source.name + ".idx.json")


def _parquet_path(source: Path) -> Path:
    return source.with_name(source.name + ".idx.parquet")


def _fps_path(source: Path) -> Path:
    return source.with_name(source.name + ".idx.fps.npy")


def _read_header(source: Path) -> Optional[dict]:
    p = _header_path(source)
    if not p.exists():
        return None
    try:
        with open(p, "r") as f:
            return json.load(f)
    except Exception:
        return None


def _cache_is_valid(source: Path) -> bool:
    header = _read_header(source)
    if header is None:
        return False
    if not (_parquet_path(source).exists() and _fps_path(source).exists()):
        return False
    stat = source.stat()
    return (
        header.get("version") == _CACHE_VERSION
        and header.get("source_mtime") == stat.st_mtime
        and header.get("source_size") == stat.st_size
    )


@dataclass
class CatalogInfo:
    name: str
    source_path: str
    format: str
    size_bytes: int
    compound_count: Optional[int]
    indexed: bool
    indexed_at: Optional[str]


def list_catalogs() -> list[CatalogInfo]:
    d = get_catalog_dir()
    out: list[CatalogInfo] = []
    for path in sorted(d.iterdir()):
        if not path.is_file() or not _is_supported_source(path):
            continue
        header = _read_header(path)
        valid = _cache_is_valid(path)
        out.append(CatalogInfo(
            name=path.name,
            source_path=str(path),
            format=_format_for(path),
            size_bytes=path.stat().st_size,
            compound_count=(header.get("compound_count") if valid and header else None),
            indexed=valid,
            indexed_at=(header.get("indexed_at") if valid and header else None),
        ))
    return out


def _resolve_catalog(name: str) -> Path:
    """Resolve a catalog by filename, preventing path traversal."""
    if "/" in name or "\\" in name or ".." in name:
        raise ValueError(f"Invalid catalog name: {name}")
    d = get_catalog_dir()
    candidate = (d / name).resolve()
    if not str(candidate).startswith(str(d.resolve())):
        raise ValueError(f"Invalid catalog name: {name}")
    if not candidate.exists() or not candidate.is_file():
        raise FileNotFoundError(f"Catalog not found: {name}")
    return candidate


def _iter_sdf_mols(source: Path):
    """Stream molecules from an SDF or SDF.gz file."""
    from rdkit import Chem
    fmt = _format_for(source)
    if fmt == "sdf.gz":
        handle = gzip.open(source, "rb")
        try:
            supplier = Chem.ForwardSDMolSupplier(handle, sanitize=True, removeHs=False)
            for mol in supplier:
                yield mol
        finally:
            handle.close()
    else:
        supplier = Chem.SDMolSupplier(str(source), sanitize=True, removeHs=False)
        for mol in supplier:
            yield mol


def _detect_columns(df: pd.DataFrame) -> tuple[Optional[str], Optional[str]]:
    smiles_col = None
    for c in ("smiles", "SMILES", "Smiles", "canonical_smiles", "CanonicalSMILES", "smi"):
        if c in df.columns:
            smiles_col = c
            break
    name_col = None
    for c in ("name", "Name", "NAME", "id", "ID", "compound_id", "vendor_id", "Vendor_ID", "title"):
        if c in df.columns:
            name_col = c
            break
    return smiles_col, name_col


def _fp_to_packed(fp) -> np.ndarray:
    """Convert an RDKit ExplicitBitVect to a uint8 packed-bit numpy array of length nBits/8."""
    from rdkit import DataStructs
    arr = np.zeros((_FP_NBITS,), dtype=np.uint8)
    DataStructs.ConvertToNumpyArray(fp, arr)
    return np.packbits(arr)


def index_catalog(
    name: str,
    progress: Optional[Callable[[float, str], None]] = None,
) -> dict:
    """Parse the catalog file and write the indexed cache. Returns the header dict."""
    from rdkit import Chem
    from rdkit.Chem import AllChem

    if progress is None:
        progress = lambda p, m: None

    source = _resolve_catalog(name)
    stat = source.stat()
    fmt = _format_for(source)
    progress(0.02, f"Reading {source.name}")

    smiles_out: list[str] = []
    names_out: list[str] = []
    props_out: list[dict] = []
    fps_list: list[np.ndarray] = []

    def _add(mol, fallback_idx: int, extra_props: dict | None = None):
        try:
            smi = Chem.MolToSmiles(mol)
        except Exception:
            return
        if not smi:
            return
        try:
            fp = AllChem.GetMorganFingerprintAsBitVect(mol, _FP_RADIUS, nBits=_FP_NBITS)
        except Exception:
            return
        nm = mol.GetProp("_Name") if mol.HasProp("_Name") else f"compound_{fallback_idx}"
        props: dict = {}
        if extra_props is not None:
            for k, v in extra_props.items():
                if v is None:
                    continue
                # Coerce to JSON/parquet-friendly types
                if isinstance(v, (int, float, bool, str)):
                    props[k] = v
                else:
                    props[k] = str(v)
        else:
            for k in mol.GetPropNames():
                if k == "_Name":
                    continue
                try:
                    props[k] = mol.GetProp(k)
                except Exception:
                    pass
        smiles_out.append(smi)
        names_out.append(str(nm))
        props_out.append(props)
        fps_list.append(_fp_to_packed(fp))

    if fmt in ("sdf", "sdf.gz"):
        count = 0
        for mol in _iter_sdf_mols(source):
            count += 1
            if mol is None:
                continue
            _add(mol, count)
            if count % 5000 == 0:
                progress(min(0.92, 0.05 + count / 2_000_000), f"Parsed {count} compounds")
    elif fmt in ("csv", "tsv"):
        sep = "\t" if fmt == "tsv" else ","
        df = pd.read_csv(source, sep=sep)
        smi_col, nm_col = _detect_columns(df)
        if smi_col is None:
            raise ValueError(f"No SMILES column in {source.name}; got: {list(df.columns)}")
        total = len(df)
        for idx, row in df.iterrows():
            raw = str(row[smi_col]).strip()
            mol = Chem.MolFromSmiles(raw)
            if mol is None:
                continue
            if nm_col is not None:
                mol.SetProp("_Name", str(row[nm_col]))
            extra = {c: (row[c] if pd.notna(row[c]) else None) for c in df.columns if c not in (smi_col, nm_col)}
            _add(mol, int(idx) if isinstance(idx, (int, np.integer)) else 0, extra)
            if total and isinstance(idx, (int, np.integer)) and int(idx) % 5000 == 0:
                progress(min(0.92, 0.05 + int(idx) / max(total, 1) * 0.87), f"Parsed {int(idx)}/{total} compounds")
    elif fmt == "xlsx":
        df = pd.read_excel(source)
        smi_col, nm_col = _detect_columns(df)
        if smi_col is None:
            raise ValueError(f"No SMILES column in {source.name}; got: {list(df.columns)}")
        total = len(df)
        for idx, row in df.iterrows():
            raw = str(row[smi_col]).strip()
            mol = Chem.MolFromSmiles(raw)
            if mol is None:
                continue
            if nm_col is not None:
                mol.SetProp("_Name", str(row[nm_col]))
            extra = {c: (row[c] if pd.notna(row[c]) else None) for c in df.columns if c not in (smi_col, nm_col)}
            _add(mol, int(idx) if isinstance(idx, (int, np.integer)) else 0, extra)
            if total and isinstance(idx, (int, np.integer)) and int(idx) % 5000 == 0:
                progress(min(0.92, 0.05 + int(idx) / max(total, 1) * 0.87), f"Parsed {int(idx)}/{total} compounds")
    else:
        raise ValueError(f"Unsupported catalog format: {fmt}")

    if not smiles_out:
        raise ValueError("No valid compounds parsed from catalog")

    # Build the compound DataFrame. Property keys vary across SDF entries; let pandas align.
    progress(0.93, f"Building dataframe ({len(smiles_out)} compounds)")
    compounds = pd.DataFrame(props_out)
    compounds.insert(0, "name", names_out)
    compounds.insert(0, "smiles", smiles_out)

    # Coerce object columns with mixed scalars to string for parquet compatibility.
    for col in compounds.columns:
        if col in ("smiles", "name"):
            continue
        s = compounds[col]
        if s.dtype == object:
            compounds[col] = s.where(s.notna(), None).astype("string")

    fps_arr = np.stack(fps_list, axis=0).astype(np.uint8)
    header = {
        "version": _CACHE_VERSION,
        "source_mtime": stat.st_mtime,
        "source_size": stat.st_size,
        "compound_count": len(smiles_out),
        "indexed_at": datetime.utcnow().isoformat(),
        "fp_radius": _FP_RADIUS,
        "fp_nbits": _FP_NBITS,
    }

    progress(0.97, "Writing cache")
    pq = _parquet_path(source)
    npy = _fps_path(source)
    hdr = _header_path(source)
    pq_tmp = pq.with_name(pq.name + ".tmp")
    npy_tmp = npy.with_name(npy.name + ".tmp")
    hdr_tmp = hdr.with_name(hdr.name + ".tmp")
    compounds.to_parquet(pq_tmp, engine="pyarrow", compression="snappy", index=False)
    np.save(npy_tmp, fps_arr, allow_pickle=False)
    # np.save may add .npy suffix if missing; ensure final path matches.
    saved_npy = npy_tmp if npy_tmp.exists() else npy_tmp.with_name(npy_tmp.name + ".npy")
    with open(hdr_tmp, "w") as f:
        json.dump(header, f, indent=2)

    pq_tmp.replace(pq)
    saved_npy.replace(npy)
    hdr_tmp.replace(hdr)
    progress(1.0, f"Indexed {len(smiles_out)} compounds")
    log.info(f"Indexed catalog '{name}': {len(smiles_out)} compounds")
    return header


def load_catalog(name: str) -> tuple[pd.DataFrame, np.ndarray]:
    """Load a fully-indexed catalog.

    Returns:
        (compounds DataFrame with smiles+name+extra cols,
         numpy uint8 array of shape (N, nBits/8) of packed fingerprint bits).

    Raises ValueError if the catalog isn't indexed or its cache is stale.
    """
    source = _resolve_catalog(name)
    if not _cache_is_valid(source):
        raise ValueError(
            f"Catalog '{name}' is not indexed (or cache is stale). Re-index it first."
        )
    compounds = pd.read_parquet(_parquet_path(source), engine="pyarrow")
    fps = np.load(_fps_path(source), allow_pickle=False)
    return compounds, fps


# ── Vectorized Tanimoto on packed fingerprints ───────────────────────────────

# Precompute a lookup table of popcounts for each byte value.
_POPCOUNT_U8 = np.array([bin(i).count("1") for i in range(256)], dtype=np.uint16)


def _popcount_per_row(packed: np.ndarray) -> np.ndarray:
    """Sum of set bits per row for a packed-uint8 fingerprint array."""
    return _POPCOUNT_U8[packed].sum(axis=1, dtype=np.uint32)


def max_tanimoto_to_queries(
    library_packed: np.ndarray,  # (N, B)
    query_packed: np.ndarray,    # (M, B)
) -> np.ndarray:
    """For each library fingerprint, the max Tanimoto similarity over all queries.

    Vectorized — fast enough for N=3M, M=50 in seconds. Returns a (N,) float32 array.
    """
    if library_packed.ndim != 2 or query_packed.ndim != 2:
        raise ValueError("packed FP arrays must be 2D (N, bytes_per_fp)")
    if library_packed.shape[1] != query_packed.shape[1]:
        raise ValueError("library/query byte width mismatch")

    lib_pop = _popcount_per_row(library_packed)                        # (N,)
    q_pop = _popcount_per_row(query_packed).astype(np.uint32)          # (M,)

    best = np.zeros(library_packed.shape[0], dtype=np.float32)
    # Iterate over queries to keep peak memory bounded (N * 1 byte per chunk).
    for j in range(query_packed.shape[0]):
        q = query_packed[j]
        # bitwise AND → popcount per row
        and_pop = _POPCOUNT_U8[library_packed & q].sum(axis=1, dtype=np.uint32)
        union = lib_pop + q_pop[j] - and_pop
        # Avoid div-by-zero: where union==0, Tanimoto is defined as 0 (both empty FPs).
        with np.errstate(divide="ignore", invalid="ignore"):
            sim = np.where(union > 0, and_pop / union.astype(np.float32), 0.0).astype(np.float32)
        np.maximum(best, sim, out=best)
    return best


def smiles_to_packed_fp(smiles: str) -> Optional[np.ndarray]:
    """SMILES → uint8 packed Morgan fingerprint, matching the cache layout."""
    from rdkit import Chem
    from rdkit.Chem import AllChem

    mol = Chem.MolFromSmiles(smiles)
    if mol is None:
        return None
    fp = AllChem.GetMorganFingerprintAsBitVect(mol, _FP_RADIUS, nBits=_FP_NBITS)
    return _fp_to_packed(fp)
