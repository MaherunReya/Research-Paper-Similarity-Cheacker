"""Best-effort title/abstract extraction from a paper PDF.

Heuristics: the title is the largest text on page 1; the abstract is the text after
the word "Abstract" up to "Introduction"/"Keywords". Works for most arXiv-style papers.
The frontend shows what was extracted so the user can correct it.
"""
import re

import fitz  # PyMuPDF


def extract_title_abstract(pdf_bytes: bytes) -> tuple[str, str]:
    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    if doc.page_count == 0:
        return "", ""

    spans = []
    for block in doc[0].get_text("dict")["blocks"]:
        for line in block.get("lines", []):
            for s in line["spans"]:
                text = s["text"].strip()
                if text:
                    spans.append((s["size"], s["bbox"][1], text))
    title = ""
    if spans:
        biggest = max(size for size, _, _ in spans)
        parts = sorted((y, t) for size, y, t in spans if biggest - size < 0.5)
        title = re.sub(r"\s+", " ", " ".join(t for _, t in parts)).strip()

    text = "\n".join(doc[i].get_text() for i in range(min(2, doc.page_count)))
    m = re.search(
        r"abstract\W*(.+?)(?:\n\s*(?:1\.?|I\.?)?\s*introduction|\n\s*(?:index terms|keywords)|\Z)",
        text,
        flags=re.IGNORECASE | re.DOTALL,
    )
    abstract = m.group(1) if m else text[:2000]
    abstract = re.sub(r"\s+", " ", abstract).strip()[:3000]
    return title, abstract
