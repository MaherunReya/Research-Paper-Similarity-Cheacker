import { useState } from "react";

async function post(url, options) {
  const res = await fetch(url, options);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = body.detail;
    throw new Error(
      typeof detail === "string" ? detail : "Something went wrong. Check your input and try again."
    );
  }
  return body;
}

const MAX_WORDS = 400; // keep in sync with MAX_WORDS in backend/app/main.py
const countWords = (t) => t.trim().split(/\s+/).filter(Boolean).length;

// Raw cosine scores are compressed: embedding models give 0.85-0.95 even to loosely related papers.
// So the score is stretched from a per-source "floor" (what an unrelated in-field paper scores).
// These numbers are estimates: tune floor/dup using papers you know are related or unrelated.
const SCALE = {
  local: { floor: 0.7, dup: 0.97 }, // SPECTER2 + your FAISS index
  web: { floor: 0.88, dup: 0.97 }, // OpenAlex semantic search
};

function describe(score, source) {
  const { floor, dup } = SCALE[source] || SCALE.local;
  const pct = Math.max(0, Math.min(100, Math.round(((score - floor) / (1 - floor)) * 100)));
  let label = "Loosely related";
  if (score >= dup) label = "Near-duplicate";
  else if (pct >= 60) label = "Closely related";
  else if (pct >= 30) label = "Related";
  return { pct, label };
}

// Problem/method scores compare short sentence groups with SPECTER2. Thresholds are estimates: tune them.
const ROLE = { same: 0.9, close: 0.8 };

function roleLabel(x) {
  if (x == null) return "not found";
  return `${x >= ROLE.same ? "Same" : x >= ROLE.close ? "Close" : "Different"} (${x.toFixed(2)})`;
}

function roleVerdict(p, m) {
  const P = p != null && p >= ROLE.close;
  const M = m != null && m >= ROLE.close;
  if (P && M) return "Overlapping work";
  if (P && m == null) return "Similar problem (method not detected)";
  if (P) return "Same problem, different method";
  if (M) return "Same method, different problem";
  return "";
}

function Result({ paper, rank, source }) {
  const [open, setOpen] = useState(false);
  const { pct, label } = describe(paper.score, source);
  return (
    <li className="result">
      <div className="rank">{rank}</div>
      <div className="body">
        <h3>
          <a href={paper.url} target="_blank" rel="noreferrer">
            {paper.title}
          </a>
        </h3>
        <p className="meta">
          {paper.authors.length > 90 ? paper.authors.slice(0, 90) + "…" : paper.authors}
          {paper.year ? `, ${paper.year}` : ""}
        </p>
        {paper.problem_score !== undefined && (
          <p className="meta">
            <strong>{roleVerdict(paper.problem_score, paper.method_score)}</strong>
            {roleVerdict(paper.problem_score, paper.method_score) && " · "}
            Problem: {roleLabel(paper.problem_score)} · Method: {roleLabel(paper.method_score)}
          </p>
        )}
        <p className="abstract">
          {open ? paper.abstract : paper.abstract.slice(0, 260) + (paper.abstract.length > 260 ? "…" : "")}
        </p>
        {paper.abstract.length > 260 && (
          <button className="link" onClick={() => setOpen(!open)}>
            {open ? "Show less" : "Show full abstract"}
          </button>
        )}
      </div>
      <div className="score" title="Raw cosine similarity. Scores cluster high, so read the label, not the number.">
        <span>{label}</span>
        <div style={{ fontWeight: 400, fontSize: ".8rem", color: "var(--muted)" }}>cos {paper.score.toFixed(2)}</div>
        <div className="bar">
          <div style={{ width: `${pct}%` }} />
        </div>
      </div>
    </li>
  );
}

