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

function Result({ paper, rank }) {
  const [open, setOpen] = useState(false);
  const pct = Math.round(paper.score * 100);
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
        <p className="abstract">
          {open ? paper.abstract : paper.abstract.slice(0, 260) + (paper.abstract.length > 260 ? "…" : "")}
        </p>
        {paper.abstract.length > 260 && (
          <button className="link" onClick={() => setOpen(!open)}>
            {open ? "Show less" : "Show full abstract"}
          </button>
        )}
      </div>
      <div className="score" title="Cosine similarity">
        <span>{pct}%</span>
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
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [data, setData] = useState(null);

  const canSubmit = mode === "text" ? abstract.trim().length >= 20 : !!file;

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
          body: JSON.stringify({ title, abstract, k }),
        });
      } else {
        const form = new FormData();
        form.append("file", file);
        out = await post(`/api/search-pdf?k=${k}`, { method: "POST", body: form });
      }
      setData(out);
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
            </>
          ) : (
            <>
              <label htmlFor="pdf">PDF file (up to 20 MB)</label>
              <input id="pdf" type="file" accept="application/pdf" onChange={(e) => setFile(e.target.files[0] || null)} />
            </>
          )}

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
            <ol>
              {data.results.map((p, i) => (
                <Result key={p.id} paper={p} rank={i + 1} />
              ))}
            </ol>
          </>
        )}
      </main>
    </div>
  );
}
