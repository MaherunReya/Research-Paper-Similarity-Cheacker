# Paper Similarity

Find the research papers closest to yours. Paste a title and abstract (or upload a PDF) and get related papers ranked by meaning, not by shared keywords. You can also check whether a result tackles the **same problem** or uses the **same method**.

- **Two search sources:** your own local index (arXiv, optionally OpenAlex) or a live search over all of OpenAlex.
- **Semantic matching:** abstracts are embedded with [SPECTER2](https://huggingface.co/allenai/specter2_base), a model built for scientific papers, and compared with FAISS.
- **Problem vs method comparison:** each result is scored separately on problem and method, so "same problem, different method" is visible at a glance.
- **Plain-language match labels:** Near-duplicate, Closely related, Related, Loosely related, with the raw cosine score shown for reference.
- **PDF upload:** the title and abstract are extracted for you, and shown so you can correct them.
- **Light and dark themes**, responsive layout, and a progress animation while searching.

## How it works

1. The title and abstract are turned into a 768-dimension vector by SPECTER2 (the `proximity` adapter, meant for nearest-neighbour search).
2. **Local mode:** FAISS returns the closest vectors from `data/index.faiss`.
   **Live mode:** the first 1,000 characters of the abstract are sent to OpenAlex's semantic search.
3. **Optional problem/method comparison:** the abstract is split into problem sentences and method sentences using cue phrases ("remains a challenge", "we propose", and so on). Each part is embedded separately and compared with the same part of every result.
4. Cosine scores are stretched into a label (see [Tuning](#tuning)), because raw scores cluster between 0.85 and 0.95 even for loosely related papers.

## Requirements

- Python 3.10 or newer
- Node.js 18 or newer
- A GPU is optional, but strongly recommended for building a large index (Kaggle or Colab works)
- A free [OpenAlex API key](https://openalex.org/settings/api), needed for live search and for downloading OpenAlex data

## Project structure

```
backend/
  app/
    main.py        FastAPI app: endpoints, OpenAlex live search, problem/method scoring
    embedder.py    SPECTER2 embedder (shared by the API and the index builder)
    search.py      FAISS index + metadata lookup
    pdf.py         Title/abstract extraction from PDFs (PyMuPDF)
    roles.py       Splits an abstract into problem and method parts
  scripts/
    build_index.py     Builds data/index.faiss and data/papers.jsonl
    fetch_openalex.py  Downloads OpenAlex metadata into data/openalex.jsonl
  data/                Git-ignored: raw datasets and the built index live here
frontend/
  src/App.jsx, styles.css, main.jsx
  index.html
```

## Setup

### 1. Backend

```bash
cd backend
python -m venv .venv
```

Activate the environment:

| OS | Command |
|---|---|
| Windows (cmd) | `.venv\Scripts\activate` |
| Windows (PowerShell) | `.venv\Scripts\Activate.ps1` |
| macOS / Linux | `source .venv/bin/activate` |

```bash
pip install -r requirements.txt
```

### 2. Get the data

**arXiv (main corpus).** Download the metadata snapshot from [Kaggle](https://www.kaggle.com/datasets/Cornell-University/arxiv). Kaggle gives you a zip, so extract it and put `arxiv-metadata-oai-snapshot.json` in `backend/data/`.

**OpenAlex (optional second corpus).** Set your API key, then download computer science papers from 2020 to 2025:

```bash
# Windows cmd:        set OPENALEX_API_KEY=your_key
# PowerShell:         $env:OPENALEX_API_KEY="your_key"
# macOS / Linux:      export OPENALEX_API_KEY=your_key

python -m scripts.fetch_openalex --max 50000 --filter "primary_topic.field.id:17,publication_year:2020-2025"
```

The filter must use the field **ID** (17 is Computer Science), not its name. Using `primary_topic.field.display_name` returns HTTP 400.

### 3. Build the index

Run from `backend/`. Start small to check everything works (a few minutes on CPU):

```bash
python -m scripts.build_index --input data/arxiv-metadata-oai-snapshot.json --prefix cs. --limit 5000
```

For real use, build a larger and more varied index on a GPU machine:

```bash
python -m scripts.build_index \
  --input data/arxiv-metadata-oai-snapshot.json \
  --prefix cs.CV,cs.CL,cs.LG,cs.AI \
  --min-year 2018 --sample --limit 100000 \
  --extra data/openalex.jsonl
```

| Option | What it does |
|---|---|
| `--prefix` | arXiv categories to keep, comma-separated (`cs.` keeps all computer science, `""` keeps everything) |
| `--min-year` | Skip papers older than this year |
| `--sample` | Pick a random subset of `--limit` papers instead of the first N |
| `--limit` | Maximum number of arXiv papers |
| `--extra` | Extra JSONL files in the same format, such as `data/openalex.jsonl`. Papers with a title already present are skipped |

The output is `data/index.faiss` and `data/papers.jsonl`. If you built the index on another machine, copy only those two files into `backend/data/`. You do not need the raw datasets after that.

> **Why `--min-year` and `--sample` matter:** the arXiv snapshot is roughly ordered by date, so the first 5,000 computer science papers are all old. Without these options, a search about a recent topic has nothing close to match and returns unrelated papers.

**Rebuild the index** whenever you add a data source, change the filters, or change how text is embedded in `embedder.py`. Restart the API afterwards, because it keeps the old index in memory.

### 4. Run the API

```bash
cd backend
# set OPENALEX_API_KEY first if you want live search
uvicorn app.main:app --reload --port 8000
```

Open http://localhost:8000/api/health. It should report the number of indexed papers. Interactive docs are at http://localhost:8000/docs.

### 5. Run the frontend

In a second terminal:

```bash
cd frontend
npm install
npm run dev
```

Open http://localhost:5173. The dev server forwards `/api` requests to port 8000.

## Using it

1. Choose **Paste text** or **Upload PDF**.
2. Choose where to search: **My index** (fast) or **OpenAlex (live)** (all papers, slower).
3. Optionally tick **Compare problem and method**. It adds a few seconds.
4. Click **Find similar papers**.

Abstracts are limited to 400 words. For PDFs, the extracted abstract is trimmed to the same limit.

## API reference

### `GET /api/health`

Returns `{"status": "ok", "papers": 104212}`.

### `POST /api/search`

```json
{
  "title": "optional title",
  "abstract": "at least 20 characters, at most 400 words",
  "k": 10,
  "source": "local",
  "roles": false
}
```

| Field | Notes |
|---|---|
| `k` | 1 to 50 results |
| `source` | `"local"` or `"web"` |
| `roles` | `true` adds `problem_score` and `method_score` to each result, plus `query_roles` with the sentences used |

Example:

```bash
curl -X POST http://localhost:8000/api/search \
  -H "Content-Type: application/json" \
  -d '{"abstract": "We study how vision-language models revise correct answers after misleading feedback...", "k": 5}'
```

Each result contains `id`, `title`, `authors`, `year`, `categories`, `abstract`, `score` (cosine similarity) and `url`.

### `POST /api/search-pdf`

Multipart upload with a `file` field (PDF, up to 20 MB). Query parameters: `k`, `source`, `roles`. The response matches `/api/search` and includes the extracted title and abstract under `query`.

### Errors

| Status | Meaning |
|---|---|
| 400 | The PDF could not be read |
| 413 | The PDF is larger than 20 MB |
| 422 | Abstract too short, over 400 words, or no abstract found in the PDF |
| 502 | OpenAlex returned an error or timed out |
| 503 | Live search was requested but `OPENALEX_API_KEY` is not set |

## Tuning

These values are estimates. Adjust them using papers you know are related or unrelated.

| What | Where | Default |
|---|---|---|
| Score-to-label calibration (`floor` is the score an unrelated paper in the same field gets, `dup` is the near-duplicate threshold) | `SCALE` in `frontend/src/App.jsx` | local 0.70 / 0.97, web 0.88 / 0.97 |
| Problem/method thresholds (Same, Close) | `ROLE` in `frontend/src/App.jsx` | 0.90, 0.80 |
| Abstract word limit | `MAX_WORDS` in both `backend/app/main.py` and `frontend/src/App.jsx` | 400 |
| Characters sent to OpenAlex | `WEB_QUERY_CHARS` in `backend/app/main.py`, and `WEB_CHARS` in `frontend/src/App.jsx` | 1000 |
| Problem and method cue phrases | `METHOD` and `PROBLEM` in `backend/app/roles.py` | |

## Troubleshooting

**`FileNotFoundError: data\arxiv-metadata-oai-snapshot.json`.** The file is not where the command expects it. Run `dir data`. Common causes are a zip that was never extracted, the file placed in the wrong folder, or an extra `.json` in the name.

**Results look unrelated.** Check the index size at `/api/health`, and rebuild with `--min-year` and `--sample` as described above. Also confirm `index.faiss` and `papers.jsonl` come from the same build.

**A paper in the index does not come back as result #1.** It should, at a very high score. If not, the index and metadata files are from different builds, or the SPECTER2 adapter failed to load. Check the API startup log.

**OpenAlex HTTP 400.** Use `primary_topic.field.id:17`, not the field's display name.

**OpenAlex 502 or timeout in live search.** OpenAlex's semantic search sometimes times out on long text. The server retries with shorter queries (1000, 500, then 250 characters). If it still fails, try again later or use the local index.

**503 "Web search needs an OpenAlex API key".** Set `OPENALEX_API_KEY` in the same terminal that runs `uvicorn`, then restart it.

**"Server not reachable" in the header.** The frontend cannot reach the API. Make sure `uvicorn` is running on port 8000.

## Limitations

- Matching uses **abstracts only**, not full text. Treat results as papers to read, not a verdict on originality or plagiarism.
- Problem and method splitting uses cue phrases, so abstracts without typical phrasing may show "not found". The extracted parts are shown in the results so you can check them.
- Cosine scores are compressed, so the labels are estimates. Calibrate them for your own data.
- The local index only covers what you indexed.
- CORS is set to `http://localhost:5173`. Change it in `backend/app/main.py` before deploying elsewhere.
- In live mode, your abstract is sent to openalex.org. The app itself does not store searches, but check your hosting setup if you deploy it, since servers may log request bodies.


## Credits and data

- Embeddings: [SPECTER2](https://huggingface.co/allenai/specter2_base) by the Allen Institute for AI
- Papers: the [arXiv metadata dataset](https://www.kaggle.com/datasets/Cornell-University/arxiv) and [OpenAlex](https://openalex.org)
- Vector search: [FAISS](https://github.com/facebookresearch/faiss)

Check each data source's terms before redistributing any data.
