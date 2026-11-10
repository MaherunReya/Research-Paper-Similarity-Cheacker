import { useEffect, useRef, useState } from "react";

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
const WEB_CHARS = 1000; // keep in sync with WEB_QUERY_CHARS in backend/app/main.py
const countWords = (t) => t.trim().split(/\s+/).filter(Boolean).length;

const EXAMPLE_TITLE = "Learning dense representations of scientific papers from citation links";
const EXAMPLE_ABSTRACT =
  "Finding related work gets harder as the number of published papers grows. We propose a method that represents each paper as a dense vector learned from the citations between papers, so that papers with similar content and similar citation context lie close together. We evaluate on scientific document recommendation and citation prediction benchmarks and show improvements over keyword-based and general-purpose embedding baselines. We release our models and an evaluation suite.";

// Raw cosine scores are compressed: embedding models give 0.85-0.95 even to loosely related papers.
// So the score is stretched from a per-source "floor" (what an unrelated in-field paper scores).
// These numbers are estimates: tune floor/dup using papers you know are related or unrelated.
const SCALE = {
  local: { floor: 0.7, dup: 0.97 }, // SPECTER2 + your FAISS index
  web: { floor: 0.88, dup: 0.97 }, // OpenAlex semantic search
};

// tier 1-4 drives the label and how many meter segments are filled
function describe(score, source) {
  const { floor, dup } = SCALE[source] || SCALE.local;
  const pct = Math.max(0, Math.min(100, Math.round(((score - floor) / (1 - floor)) * 100)));
  if (score >= dup) return { tier: 4, label: "Near-duplicate" };
  if (pct >= 60) return { tier: 3, label: "Closely related" };
  if (pct >= 30) return { tier: 2, label: "Related" };
  return { tier: 1, label: "Loosely related" };
}

// Problem/method scores compare short sentence groups with SPECTER2. Thresholds are estimates: tune them.
const ROLE = { same: 0.9, close: 0.8 };

