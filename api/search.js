/**
 * ArixAI Live Web Search / Crawler
 * v2.3.0 — Standalone Search Engine Fusion
 *
 * Vercel Edge / dependency-free.
 * No local helper dependency or page-content extractor.
 *
 * Design goals:
 * - High-recall discovery from multiple public search surfaces.
 * - Precision-first fusion/ranking without throwing away valid candidates too early.
 * - Fast parallel requests with bounded concurrency and per-request timeouts.
 * - Optional lightweight verification of top URLs; no page-content extractor.
 * - Search snippets remain snippets; they are never mislabeled as page content.
 * - Conservative SSRF protection without over-blocking ordinary public sources.
 */

export const runtime = 'nodejs';
export const config = { runtime: 'nodejs', maxDuration: 60 };
export const maxDuration = 60;

const VERSION = 'arix-crawler-4.0.0';
const MAX_RESULTS = 40;
const DEFAULT_RESULTS = 10;
const MAX_QUERY_LEN = 1600;
const MAX_REQUEST_BODY = 100_000;
const SEARCH_BUDGET_MS = 25_000;
const SEARCH_TIMEOUT_MS = 3_800;
const VERIFY_TIMEOUT_MS = 600;
const VERIFY_HEADROOM_MS = 80;
const DISCOVERY_CUTOFF_MS = 18_000;
const SEARCH_CONCURRENCY = 18;
const VERIFY_CONCURRENCY = 16;
const MAX_ENGINE_REQUESTS = 72;
const MAX_DISCOVERY_RESULTS = 500;
const MAX_LIVE_LOG = 80;
const OUTPUT_MAX_SOURCES = 1000;
const CACHE_MAX = 120;
const CACHE_TTL_MS = 7_000;
const LIVE_CACHE_TTL_MS = 2_500;
const CACHE = new Map();
let commonCrawlIndexCache = { at: 0, ids: [] };
const COMMON_CRAWL_TIMEOUT_MS = 650;
const MAX_COMMON_CRAWL = 4;
const COMMON_CRAWL_INDEXES = []; // Resolved from Common Crawl's live collection catalogue.
const AI_RERANK_TIMEOUT_MS = 700;
const USER_AGENT = 'Mozilla/5.0 (compatible; ArixCrawler/4.0; +https://github.com/carryinsan/Arix-Crawler)';

/* Only obvious tracking / measurement surfaces are blocked. Ordinary public sites,
 * PDFs, JS documentation, forums, media pages, etc. are not blanket-blocked. */
const BLOCKED_HOSTS = new Set([
  'google-analytics.com',
  'googletagmanager.com',
  'googlesyndication.com',
  'googleadservices.com',
  'doubleclick.net',
  'scorecardresearch.com',
  'pixel.wp.com',
  'adsrvr.org',
  'amazon-adsystem.com',
  'taboola.com',
  'outbrain.com',
  'segment.io',
  'hotjar.com',
  'clarity.ms',
]);

/* Strict search-result/source blacklist. These hosts are never allowed to become
 * candidate source URLs, even after redirect/unwrapping/canonicalization. This is
 * intentionally separate from SEARCH_HOSTS so the blacklist is enforced at every
 * candidate -> verification -> final-result boundary. */
const SEARCH_SOURCE_BLACKLIST = new Set([
  'google.com',
  'google.co.in',
  'google.co.uk',
  'google.de',
  'google.fr',
  'google.ca',
  'bing.com',
  'search.brave.com',
  'yahoo.com',
  'search.yahoo.com',
  'mojeek.com',
  'duckduckgo.com',
  'html.duckduckgo.com',
  'news.google.com',
  'ecosia.org',
  'yandex.com',
  'yandex.ru',
  'qwant.com',
  'startpage.com',
  'search.aol.com',
  'ask.com',
  'baidu.com',
  'sogou.com',
  'search.naver.com',
]);

const TRACKING_PATH = /(?:^|[\/_-])(?:analytics|gtag|ga4|collect|pixel|beacon|tracking|tracker|telemetry)(?:[\/_-]|$)/i;
const SEARCH_HOSTS = new Set([...SEARCH_SOURCE_BLACKLIST, 'youtube.com', 'www.youtube.com']);

const GOV_DOMAINS = [
  'gov.in',
  'nic.in',
  'mygov.in',
  'india.gov.in',
  'pib.gov.in',
  'mca.gov.in',
  'gst.gov.in',
  'incometax.gov.in',
  'msme.gov.in',
  'education.gov.in',
  'meity.gov.in',
  'rbi.org.in',
  'sebi.gov.in',
  'supremecourt.gov.in',
  'indiacode.nic.in'
];

const TRUSTED_DOMAINS = [
  'who.int',
  'un.org',
  'europa.eu',
  'nasa.gov',
  'oecd.org',
  'worldbank.org',
  'imf.org',
  'ietf.org',
  'w3.org',
  'mozilla.org',
  'developer.mozilla.org',
  'nih.gov',
  'cdc.gov',
  'mit.edu',
  'stanford.edu',
  'harvard.edu'
];

const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'from', 'by', 'as', 'at',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'this', 'that', 'these', 'those', 'what',
  'when', 'where', 'how', 'why', 'who', 'which', 'about', 'into', 'near', 'over', 'under', 'than',
  'then', 'during', 'through', 'latest', 'current', 'recent', 'today', 'news', 'update', 'updates',
  'please', 'show', 'find', 'give', 'tell', 'me', 'can', 'you', 'i', 'we', 'it', 'its', 'their', 'our',
  'your', 'my', 'more', 'information', 'info', 'details', 'best', 'all', 'some', 'does', 'do', 'did',
  'explain', 'explained', 'need', 'want', 'using', 'use', 'from', 'vs', 'versus', 'compare', 'comparison'
]);

const SYNONYMS = [
  ['car', 'cars', 'automobile', 'automobiles', 'motorcar', 'motorcars'],
  ['history', 'historical'],
  ['india', 'indian'],
  ['price', 'prices', 'cost', 'costs', 'pricing', 'priced'],
  ['law', 'laws', 'legal', 'legislation'],
  ['policy', 'policies'],
  ['programme', 'program', 'programs'],
  ['company', 'companies', 'corporation', 'corporations', 'firm', 'firms'],
  ['population', 'populations'],
  ['people', 'residents', 'inhabitants'],
  ['economy', 'economic', 'economics'],
  ['market', 'markets'],
  ['education', 'educational'],
  ['school', 'schools'],
  ['student', 'students'],
  ['research', 'researches'],
  ['study', 'studies'],
  ['paper', 'papers'],
  ['report', 'reports'],
  ['technology', 'technologies', 'tech'],
  ['electric', 'electrical'],
  ['manufacturing', 'manufacture'],
  ['factory', 'factories'],
  ['guide', 'guides', 'tutorial', 'tutorials', 'manual'],
  ['documentation', 'docs'],
  ['ai', 'artificial-intelligence'],
];

const SYNONYM_MAP = new Map();
for (const group of SYNONYMS) {
  for (const term of group) {
    SYNONYM_MAP.set(term, group[0]);
  }
}

function nowIso() {
  return new Date().toISOString();
}

function left(deadline) {
  return Math.max(0, deadline - Date.now());
}

function clamp(v, min, max) {
  return Math.min(max, Math.max(min, Number(v) || 0));
}

