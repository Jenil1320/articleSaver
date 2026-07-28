"""Offline classification: what kind of thing is this, and what is it about.

Rules only, no model and no API key, so saving works with no network beyond the fetch
and gives the same answer every time. Two questions are answered separately:

  kind  - article, paper, post, or product (a tool or platform rather than a read)
  theme - the shelf it belongs on

Both are suggestions. The reader can override either, and an override is remembered
as `theme_source='user'` so a later re-scan never overwrites a human decision.
"""
from __future__ import annotations

import re
from collections import Counter
from urllib.parse import urlparse

# --------------------------------------------------------------- kind

PRODUCT_PATH_RE = re.compile(
    r"/(product|products|platform|pricing|features|solutions|use-cases?|"
    r"integrations?|docs?|documentation|api|developers?|download|app|tools?|"
    r"get-started|demo|signup|sign-up|register)(/|$)",
    re.I,
)

PRODUCT_PHRASES = (
    "book a demo", "request a demo", "get started", "start free", "free trial",
    "start your free", "contact sales", "talk to sales", "sign up", "sign in",
    "log in", "pricing", "per month", "per user", "our platform", "our product",
    "trusted by", "customers", "case studies", "integrations", "api reference",
    "install", "pip install", "npm install", "getting started", "documentation",
    "release notes", "changelog", "sdk", "open source", "github", "roadmap",
    "schedule a call", "join the waitlist", "try it free", "no credit card",
)

PAPER_PHRASES = (
    "abstract", "introduction", "methodology", "we propose", "in this paper",
    "related work", "references", "et al.", "doi:", "arxiv", "conclusion",
    "experimental results", "literature review", "executive summary",
    "this report", "appendix", "bibliography", "acknowledgements",
)

PAPER_HOST_RE = re.compile(
    r"(arxiv\.org|doi\.org|researchgate|ssrn|nature\.com|sciencedirect|springer|"
    r"ieee\.org|acm\.org|jstor|biorxiv|medrxiv|pubmed|semanticscholar|osti\.gov)",
    re.I,
)

REPORT_HOST_RE = re.compile(
    r"(iea\.org|irena\.org|ember-energy|ember-climate|bnef|wri\.org|iisd|"
    r"worldbank|imf\.org|un\.org|oecd|nrel\.gov|niti\.gov|cea\.nic\.in|"
    r"powermin\.gov|mnre\.gov|rmi\.org|carbontracker|climateworks)",
    re.I,
)


def _phrase_hits(text: str, phrases) -> int:
    low = text.lower()
    return sum(1 for p in phrases if p in low)


def classify_kind(*, url: str, title: str, blocks: list[dict], word_count: int,
                  text_plain: str, signals: dict | None = None,
                  kind_hint: str = "", page_count: int = 0) -> tuple[str, float]:
    """Return (kind, confidence 0..1)."""
    signals = signals or {}
    host = (urlparse(url).netloc or "").lower()
    path = (urlparse(url).path or "/")
    head = f"{title}\n{text_plain[:4000]}"

    if kind_hint == "post":
        return "post", 0.95
    if kind_hint == "text":
        # Text the reader pasted in is something they chose to keep, never a product
        # page, however short it is.
        return "article", 0.9

    scores: Counter[str] = Counter()

    # --- paper / report -------------------------------------------------
    if PAPER_HOST_RE.search(host):
        scores["paper"] += 6
    if REPORT_HOST_RE.search(host):
        scores["paper"] += 4
    if kind_hint == "paper":                       # came in as a PDF
        scores["paper"] += 3
        if page_count >= 6:
            scores["paper"] += 2
        if word_count > 4000:
            scores["paper"] += 2
    scores["paper"] += min(_phrase_hits(head, PAPER_PHRASES), 5)

    # --- product / platform ---------------------------------------------
    if PRODUCT_PATH_RE.search(path):
        scores["product"] += 3
    if path in ("", "/"):                          # a bare homepage is rarely an article
        scores["product"] += 3
    scores["product"] += min(_phrase_hits(head, PRODUCT_PHRASES), 6)

    heads = sum(1 for b in blocks if b["type"] in ("h1", "h2", "h3", "h4"))
    paras = sum(1 for b in blocks if b["type"] == "p")
    if paras and heads / max(paras, 1) > 0.5:      # marketing pages are heading-heavy
        scores["product"] += 3
    if word_count < 700:
        scores["product"] += 2
    if word_count < 300:
        scores["product"] += 2
    og = (signals.get("og_type") or "").lower()
    if og == "website":
        scores["product"] += 1
    if any("documentation" in (b["text"] or "").lower() for b in blocks[:4]):
        scores["product"] += 2
    if re.search(r"(github\.io|readthedocs|gitlab\.io|\.dev$)", host):
        scores["product"] += 2

    # --- article ---------------------------------------------------------
    if og == "article":
        scores["article"] += 4
    if any(t in ("Article", "NewsArticle", "BlogPosting") for t in signals.get("ld_types", [])):
        scores["article"] += 4
    if word_count >= 700:
        scores["article"] += 3
    if word_count >= 1500:
        scores["article"] += 3
    if paras >= 12:
        scores["article"] += 2
    if re.search(r"/(blog|posts?|article|news|writing|essays?|\d{4}/\d{2})(/|$)", path, re.I):
        scores["article"] += 4

    if not scores:
        return "article", 0.3

    kind, top = scores.most_common(1)[0]
    total = sum(scores.values()) or 1
    return kind, round(min(0.99, top / total), 2)


