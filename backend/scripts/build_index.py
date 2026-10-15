"""Build a FAISS index from the arXiv metadata snapshot.

Usage (from backend/):
    python -m scripts.build_index --input data/arxiv-metadata-oai-snapshot.json --prefix cs. --limit 100000
"""
import argparse
import json
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


def load_papers(path: Path, prefix: str, limit: int) -> list[dict]:
    papers = []
    with open(path, encoding="utf-8") as f:
        for line in tqdm(f, desc="Reading metadata"):
            rec = json.loads(line)
            cats = rec.get("categories", "")
            if prefix and not any(c.startswith(prefix) for c in cats.split()):
                continue
            title, abstract = clean(rec.get("title")), clean(rec.get("abstract"))
            if not title or len(abstract) < 100:
                continue
            papers.append(
                {
                    "id": rec["id"],
                    "title": title,
                    "abstract": abstract,
                    "authors": clean(rec.get("authors")),
                    "year": year_of(rec),
                    "categories": cats,
                }
            )
            if len(papers) >= limit:
                break
    return papers


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True, type=Path)
    ap.add_argument("--out", default=Path("data"), type=Path)
    ap.add_argument("--prefix", default="cs.", help="arXiv category prefix, '' for all")
    ap.add_argument("--limit", default=100_000, type=int)
    ap.add_argument("--batch-size", default=64, type=int)
    args = ap.parse_args()

    args.out.mkdir(parents=True, exist_ok=True)
    papers = load_papers(args.input, args.prefix, args.limit)
    print(f"{len(papers)} papers selected")

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