function truncate(v, max) {
  const s = String(v ?? '').trim();
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

function encode(v) {
  return JSON.stringify(v);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function env(name) {
  try {
    return typeof process !== 'undefined' ? String(process.env?.[name] || '').trim() : '';
  } catch {
    return '';
  }
}

function safeInt(v, fallback, min, max) {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? clamp(n, min, max) : fallback;
}

function unique(arr) {
  return [...new Set((arr || []).filter(Boolean))];
}

function normalizeText(v) {
  return String(v || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function rawTokens(v) {
  return normalizeText(v).split(' ').filter(Boolean);
}

function canonicalToken(v) {
  // Ranking normalization only. Never expand, replace or rewrite the agent query.
  return String(v || '').toLowerCase();
}

function stem(x) {
  let t = String(x || '').toLowerCase();
  if (t.length <= 4) return t;
  t = t.replace(/(ings|ies|ied)$/i, (m) => (m[0].toLowerCase() === 'i' ? 'y' : ''));
  t = t.replace(/(ing|ed|es)$/i, '');
  if (t.endsWith('s') && !t.endsWith('ss')) t = t.slice(0, -1);
  return t;
}

function contentTokens(v) {
  return rawTokens(v)
    .filter((x) => x.length > 1 && !STOPWORDS.has(x))
    .map((x) => canonicalToken(x));
}

function tokenSet(v) {
  return new Set(contentTokens(v));
}

function normalizeHost(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

function safeUrl(url) {
  try {
    const u = new URL(String(url));
    if (!/^https?:$/i.test(u.protocol)) return false;
    const h = u.hostname.toLowerCase();
    if (!h || h === 'localhost' || h.endsWith('.localhost')) return false;
    if (/^(127\.|10\.|192\.168\.|169\.254\.)/.test(h)) return false;
    if (/^172\.(?:1[6-9]|2\d|3[0-1])\./.test(h)) return false;
    if (h === '::1' || h.startsWith('fc') || h.startsWith('fd')) return false;
    return true;
  } catch {
    return false;
  }
}

function blocked(url) {
  if (!safeUrl(url)) return true;
  const h = normalizeHost(url);
  if ([...BLOCKED_HOSTS].some((x) => h === x || h.endsWith(`.${x}`))) return true;
  if ([...SEARCH_SOURCE_BLACKLIST].some((x) => h === x || h.endsWith(`.${x}`))) return true;
  try {
    const u = new URL(url);
    const raw = `${u.href} ${decodeUri(u.href)}`;
    if (/(?:^|[/:.?=&_-])(?:www\.)?(?:google\.com|bing\.com|search\.brave\.com|yahoo\.com|mojeek\.com)(?:[/:?#=&_-]|$)/i.test(raw)) {
      return true;
    }
    return TRACKING_PATH.test(u.pathname);
  } catch {
    return true;
  }
}

function isGov(url) {
  const h = normalizeHost(url);
  return GOV_DOMAINS.some((d) => h === d || h.endsWith(`.${d}`));
}

function isTrusted(url) {
  const h = normalizeHost(url);
  return (
    TRUSTED_DOMAINS.some((d) => h === d || h.endsWith(`.${d}`)) ||
    /\.edu(?:\.|$)/i.test(h) ||
    /\.ac\.(?:in|uk|jp|nz)$/i.test(h)
  );
}

function isYouTube(url) {
  const h = normalizeHost(url);
  return h === 'youtube.com' || h.endsWith('.youtube.com') || h === 'youtu.be';
}

function isVideo(url) {
  return isYouTube(url) || /(?:vimeo\.com|dailymotion\.com)$/i.test(normalizeHost(url));
}

function isDoc(url) {
  return /\.(?:pdf|docx?|xlsx?|pptx?|csv|txt)(?:[?#]|$)/i.test(String(url || ''));
}

function isLikelySearchUrl(url) {
  const h = normalizeHost(url);
  try {
    const u = new URL(url);
    if (h === 'youtube.com' || h === 'www.youtube.com') {
      return !/^\/watch(?:$|\?)/i.test(u.pathname + u.search);
    }
    if (h === 'youtu.be') return false;
    return (
      SEARCH_HOSTS.has(h) &&
      (/\/search|\/url|\/ck\/a|\/l\/?|\/results/i.test(u.pathname + '?' + u.search) || h === 'news.google.com')
    );
  } catch {
    return false;
  }
}

function normalizedUrl(url) {
  try {
    const u = new URL(String(url));
    u.hash = '';
    for (const k of [...u.searchParams.keys()]) {
      if (/^(utm_|fbclid$|gclid$|dclid$|msclkid$|ref$|referrer$|cmpid$|src$|trk$|tracking)/i.test(k)) {
        u.searchParams.delete(k);
      }
    }
    return u.href;
  } catch {
    return '';
  }
}

function normalizedKey(url) {
  const u = normalizedUrl(url);
  if (!u) return '';
  try {
    const x = new URL(u);
    return `${x.hostname.toLowerCase().replace(/^www\./, '')}${x.pathname.replace(/\/+/g, '/').replace(/\/$/, '')}${x.search}`;
  } catch {
    return u.toLowerCase();
  }
}

function absoluteUrl(raw, base) {
  try {
    return new URL(String(raw || ''), base).href;
  } catch {
    return null;
  }
}

function decodeUri(v) {
  try {
    return decodeURIComponent(String(v || ''));
  } catch {
    return String(v || '');
  }
}

function unwrap(raw, base) {
  let current = absoluteUrl(raw, base);
  if (!current) return null;
  for (let depth = 0; depth < 5; depth++) {
    let u;
    try {
      u = new URL(current);
    } catch {
      return null;
    }
    const h = normalizeHost(u.href);
    let next = null;
    if (h === 'bing.com' && /^\/ck\/a/i.test(u.pathname)) {
      const val = u.searchParams.get('u') || u.searchParams.get('url') || u.searchParams.get('target');
      if (val) {
        const decoded = decodeUri(val);
        if (/^https?:\/\//i.test(decoded)) next = decoded;
        if (!next) {
          try {
            let s = val.replace(/-/g, '+').replace(/_/g, '/');
            while (s.length % 4) s += '=';
            const bin = atob(s);
            let decoded2 = '';
            for (let i = 0; i < bin.length; i++) decoded2 += String.fromCharCode(bin.charCodeAt(i));
            const t = new TextDecoder().decode(new Uint8Array([...decoded2].map((c) => c.charCodeAt(0))));
            if (/^https?:\/\//i.test(t)) next = t;
          } catch {}
        }
      }
    }
    if (!next && /^google\.[^./]+(?:\.[^./]+)?$/i.test(h) && /^\/url$/i.test(u.pathname)) {
      next = u.searchParams.get('url') || u.searchParams.get('q');
    }
    if (!next && (h === 'duckduckgo.com' || h === 'html.duckduckgo.com') && /^\/l\/?$/i.test(u.pathname)) {
      next = u.searchParams.get('uddg') || u.searchParams.get('u');
    }
    if (!next && h === 'search.yahoo.com') {
      const ru = u.pathname.match(/\/RU=([^/]+)/i)?.[1];
      next = ru || u.searchParams.get('RU') || u.searchParams.get('url');
    }
    if (!next) break;
    const clean = absoluteUrl(decodeUri(next), current);
    if (!clean || clean === current) break;
    current = clean;
  }
  return normalizedUrl(current);
}

function stripTags(html) {
  return String(html || '')
    .replace(/<!--(?:[\s\S]*?)-->/g, ' ')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#x([0-9a-f]+);?/gi, (_, x) => {
      const n = parseInt(x, 16);
      return Number.isFinite(n) ? String.fromCodePoint(Math.min(n, 0x10ffff)) : ' ';
    })
    .replace(/&#(\d+);?/g, (_, x) => {
      const n = parseInt(x, 10);
      return Number.isFinite(n) ? String.fromCodePoint(Math.min(n, 0x10ffff)) : ' ';
    })
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanSnippet(v) {
  return truncate(stripTags(v).replace(/\s+/g, ' ').trim(), 3000);
}

function titleFromHtml(html) {
  return cleanSnippet((String(html).match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [, ''])[1]);
}

function metaFromHtml(html, name) {
  const e = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const a = String(html).match(new RegExp(`<meta[^>]+(?:name|property|itemprop)=["']${e}["'][^>]*content=["']([\\s\\S]*?)["']`, 'i'));
  const b = String(html).match(new RegExp(`<meta[^>]+content=["']([\\s\\S]*?)["'][^>]+(?:name|property|itemprop)=["']${e}["']`, 'i'));
  return cleanSnippet((a || b || [, ''])[1] || '');
}

function dateFromHtml(html) {
  const vals = [
    metaFromHtml(html, 'article:published_time'),
    metaFromHtml(html, 'datePublished'),
    metaFromHtml(html, 'dateModified'),
    metaFromHtml(html, 'date'),
    (String(html).match(/<time[^>]+datetime=["']([^"']+)["']/i) || [])[1]
  ];
  for (const v of vals) {
    const t = Date.parse(v || '');
    if (!Number.isNaN(t)) return new Date(t).toISOString();
  }
  return null;
}

function parseMaybeDateFromText(v) {
  const s = String(v || '');
  const candidates =
    s.match(
      /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2}(?:,\s*|\s+)\d{4}\b|\b20\d{2}-\d{1,2}-\d{1,2}\b/gi
    ) || [];
  for (const c of candidates) {
    const t = Date.parse(c);
    if (!Number.isNaN(t)) return new Date(t).toISOString();
  }
  return null;
}

const QUERY_FILLERS = new Set([
  'available', 'allow', 'allows', 'allowed', 'also', 'answer', 'answers', 'around', 'based', 'can', 'could',
  'details', 'different', 'does', 'explain', 'explained', 'focus', 'give', 'help', 'important', 'include',
  'including', 'just', 'kind', 'kinds', 'known', 'look', 'looking', 'make', 'need', 'needs', 'provide', 'really',
  'should', 'show', 'specific', 'tell', 'things', 'ways', 'well', 'would', 'which', 'what', 'when', 'where', 'who',
  'why', 'how', 'latest', 'current', 'recent', 'today', 'tomorrow', 'yesterday', 'please', 'find', 'search', 'information',
  'information-on', 'information-about', 'details-on', 'details-about', 'using', 'use', 'used', 'want', 'would-like'
]);

function extractQuotedPhrases(q) {
  const out = [];
  for (const m of String(q || '').matchAll(/["“”]([^"“”]{4,180})["“”]/g)) {
    const x = normalizeText(m[1]);
    if (x) out.push(x);
  }
  return unique(out);
}

function selectCoreTerms(q, allTerms, anchors) {
  const quoted = extractQuotedPhrases(q);
  const filtered = allTerms.filter((t) => !QUERY_FILLERS.has(t));
  if (filtered.length <= 10) return unique([...quoted.flatMap(rawTokens), ...filtered]).slice(0, 12);
  const anchorSet = new Set((anchors || []).map(normalizeText));
  const scored = filtered
    .map((term, idx) => {
      let score = 0;
      if (anchorSet.has(term) || anchorSet.has(stem(term))) score += 5;
      if (/^20\d{2}$|^\d{4,}$/.test(term)) score += 4;
      if (term.length >= 9) score += 2.5;
      else if (term.length >= 6) score += 1.5;
      if (idx < 5) score += 1.0;
      if (SYNONYM_MAP.has(term)) score += 0.5;
      return { term, score, idx };
    })
    .sort((a, b) => b.score - a.score || a.idx - b.idx);
  const chosen = scored.slice(0, 10).sort((a, b) => a.idx - b.idx).map((x) => x.term);
  return unique([...quoted.flatMap(rawTokens), ...chosen]).slice(0, 12);
}

function queryPlan(query, options = {}) {
  // The crawler is a retrieval engine, not a query-understanding agent.
  // Preserve the exact input query string and use tokens only as local ranking features.
  const q = String(query ?? '');
  const requested = String(options.type || '').toLowerCase();
  const allowedTypes = new Set(['web', 'news', 'video', 'gov', 'doc', 'academic', 'mixed', 'all']);
  const type = allowedTypes.has(requested) && requested !== 'mixed' && requested !== 'all' ? requested : 'web';
  const mode = String(options.mode || 'balanced').toLowerCase();
  const terms = unique(contentTokens(q));
  const quotedPhrases = extractQuotedPhrases(q);
  const flags = {
    live: false,
    history: false,
    official: false,
    academic: type === 'academic',
    explicitNews: type === 'news',
    explicitVideo: type === 'video',
    explicitDoc: type === 'doc',
    explicitGov: type === 'gov'
  };
  return {
    query: q,
    type,
    requestedType: requested,
    mode,
    terms,
    coreTerms: terms,
    coreQuery: q,
    quotedPhrases,
    exactish: q,
    anchors: [],
    longQuery: q.length > 520,
    flags,
    agentQueries: Array.isArray(options.agentQueries) ? options.agentQueries : [q]
  };
}

function buildQueries(query, plan) {
  // Exact preservation is a core API invariant. No expansion or decomposition.
  return (plan.agentQueries || [query]).filter((q) => typeof q === 'string' && q.length > 0).slice(0, 8);
}

function typeFromUrl(url, fallback = 'web') {
  if (isGov(url)) return 'gov';
  if (isDoc(url)) return 'doc';
  if (isVideo(url)) return 'video';
  return fallback || 'web';
}

function typeFits(item, plan) {
  if (plan.type === 'gov') return isGov(item.url) || item.type === 'gov';
  if (plan.type === 'doc') return isDoc(item.url) || item.type === 'doc';
  if (plan.type === 'video') return isVideo(item.url) || item.type === 'video';
  if (plan.type === 'news') return item.type === 'news' || /\/(?:news|article|story|stories|post|press[-_]?release)\b/i.test(item.url || '');
  return true;
}

function makeCandidate(url, title, snippet, provider, type, extra = {}) {
  const clean = unwrap(url, extra.base || 'https://example.com/');
  if (!clean || blocked(clean) || isLikelySearchUrl(clean)) return null;
  const t = typeFromUrl(clean, type || 'web');
  const result = {
    title: truncate(cleanSnippet(title), 500) || truncate(cleanSnippet(new URL(clean).hostname), 300),
    url: clean,
    snippet: cleanSnippet(snippet || ''),
    source: provider,
    type: t,
    providerRank: Number(extra.providerRank || 0),
    providerRanks: { [provider]: Number(extra.providerRank || 0) },
    queryVariant: Number(extra.queryVariant || 0),
    publishedAt: extra.publishedAt || parseMaybeDateFromText(`${title} ${snippet}`),
    searchWrapperResolved: Boolean(extra.searchWrapperResolved),
  };
  delete extra.base;
  delete extra.providerRank;
  delete extra.queryVariant;
  delete extra.publishedAt;
  delete extra.searchWrapperResolved;
  Object.assign(result, extra);
  if (!result.title || result.title.length < 2) return null;
  return result;
}

function decodeEntities(v = '') {
  return String(v)
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#x([0-9a-f]+);?/gi, (_, x) => {
      const n = parseInt(x, 16);
      return Number.isFinite(n) ? String.fromCodePoint(Math.min(0x10ffff, n)) : ' ';
    })
    .replace(/&#(\d+);?/g, (_, x) => {
      const n = parseInt(x, 10);
      return Number.isFinite(n) ? String.fromCodePoint(Math.min(0x10ffff, n)) : ' ';
    });
}

function searchTitle(v) {
  const t = cleanSnippet(decodeEntities(v || '')).replace(/\s+/g, ' ').trim();
  if (!t || t.length < 2 || /^(images?|videos?|maps?|news|shopping|settings|sign in|log in|menu|more|next|previous|feedback|tools)$/i.test(t)) {
    return '';
  }
  return truncate(t, 500);
}

function hasSearchNoiseTitle(v) {
  const t = normalizeText(v);
  return !t || /^(sponsored|ad|advertisement|ads|sign in|log in|privacy|terms|cookie|feedback|more results|related searches|people also ask|images|videos|maps|shopping|news)$/.test(t);
}

function resultContext(html, index, width = 2500) {
  const s = String(html || '');
  return s.slice(Math.max(0, index - Math.floor(width * 0.35)), Math.min(s.length, index + width));
}

function nearbySnippet(html, index) {
  const w = resultContext(html, index, 2600).replace(/<(script|style|noscript|svg|template|form)\b[\s\S]*?<\/\1>/gi, ' ');
  return cleanSnippet(stripTags(w));
}

function scoreSearchAnchor(url, title, context, provider) {
  let score = 0;
  const h = normalizeHost(url);
  const t = normalizeText(title);
  const c = normalizeText(context);

  if (!safeUrl(url) || blocked(url) || isLikelySearchUrl(url)) return -999;
  if (hasSearchNoiseTitle(title)) return -999;
  if (title.length >= 12) score += 8;
  if (title.length >= 30) score += 5;
  if (title.length <= 180) score += 3;
  else score -= 4;

  if (/\b(home|homepage|about us|contact us|careers|login|sign in|privacy policy|terms of service)\b/i.test(title)) score -= 8;
  if (/\b(sponsored|advertisement|ad)\b/i.test(title)) score -= 18;
  if (new URL(url).pathname && new URL(url).pathname !== '/') score += 3;
  if (/\b(?:result|organic|web-result|b_algo|MjjYud|result__a|algo|search-result)\b/i.test(context)) score += 12;
  if (/<(?:h1|h2|h3|h4)\b/i.test(context)) score += 8;
  if (/\b(?:sponsored|advertisement|ads by)\b/i.test(c)) score -= 20;

  if (provider === 'bing' && /b_algo/i.test(context)) score += 12;
 if (provider === 'google' && /MjjYud|g\.h3|<h3/i.test(context)) score += 8;
 if (provider === 'brave' && /snippet|result|fdb/i.test(context)) score += 11;

  if (isGov(url)) score += 4;
  if (isTrusted(url)) score += 3;
  if (/\.(pdf|docx?|xlsx?|pptx?)$/i.test(new URL(url).pathname)) score += 2;
  if (h === 'youtube.com' || h === 'youtu.be') score += 2;

  return score;
}

function extractAnchors(html, base, provider, req, cap = 80) {
  const out = [];
  const s = String(html || '');
  const seen = new Set();
  const re = /<a\b([^>]*?)\bhref\s*=\s*(["'])([\s\S]*?)\2([^>]*)>([\s\S]*?)<\/a\s*>/gi;
  let m;
  while ((m = re.exec(s)) && out.length < cap * 4) {
    const raw = decodeEntities(m[3]).trim();
    const url = unwrap(raw, base);
    if (!url || blocked(url) || isLikelySearchUrl(url)) continue;
    const title = searchTitle(m[5]);
    if (!title) continue;
    const context = resultContext(s, m.index || 0, 3000);
    const score = scoreSearchAnchor(url, title, context, provider);
    if (score < 2) continue;
    const key = normalizedKey(url);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({
      candidate: makeCandidate(url, title, nearbySnippet(s, m.index || 0), provider, req.type, {
        base,
        providerRank: out.length + 1,
        queryVariant: req.queryVariant,
        searchWrapperResolved: true
      }),
      score
    });
  }
  out.sort((a, b) => b.score - a.score);
  return out.filter((x) => x.candidate).slice(0, cap).map((x) => x.candidate);
}

function extractHeadingAnchors(html, base, provider, req, heading = 'h3', cap = 40) {
  const s = String(html || '');
  const out = [];
  const seen = new Set();
  const re = new RegExp(`<${heading}\\b[^>]*>([\\s\\S]*?)<\\/${heading}\\s*>`, 'gi');
  let m;
  while ((m = re.exec(s)) && out.length < cap) {
    const idx = m.index || 0;
    const before = s.slice(Math.max(0, idx - 1600), idx);
    const after = s.slice(idx, Math.min(s.length, idx + 1600));
    const around = `${before}${after}`;
    const links = [];
    for (const lm of around.matchAll(/<a\b[^>]*\bhref\s*=\s*(["'])([\s\S]*?)\1[^>]*>/gi)) {
      links.push(lm[2]);
    }
    for (const raw of links.reverse()) {
      const url = unwrap(decodeEntities(raw), base);
      if (!url || blocked(url) || isLikelySearchUrl(url)) continue;
      const title = searchTitle(m[1]);
      if (!title) continue;
      const key = normalizedKey(url);
      if (!key || seen.has(key)) continue;
      const score = scoreSearchAnchor(url, title, around, provider) + 12;
      if (score < 8) continue;
      seen.add(key);
      const c = makeCandidate(url, title, nearbySnippet(s, idx), provider, req.type, {
        base,
        providerRank: out.length + 1,
        queryVariant: req.queryVariant,
        searchWrapperResolved: true
      });
      if (c) {
        out.push(c);
        break;
      }
    }
  }
  return out;
}

function extractEmbeddedResults(html, base, provider, req, cap = 40) {
  const s = String(html || '');
  const out = [];
  const seen = new Set();
  const patterns = [
    /"(?:url|link|targetUrl|resultUrl)"\s*:\s*"(https?:\/\/[^"]+)"/gi,
    /(?:url|href)=["'](https?:\/\/[^"']+)["']/gi
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(s)) && out.length < cap) {
      const url = unwrap(m[1].replace(/\\\//g, '/'), base);
      if (!url || blocked(url) || isLikelySearchUrl(url)) continue;
      const key = normalizedKey(url);
      if (!key || seen.has(key)) continue;
      const idx = m.index || 0;
      const window = resultContext(s, idx, 1800);
      const textMatches = [];
      for (const tm of window.matchAll(/"(?:title|name|text|displayName)"\s*:\s*"((?:\\.|[^"\\]){5,280})"/gi)) {
        textMatches.push(tm[1]);
      }
      const title = searchTitle(textMatches[0] || stripTags(window).slice(0, 240) || normalizeHost(url));
      if (!title) continue;
      const score = scoreSearchAnchor(url, title, window, provider);
      if (score < 2) continue;
      const c = makeCandidate(url, title, nearbySnippet(s, idx), provider, req.type, {
        base,
        providerRank: out.length + 1,
        queryVariant: req.queryVariant,
        searchWrapperResolved: true
      });
      if (c) {
        seen.add(key);
        out.push(c);
      }
    }
  }
  return out;
}

function parseRssSearch(text, req, provider = req.provider) {
  const out = [];
  const items = String(text || '').match(/<item\b[\s\S]*?<\/item\s*>/gi) || [];
  for (let i = 0; i < items.length && out.length < 80; i++) {
    const item = items[i];
    const title = searchTitle((item.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [, ''])[1]);
    const link = decodeEntities((item.match(/<link[^>]*>([\s\S]*?)<\/link>/i) || [, ''])[1]);
    const desc = cleanSnippet((item.match(/<(?:description|content:encoded)[^>]*>([\s\S]*?)<\/(?:description|content:encoded)>/i) || [, ''])[1]);
    const pub = decodeEntities((item.match(/<(?:pubDate|published|updated)[^>]*>([\s\S]*?)<\/(?:pubDate|published|updated)>/i) || [, ''])[1]);
    const c = makeCandidate(link, title, desc, provider, req.type, {
      publishedAt: safeDate(pub),
      providerRank: out.length + 1,
      queryVariant: req.queryVariant
    });
    if (c) out.push(c);
  }
  return out;
}

function parseBing(html, req) {
  const s = String(html || '');
  const primary = [];
  for (const block of s.match(/<li[^>]+class=["'][^"']*b_algo[^"']*["'][\s\S]*?<\/li>/gi) || []) {
    const m = block.match(/<a\b[^>]*href\s*=\s*(["'])([\s\S]*?)\1[^>]*>([\s\S]*?)<\/a\s*>/i);
    if (!m) continue;
    const t = searchTitle(m[3]);
    const c = makeCandidate(m[2], t, (block.match(/<p[^>]*>([\s\S]*?)<\/p>/i) || [, ''])[1], 'bing', req.type, {
      base: 'https://www.bing.com/',
      providerRank: primary.length + 1,
      queryVariant: req.queryVariant,
      searchWrapperResolved: true
    });
    if (c) primary.push(c);
  }
  return primary.length >= 3
    ? primary.slice(0, 40)
    : [
        ...primary,
        ...extractHeadingAnchors(s, 'https://www.bing.com/', 'bing', req, 'h2', 40),
        ...extractAnchors(s, 'https://www.bing.com/', 'bing', req, 40),
        ...extractEmbeddedResults(s, 'https://www.bing.com/', 'bing', req, 20)
      ]
        .filter((v, i, a) => a.findIndex((x) => normalizedKey(x.url) === normalizedKey(v.url)) === i)
        .slice(0, 40);
}

function parseGoogle(html, req, source = 'google') {
  const s = String(html || '');
  const primary = extractHeadingAnchors(s, 'https://www.google.com/', source, req, 'h3', 40);
  if (primary.length >= 3) return primary;
  const generic = extractAnchors(s, 'https://www.google.com/', source, req, 40);
  const embedded = extractEmbeddedResults(s, 'https://www.google.com/', source, req, 30);
  return [...primary, ...generic, ...embedded]
    .filter((v, i, a) => a.findIndex((x) => normalizedKey(x.url) === normalizedKey(v.url)) === i)
    .slice(0, 40);
}


function parseGoogleNews(xml, req) {
  return parseRssSearch(xml, req, 'google-news');
}

function parseYoutube(html, req) {
  const out = [];
  const seen = new Set();
  const s = String(html || '');
  for (const m of s.matchAll(/"videoRenderer"\s*:\s*\{[\s\S]*?"videoId"\s*:\s*"([A-Za-z0-9_-]{6,20})"[\s\S]*?"title"\s*:\s*\{\s*"runs"\s*:\s*\[\s*\{\s*"text"\s*:\s*"((?:\\.|[^"\\])*)"/g)) {
    const id = m[1];
    if (seen.has(id)) continue;
    seen.add(id);
    const title = searchTitle(m[2].replace(/\\"/g, '"').replace(/\\\\/g, '\\')) || `YouTube video ${id}`;
    const c = makeCandidate(`https://www.youtube.com/watch?v=${id}`, title, 'YouTube result', 'youtube', 'video', {
      providerRank: out.length + 1,
      queryVariant: req.queryVariant
    });
    if (c) out.push(c);
    if (out.length >= 40) break;
  }
  if (out.length < 3) {
    for (const m of s.matchAll(/"videoId"\s*:\s*"([A-Za-z0-9_-]{6,20})"/g)) {
      const id = m[1];
      if (seen.has(id)) continue;
      seen.add(id);
      const c = makeCandidate(`https://www.youtube.com/watch?v=${id}`, `YouTube video ${id}`, 'YouTube result', 'youtube', 'video', {
        providerRank: out.length + 1,
        queryVariant: req.queryVariant
      });
      if (c) out.push(c);
      if (out.length >= 40) break;
    }
  }
  return out;
}

function parseBrave(html, req) {
  const s = String(html || '');
  const a = extractHeadingAnchors(s, 'https://search.brave.com/', 'brave', req, 'h2', 40);
  const b = extractHeadingAnchors(s, 'https://search.brave.com/', 'brave', req, 'h3', 40);
  const c = extractAnchors(s, 'https://search.brave.com/', 'brave', req, 40);
  return [...a, ...b, ...c]
    .filter((v, i, arr) => arr.findIndex((x) => normalizedKey(x.url) === normalizedKey(v.url)) === i)
    .slice(0, 40);
}

function safeDate(value) {
  const t = Date.parse(String(value || ''));
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

function freshness(publishedAt) {
  if (!publishedAt) return 'unknown';
  const t = Date.parse(publishedAt);
  if (Number.isNaN(t)) return 'unknown';
  const age = Math.max(0, (Date.now() - t) / 86400000);
  if (age <= 1) return 'last_24h';
  if (age <= 7) return 'last_7d';
  if (age <= 30) return 'last_30d';
  if (age <= 90) return 'last_90d';
  if (age <= 365) return 'last_year';
  return 'older';
}

function providerRequests(queries, plan, deep, input = {}) {
  const out = [];
  const seen = new Set();
  const add = (provider, q, type, url, queryVariant, page = 1) => {
    if (out.length >= MAX_ENGINE_REQUESTS || !url) return;
    const key = `${provider}|${url}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ provider, query: q, type, url, queryVariant, page });
  };

  const mode = String(input.mode || plan.mode || 'balanced').toLowerCase();
  const pages = mode === 'quick' ? 1 : mode === 'deep' ? 4 : mode === 'maximum' ? 6 : 2;
  const providerInput = Array.isArray(input.providers) ? input.providers : ['google', 'bing', 'brave'];
  const sourceInput = Array.isArray(input.sources) ? input.sources : [];
  const providers = new Set(providerInput.map((x) => String(x).toLowerCase()));
  for (const source of sourceInput) providers.add(String(source).toLowerCase());
  if (plan.type === 'news') providers.add('google-news');
  if (plan.type === 'video') providers.add('youtube');
  if (plan.type === 'academic') for (const x of ['openalex', 'crossref', 'europepmc', 'arxiv']) providers.add(x);

  const lang = String(input.language || '').trim();
  const country = String(input.country || '').trim();
  const qList = queries.slice(0, 8);
  for (let qi = 0; qi < qList.length; qi++) {
    const q = qList[qi]; // Exact agent-supplied string is encoded, not rewritten.
    const e = encodeURIComponent(q);
    if (providers.has('google')) {
      for (let page = 0; page < pages; page++) {
        const params = new URLSearchParams({ gbv: '1', q, num: '20', start: String(page * 10), filter: '0' });
        if (lang) params.set('hl', lang);
        if (country) params.set('gl', country.toLowerCase());
        add('google', q, plan.type === 'news' ? 'news' : 'web', `https://www.google.com/search?${params.toString()}`, qi, page + 1);
      }
    }
    if (providers.has('bing')) {
      for (let page = 0; page < pages; page++) {
        const params = new URLSearchParams({ q, count: '10', first: String(page * 10) });
        if (lang) params.set('setlang', lang);
        if (country) params.set('cc', country.toLowerCase());
        add('bing', q, plan.type === 'news' ? 'news' : 'web', `https://www.bing.com/search?${params.toString()}`, qi, page + 1);
      }
      add('bing-rss', q, plan.type === 'news' ? 'news' : 'web', `https://www.bing.com/search?format=rss&q=${e}`, qi, 1);
    }
    if (providers.has('brave')) {
      for (let page = 0; page < Math.min(pages, 3); page++) {
        const params = new URLSearchParams({ q, source: 'web', page: String(page + 1) });
        add('brave', q, plan.type === 'news' ? 'news' : 'web', `https://search.brave.com/search?${params.toString()}`, qi, page + 1);
      }
    }
    if (providers.has('google-news')) {
      const params = new URLSearchParams({ q, hl: lang || 'en-US', gl: country || 'US', ceid: `${country || 'US'}:${lang || 'en'}` });
      add('google-news', q, 'news', `https://news.google.com/rss/search?${params.toString()}`, qi, 1);
    }
    if (providers.has('youtube') && plan.type === 'video') {
      const params = new URLSearchParams({ search_query: q, hl: lang || 'en' });
      add('youtube', q, 'video', `https://www.youtube.com/results?${params.toString()}`, qi, 1);
    }
    const apiRows = safeInt(input.apiResultsPerSource, 10, 1, 50);
    if (providers.has('openalex')) {
      const params = new URLSearchParams({ search: q, 'per-page': String(apiRows), select: 'id,doi,title,publication_year,authorships,primary_location,open_access' });
      add('openalex', q, 'academic', `https://api.openalex.org/works?${params.toString()}`, qi, 1);
    }
    if (providers.has('crossref')) {
      const params = new URLSearchParams({ query: q, rows: String(apiRows), select: 'DOI,title,URL,published,author,container-title,type,abstract' });
      add('crossref', q, 'academic', `https://api.crossref.org/works?${params.toString()}`, qi, 1);
    }
    if (providers.has('europepmc') || providers.has('pubmed')) {
      const params = new URLSearchParams({ query: q, format: 'json', pageSize: String(apiRows), resultType: 'core' });
      add('europepmc', q, 'academic', `https://www.ebi.ac.uk/europepmc/webservices/rest/search?${params.toString()}`, qi, 1);
    }
    if (providers.has('arxiv')) {
      const params = new URLSearchParams({ search_query: `all:${q}`, start: '0', max_results: String(apiRows), sortBy: 'relevance', sortOrder: 'descending' });
      add('arxiv', q, 'academic', `https://export.arxiv.org/api/query?${params.toString()}`, qi, 1);
    }
  }
  return out;
}

function xmlText(value) {
  return decodeEntities(String(value || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
}

function abstractFromOpenAlex(inverted) {
  if (!inverted || typeof inverted !== 'object') return '';
  const ordered = [];
  for (const [word, positions] of Object.entries(inverted)) {
    for (const pos of positions || []) ordered[pos] = word;
  }
  return ordered.filter(Boolean).join(' ');
}

function parseApiResults(provider, body, req) {
  const out = [];
  try {
    if (provider === 'arxiv') {
      const entries = [...body.matchAll(/<entry>([\s\S]*?)<\/entry>/gi)].slice(0, 50);
      for (const [i, m] of entries.entries()) {
        const block = m[1];
        const title = xmlText((block.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [,''])[1]);
        const summary = xmlText((block.match(/<summary[^>]*>([\s\S]*?)<\/summary>/i) || [,''])[1]);
        const url = (block.match(/<id[^>]*>([\s\S]*?)<\/id>/i) || [,''])[1].trim();
        const publishedAt = (block.match(/<published[^>]*>([^<]+)</i) || [,''])[1] || null;
        const authors = [...block.matchAll(/<author>\s*<name>([^<]+)<\/name>/gi)].map((x) => xmlText(x[1])).join(', ');
        const c = makeCandidate(url, title, summary, provider, 'academic', { providerRank: i + 1, publishedAt, author: authors || null, contentType: 'application/atom+xml' });
        if (c) out.push(c);
      }
      return out;
    }
    const data = JSON.parse(body);
    if (provider === 'openalex') {
      for (const [i, item] of (data.results || []).entries()) {
        const url = item.primary_location?.landing_page_url || item.doi || item.id;
        const title = item.title || 'Untitled scholarly work';
        const abstract = abstractFromOpenAlex(item.abstract_inverted_index);
        const authors = (item.authorships || []).slice(0, 8).map((a) => a.author?.display_name).filter(Boolean).join(', ');
        const c = makeCandidate(url, title, abstract || `Academic work published ${item.publication_year || 'date unavailable'}. Authors: ${authors}`, provider, 'academic', { providerRank: i + 1, publishedAt: item.publication_year ? `${item.publication_year}-01-01` : null, author: authors || null, doi: item.doi || null, openAccess: item.open_access?.is_oa ?? null });
        if (c) out.push(c);
      }
    } else if (provider === 'crossref') {
      for (const [i, item] of (data.message?.items || []).entries()) {
        const title = item.title?.[0] || 'Untitled Crossref record';
        const url = item.URL || (item.DOI ? `https://doi.org/${item.DOI}` : null);
        const date = item.published?.['date-parts']?.[0];
        const publishedAt = Array.isArray(date) ? date.map((v, j) => String(v).padStart(j ? 2 : 4, '0')).join('-') : null;
        const author = (item.author || []).slice(0, 8).map((a) => [a.given, a.family].filter(Boolean).join(' ')).join(', ');
        const c = makeCandidate(url, title, xmlText(item.abstract || '') || `${item['container-title']?.[0] || ''} ${author}`, provider, 'academic', { providerRank: i + 1, publishedAt, author: author || null, doi: item.DOI || null, publication: item['container-title']?.[0] || null });
        if (c) out.push(c);
      }
    } else if (provider === 'europepmc') {
      for (const [i, item] of (data.resultList?.result || []).entries()) {
        const url = item.doi ? `https://doi.org/${item.doi}` : item.pmcid ? `https://europepmc.org/articles/${item.pmcid}` : item.pmid ? `https://europepmc.org/article/MED/${item.pmid}` : null;
        const c = makeCandidate(url, item.title || 'Untitled Europe PMC record', item.abstractText || item.authorString || '', provider, 'academic', { providerRank: i + 1, publishedAt: item.firstPublicationDate || null, author: item.authorString || null, doi: item.doi || null, pmid: item.pmid || null, pmcid: item.pmcid || null, publication: item.journalTitle || null });
        if (c) out.push(c);
      }
    }
  } catch (error) {
    throw new Error(`INVALID_${provider.toUpperCase()}_RESPONSE`);
  }
  return out;
}

async function fetchWithTimeout(url, timeout, deadline, headers = {}) {
  const budget = Math.min(timeout, Math.max(250, left(deadline) - VERIFY_HEADROOM_MS));
  if (budget <= 0) throw new Error('BUDGET_EXHAUSTED');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), budget);
  try {
    return await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'user-agent': USER_AGENT,
        accept: 'text/html,application/xhtml+xml,application/xml,application/rss+xml,text/plain;q=0.9,application/pdf;q=0.8,*/*;q=0.1',
        'accept-language': 'en-IN,en;q=0.9',
        ...headers
      }
    });
  } finally {
    clearTimeout(timer);
  }
}

async function readLimited(res, maxBytes, deadline) {
  const reader = res.body?.getReader?.();
  if (!reader) return truncate(await res.text(), maxBytes);
  const chunks = [];
  let total = 0;
  try {
    while (left(deadline) > 50 && total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      const room = maxBytes - total;
      const c = value.byteLength > room ? value.slice(0, room) : value;
      chunks.push(c);
      total += c.byteLength;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {}
  }
  const bytes = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    bytes.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

async function fetchSearch(req, deadline) {
  const res = await fetchWithTimeout(req.url, SEARCH_TIMEOUT_MS, deadline, {
    accept:
      req.provider === 'google-news'
        ? 'application/rss+xml,application/xml,text/xml;q=0.9,*/*;q=0.1'
        : 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1'
  });
  if (!res.ok) throw new Error(`HTTP_${res.status}`);
  return readLimited(res, 750_000, deadline);
}

async function discoverOne(req, deadline) {
  try {
    const body = await fetchSearch(req, deadline);
    let results = [];
    if (['openalex', 'crossref', 'europepmc', 'arxiv'].includes(req.provider)) {
      results = parseApiResults(req.provider, body, req);
    } else if (req.provider === 'bing') results = parseBing(body, req);
    else if (req.provider === 'google') results = parseGoogle(body, req, req.provider);
    else if (req.provider === 'brave') results = parseBrave(body, req);
    else if (req.provider === 'bing-rss') results = parseRssSearch(body, req, 'bing-rss');
    else if (req.provider === 'google-news') results = parseGoogleNews(body, req);
    else if (req.provider === 'youtube') results = parseYoutube(body, req);
    if (!results.length && ['google', 'bing', 'brave'].includes(req.provider)) {
      results = extractAnchors(body, req.url, req.provider, req, 40);
    }
    return { provider: req.provider, ok: true, results };
  } catch (error) {
    return { provider: req.provider, ok: false, results: [], error: error?.message || 'DISCOVERY_FAILED' };
  }
}

function dedupe(list) {
  const map = new Map();
  for (const raw of list || []) {
    if (!raw?.url) continue;
    const url = normalizedUrl(raw.url);
    if (!url || blocked(url) || isLikelySearchUrl(url)) continue;
    const key = normalizedKey(url);
    if (!key) continue;
    const old = map.get(key);
    if (!old) {
      map.set(key, { ...raw, url });
    } else {
      const providers = new Set([...(old.providers || [old.source]), ...(raw.providers || [raw.source])].filter(Boolean));
      const better = (raw.providerRank || 99) < (old.providerRank || 99);
      const providerRanks = { ...(old.providerRanks || {}), ...(raw.providerRanks || {}) };
      const merged = {
        ...old,
        ...raw,
        url,
        providers: [...providers],
        providerRanks,
        source: providers.size > 1 ? 'multi-source' : better ? raw.source : old.source
      };
      if (!raw.snippet && old.snippet) merged.snippet = old.snippet;
      if (!raw.publishedAt && old.publishedAt) merged.publishedAt = old.publishedAt;
      map.set(key, merged);
    }
  }
  return [...map.values()].slice(0, MAX_DISCOVERY_RESULTS);
}

function titleTerms(text, terms) {
  const norm = normalizeText(text);
  const set = tokenSet(text);
  let hits = 0;
  const matched = [];
  for (const term of terms) {
    const c = canonicalToken(term);
    if (set.has(c) || set.has(stem(c)) || norm.includes(` ${c} `)) {
      hits++;
      matched.push(c);
    }
  }
  return { hits, matched: unique(matched) };
}

function phraseScore(query, text) {
  const q = normalizeText(query);
  const t = normalizeText(text);
  if (!q || !t) return 0;
  if (t.includes(q)) return 1;
  const qs = contentTokens(q).slice(0, 8);
  if (qs.length < 2) return 0;
  const joined = qs.join(' ');
  if (t.includes(joined)) return 0.82;
  let run = 0,
    best = 0;
  const tt = contentTokens(t);
  let pos = 0;
  for (const qx of qs) {
    const i = tt.indexOf(qx, pos);
    if (i >= 0) {
      run++;
      pos = i + 1;
      best = Math.max(best, run);
    } else {
      run = 0;
    }
  }
  return best / qs.length >= 0.7 ? 0.58 : best / qs.length >= 0.5 ? 0.35 : 0;
}

function domainQuality(url) {
  const h = normalizeHost(url);
  let score = 0.55;
  if (isGov(url)) score = 0.98;
  else if (isTrusted(url)) score = 0.93;
  else if (/\.edu(?:\.|$)/i.test(h) || /\.ac\.(?:in|uk|jp|nz)$/i.test(h)) score = 0.9;
  else if (
    /(?:reuters|apnews|bbc|theguardian|nytimes|economist|nature|science|arxiv|nasa|who|wikipedia|britannica|investopedia|microsoft|google|apple|ibm|intel|mitre|github)\./i.test(
      h
    )
  )
    score = 0.86;
  else if (/(?:medium|quora|reddit|facebook|pinterest|instagram|tiktok)\./i.test(h)) score = 0.48;
  const labels = h.split('.');
  if (labels.length <= 1) score -= 0.08;
  return clamp(score, 0, 1);
}

function urlIntentScore(url, plan) {
  const s = String(url || '').toLowerCase();
  let x = 0;
  if (plan.flags.history && /history|timeline|evolution|origin|milestone/.test(s)) x += 5;
  if (plan.flags.academic && /paper|research|study|journal|arxiv|doi/.test(s)) x += 5;
  if (plan.flags.official && (isGov(url) || /official|policy|notification|circular/.test(s))) x += 6;
  if (plan.type === 'doc' && isDoc(url)) x += 9;
  if (plan.type === 'video' && isVideo(url)) x += 8;
  if (plan.type === 'news' && /news|article|story|press|reuters|apnews|bbc/.test(s)) x += 5;
  if (/(?:\/tag\/|\/tags\/|\/category\/|\/categories\/|\/search[/?]|\/author\/|\/authors\/|\/topic\/|\/topics\/|\/(?:home|homepage)\/?$)/i.test(s)) x -= 6;
  return x;
}

function weightedCoverage(text, terms) {
  const norm = normalizeText(text);
  if (!norm || !terms.length) return { coverage: 0, hits: 0, matched: [] };
  let total = 0,
    matchedWeight = 0,
    hits = 0;
  const matched = [];
  for (const term of terms) {
    const c = canonicalToken(term);
    const weight = 1 + Math.min(1.2, Math.max(0, String(c).length - 4) * 0.09);
    total += weight;
    const variants = unique([c, stem(c)]);
    const hit = variants.some((v) => v && (tokenSet(norm).has(v) || norm.includes(` ${v} `)));
    if (hit) {
      matchedWeight += weight;
      hits++;
      matched.push(c);
    }
  }
  return { coverage: total ? matchedWeight / total : 0, hits, matched: unique(matched) };
}

function querySpecificity(plan) {
  const n = plan.coreTerms?.length || plan.terms?.length || 0;
  if (n >= 14) return 1.25;
  if (n >= 10) return 1.15;
  if (n >= 7) return 1.05;
  return 0.95;
}

function genericPagePenalty(url, title) {
  const s = String(url || '').toLowerCase();
  const t = normalizeText(title);
  let p = 0;
  if (/(?:^|\/)(?:tag|tags|category|categories|topic|topics|author|authors|search|results|archive|archives)(?:\/|\?|$)/i.test(s)) p += 10;
  if (/(?:^|\/)(?:home|homepage|index)(?:\.[a-z0-9]+)?$/i.test(s) || s.endsWith('/')) p += 3;
  if (/^(?:home|homepage|welcome|search results|results|index|untitled)$/i.test(t)) p += 9;
  if (/\b(?:login|sign in|subscribe|contact us|privacy policy|terms of service)\b/i.test(t)) p += 8;
  return p;
}

function bm25FieldScore(results, plan) {
  const queryTerms = unique((plan.terms || []).filter((t) => t.length > 1));
  if (!queryTerms.length) return results.map(() => 0);
  const fields = results.map((r) => ({
    title: rawTokens(r.title || ''),
    headings: rawTokens(r.headingsText || ''),
    snippet: rawTokens(r.snippet || ''),
    body: rawTokens(r.pageProbeText || '')
  }));
  const weights = { title: 3.2, headings: 2.2, snippet: 1.5, body: 1.0 };
  const b = { title: 0.45, headings: 0.55, snippet: 0.65, body: 0.75 };
  const avg = {};
  for (const field of Object.keys(weights)) avg[field] = fields.reduce((sum, d) => sum + d[field].length, 0) / Math.max(1, fields.length) || 1;
  const dfs = new Map(queryTerms.map((t) => [t, fields.filter((d) => Object.values(d).some((arr) => arr.includes(t))).length]));
  const k1 = 1.2;
  return fields.map((doc, index) => {
    let score = 0;
    for (const term of queryTerms) {
      const df = dfs.get(term) || 0;
      const idf = Math.log(1 + (fields.length - df + 0.5) / (df + 0.5));
      let combinedTf = 0;
      for (const field of Object.keys(weights)) {
        const tokens = doc[field];
        const tf = tokens.filter((x) => x === term).length;
        const lengthNorm = 1 - b[field] + b[field] * (tokens.length / avg[field]);
        combinedTf += weights[field] * tf / Math.max(0.25, lengthNorm);
      }
      if (combinedTf > 0) score += idf * ((combinedTf * (k1 + 1)) / (combinedTf + k1));
    }
    const titleNorm = normalizeText(results[index].title || '');
    const snippetNorm = normalizeText(results[index].snippet || '');
    const exactPhraseBonus = (plan.quotedPhrases || []).some((phrase) => titleNorm.includes(normalizeText(phrase)) || snippetNorm.includes(normalizeText(phrase))) ? 2.5 : 0;
    const phraseBonus = phraseScore(plan.query, `${results[index].title || ''} ${results[index].snippet || ''}`) * 1.2;
    return score + exactPhraseBonus + phraseBonus;
  });
}

function simHash64(text) {
  const tokens = rawTokens(text).filter((x) => x.length > 2);
  if (!tokens.length) return 0n;
  const v = Array(64).fill(0);
  for (const token of tokens) {
    let h = 1469598103934665603n;
    for (const ch of token) { h ^= BigInt(ch.codePointAt(0)); h = BigInt.asUintN(64, h * 1099511628211n); }
    for (let i = 0; i < 64; i++) v[i] += ((h >> BigInt(i)) & 1n) ? 1 : -1;
  }
  let result = 0n;
  for (let i = 0; i < 64; i++) if (v[i] >= 0) result |= 1n << BigInt(i);
  return result;
}

function hamming64(a, b) {
  let x = a ^ b, n = 0;
  while (x) { n++; x &= x - 1n; }
  return n;
}

function jaccardTokens(a, b) {
  const A = new Set(rawTokens(a).filter((x) => x.length > 2));
  const B = new Set(rawTokens(b).filter((x) => x.length > 2));
  if (!A.size || !B.size) return 0;
  let intersection = 0;
  for (const x of A) if (B.has(x)) intersection++;
  return intersection / (A.size + B.size - intersection);
}

function minHashSignature(text, size = 24) {
  const tokens = [...new Set(rawTokens(text).filter((x) => x.length > 2))];
  if (!tokens.length) return [];
  const signature = [];
  for (let seed = 0; seed < size; seed++) {
    let min = 0xffffffff;
    for (const token of tokens) {
      let hash = (2166136261 ^ Math.imul(seed + 1, 0x45d9f3b)) >>> 0;
      for (let i = 0; i < token.length; i++) { hash ^= token.charCodeAt(i); hash = Math.imul(hash, 16777619) >>> 0; }
      if (hash < min) min = hash;
    }
    signature.push(min);
  }
  return signature;
}

function minHashSimilarity(a, b) {
  const A = Array.isArray(a) ? a : minHashSignature(a);
  const B = Array.isArray(b) ? b : minHashSignature(b);
  const length = Math.min(A.length, B.length);
  if (!length) return 0;
  let equal = 0;
  for (let i = 0; i < length; i++) if (A[i] === B[i]) equal++;
  return equal / length;
}

function similarity(a, b) {
  const textA = `${a.title || ''} ${a.snippet || ''}`;
  const textB = `${b.title || ''} ${b.snippet || ''}`;
  const simHashSimilarity = 1 - hamming64(simHash64(textA), simHash64(textB)) / 64;
  return Math.max(simHashSimilarity, minHashSimilarity(minHashSignature(textA), minHashSignature(textB)), jaccardTokens(textA, textB));
}

function rankOne(item, plan) {
  const score = Number(item._bm25f || 0);
  const trust = domainQuality(item.url);
  const freshnessValue = freshness(item.publishedAt);
  const freshnessBonus = { last_24h: 3, last_7d: 2, last_30d: 1 }[freshnessValue] || 0;
  const consensus = Math.min(4, Math.max(0, (item.providers?.length || 1) - 1)) * 0.65;
  return clamp(Math.round((score * 7.5 + trust * 2 + freshnessBonus + consensus + (item.verified ? 1 : 0)) * 100) / 100, 0, 100);
}

function relevanceObject(item, plan) {
  const terms = plan.terms || [];
  const title = weightedCoverage(item.title, terms);
  const body = weightedCoverage(item.snippet, terms);
  const phrase = phraseScore(plan.query, `${item.title} ${item.snippet || ''}`);
  return {
    score: rankOne(item, plan),
    titleCoverage: Number(title.coverage.toFixed(3)),
    bodyCoverage: Number(body.coverage.toFixed(3)),
    conceptCoverage: Number(((title.coverage + body.coverage) / 2).toFixed(3)),
    matchedConcepts: unique([...title.matched, ...body.matched]),
    matchedCount: title.hits + body.hits,
    conceptCount: Math.max(1, terms.length),
    exactPhrase: (plan.quotedPhrases || []).some((p) => normalizeText(item.title + ' ' + item.snippet).includes(normalizeText(p))),
    phraseScore: Number(phrase.toFixed(3)),
    providers: item.providers || [item.source],
    focusTerms: terms
  };
}

function fusionRank(results, plan) {
  const bm25Scores = bm25FieldScore(results, plan);
  const maxBm25 = Math.max(1, ...bm25Scores);
  const enriched = results.map((r, index) => {
    const providerRanks = r.providerRanks || { [r.source || 'search']: r.providerRank || index + 1 };
    let rrf = 0;
    for (const rank of Object.values(providerRanks)) {
      if (Number(rank) > 0) rrf += 1 / (60 + Number(rank));
    }
    const bm25 = bm25Scores[index] || 0;
    const normalizedBm25 = bm25 / maxBm25;
    const rawScore = normalizedBm25 * 10 + Math.min(2, rrf * 45) + domainQuality(r.url) * 0.35;
    const item = { ...r, _bm25f: rawScore, simHash: simHash64(`${r.title || ''} ${r.snippet || ''}`).toString(16), minHashSignature: minHashSignature(`${r.title || ''} ${r.snippet || ''}`) };
    const rel = relevanceObject(item, plan);
    return { ...item, relevance: rel, relevanceScore: rel.score, relevanceBand: rel.score >= 82 ? 'excellent' : rel.score >= 65 ? 'strong' : rel.score >= 48 ? 'usable' : rel.score >= 25 ? 'related' : 'weak', _baseScore: rel.score };
  });

  // MMR-style greedy reranking: relevance plus novelty; near-duplicates and repeated domains are penalized.
  const selected = [];
  const remaining = [...enriched];
  const lambda = 0.82;
  while (remaining.length) {
    let bestIndex = 0, bestValue = -Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const candidate = remaining[i];
      const maxSimilarity = selected.length ? Math.max(...selected.map((x) => similarity(candidate, x))) : 0;
      const sameDomain = selected.filter((x) => normalizeHost(x.url) === normalizeHost(candidate.url)).length;
      const novelty = 1 - maxSimilarity;
      const selection = lambda * (candidate._baseScore / 100) + (1 - lambda) * novelty - Math.min(0.15, sameDomain * 0.035);
      if (selection > bestValue) { bestValue = selection; bestIndex = i; }
    }
    const [chosen] = remaining.splice(bestIndex, 1);
    chosen._selectionScore = bestValue;
    if (selected.length) chosen.nearDuplicateOf = selected.find((x) => similarity(chosen, x) >= 0.88)?.url || null;
    selected.push(chosen);
  }
  return selected.map((r, i) => ({ ...r, domainRepetition: selected.slice(0, i + 1).filter((x) => normalizeHost(x.url) === normalizeHost(r.url)).length }));
}

async function mapConcurrent(list, limit, worker) {
  const arr = Array.isArray(list) ? list : [];
  const out = new Array(arr.length);
  let cursor = 0;
  const n = Math.max(1, Math.min(limit, arr.length || 1));
  const runner = async () => {
    while (true) {
      const i = cursor++;
      if (i >= arr.length) return;
      try {
        out[i] = await worker(arr[i], i);
      } catch {
        out[i] = null;
      }
    }
  };
  await Promise.all(Array.from({ length: n }, runner));
  return out;
}

async function verifyOne(candidate, deadline) {
  if (!safeUrl(candidate.url) || left(deadline) < 220) {
    return { ...candidate, verified: false, verificationMethod: 'budget' };
  }
  const localDeadline = Date.now() + Math.min(VERIFY_TIMEOUT_MS, left(deadline) - 100);
  try {
    const res = await fetchWithTimeout(candidate.url, VERIFY_TIMEOUT_MS, localDeadline, {
      accept: 'text/html,application/xhtml+xml,application/xml,text/plain,application/pdf;q=0.8,*/*;q=0.1',
      range: 'bytes=0-16383'
    });
    const finalUrl = normalizedUrl(res.url || candidate.url) || candidate.url;
    if (!safeUrl(finalUrl) || blocked(finalUrl)) {
      return { ...candidate, verified: false, verificationMethod: 'redirect-rejected', httpStatus: res.status };
    }
    const ct = String(res.headers.get('content-type') || '').toLowerCase();
    const body = await readLimited(res, 20_000, localDeadline).catch(() => '');
    const title = titleFromHtml(body) || metaFromHtml(body, 'og:title') || candidate.title;
    const canonical = metaFromHtml(body, 'og:url');
    const metaDescription = metaFromHtml(body, 'description') || metaFromHtml(body, 'og:description');
    const headingSignals = [...String(body).matchAll(/<h[1-3]\b[^>]*>([\s\S]*?)<\/h[1-3]\s*>/gi)]
      .slice(0, 10)
      .map((m) => cleanSnippet(m[1]))
      .join(' ');
    const pageProbeText = truncate(
      normalizeText([title, metaDescription, headingSignals, stripTags(body).slice(0, 7000)].filter(Boolean).join(' ')),
      9000
    );
    const published = dateFromHtml(body) || candidate.publishedAt || null;
    const reachable = res.ok || (res.status >= 300 && res.status < 500);
    return {
      ...candidate,
      url: finalUrl,
      title: truncate(title, 500),
      publishedAt: published,
      httpStatus: res.status,
      contentType: ct || null,
      verified: Boolean(reachable),
      verificationMethod: 'light-http-check',
      contentAvailable: false,
      contentStatus: 'metadata-only',
      contentMethod: 'search-metadata',
      pageProbeText,
      metaDescription: truncate(metaDescription, 900),
      canonicalUrl: safeUrl(canonical) && !blocked(canonical) ? normalizedUrl(canonical) : null
    };
  } catch (error) {
    return {
      ...candidate,
      verified: false,
      verificationMethod: 'light-http-check-failed',
      verificationError: error?.message || 'VERIFY_FAILED'
    };
  }
}

async function optionalGroqRerank(query, results, deadline) {
  const key = env('GROQ_API_KEY');
  if (!key || results.length < 4 || left(deadline) < 500) return null;
  const controller = new AbortController();
  const timeout = Math.min(AI_RERANK_TIMEOUT_MS, Math.max(350, left(deadline) - 100));
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const payload = results.slice(0, 30).map((r, i) => ({
      id: i,
      title: truncate(r.title, 180),
      domain: normalizeHost(r.url),
      snippet: truncate(r.snippet, 280),
      score: r.relevanceScore,
      providers: r.providers?.length || 1,
      type: r.type
    }));
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: 'llama-3.1-8b-instant',
        messages: [
          {
            role: 'system',
            content: 'Return JSON only. Reorder the supplied ids by relevance to the query. Never invent ids. Do not omit any id. Prefer exact topical match and direct source evidence.'
          },
          {
            role: 'user',
            content: JSON.stringify({ query, results: payload, order: payload.map((x) => x.id) })
          }
        ],
        temperature: 0,
        max_tokens: 500
      })
    });
    if (!res.ok) return null;
    const data = await res.json();
    const txt = String(data?.choices?.[0]?.message?.content || '');
    const obj = JSON.parse(txt.match(/\{[\s\S]*\}/)?.[0] || txt);
    if (!Array.isArray(obj.order)) return null;
    return obj.order.map(Number).filter((i) => Number.isInteger(i) && i >= 0 && i < Math.min(30, results.length));
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function commonCrawlMeta(url, deadline) {
  if (!safeUrl(url) || left(deadline) < 250) return null;
  let indexes = COMMON_CRAWL_INDEXES;
  if (!indexes.length) {
    if (Date.now() - commonCrawlIndexCache.at > 60 * 60 * 1000 || !commonCrawlIndexCache.ids.length) {
      try {
        const response = await fetchWithTimeout('https://index.commoncrawl.org/collinfo.json', 900, deadline, { accept: 'application/json' });
        if (response.ok) {
          const catalogue = await response.json();
          commonCrawlIndexCache = { at: Date.now(), ids: (Array.isArray(catalogue) ? catalogue : []).slice(0, 3).map((x) => x.id).filter(Boolean) };
        }
      } catch {}
    }
    indexes = commonCrawlIndexCache.ids;
  }
  const encoded = encodeURIComponent(url);
  for (const index of indexes) {
    if (left(deadline) < 200) break;
    try {
      const res = await fetchWithTimeout(
        `https://index.commoncrawl.org/${index}-index?url=${encoded}&output=json&filter=status:200&limit=1`,
        COMMON_CRAWL_TIMEOUT_MS,
        deadline,
        { accept: 'application/json,text/plain;q=0.8' }
      );
      if (!res.ok) continue;
      const body = await readLimited(res, 20_000, deadline);
      const row = body
        .split('\n')
        .map((x) => {
          try {
            return JSON.parse(x);
          } catch {
            return null;
          }
        })
        .find(Boolean);
      if (row) return { index, timestamp: row.timestamp || null, digest: row.digest || null };
    } catch {}
  }
  return null;
}

function createLogger() {
  const logs = [];
  const add = (event, message, extra = {}) => {
    const x = { at: nowIso(), event, message, ...extra };
    logs.push(x);
    if (logs.length > MAX_LIVE_LOG) logs.shift();
    try {
      console.log(`[ArixAI ${event}] ${message}`);
    } catch {}
  };
  return { logs, add };
}

function cacheKey(input, query, plan) {
  return JSON.stringify({
    q: query,
    type: plan.type,
    deep: String(input.deep || 'false').toLowerCase(),
    verify: String(input.verify ?? 'true').toLowerCase(),
    ai: String(input.ai ?? 'auto').toLowerCase(),
    cc: String(input.commonCrawl || 'false').toLowerCase(),
    providers: input.providers || null,
    sources: input.sources || null,
    includeDomains: input.includeDomains || null,
    excludeDomains: input.excludeDomains || null,
    dateAfter: input.dateAfter || null,
    dateBefore: input.dateBefore || null,
    queries: input.queries || null,
    mode: input.mode || null
  });
}

function cacheGet(key) {
  const x = CACHE.get(key);
  if (!x) return null;
  if (Date.now() - x.at > x.ttl) {
    CACHE.delete(key);
    return null;
  }
  return x.value;
}

function cacheSet(key, value, ttl) {
  CACHE.set(key, { at: Date.now(), ttl, value });
  while (CACHE.size > CACHE_MAX) CACHE.delete(CACHE.keys().next().value);
}

function decorateResult(r, i, plan) {
  const type = typeFromUrl(r.url, r.type);
  const score = Math.round(Number(r.relevanceScore || 0));
  return {
    rank: i + 1,
    title: truncate(r.title || 'Untitled', 300),
    url: r.url,
    domain: normalizeHost(r.url),
    type,
    source: r.source || 'search',
    providers: r.providers || [r.source || 'search'],
    providerRank: r.providerRank || null,
    providerRanks: r.providerRanks || {},
    originalUrl: r.url,
    finalUrl: r.finalUrl || r.url,
    authoritySignals: { officialGovernmentDomain: isGov(r.url), academicDomain: /\.(?:edu|ac\.[a-z]{2})$/i.test(normalizeHost(r.url)), knownInstitutionalDomain: isTrusted(r.url), domainSignalOnly: true },
    snippet: truncate(r.snippet || '', 1200),
    publishedAt: r.publishedAt || null,
    author: r.author || null,
    doi: r.doi || null,
    pmid: r.pmid || null,
    pmcid: r.pmcid || null,
    publication: r.publication || null,
    openAccess: typeof r.openAccess === 'boolean' ? r.openAccess : null,
    language: r.language || null,
    freshness: freshness(r.publishedAt),
    verified: Boolean(r.verified),
    httpStatus: r.httpStatus || null,
    trust: Number(domainQuality(r.url).toFixed(2)),
    relevanceScore: score,
    relevanceBand: r.relevanceBand || 'related',
    relevance: r.relevance || null,
    publisherResolved: Boolean(r.publisherResolved),
    publisherWrapperUrl: r.publisherWrapperUrl || null,
    searchWrapperResolved: Boolean(r.searchWrapperResolved),
    extractedText: r.pageProbeText ? truncate(r.pageProbeText, 3500) : (r.snippet ? truncate(r.snippet, 1000) : ''),
    pageContent: r.pageProbeText ? truncate(r.pageProbeText, 3500) : '',
    contentAvailable: Boolean(r.pageProbeText),
    contentStatus: r.pageProbeText ? 'verified-preview' : 'metadata-only',
    contentMethod: r.pageProbeText ? 'probe-extract' : 'search-metadata',
    contentLength: 0,
    contentConfidence: 0,
    contentSourceUrl: r.url,
    contentTargetMatched: false,
    contentTitleSimilarity: Number(r.relevance?.titleCoverage || 0).toFixed(3),
    contentConceptCoverage: Number(r.relevance?.conceptCoverage || 0).toFixed(3),
    contentFormat: 'none',
    contentRole: 'search_metadata_only',
    contentForAI: null,
    verificationMethod: r.verificationMethod || null,
    verificationError: r.verificationError || null,
    commonCrawl: r.commonCrawl || null,
    queryMatch: {
      planType: plan.type,
      liveIntent: plan.flags.live,
      historyIntent: plan.flags.history,
      officialIntent: plan.flags.official,
      terms: plan.terms
    }
  };
}

function buildResponse(ctx) {
  const {
    query,
    count,
    mode,
    requestedType,
    plan,
    preciseQueries,
    providerStats,
    results,
    logger,
    started,
    verifyRequested,
    deep,
    aiRequested,
    useCc,
    cacheHit = false
  } = ctx;
  const verifiedCount = results.filter((r) => r.verified).length;
  return {
    ok: true,
    version: VERSION,
    query,
    requestedResults: count,
    returnedResults: results.length,
    sourceCountMode: 'all-discovered-ranked',
    resultSelectionPolicy: 'return-all-discovered-ranked-by-query-match',
    mode,
    intent: {
      type: requestedType || plan.type,
      wantsNews: plan.flags.explicitNews || plan.type === 'news' || plan.flags.live,
      wantsVideo: plan.flags.explicitVideo || plan.type === 'video',
      wantsGov: plan.flags.explicitGov || plan.type === 'gov',
      wantsDocs: plan.flags.explicitDoc || plan.type === 'doc',
      wantsHistory: plan.flags.history,
      wantsAcademic: plan.flags.academic
    },
    generatedAt: nowIso(),
    started,
    latencyMs: Date.now() - started,
    keylessCoreSearch: true,
    groqUsed: Boolean(ctx.groqUsed),
    cached: cacheHit,
    providers: providerStats,
    quality: {
      discoveredResults: results.length,
      validatedResults: verifiedCount,
      requestedResults: count,
      realContentOnly: false,
      contentGuarantee: 'This endpoint returns discovered source metadata and search snippets only. Full page content is returned by /api/retrieve or /api/extract.'
    },
    searchPlan: {
      agentQueries: preciseQueries,
      queryVariants: preciseQueries,
      engineRequests: Object.values(providerStats).reduce((s, p) => s + Number(p.requests || 0), 0),
      verificationRequested: verifyRequested,
      verificationPerformed: Number(ctx.verificationPerformed || 0),
      verificationSucceeded: verifiedCount,
      commonCrawlEnabled: useCc,
      commonCrawlPerformed: results.filter((r) => r.commonCrawl).length,
      streamed: true,
      logStreamSupported: true,
      deep,
      aiRequested
    },
    liveLog: logger.logs,
    allFetchedSources: results.length,
    results,
    warnings:
      results.length < count
        ? [`${results.length} ranked sources were discovered. Public engines may return fewer results than requested.`]
        : []
  };
}

function normalizeDomainFilter(value) {
  const list = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[\s,;]+/) : [];
  return list.map((x) => String(x).trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '')).filter(Boolean);
}

function domainMatches(host, domain) {
  return host === domain || host.endsWith(`.${domain}`);
}

function filterCandidateSet(results, input, plan) {
  const includes = normalizeDomainFilter(input.includeDomains ?? input.domains);
  const excludes = normalizeDomainFilter(input.excludeDomains);
  const after = input.dateAfter ? Date.parse(String(input.dateAfter)) : NaN;
  const before = input.dateBefore ? Date.parse(String(input.dateBefore)) : NaN;
  const minDate = Number.isFinite(after) ? after : null;
  const maxDate = Number.isFinite(before) ? before : null;
  const languages = String(input.language || '').toLowerCase();
  return results.filter((item) => {
    const host = normalizeHost(item.url);
    if (includes.length && !includes.some((d) => domainMatches(host, d))) return false;
    if (excludes.some((d) => domainMatches(host, d))) return false;
    if (plan.type === 'gov' && !isGov(item.url)) return false;
    if (plan.type === 'doc' && !isDoc(item.url)) return false;
    if (plan.type === 'video' && !isVideo(item.url)) return false;
    if (plan.type === 'academic' && item.type !== 'academic') return false;
    if (minDate !== null || maxDate !== null) {
      const published = Date.parse(String(item.publishedAt || ''));
      if (!Number.isFinite(published)) return false;
      if (minDate !== null && published < minDate) return false;
      if (maxDate !== null && published > maxDate) return false;
    }
    if (languages && item.language && !String(item.language).toLowerCase().startsWith(languages)) return false;
    return true;
  });
}

async function performSearch(input, started, logger) {
  const deadline = started + SEARCH_BUDGET_MS;
  const query = String(input.query ?? input.q ?? '');
  const count = safeInt(input.count ?? input.limit, DEFAULT_RESULTS, 1, MAX_RESULTS);
  const mode = String(input.mode || 'auto').toLowerCase();
  const requestedType = String(input.type || '').toLowerCase();
  const deep = ['deep', 'maximum'].includes(mode) || String(input.deep ?? 'false').toLowerCase() === 'true';
  const verifyRequested = input.verify == null ? false : String(input.verify).toLowerCase() !== 'false';
  const aiRequested = String(input.ai ?? 'auto').toLowerCase();
  const useCc = String(input.commonCrawl ?? 'false').toLowerCase() === 'true';

  const agentQueries = Array.isArray(input.queries) ? input.queries.slice(0, 8).map((q) => String(q)) : [query];
  if (!agentQueries.includes(query)) agentQueries.unshift(query);
  const plan = queryPlan(query, { mode, type: requestedType, agentQueries });
  const key = cacheKey(input, query, plan);
  const cached = cacheGet(key);
  if (cached) {
    logger.add('cache-hit', 'Returned a warm cached search result.');
    return { ...cached, generatedAt: nowIso(), latencyMs: Date.now() - started, cached: true, liveLog: logger.logs };
  }

  const preciseQueries = buildQueries(query, plan);
  logger.add('agent-query-received', 'Preserved agent-supplied queries without rewriting.', {
    queryCount: preciseQueries.length,
    providers: Array.isArray(input.providers) ? input.providers : ['google', 'bing', 'brave']
  });
  const requests = providerRequests(preciseQueries, plan, deep, input);
  logger.add('discovery-start', `Launching ${requests.length} public search requests in parallel.`, { queries: preciseQueries });

  const discoveryDeadline = Math.min(deadline, started + DISCOVERY_CUTOFF_MS);
  const entries = await mapConcurrent(requests, SEARCH_CONCURRENCY, (r) => discoverOne(r, discoveryDeadline));

  const providerStats = {};
  let discovered = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i] || { provider: requests[i]?.provider, ok: false, results: [] };
    const p = entry.provider || requests[i]?.provider || 'unknown';
    providerStats[p] ||= { requests: 0, ok: 0, failed: 0, results: 0 };
    providerStats[p].requests++;
    if (entry.ok) {
      providerStats[p].ok++;
      providerStats[p].results += entry.results.length;
      discovered.push(...entry.results);
    } else {
      providerStats[p].failed++;
    }
  }

  discovered = filterCandidateSet(discovered, input, plan);
  discovered = dedupe(discovered);
  logger.add('discovery-complete', `Discovery produced ${discovered.length} unique public sources.`, {
    providers: Object.fromEntries(Object.entries(providerStats).map(([k, v]) => [k, { ok: v.ok, failed: v.failed, results: v.results }]))
  });

  if (!discovered.length) {
    const empty = buildResponse({
      query,
      count,
      mode,
      requestedType,
      plan,
      preciseQueries,
      providerStats,
      results: [],
      logger,
      started,
      verifyRequested,
      deep,
      aiRequested,
      useCc,
      verifyLimit: 0
    });
    cacheSet(key, empty, plan.flags.live ? LIVE_CACHE_TTL_MS : CACHE_TTL_MS);
    return empty;
  }

  let ranked = fusionRank(discovered, plan);
  logger.add('ranking-complete', 'Fused provider rank, query match, source quality, consensus and intent.');

  /* Verify more than the displayed count when possible, but never make verification the
   * bottleneck. Unverified sources are still retained and ranked. */
  const verifyLimit = Math.min(ranked.length, deep ? 16 : Math.min(10, Math.max(5, count)));
 let verificationPerformed = 0;
 if (verifyRequested && left(deadline) > 400 && verifyLimit) {
 logger.add('verification-start', `Running lightweight reachability checks on ${verifyLimit} top sources.`);
 verificationPerformed = verifyLimit;
 const verifyDeadline = Math.min(deadline - 60, Date.now() + Math.max(350, left(deadline) - 60));
 const checked = await mapConcurrent(ranked.slice(0, verifyLimit), VERIFY_CONCURRENCY, (r) => verifyOne(r, verifyDeadline));
    const checkedMap = new Map(checked.filter(Boolean).map((r) => [normalizedKey(r.url), r]));
    ranked = ranked.map((r) => checkedMap.get(normalizedKey(r.url)) || r);
    ranked = fusionRank(ranked, plan);
    logger.add(
      'verification-complete',
      `Verification finished; ${ranked.slice(0, verifyLimit).filter((r) => r.verified).length} of ${verifyLimit} top sources responded usefully.`
    );
  } else {
    logger.add('verification-skipped', 'Verification skipped because the remaining wall-clock budget was too small.');
  }

  let groqUsed = false;
  if ((aiRequested === 'true' || aiRequested === 'auto') && env('GROQ_API_KEY') && left(deadline) > 850) {
    const order = await optionalGroqRerank(query, ranked.slice(0, 30), deadline);
    if (Array.isArray(order) && order.length) {
      const top = ranked.slice(0, 30);
      const reordered = order.map((i) => top[i]).filter(Boolean);
      const seen = new Set(reordered.map((x) => normalizedKey(x.url)));
      ranked = [...reordered, ...ranked.slice(30).filter((x) => !seen.has(normalizedKey(x.url)))];
      groqUsed = true;
      logger.add('ai-rerank-complete', 'Optional Groq reranking reordered the top candidate set.');
    }
  }

  let final = ranked.filter((r) => r?.url && !blocked(r.url) && !isLikelySearchUrl(r.url)).slice(0, MAX_DISCOVERY_RESULTS);
  if (useCc && left(deadline) > 500) {
    const ccDeadline = Date.now() + Math.min(500, left(deadline) - 50);
    const rows = await Promise.all(
      final.slice(0, MAX_COMMON_CRAWL).map(async (r) => ({ url: r.url, cc: await commonCrawlMeta(r.url, ccDeadline) }))
    );
    const ccMap = new Map(rows.filter((x) => x.cc).map((x) => [normalizedKey(x.url), x.cc]));
    final = final.map((r) => ({ ...r, commonCrawl: ccMap.get(normalizedKey(r.url)) || null }));
  }

  const decorated = final.map((r, i) => decorateResult(r, i, plan));
  const result = buildResponse({
    query,
    count,
    mode,
    requestedType,
    plan,
    preciseQueries,
    providerStats,
    results: decorated,
    logger,
    started,
    verifyRequested,
    deep,
    aiRequested,
    useCc,
    groqUsed,
    verifyLimit,
    verificationPerformed
  });
  cacheSet(key, result, plan.flags.live ? LIVE_CACHE_TTL_MS : CACHE_TTL_MS);
  return result;
}

async function readInput(req) {
  const url = new URL(req.url);
  if (req.method === 'GET') return Object.fromEntries(url.searchParams.entries());
  const raw = await req.text();
  if (raw.length > MAX_REQUEST_BODY) throw new Error('REQUEST_BODY_TOO_LARGE');
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return Object.fromEntries(new URLSearchParams(raw).entries());
  }
}

function corsHeaders(contentType = 'application/json; charset=utf-8') {
 return {
 'content-type': contentType,
 'cache-control': 'no-store, no-cache, no-transform, must-revalidate',
 'x-accel-buffering': 'no',
 'access-control-allow-origin': '*',
 'access-control-allow-methods': 'GET, POST, OPTIONS',
 'access-control-allow-headers': 'content-type, authorization, x-arix-search-key',
 'access-control-max-age': '86400',
 'x-arix-crawler-version': VERSION
 };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), { status, headers: corsHeaders() });
}

function streamJsonSearch(input) {
  const encoder = new TextEncoder();
  const started = Date.now();
  const logger = createLogger();
  const query = String(input.query ?? input.q ?? '');
  const count = safeInt(input.count ?? input.limit, DEFAULT_RESULTS, 1, MAX_RESULTS);
  const mode = String(input.mode || 'auto').toLowerCase();

  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      const send = (x) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(x));
        } catch {
          closed = true;
        }
      };

      logger.add('request-start', `Starting live search for ${query}.`, { count, mode });
      send(`{"ok":true,"version":${encode(VERSION)},"query":${encode(query)},"requestedResults":${count},"mode":${encode(mode)},"streaming":true,"results":[\n` + ' '.repeat(2048) + '\n');
      const heartbeat = setInterval(() => send(' \n'), 600);
      Promise.resolve()
        .then(() => performSearch(input, started, logger))
        .then((result) => {
          clearInterval(heartbeat);
          const rows = Array.isArray(result.results) ? result.results : [];
          rows.forEach((r, i) => send(`${i ? ',\n' : ''}${JSON.stringify(r)}\n`));
          const meta = { ...result };
          delete meta.results;
          send('],\n');
          const entries = Object.entries(meta);
          entries.forEach(([k, v], i) => send(`${JSON.stringify(k)}:${JSON.stringify(v)}${i === entries.length - 1 ? '' : ',\n'}`));
          send('}');
          try {
            controller.close();
          } catch {}
          closed = true;
        })
        .catch((error) => {
          clearInterval(heartbeat);
          send(
            `],"returnedResults":0,"generatedAt":${encode(nowIso())},"latencyMs":${Date.now() - started},"keylessCoreSearch":true,"groqUsed":false,"resultsError":${encode(error?.message || 'SEARCH_FAILED')},"liveLog":${JSON.stringify(logger.logs)},"warnings":[${encode('The crawler failed safely after the stream had already started.').slice(1, -1)}]}`
          );
          try {
            controller.close();
          } catch {}
          closed = true;
        });
    }
  });

  return new Response(stream, {
    status: 200,
    headers: { ...corsHeaders(), 'x-arix-search-stream': '1', 'x-arix-stream-heartbeat-ms': '1000' }
  });
}