# --------------------------------------------------------------- theme

# Each theme lists terms that genuinely discriminate it from the others.
# Multi-word terms score higher because they are far less ambiguous.
THEMES: dict[str, list[str]] = {
    "Energy & Grid": [
        "energy", "grid", "electricity", "power system", "transmission", "substation",
        "renewable", "solar", "wind", "photovoltaic", "megawatt", "gigawatt",
        "battery storage", "energy storage", "bess", "dispatch", "curtailment",
        "load", "demand response", "capacity factor", "interconnection",
        "power purchase", "ppa", "utility", "feeder", "distribution network",
        "grid integration", "ancillary services", "frequency regulation",
        "energy transition", "decarbonisation", "decarbonization", "coal plant",
        "thermal power", "hydropower", "nuclear", "electrolyser", "hydrogen",
        "smart meter", "discom", "tariff", "energy market", "spot market",
        "balancing", "inertia", "reactive power", "transformer", "kwh", "mwh",
    ],
    "Climate & Policy": [
        "climate", "emissions", "carbon", "net zero", "greenhouse gas", "co2",
        "paris agreement", "cop28", "cop29", "mitigation", "adaptation",
        "regulation", "policy", "subsidy", "mandate", "compliance", "legislation",
        "carbon price", "carbon credit", "offset", "sustainability", "esg",
        "climate risk", "global warming", "renewable target",
    ],
    "AI & Machine Learning": [
        "machine learning", "neural network", "deep learning", "llm",
        "large language model", "transformer", "gpt", "training data",
        "fine-tuning", "inference", "embedding", "prompt", "artificial intelligence",
        "reinforcement learning", "supervised", "unsupervised", "model weights",
        "hallucination", "benchmark", "gradient", "attention mechanism",
        "diffusion model", "agent", "rag", "token",
    ],
    "Software & Engineering": [
        "software", "codebase", "api", "database", "framework", "library",
        "deployment", "kubernetes", "docker", "microservice", "refactor",
        "git", "repository", "compiler", "runtime", "latency", "throughput",
        "architecture", "backend", "frontend", "devops", "ci/cd", "python",
        "javascript", "typescript", "rust", "sql", "open source", "bug",
        "pull request", "unit test", "scalability",
    ],
    "Data & Analytics": [
        "dataset", "analytics", "statistics", "regression", "forecast",
        "time series", "visualisation", "visualization", "dashboard", "metric",
        "correlation", "probability", "sampling", "data pipeline", "etl",
        "data quality", "outlier", "distribution", "confidence interval",
    ],
    "Business & Strategy": [
        "strategy", "market share", "competitor", "revenue", "business model",
        "go-to-market", "customer", "acquisition", "merger", "valuation",
        "startup", "venture capital", "funding round", "profit", "margin",
        "supply chain", "procurement", "operations", "productivity", "pricing",
        "stakeholder", "roadmap", "growth",
    ],
    "Finance & Markets": [
        "investor", "portfolio", "equity", "bond", "interest rate", "inflation",
        "hedge", "derivative", "commodity", "trading", "arbitrage", "yield",
        "capital", "balance sheet", "cash flow", "dividend", "asset class",
        "risk premium", "volatility", "central bank", "recession",
    ],
    "Writing & Communication": [
        "writing", "prose", "essay", "grammar", "sentence", "paragraph", "editor",
        "style guide", "punctuation", "em-dash", "readability", "narrative",
        "storytelling", "rhetoric", "vocabulary", "draft", "manuscript",
    ],
    "Product & Design": [
        "user experience", "usability", "interface", "design system", "prototype",
        "wireframe", "typography", "accessibility", "user research", "onboarding",
        "product manager", "feature", "user journey", "figma", "affordance",
    ],
    "Science & Health": [
        "clinical", "patient", "molecule", "protein", "genome", "trial",
        "diagnosis", "therapy", "biology", "chemistry", "physics", "quantum",
        "experiment", "hypothesis", "peer review", "vaccine", "neuroscience",
    ],
    "Career & Working": [
        "career", "hiring", "interview", "promotion", "manager", "team",
        "productivity", "burnout", "remote work", "salary", "mentorship",
        "performance review", "leadership", "onboarding", "resignation",
    ],
}

