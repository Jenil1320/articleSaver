/* Offline classification: what kind of thing is this, and what is it about.

   Rules only, no model and no API key, so saving works with nothing but the fetch
   itself and gives the same answer every time. Two questions are answered separately:

     kind  - article, paper, post, or product (a tool or platform rather than a read)
     theme - the shelf it belongs on

   Both are suggestions. The reader can override either, and an override is remembered
   as themeSource='user' so a later re-scan never overwrites a human decision. */

const PRODUCT_PATH_RE = new RegExp(
  '/(product|products|platform|pricing|features|solutions|use-cases?|'
  + 'integrations?|docs?|documentation|api|developers?|download|app|tools?|'
  + 'get-started|demo|signup|sign-up|register)(/|$)', 'i');

const PRODUCT_PHRASES = [
  'book a demo', 'request a demo', 'get started', 'start free', 'free trial',
  'start your free', 'contact sales', 'talk to sales', 'sign up', 'sign in',
  'log in', 'pricing', 'per month', 'per user', 'our platform', 'our product',
  'trusted by', 'customers', 'case studies', 'integrations', 'api reference',
  'install', 'pip install', 'npm install', 'getting started', 'documentation',
  'release notes', 'changelog', 'sdk', 'open source', 'github', 'roadmap',
  'schedule a call', 'join the waitlist', 'try it free', 'no credit card',
];

const PAPER_PHRASES = [
  'abstract', 'introduction', 'methodology', 'we propose', 'in this paper',
  'related work', 'references', 'et al.', 'doi:', 'arxiv', 'conclusion',
  'experimental results', 'literature review', 'executive summary',
  'this report', 'appendix', 'bibliography', 'acknowledgements',
];

const PAPER_HOST_RE = new RegExp(
  '(arxiv\\.org|doi\\.org|researchgate|ssrn|nature\\.com|sciencedirect|springer|'
  + 'ieee\\.org|acm\\.org|jstor|biorxiv|medrxiv|pubmed|semanticscholar|osti\\.gov)', 'i');

const REPORT_HOST_RE = new RegExp(
  '(iea\\.org|irena\\.org|ember-energy|ember-climate|bnef|wri\\.org|iisd|'
  + 'worldbank|imf\\.org|un\\.org|oecd|nrel\\.gov|niti\\.gov|cea\\.nic\\.in|'
  + 'powermin\\.gov|mnre\\.gov|rmi\\.org|carbontracker|climateworks)', 'i');

function parts(url) {
  try {
    const u = new URL(url);
    return { host: u.hostname.toLowerCase(), path: u.pathname || '/' };
  } catch {
    return { host: '', path: '/' };
  }
}

const phraseHits = (text, phrases) => {
  const low = text.toLowerCase();
  return phrases.reduce((n, p) => n + (low.includes(p) ? 1 : 0), 0);
};

export function classifyKind({
  url = '', title = '', blocks = [], wordCount = 0, textPlain = '',
  signals = {}, kindHint = '', pageCount = 0,
}) {
  if (kindHint === 'post') return { kind: 'post', confidence: 0.95 };
  // Text the reader pasted in is something they chose to keep, never a product
  // page, however short it is.
  if (kindHint === 'text') return { kind: 'article', confidence: 0.9 };

  const { host, path } = parts(url);
  const head = `${title}\n${textPlain.slice(0, 4000)}`;
  const scores = { paper: 0, product: 0, article: 0 };

  // --- paper / report -------------------------------------------------
  if (PAPER_HOST_RE.test(host)) scores.paper += 6;
  if (REPORT_HOST_RE.test(host)) scores.paper += 4;
  if (kindHint === 'paper') {
    scores.paper += 3;
    if (pageCount >= 6) scores.paper += 2;
    if (wordCount > 4000) scores.paper += 2;
  }
  scores.paper += Math.min(phraseHits(head, PAPER_PHRASES), 5);

  // --- product / platform ---------------------------------------------
  if (PRODUCT_PATH_RE.test(path)) scores.product += 3;
  if (path === '' || path === '/') scores.product += 3;   // a bare homepage is rarely an article
  scores.product += Math.min(phraseHits(head, PRODUCT_PHRASES), 6);

  const heads = blocks.filter((b) => ['h1', 'h2', 'h3', 'h4'].includes(b.type)).length;
  const paras = blocks.filter((b) => b.type === 'p').length;
  if (paras && heads / Math.max(paras, 1) > 0.5) scores.product += 3;  // marketing pages are heading-heavy
  if (wordCount < 700) scores.product += 2;
  if (wordCount < 300) scores.product += 2;

  const og = (signals.ogType || '').toLowerCase();
  if (og === 'website') scores.product += 1;
  if (blocks.slice(0, 4).some((b) => (b.text || '').toLowerCase().includes('documentation'))) {
    scores.product += 2;
  }
  if (/(github\.io|readthedocs|gitlab\.io|\.dev$)/.test(host)) scores.product += 2;

  // --- article ---------------------------------------------------------
  if (og === 'article') scores.article += 4;
  if ((signals.ldTypes || []).some((t) => ['Article', 'NewsArticle', 'BlogPosting'].includes(t))) {
    scores.article += 4;
  }
  if (wordCount >= 700) scores.article += 3;
  if (wordCount >= 1500) scores.article += 3;
  if (paras >= 12) scores.article += 2;
  if (/\/(blog|posts?|article|news|writing|essays?|\d{4}\/\d{2})(\/|$)/i.test(path)) {
    scores.article += 4;
  }

  const entries = Object.entries(scores).filter(([, v]) => v > 0);
  if (!entries.length) return { kind: 'article', confidence: 0.3 };

  entries.sort((a, b) => b[1] - a[1]);
  const [kind, top] = entries[0];
  const total = entries.reduce((n, [, v]) => n + v, 0) || 1;
  return { kind, confidence: Math.round(Math.min(0.99, top / total) * 100) / 100 };
}

