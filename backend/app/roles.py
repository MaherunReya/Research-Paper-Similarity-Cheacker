"""Split an abstract into a "problem" part and a "method" part with cue phrases.

Rough on purpose: no extra models. Abstracts that don't use the usual phrasing may be split
badly, so the API returns the extracted parts and the UI shows them for checking.
"""
import re

SENT_SPLIT = re.compile(r"(?<=[.!?])\s+(?=[A-Z\"“(])")

METHOD = re.compile(
    r"\b(we|this (?:paper|work|thesis|study|article))\s+"
    r"(?:\w+\s+)?(?:propose|present|introduce|develop|design|build|devise|describe|"
    r"leverage|utili[sz]e|adopt|employ|apply)\w*"
    r"|\b(?:our|the proposed)\s+(?:\w+\s+)?(?:method|approach|framework|model|system|technique|"
    r"algorithm|pipeline|architecture|layer|module|strategy|scheme|controller)\b"
    r"|\b(?:training-free|novel (?:method|approach|framework|model|algorithm)|"
    r"consists of|is implemented|built on|based on)\b",
    re.IGNORECASE,
)

PROBLEM = re.compile(
    r"\b(?:remains?|remained)\b|\bchalleng\w*|\bsuffers?\b|\bvulnerab\w*|\bproblem\b|\bissues?\b|"
    r"\blimitations?\b|\blimited\b|\bstruggles?\b|\bfails?\b|\bdifficult\w*|\black\w*\b|\bdespite\b|"
    r"\bhowever\b|\bhallucinat\w*|\bsycophan\w*|\bbias\w*|\bthe (?:aim|goal|objective) of\b|"
    r"\b(?:we|this \w+)\s+(?:study|studies|investigate|investigates|address|addresses|explore|explores|"
    r"examine|examines|tackle|tackles)\b|\bmotivat\w*|\bshadow\b|\bcrucial\b|\bhampers?\b",
    re.IGNORECASE,
)


def split_roles(abstract: str) -> tuple[str, str]:
    """Return (problem_text, method_text). Either can be '' if nothing matched."""
    sents = [s.strip() for s in SENT_SPLIT.split(re.sub(r"\s+", " ", abstract or "").strip()) if s.strip()]
    if not sents:
        return "", ""
    labels = ["method" if METHOD.search(s) else "problem" if PROBLEM.search(s) else None for s in sents]
    method = [s for s, lab in zip(sents, labels) if lab == "method"]
    problem = [s for s, lab in zip(sents, labels) if lab == "problem"]
    if not problem:
        # fall back to the opening sentences before the method starts (usually the context/problem)
        first_method = labels.index("method") if "method" in labels else None
        problem = sents[:first_method] if first_method else sents[:1]
    return " ".join(problem), " ".join(method)