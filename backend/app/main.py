from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from .embedder import Embedder
from .pdf import extract_title_abstract
from .search import SearchIndex

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
MAX_PDF_BYTES = 20 * 1024 * 1024
state: dict = {}


@asynccontextmanager
async def lifespan(app: FastAPI):
    state["embedder"] = Embedder()  # load the model once at startup
    state["index"] = SearchIndex(DATA_DIR)
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


def run_search(title: str, abstract: str, k: int) -> list[dict]:
    vec = state["embedder"].embed([{"title": title, "abstract": abstract}])[0]
    return state["index"].search(vec, k)


@app.get("/api/health")
def health():
    return {"status": "ok", "papers": len(state["index"].papers)}


@app.post("/api/search")
def search(req: SearchRequest):
    return {
        "query": {"title": req.title, "abstract": req.abstract},
        "results": run_search(req.title, req.abstract, req.k),
    }


@app.post("/api/search-pdf")
async def search_pdf(file: UploadFile = File(...), k: int = 10):
    data = await file.read()
    if len(data) > MAX_PDF_BYTES:
        raise HTTPException(413, "PDF is larger than 20 MB.")
    try:
        title, abstract = extract_title_abstract(data)
    except Exception:
        raise HTTPException(400, "Could not read this PDF.")
    if len(abstract) < 20:
        raise HTTPException(422, "No abstract found in this PDF. Paste the abstract instead.")
    return {
        "query": {"title": title, "abstract": abstract},
        "results": run_search(title, abstract, min(max(k, 1), 50)),
    }
