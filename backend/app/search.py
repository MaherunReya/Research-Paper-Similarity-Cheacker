import json
from pathlib import Path

import faiss
import numpy as np


class SearchIndex:
    def __init__(self, data_dir: Path):
        self.index = faiss.read_index(str(data_dir / "index.faiss"))
        with open(data_dir / "papers.jsonl", encoding="utf-8") as f:
            self.papers = [json.loads(line) for line in f]

    def search(self, vector: np.ndarray, k: int = 10) -> list[dict]:
        scores, ids = self.index.search(vector.reshape(1, -1), k)
        results = []
        for score, i in zip(scores[0], ids[0]):
            if i < 0:
                continue
            p = self.papers[i]
            results.append(
                {
                    "id": p["id"],
                    "title": p["title"],
                    "authors": p["authors"],
                    "year": p["year"],
                    "categories": p["categories"],
                    "abstract": p["abstract"],
                    "score": round(float(score), 4),
                    "url": f"https://arxiv.org/abs/{p['id']}",
                }
            )
        return results