function streamSseSearch(input) {
  const encoder = new TextEncoder();
  const started = Date.now();
  const logger = createLogger();

  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      const send = (event, data) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          closed = true;
        }
      };

      const originalAdd = logger.add;
      logger.add = (event, message, extra = {}) => {
        originalAdd(event, message, extra);
        send('log', logger.logs[logger.logs.length - 1]);
      };

      const heartbeat = setInterval(() => send('heartbeat', { at: nowIso(), version: VERSION }), 1000);

      Promise.resolve()
        .then(() => performSearch(input, started, logger))
        .then((result) => {
          clearInterval(heartbeat);
          send('result', result);
          send('done', { ok: true, latencyMs: Date.now() - started });
          try {
            controller.close();
          } catch {}
          closed = true;
        })
        .catch((error) => {
          clearInterval(heartbeat);
          send('error', { ok: false, error: error?.message || 'SEARCH_FAILED', latencyMs: Date.now() - started });
          try {
            controller.close();
          } catch {}
          closed = true;
        });
    }
  });

  return new Response(stream, {
    status: 200,
    headers: { ...corsHeaders('text/event-stream; charset=utf-8'), 'x-arix-log-stream': 'sse' }
  });
}

export async function runSearch(input = {}) {
  const query = String(input.query ?? input.q ?? '');
  if (!query.trim()) throw new Error('MISSING_QUERY');
  return performSearch({ ...input, query }, Date.now(), createLogger());
}