export default function App() {
  const [mode, setMode] = useState("text");
  const [title, setTitle] = useState("");
  const [abstract, setAbstract] = useState("");
  const [file, setFile] = useState(null);
  const [k, setK] = useState(10);
  const [source, setSource] = useState("local");
  const [roles, setRoles] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [data, setData] = useState(null);

  const words = countWords(abstract);
  const overLimit = words > MAX_WORDS;
  const canSubmit = mode === "text" ? abstract.trim().length >= 20 && !overLimit : !!file;

  async function submit(e) {
    e.preventDefault();
    setLoading(true);
    setError("");
    try {
      let out;
      if (mode === "text") {
        out = await post("/api/search", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title, abstract, k, source, roles }),
        });
      } else {
        const form = new FormData();
        form.append("file", file);
        out = await post(`/api/search-pdf?k=${k}&source=${source}&roles=${roles}`, { method: "POST", body: form });
      }
      setData({ ...out, source });
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="layout">
      <aside className="panel">
        <h1>Find related papers</h1>
        <p className="lead">Give a paper’s title and abstract, or upload its PDF. You get the closest papers by meaning, not by shared words.</p>

        <div className="tabs" role="tablist">
          <button role="tab" aria-selected={mode === "text"} onClick={() => setMode("text")}>
            Paste text
          </button>
          <button role="tab" aria-selected={mode === "pdf"} onClick={() => setMode("pdf")}>
            Upload PDF
          </button>
        </div>

        <form onSubmit={submit}>
          {mode === "text" ? (
            <>
              <label htmlFor="title">Title</label>
              <input id="title" value={title} onChange={(e) => setTitle(e.target.value)} />
              <label htmlFor="abstract">Abstract</label>
              <textarea
                id="abstract"
                rows={10}
                value={abstract}
                onChange={(e) => setAbstract(e.target.value)}
              />
              <p className={`count${overLimit ? " over" : ""}`} aria-live="polite">
                {words} / {MAX_WORDS} words{overLimit ? ` (remove ${words - MAX_WORDS})` : ""}
              </p>
            </>
          ) : (
            <>
              <label htmlFor="pdf">PDF file (up to 20 MB)</label>
              <input id="pdf" type="file" accept="application/pdf" onChange={(e) => setFile(e.target.files[0] || null)} />
            </>
          )}

          <label htmlFor="source">Search in</label>
          <select id="source" value={source} onChange={(e) => setSource(e.target.value)}>
            <option value="local">My local index</option>
            <option value="web">OpenAlex (live, all papers)</option>
          </select>

          <label style={{ display: "flex", gap: ".5rem", alignItems: "center", fontWeight: 400 }}>
            <input
              type="checkbox"
              style={{ width: "auto" }}
              checked={roles}
              onChange={(e) => setRoles(e.target.checked)}
            />
            Compare problem &amp; method (slower)
          </label>

          <label htmlFor="k">Number of results</label>
          <select id="k" value={k} onChange={(e) => setK(Number(e.target.value))}>
            {[5, 10, 20, 30].map((n) => (
              <option key={n}>{n}</option>
            ))}
          </select>

          <button className="primary" disabled={!canSubmit || loading}>
            {loading ? "Searching…" : "Find similar papers"}
          </button>
          {error && <p className="error" role="alert">{error}</p>}
        </form>
      </aside>

      <main className="results">
        {!data && !loading && (
          <p className="empty">Results appear here. Paste an abstract to start.</p>
        )}
        {data && (
          <>
            {mode === "pdf" && (
              <div className="extracted">
                <p>
                  We read this from your PDF. If it looks wrong, switch to “Paste text” and correct it.
                </p>
                <p><strong>{data.query.title || "No title found"}</strong></p>
                <p>{data.query.abstract.slice(0, 300)}…</p>
              </div>
            )}
            {data.query_roles && (
              <div className="extracted">
                <p>Compared on these parts of your abstract. If they look wrong, edit the abstract wording.</p>
                <p><strong>Problem:</strong> {data.query_roles.problem.slice(0, 250) || "none found"}</p>
                <p><strong>Method:</strong> {data.query_roles.method.slice(0, 250) || "none found"}</p>
              </div>
            )}
            <ol>
              {data.results.map((p, i) => (
                <Result key={p.id} paper={p} rank={i + 1} source={data.source} />
              ))}
            </ol>
          </>
        )}
      </main>
    </div>
  );
}