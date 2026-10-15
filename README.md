# Paper Similarity

Paste a title and abstract (or upload a PDF) and get the most semantically similar papers.
Embeddings: SPECTER2. Vector search: FAISS. Backend: FastAPI. Frontend: React + Vite.

## 1. Backend setup

```bash
cd backend
python -m venv .venv && source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

## 2. Get the corpus

Download the arXiv metadata snapshot from Kaggle
(https://www.kaggle.com/datasets/Cornell-University/arxiv) and put
`arxiv-metadata-oai-snapshot.json` in `backend/data/`.

## 3. Build the index (one time, use a GPU if you have one, e.g. Colab/Kaggle)

```bash
python -m scripts.build_index --input data/arxiv-metadata-oai-snapshot.json --prefix cs. --limit 100000
```

This writes `data/index.faiss` and `data/papers.jsonl`.
Try `--limit 5000` first to check everything works (takes a few minutes on CPU).
If you built the index on another machine, just copy those two files into `backend/data/`.

### Optional: add a second corpus (OpenAlex)

```bash
python -m scripts.fetch_openalex --mailto you@example.com --max 50000 \
  --filter "primary_topic.field.display_name:Computer Science,publication_year:2020-2025"
python -m scripts.build_index --input data/arxiv-metadata-oai-snapshot.json --prefix cs. --limit 100000 --extra data/openalex.jsonl
```

Duplicates (same title) are skipped. Rebuild the index whenever you add a source.

## 4. Run the API

```bash
uvicorn app.main:app --reload --port 8000
```

Docs at http://localhost:8000/docs

## 5. Run the frontend

```bash
cd frontend
npm install
npm run dev
```

Open http://localhost:5173. The Vite dev server proxies `/api` to port 8000.

## Next steps
- Filters by year / category (move to pgvector or Qdrant for metadata filtering)
- Hybrid search: BM25 + embeddings
- Cross-encoder reranking of the top 50
- "Why is this similar?" view with the most similar sentences
