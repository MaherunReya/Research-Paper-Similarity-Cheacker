import json
import os
import urllib.error
import urllib.parse
import urllib.request
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from .embedder import Embedder
from .envfile import load_env
from .pdf import extract_title_abstract
from .roles import split_roles
from .search import SearchIndex

load_env()  # reads backend/.env (e.g. OPENALEX_API_KEY)

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
MAX_PDF_BYTES = 20 * 1024 * 1024
OPENALEX_URL = "https://api.openalex.org/works"
MAX_WORDS = 400  # abstract word limit (the frontend uses the same number)
WEB_QUERY_CHARS = 1000  # long semantic queries can time out on OpenAlex; lower this if they still do
OPENALEX_SELECT = "id,title,abstract_inverted_index,authorships,publication_year,doi,relevance_score"
state: dict = {}


@asynccontextmanager
async def lifespan(app: FastAPI):
    state["embedder"] = Embedder()  # load the model once at startup
    try:
        state["index"] = SearchIndex(DATA_DIR)
    except (FileNotFoundError, RuntimeError):
        # No local index yet: the server still starts, and live OpenAlex search keeps working.
        state["index"] = None
        print("No local index found in backend/data. Build one with scripts.build_index; "
              "until then only 'OpenAlex (live)' search works.")
    yield
    state.clear()


app = FastAPI(title="Paper Similarity", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)


class SearchRequest(BaseModel):
    title: str = ""
    abstract: str = Field(min_length=20)
    k: int = Field(default=10, ge=1, le=50)
    source: Literal["local", "web"] = "local"
    roles: bool = False


def rebuild_abstract(inverted: dict | None) -> str:
    """OpenAlex stores abstracts as {word: [positions]}; turn that back into text."""
    if not inverted:
        return ""
    by_pos = {p: word for word, positions in inverted.items() for p in positions}
    return " ".join(by_pos[i] for i in sorted(by_pos))


def web_search(title: str, abstract: str, k: int) -> list[dict]:
    """Live semantic search over all of OpenAlex (needs the OPENALEX_API_KEY env var)."""
    key = os.environ.get("OPENALEX_API_KEY", "")
    if not key:
        raise HTTPException(
            503,
            "Web search needs an OpenAlex API key. Set OPENALEX_API_KEY and restart the server.",
        )
    text = (abstract or title).strip()
    data = None
    # OpenAlex semantic search sometimes times out on long text, so retry with shorter and shorter queries
    for n in (WEB_QUERY_CHARS, WEB_QUERY_CHARS // 2, WEB_QUERY_CHARS // 4):
        query = text[:n].rsplit(" ", 1)[0] if len(text) > n else text
        params = {"search.semantic": query, "per-page": min(k, 50), "select": OPENALEX_SELECT}
        req = urllib.request.Request(
            f"{OPENALEX_URL}?{urllib.parse.urlencode(params)}",
            headers={"Authorization": f"Bearer {key}"},
        )
        try:
            with urllib.request.urlopen(req, timeout=40) as r:
                data = json.load(r)
            break
        except urllib.error.HTTPError as e:
            if e.code in (502, 503, 504):  # timeout on OpenAlex's side: try a shorter query
                continue
            body = e.read().decode("utf-8", "ignore")
            try:
                detail = json.loads(body).get("message") or body
            except ValueError:
                detail = body
            raise HTTPException(502, f"OpenAlex error {e.code}: {detail[:200]}")
        except Exception:
            continue
    if data is None:
        raise HTTPException(
            502,
            "OpenAlex timed out, even on a short query. Its semantic search may be overloaded: "
            "try again in a few minutes, or switch to 'My local index'.",
        )

    results = []
    for w in data.get("results", []):
        names = [a["author"]["display_name"] for a in w.get("authorships", []) if a.get("author")]
        results.append(
            {
                "id": w["id"].rsplit("/", 1)[-1],
                "title": w.get("title") or "(untitled)",
                "authors": ", ".join(names[:10]) + (" et al." if len(names) > 10 else ""),
                "year": w.get("publication_year"),
                "categories": "",
                "abstract": rebuild_abstract(w.get("abstract_inverted_index")),
                "score": round(float(w.get("relevance_score") or 0), 4),
                "url": w.get("doi") or w["id"],
            }
        )
    return results


def run_search(title: str, abstract: str, k: int, source: str = "local") -> list[dict]:
    if source == "web":
        return web_search(title, abstract, k)
    if state.get("index") is None:
        raise HTTPException(
            503,
            "No local index yet. Build one with scripts.build_index, or switch to 'OpenAlex (live)'.",
        )
    vec = state["embedder"].embed([{"title": title, "abstract": abstract}])[0]
    return state["index"].search(vec, k)


def add_roles(abstract: str, results: list[dict]) -> dict:
    """Score each result on problem-vs-problem and method-vs-method similarity (adds fields in place)."""
    texts: list[dict] = []

    def queue(text: str) -> int | None:
        if not text:
            return None
        texts.append({"abstract": text})
        return len(texts) - 1

    q_problem, q_method = split_roles(abstract)
    qp, qm = queue(q_problem), queue(q_method)
    slots = []
    for r in results:
        p, m = split_roles(r.get("abstract", ""))
        slots.append((queue(p), queue(m)))
    vecs = state["embedder"].embed(texts) if texts else []

    def cos(a: int | None, b: int | None) -> float | None:
        return None if a is None or b is None else round(float(vecs[a] @ vecs[b]), 4)

    for r, (ip, im) in zip(results, slots):
        r["problem_score"] = cos(qp, ip)
        r["method_score"] = cos(qm, im)
    return {"problem": q_problem, "method": q_method}


def do_search(title: str, abstract: str, k: int, source: str, roles: bool) -> dict:
    if len(abstract.split()) > MAX_WORDS:
        raise HTTPException(422, f"Abstract is over {MAX_WORDS} words. Please shorten it.")
    results = run_search(title, abstract, k, source)
    out = {"query": {"title": title, "abstract": abstract}, "results": results}
    if roles:
        out["query_roles"] = add_roles(abstract, results)
    return out


@app.get("/api/health")
def health():
    index = state.get("index")
    return {"status": "ok", "papers": len(index.papers) if index else 0}


@app.post("/api/search")
def search(req: SearchRequest):
    return do_search(req.title, req.abstract, req.k, req.source, req.roles)


@app.post("/api/search-pdf")
async def search_pdf(
    file: UploadFile = File(...),
    k: int = 10,
    source: Literal["local", "web"] = "local",
    roles: bool = False,
):
    data = await file.read()
    if len(data) > MAX_PDF_BYTES:
        raise HTTPException(413, "PDF is larger than 20 MB.")
    try:
        title, abstract = extract_title_abstract(data)
    except Exception:
        raise HTTPException(400, "Could not read this PDF.")
    if len(abstract) < 20:
        raise HTTPException(422, "No abstract found in this PDF. Paste the abstract instead.")
    abstract = " ".join(abstract.split()[:MAX_WORDS])  # PDF text: trim instead of failing
    return await run_in_threadpool(do_search, title, abstract, min(max(k, 1), 50), source, roles)