function roleState(x) {
  if (x == null) return "none";
  return x >= ROLE.same ? "same" : x >= ROLE.close ? "close" : "diff";
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

function RoleChip({ name, score }) {
  const state = roleState(score);
  const text = { none: "not found", same: "same", close: "close", diff: "different" }[state];
  return (
    <span className={`chip role ${state}`} title={score != null ? `cosine ${score.toFixed(2)}` : undefined}>
      {name}: {text}
    </span>
  );
}

function Mark() {
  return (
    <svg className="mark" width="30" height="30" viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <rect x="3" y="3" width="16" height="20" rx="3" stroke="currentColor" strokeWidth="2" />
      <rect x="13" y="9" width="16" height="20" rx="3" stroke="currentColor" strokeWidth="2" fill="var(--brand-soft)" />
      <path d="M17 16h8M17 20h8M17 24h5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function Segmented({ label, value, onChange, options }) {
  return (
    <div className="seg" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          type="button"
          key={o.value}
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Result({ paper, rank, source, index }) {
  const [open, setOpen] = useState(false);
  const { tier, label } = describe(paper.score, source);
  const verdict = paper.problem_score !== undefined ? roleVerdict(paper.problem_score, paper.method_score) : "";
  const long = paper.abstract.length > 260;
  return (
    <li className="result" style={{ "--i": Math.min(index, 8) }}>
      <div className="rank">{rank}</div>
      <div className="body">
        <h3>
          <a href={paper.url} target="_blank" rel="noreferrer">
            {paper.title}
          </a>
        </h3>
        <p className="meta">
          {paper.authors.length > 90 ? paper.authors.slice(0, 90) + "…" : paper.authors}
          {paper.year ? <span className="chip year">{paper.year}</span> : null}
        </p>
        {paper.problem_score !== undefined && (
          <div className="roles">
            {verdict && <strong>{verdict}</strong>}
            <RoleChip name="Problem" score={paper.problem_score} />
            <RoleChip name="Method" score={paper.method_score} />
          </div>
        )}
        {paper.abstract && (
          <p className="abstract">{open || !long ? paper.abstract : paper.abstract.slice(0, 260) + "…"}</p>
        )}
        <div className="actions">
          {long && (
            <button type="button" className="link" onClick={() => setOpen(!open)} aria-expanded={open}>
              {open ? "Show less" : "Show full abstract"}
            </button>
          )}
          <a className="link" href={paper.url} target="_blank" rel="noreferrer">
            View paper
          </a>
        </div>
      </div>
      <div className="match" title="Estimated from abstract similarity. The raw cosine score is shown for reference.">
        <strong className={`tier t${tier}`}>{label}</strong>
        <div className={`meter t${tier}`} aria-hidden="true">
          <i /> <i /> <i /> <i />
        </div>
        <span className="raw">cosine {paper.score.toFixed(2)}</span>
      </div>
    </li>
  );
}

function stagesFor({ mode, source, roles }, papers) {
  const stages = [mode === "pdf" ? "Reading your PDF" : "Reading your abstract"];
  if (source === "web") {
    stages.push(
      `Sending the first ${WEB_CHARS.toLocaleString()} characters to OpenAlex`,
      "Ranking the closest papers"
    );
  } else {
    stages.push(
      "Encoding it with SPECTER2",
      papers ? `Comparing it with ${papers.toLocaleString()} indexed papers` : "Comparing it with the index"
    );
  }
  if (roles) stages.push("Comparing problem and method");
  return stages;
}

function Searching({ stages, stage, elapsed }) {
  const slow = elapsed >= 15;
  return (
    <section aria-label="Search in progress">
      <div className="scan">
        <svg viewBox="0 0 96 120" aria-hidden="true">
          <defs>
            <clipPath id="docclip">
              <rect x="4" y="4" width="88" height="112" rx="8" />
            </clipPath>
          </defs>
          <rect className="doc-body" x="4" y="4" width="88" height="112" rx="8" strokeWidth="2.5" />
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <g key={i}>
              <rect className="doc-line" x="16" y={20 + i * 16} width={i % 3 === 2 ? 44 : 64} height="7" rx="3.5" />
              <rect
                className="doc-hl"
                x="12"
                y={17 + i * 16}
                width={i % 3 === 2 ? 52 : 72}
                height="13"
                rx="4"
                style={{ animationDelay: `${i * 0.4}s` }}
              />
            </g>
          ))}
          <g clipPath="url(#docclip)">
            <rect className="doc-scan" x="4" y="4" width="88" height="3" />
          </g>
        </svg>
        <div>
          <p className="stage" role="status" aria-live="polite">
            {stages[stage]}
          </p>
          <p className="elapsed">
            {elapsed} s elapsed.{" "}
            {slow ? "Live search can take up to a minute when OpenAlex is busy." : "This usually takes a few seconds."}
          </p>
        </div>
      </div>
      <div className="skels" aria-hidden="true">
        {[0, 1, 2].map((i) => (
          <div className="skel" key={i}>
            <i style={{ width: "62%" }} />
            <i style={{ width: "38%" }} />
            <i style={{ width: "94%" }} />
            <i style={{ width: "80%" }} />
          </div>
        ))}
      </div>
    </section>
  );
}

function Welcome() {
  return (
    <section>
      <h1>Find the papers closest to yours</h1>
      <p className="lead">
        Paste an abstract or upload a PDF. Papers are ranked by meaning, so a paper that describes the same idea in
        different words still shows up.
      </p>
      <ol className="steps">
        <li>
          <b aria-hidden="true">1</b>
          <p>
            <strong>Add your paper.</strong> Paste the title and abstract, or upload the PDF and the abstract is read
            for you.
          </p>
        </li>
        <li>
          <b aria-hidden="true">2</b>
          <p>
            <strong>It is converted to a vector.</strong> SPECTER2, a language model built for scientific papers,
            turns the abstract into numbers that capture its meaning.
          </p>
        </li>
        <li>
          <b aria-hidden="true">3</b>
          <p>
            <strong>You get the closest papers.</strong> Each result has a plain-language match label, and you can
            compare problem and method separately.
          </p>
        </li>
      </ol>
      <dl className="facts">
        <div>
          <dt>Where results come from</dt>
          <dd>Your local arXiv computer science index, or all of OpenAlex when you choose live search.</dd>
        </div>
        <div>
          <dt>What happens to your text</dt>
          <dd>
            This app does not save it. In live mode, the first {WEB_CHARS.toLocaleString()} characters are sent to
            openalex.org.
          </dd>
        </div>
        <div>
          <dt>What it cannot tell you</dt>
          <dd>It compares abstracts, not full texts. Treat results as papers to read, not a verdict on originality.</dd>
        </div>
      </dl>
    </section>
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
  const [papers, setPapers] = useState(undefined); // undefined = checking, null = server offline
  const [running, setRunning] = useState(null);
  const [stage, setStage] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const mainRef = useRef(null);

  useEffect(() => {
    fetch("/api/health")
      .then((r) => r.json())
      .then((d) => {
        setPapers(d.papers ?? null);
        if (d.papers === 0) setSource("web"); // no local index yet: start on live search
      })
      .catch(() => setPapers(null));
  }, []);

  useEffect(() => {
    if (!loading || !running) return;
    const t0 = Date.now();
    const last = stagesFor(running, papers).length - 1;
    setStage(0);
    setElapsed(0);
    const id = setInterval(() => {
      const s = Math.floor((Date.now() - t0) / 1000);
      setElapsed(s);
      setStage(Math.min(Math.floor(s / 3), last));
    }, 500);
    return () => clearInterval(id);
  }, [loading, running, papers]);

  // Bring the progress animation into view once it has rendered (matters on phones and short screens).
  useEffect(() => {
    if (loading) mainRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [loading]);

  const words = countWords(abstract);
  const overLimit = words > MAX_WORDS;
  const canSubmit = mode === "text" ? abstract.trim().length >= 20 && !overLimit : !!file;

  async function submit(e) {
    e.preventDefault();
    setRunning({ mode, source, roles });
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
      setData({ ...out, source, mode });
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  const statusClass = papers === undefined ? "" : papers === null ? "off" : "ok";
  const statusText =
    papers === undefined
      ? "Checking server"
      : papers === null
        ? "Server not reachable"
        : papers === 0
          ? "No local index yet"
          : `Local index: ${papers.toLocaleString()} papers`;

  return (
    <div className="shell">
      <header className="top">
        <div className="brand">
          <Mark />
          <span>Paper Similarity</span>
        </div>
        <p className={`status ${statusClass}`}>{statusText}</p>
      </header>

      <div className="app">
        <aside className="card">
          <h2>Your paper</h2>
          <Segmented
            label="Input type"
            value={mode}
            onChange={setMode}
            options={[
              { value: "text", label: "Paste text" },
              { value: "pdf", label: "Upload PDF" },
            ]}
          />

          <form onSubmit={submit}>
            {mode === "text" ? (
              <>
                <label htmlFor="title">Title (optional)</label>
                <input id="title" value={title} onChange={(e) => setTitle(e.target.value)} />
                <label htmlFor="abstract">Abstract</label>
                <textarea
                  id="abstract"
                  rows={9}
                  value={abstract}
                  placeholder="Paste the abstract of the paper you want to check."
                  onChange={(e) => setAbstract(e.target.value)}
                />
                <div className="under">
                  <button
                    type="button"
                    className="link"
                    onClick={() => {
                      setTitle(EXAMPLE_TITLE);
                      setAbstract(EXAMPLE_ABSTRACT);
                    }}
                  >
                    Use an example
                  </button>
                  <p className={`count${overLimit ? " over" : ""}`} aria-live="polite">
                    {words} / {MAX_WORDS} words{overLimit ? ` (remove ${words - MAX_WORDS})` : ""}
                  </p>
                </div>
              </>
            ) : (
              <>
                <label htmlFor="pdf">PDF file (up to 20 MB)</label>
                <input
                  id="pdf"
                  type="file"
                  accept="application/pdf"
                  onChange={(e) => setFile(e.target.files[0] || null)}
                />
              </>
            )}

            <span className="label">Search in</span>
            <Segmented
              label="Search in"
              value={source}
              onChange={setSource}
              options={[
                { value: "local", label: "My index" },
                { value: "web", label: "OpenAlex (live)" },
              ]}
            />
            <p className="hint">
              {source === "local"
                ? "Fast. Searches the arXiv computer science papers you indexed."
                : "Slower. Searches all of OpenAlex and sends your abstract to openalex.org."}
            </p>

            <label className="check">
              <input type="checkbox" checked={roles} onChange={(e) => setRoles(e.target.checked)} />
              <span>
                Compare problem and method
                <small>Adds a few seconds.</small>
              </span>
            </label>

            <label htmlFor="k">Number of results</label>
            <select id="k" value={k} onChange={(e) => setK(Number(e.target.value))}>
              {[5, 10, 20, 30].map((n) => (
                <option key={n} value={n}>
                  {n} papers
                </option>
              ))}
            </select>

            <button className="primary" disabled={!canSubmit || loading}>
              {loading && <span className="spin" aria-hidden="true" />}
              {loading ? "Searching" : "Find similar papers"}
            </button>
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
          </form>
        </aside>

        <main className="main" ref={mainRef}>
          {loading && running ? (
            <Searching stages={stagesFor(running, papers)} stage={stage} elapsed={elapsed} />
          ) : data ? (
            <section>
              <div className="head">
                <h2>Closest papers</h2>
                <p>
                  {data.results.length} results from {data.source === "web" ? "OpenAlex (live)" : "your local index"}
                </p>
              </div>
              <p className="legend">
                Match labels are estimates from abstract similarity. Open a paper to judge the overlap yourself.
              </p>
              {data.mode === "pdf" && (
                <div className="note">
                  <p>We read this from your PDF. If it looks wrong, switch to “Paste text” and correct it.</p>
                  <p>
                    <strong>{data.query.title || "No title found"}</strong>
                  </p>
                  <p>{data.query.abstract.slice(0, 300)}…</p>
                </div>
              )}
              {data.query_roles && (
                <div className="note">
                  <p>Compared on these parts of your abstract. If they look wrong, edit the abstract wording.</p>
                  <p>
                    <strong>Problem:</strong> {data.query_roles.problem.slice(0, 250) || "none found"}
                  </p>
                  <p>
                    <strong>Method:</strong> {data.query_roles.method.slice(0, 250) || "none found"}
                  </p>
                </div>
              )}
              {data.results.length === 0 ? (
                <p className="empty">No papers found. Try a longer abstract, or switch the search source.</p>
              ) : (
                <ol className="list">
                  {data.results.map((p, i) => (
                    <Result key={p.id} paper={p} rank={i + 1} index={i} source={data.source} />
                  ))}
                </ol>
              )}
            </section>
          ) : (
            <Welcome />
          )}
        </main>
      </div>

      <footer className="foot">
        <p>
          Papers from <a href="https://arxiv.org">arXiv</a> and <a href="https://openalex.org">OpenAlex</a>. Meaning is
          measured with <a href="https://huggingface.co/allenai/specter2_base">SPECTER2</a> from the Allen Institute
          for AI. Results are leads to read, not a plagiarism ruling.
        </p>
      </footer>
    </div>
  );
}