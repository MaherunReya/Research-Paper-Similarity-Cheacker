"""Build a FAISS index from the arXiv metadata snapshot.

Usage (from backend/):
    python -m scripts.build_index --input data/arxiv-metadata-oai-snapshot.json --prefix cs. --limit 100000
"""
import argparse
import json
import random
import re
from pathlib import Path

import faiss
import numpy as np
from tqdm import tqdm

from app.embedder import Embedder


def clean(text: str) -> str:
    return re.sub(r"\s+", " ", text or "").strip()


def year_of(rec: dict) -> int | None:
    try:
        # "Mon, 2 Apr 2007 19:18:42 GMT" -> 2007
        return int(rec["versions"][0]["created"].split()[3])
    except Exception:
        return None


def load_papers(path: Path, prefix: str, limit: int, min_year: int = 0, sample: bool = False) -> list[dict]:
    prefixes = tuple(p.strip() for p in prefix.split(",") if p.strip())
    rng = random.Random(42)
    papers, matched = [], 0
    with open(path, encoding="utf-8") as f:
        for line in tqdm(f, desc="Reading metadata"):
            rec = json.loads(line)
            cats = rec.get("categories", "")
            if prefixes and not any(c.startswith(prefixes) for c in cats.split()):
                continue
            title, abstract = clean(rec.get("title")), clean(rec.get("abstract"))
            if not title or len(abstract) < 100:
                continue
            year = year_of(rec)
            if min_year and (year is None or year < min_year):
                continue
            paper = {
                "id": rec["id"],
                "title": title,
                "abstract": abstract,
                "authors": clean(rec.get("authors")),
                "year": year,
                "categories": cats,
                "url": f"https://arxiv.org/abs/{rec['id']}",
                "source": "arxiv",
            }
            if sample:  # reservoir sampling: uniform random subset of size `limit`
                matched += 1
                if len(papers) < limit:
                    papers.append(paper)
                else:
                    j = rng.randrange(matched)
                    if j < limit:
                        papers[j] = paper
            else:
                papers.append(paper)
                if len(papers) >= limit:
                    break
    return papers


def norm_title(t: str) -> str:
    return re.sub(r"[^a-z0-9]", "", t.lower())


def load_extra(paths: list[Path]) -> list[dict]:
    """Read JSONL files that already use our schema (e.g. from fetch_openalex.py)."""
    out = []
    for path in paths:
        with open(path, encoding="utf-8") as f:
            for line in tqdm(f, desc=f"Reading {path.name}"):
                rec = json.loads(line)
                if rec.get("title") and len(rec.get("abstract", "")) >= 100:
                    out.append(rec)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True, type=Path)
    ap.add_argument("--out", default=Path("data"), type=Path)
    ap.add_argument("--prefix", default="cs.",
                    help="arXiv category prefix(es), comma-separated, e.g. cs.CV,cs.CL,cs.LG; '' for all")
    ap.add_argument("--min-year", default=0, type=int, help="skip papers older than this year")
    ap.add_argument("--sample", action="store_true",
                    help="pick a random subset of --limit papers instead of the first N")
    ap.add_argument("--limit", default=100_000, type=int)
    ap.add_argument("--batch-size", default=64, type=int)
    ap.add_argument("--extra", nargs="*", default=[], type=Path,
                    help="extra JSONL files in our schema, e.g. data/openalex.jsonl")
    args = ap.parse_args()

    args.out.mkdir(parents=True, exist_ok=True)
    papers = load_papers(args.input, args.prefix, args.limit, args.min_year, args.sample)
    # Add the extra sources, skipping papers whose title is already present (e.g. on arXiv and OpenAlex)
    seen = {norm_title(p["title"]) for p in papers}
    added = 0
    for rec in load_extra(args.extra):
        key = norm_title(rec["title"])
        if key not in seen:
            seen.add(key)
            papers.append(rec)
            added += 1
    print(f"{len(papers)} papers selected ({added} from extra sources)")

    embedder = Embedder()
    print(f"Embedding on {embedder.device}")
    chunks = []
    step = 2048
    for i in tqdm(range(0, len(papers), step), desc="Embedding"):
        chunks.append(embedder.embed(papers[i : i + step], batch_size=args.batch_size))
    vectors = np.concatenate(chunks)

    index = faiss.IndexFlatIP(vectors.shape[1])  # inner product == cosine (vectors are normalised)
    index.add(vectors)
    faiss.write_index(index, str(args.out / "index.faiss"))
    with open(args.out / "papers.jsonl", "w", encoding="utf-8") as f:
        for p in papers:
            f.write(json.dumps(p, ensure_ascii=False) + "\n")
    print(f"Saved index and metadata to {args.out}/")


if __name__ == "__main__":
    main()