/* --------------------------------------------------------------- theme */

// Each theme lists terms that genuinely discriminate it from the others.
// Multi-word terms score higher because they are far less ambiguous.
export const THEMES = {
  'Energy & Grid': [
    'energy', 'grid', 'electricity', 'power system', 'transmission', 'substation',
    'renewable', 'solar', 'wind', 'photovoltaic', 'megawatt', 'gigawatt',
    'battery storage', 'energy storage', 'bess', 'dispatch', 'curtailment',
    'load', 'demand response', 'capacity factor', 'interconnection',
    'power purchase', 'ppa', 'utility', 'feeder', 'distribution network',
    'grid integration', 'ancillary services', 'frequency regulation',
    'energy transition', 'decarbonisation', 'decarbonization', 'coal plant',
    'thermal power', 'hydropower', 'nuclear', 'electrolyser', 'hydrogen',
    'smart meter', 'discom', 'tariff', 'energy market', 'spot market',
    'balancing', 'inertia', 'reactive power', 'transformer', 'kwh', 'mwh',
  ],
  'Climate & Policy': [
    'climate', 'emissions', 'carbon', 'net zero', 'greenhouse gas', 'co2',
    'paris agreement', 'cop28', 'cop29', 'mitigation', 'adaptation',
    'regulation', 'policy', 'subsidy', 'mandate', 'compliance', 'legislation',
    'carbon price', 'carbon credit', 'offset', 'sustainability', 'esg',
    'climate risk', 'global warming', 'renewable target',
  ],
  'AI & Machine Learning': [
    'machine learning', 'neural network', 'deep learning', 'llm',
    'large language model', 'transformer', 'gpt', 'training data',
    'fine-tuning', 'inference', 'embedding', 'prompt', 'artificial intelligence',
    'reinforcement learning', 'supervised', 'unsupervised', 'model weights',
    'hallucination', 'benchmark', 'gradient', 'attention mechanism',
    'diffusion model', 'agent', 'rag', 'token',
  ],
  'Software & Engineering': [
    'software', 'codebase', 'api', 'database', 'framework', 'library',
    'deployment', 'kubernetes', 'docker', 'microservice', 'refactor',
    'git', 'repository', 'compiler', 'runtime', 'latency', 'throughput',
    'architecture', 'backend', 'frontend', 'devops', 'ci/cd', 'python',
    'javascript', 'typescript', 'rust', 'sql', 'open source', 'bug',
    'pull request', 'unit test', 'scalability',
  ],
  'Data & Analytics': [
    'dataset', 'analytics', 'statistics', 'regression', 'forecast',
    'time series', 'visualisation', 'visualization', 'dashboard', 'metric',
    'correlation', 'probability', 'sampling', 'data pipeline', 'etl',
    'data quality', 'outlier', 'distribution', 'confidence interval',
  ],
  'Business & Strategy': [
    'strategy', 'market share', 'competitor', 'revenue', 'business model',
    'go-to-market', 'customer', 'acquisition', 'merger', 'valuation',
    'startup', 'venture capital', 'funding round', 'profit', 'margin',
    'supply chain', 'procurement', 'operations', 'productivity', 'pricing',
    'stakeholder', 'roadmap', 'growth',
  ],
  'Finance & Markets': [
    'investor', 'portfolio', 'equity', 'bond', 'interest rate', 'inflation',
    'hedge', 'derivative', 'commodity', 'trading', 'arbitrage', 'yield',
    'capital', 'balance sheet', 'cash flow', 'dividend', 'asset class',
    'risk premium', 'volatility', 'central bank', 'recession',
  ],
  'Writing & Communication': [
    'writing', 'prose', 'essay', 'grammar', 'sentence', 'paragraph', 'editor',
    'style guide', 'punctuation', 'em-dash', 'readability', 'narrative',
    'storytelling', 'rhetoric', 'vocabulary', 'draft', 'manuscript',
  ],
  'Product & Design': [
    'user experience', 'usability', 'interface', 'design system', 'prototype',
    'wireframe', 'typography', 'accessibility', 'user research', 'onboarding',
    'product manager', 'feature', 'user journey', 'figma', 'affordance',
  ],
  'Science & Health': [
    'clinical', 'patient', 'molecule', 'protein', 'genome', 'trial',
    'diagnosis', 'therapy', 'biology', 'chemistry', 'physics', 'quantum',
    'experiment', 'hypothesis', 'peer review', 'vaccine', 'neuroscience',
  ],
  'Career & Working': [
    'career', 'hiring', 'interview', 'promotion', 'manager', 'team',
    'productivity', 'burnout', 'remote work', 'salary', 'mentorship',
    'performance review', 'leadership', 'onboarding', 'resignation',
  ],
};

