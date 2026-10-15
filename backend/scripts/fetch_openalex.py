"""Download paper metadata (title + abstract) from OpenAlex into a JSONL file."""
import argparse
import json
import os
import re
import time
import urllib.parse
import urllib.request
from pathlib import Path

API = "https://api.openalex.org/works"
SELECT = "id,title,abstract_inverted_index,authorships,publication_year,primary_topic,doi"


def rebuild_abstract(inverted):
    """OpenAlex stores abstracts as {word: [positions]}; turn that back into text."""
    if not inverted:
        return ""
    by_pos = {}
    for word, positions in inverted.items():
        for p in positions:
            by_pos[p] = word
    return " ".join(by_pos[i] for i in sorted(by_pos))


def to_record(w):
    title = re.sub(r"\s+", " ", w.get("title") or "").strip()
    abstract = rebuild_abstract(w.get("abstract_inverted_index"))
    if not title or len(abstract) < 100:
        return None
    names = [a["author"]["display_name"] for a in w.get("authorships", []) if a.get("author")]
    authors = ", ".join(names[:10]) + (" et al." if len(names) > 10 else "")
    topic = w.get("primary_topic") or {}
    cats = " ".join(
        x["display_name"].replace(" ", "_")
        for x in (topic.get("field"), topic.get("subfield"))
        if x
    )
    short_id = w["id"].rsplit("/", 1)[-1]
    return {
        "id": short_id,
        "title": title,
        "abstract": abstract,
        "authors": authors,
        "year": w.get("publication_year"),
        "categories": cats,
        "url": w.get("doi") or w["id"],
        "source": "openalex",
    }


def get_json(url, api_key="", retries=4):
    headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.load(r)
        except Exception:
            if attempt == retries - 1:
                raise
            time.sleep(2 ** attempt)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=Path("data/openalex.jsonl"), type=Path)
    ap.add_argument("--max", default=50_000, type=int)
    ap.add_argument(
        "--api-key",
        default=os.environ.get("OPENALEX_API_KEY", ""),
        help="free key from openalex.org/settings/api (or set OPENALEX_API_KEY)",
    )
    ap.add_argument("--filter", default="publication_year:2020-2025",
                    help="extra OpenAlex filter, comma separated")
    args = ap.parse_args()

    if not args.api_key:
        print("No API key: OpenAlex only allows a very small daily budget without one.")
    flt = "has_abstract:true,type:article," + args.filter
    args.out.parent.mkdir(parents=True, exist_ok=True)
    cursor, saved = "*", 0
    with open(args.out, "w", encoding="utf-8") as f:
        while cursor and saved < args.max:
            params = {"filter": flt, "per-page": 200, "cursor": cursor, "select": SELECT}
            data = get_json(f"{API}?{urllib.parse.urlencode(params)}", args.api_key)
            for w in data.get("results", []):
                rec = to_record(w)
                if rec:
                    f.write(json.dumps(rec, ensure_ascii=False) + "\n")
                    saved += 1
            cursor = data.get("meta", {}).get("next_cursor")
            print(f"{saved} papers saved", end="\r")
            time.sleep(0.15)
    print(f"\nDone: {saved} papers -> {args.out}")


if __name__ == "__main__":
    main()