# Terms so generic they would match everything.
_STOP_THEME_TERMS = {"load", "agent", "token", "capital", "feature", "team", "bug"}


def _compile(terms: list[str]) -> list[tuple[re.Pattern, float]]:
    out = []
    for t in terms:
        weight = 2.5 if " " in t else (0.6 if t in _STOP_THEME_TERMS else 1.0)
        out.append((re.compile(r"\b" + re.escape(t) + r"\b", re.I), weight))
    return out


_THEME_PATTERNS = {name: _compile(terms) for name, terms in THEMES.items()}


def suggest_theme(*, title: str, text_plain: str, url: str = "",
                  top_n: int = 4) -> tuple[str, list[str]]:
    """Return (best theme, ranked alternatives including the best)."""
    body = text_plain[:20000]
    title_text = f"{title} {urlparse(url).path.replace('-', ' ').replace('/', ' ')}"

    scores: dict[str, float] = {}
    for name, patterns in _THEME_PATTERNS.items():
        score = 0.0
        distinct = 0
        for pat, weight in patterns:
            n_body = len(pat.findall(body))
            n_title = len(pat.findall(title_text))
            if n_body or n_title:
                distinct += 1
            # Diminishing returns: ten mentions of one word is not ten times the signal.
            score += weight * (min(n_body, 8) ** 0.7)
            score += weight * n_title * 3.0
        # Reward breadth of vocabulary, which separates a real topic from one stray word.
        score *= 1.0 + min(distinct, 12) * 0.12
        scores[name] = score

    ranked = sorted(scores.items(), key=lambda kv: kv[1], reverse=True)
    best, best_score = ranked[0]
    # Require a real signal, and a clear margin over the runner-up.
    if best_score < 6:
        return "Unsorted", [n for n, s in ranked[:top_n] if s > 2]
    options = [n for n, s in ranked[:top_n] if s >= best_score * 0.25]
    return best, options


def analyse(*, url: str, title: str, blocks: list[dict], word_count: int,
            text_plain: str, signals: dict | None = None, kind_hint: str = "",
            page_count: int = 0) -> dict:
    kind, confidence = classify_kind(
        url=url, title=title, blocks=blocks, word_count=word_count,
        text_plain=text_plain, signals=signals, kind_hint=kind_hint,
        page_count=page_count,
    )
    theme, options = suggest_theme(title=title, text_plain=text_plain, url=url)
    return {
        "kind": kind,
        "kind_confidence": confidence,
        "theme": theme,
        "theme_options": options,
    }