// Terms so generic they would match everything.
const STOP_THEME_TERMS = new Set(['load', 'agent', 'token', 'capital', 'feature', 'team', 'bug']);

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function compile(terms) {
  return terms.map((t) => ({
    // \b does not fire next to '/' or '+', so the boundaries are spelled out.
    re: new RegExp(`(^|[^a-z0-9])${escapeRe(t)}([^a-z0-9]|$)`, 'gi'),
    weight: t.includes(' ') ? 2.5 : (STOP_THEME_TERMS.has(t) ? 0.6 : 1.0),
  }));
}

const THEME_PATTERNS = Object.fromEntries(
  Object.entries(THEMES).map(([name, terms]) => [name, compile(terms)]),
);

const countMatches = (re, text) => {
  re.lastIndex = 0;
  let n = 0;
  // The trailing boundary is consumed by each match, so overlapping hits on
  // adjacent words need the index wound back by one.
  let m = re.exec(text);
  while (m) {
    n += 1;
    re.lastIndex = Math.max(m.index + 1, re.lastIndex - 1);
    m = re.exec(text);
  }
  return n;
};

/** Returns { theme, options } — the best shelf and the plausible alternatives. */
export function suggestTheme({ title = '', textPlain = '', url = '', topN = 4 }) {
  const body = textPlain.slice(0, 20000);
  let path = '';
  try { path = new URL(url).pathname.replace(/-/g, ' ').replace(/\//g, ' '); } catch { path = ''; }
  const titleText = `${title} ${path}`;

  const scores = [];
  for (const [name, patterns] of Object.entries(THEME_PATTERNS)) {
    let score = 0;
    let distinct = 0;
    for (const { re, weight } of patterns) {
      const nBody = countMatches(re, body);
      const nTitle = countMatches(re, titleText);
      if (nBody || nTitle) distinct += 1;
      // Diminishing returns: ten mentions of one word is not ten times the signal.
      score += weight * Math.min(nBody, 8) ** 0.7;
      score += weight * nTitle * 3.0;
    }
    // Reward breadth of vocabulary, which separates a real topic from one stray word.
    score *= 1.0 + Math.min(distinct, 12) * 0.12;
    scores.push([name, score]);
  }

  scores.sort((a, b) => b[1] - a[1]);
  const [best, bestScore] = scores[0];
  // Require a real signal, and a clear margin over the runner-up.
  if (bestScore < 6) {
    return { theme: 'Unsorted', options: scores.slice(0, topN).filter(([, s]) => s > 2).map(([n]) => n) };
  }
  const options = scores.slice(0, topN).filter(([, s]) => s >= bestScore * 0.25).map(([n]) => n);
  return { theme: best, options };
}

export function analyse(input) {
  const { kind, confidence } = classifyKind(input);
  const { theme, options } = suggestTheme(input);
  return { kind, kindConfidence: confidence, theme, themeOptions: options };
}