export const SEARCH_TESTING = Object.freeze({ queryPlan, buildQueries, providerRequests, bm25FieldScore, fusionRank, simHash64, hamming64, jaccardTokens, minHashSignature, minHashSimilarity, filterCandidateSet });

export const SEARCH_CONTRACT = Object.freeze({
 version: VERSION,
 maxResults: MAX_RESULTS,
 standalone: true,
 dependencies: [],
 searchSurfaces: ['bing', 'google', 'brave', 'google-news', 'youtube', 'openalex', 'crossref', 'europepmc', 'arxiv'],
 ranking: 'BM25F-style-field-ranking + RRF + MMR + SimHash/MinHash near-duplicate signals',
 contentMode: 'search-discovery-only',
 returnsAllDiscovered: true,
 optionalVerification: true,
 noTavily: true
});

async function readNodeBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_REQUEST_BODY) throw new Error('REQUEST_BODY_TOO_LARGE');
    chunks.push(Buffer.from(chunk));
  }
  if (!total) return {};
  const raw = Buffer.concat(chunks).toString('utf8');
  try { return JSON.parse(raw); }
  catch { return Object.fromEntries(new URLSearchParams(raw).entries()); }
}

function sendNode(res, status, body) {
  const json = JSON.stringify(body);
  res.statusCode = status;
  for (const [key, value] of Object.entries(corsHeaders())) res.setHeader(key, value);
  res.setHeader('content-length', Buffer.byteLength(json));
  res.end(json);
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return sendNode(res, 204, { ok: true, version: VERSION });
  if (!['GET', 'POST'].includes(req.method)) return sendNode(res, 405, { ok: false, version: VERSION, error: 'METHOD_NOT_ALLOWED' });
  try {
    let input;
    if (req.method === 'GET') {
      const parsed = new URL(req.url || '/', `https://${req.headers.host || 'localhost'}`);
      input = Object.fromEntries(parsed.searchParams.entries());
    } else {
      input = await readNodeBody(req);
    }
    const query = String(input.query ?? input.q ?? '');
    if (!query.trim()) return sendNode(res, 400, { ok: false, version: VERSION, error: 'MISSING_QUERY' });
    if (query.length > MAX_QUERY_LEN) return sendNode(res, 413, { ok: false, version: VERSION, error: 'QUERY_TOO_LONG', maxLength: MAX_QUERY_LEN });
    const result = await performSearch(input, Date.now(), createLogger());
    return sendNode(res, 200, result);
  } catch (error) {
    const status = error?.message === 'REQUEST_BODY_TOO_LARGE' ? 413 : 500;
    return sendNode(res, status, { ok: false, version: VERSION, error: error?.message || 'SEARCH_FAILED' });
  }
}
