import { runSearch } from './search.js';

export const config = { maxDuration: 60 };
export const maxDuration = 60;

const VERSION = 'arix-crawler-4.0.0';
const MAX_REQUEST_BYTES = 100_000;
const MAX_URLS = 40;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const DEFAULT_COUNT = 10;

function headers(res, type = 'application/json; charset=utf-8') {
  res.setHeader('content-type', type);
  res.setHeader('cache-control', 'no-store, no-cache, must-revalidate');
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type, authorization, x-arix-search-key');
  res.setHeader('access-control-max-age', '86400');
  res.setHeader('x-arix-crawler-version', VERSION);
}

function send(res, status, value) {
  const body = JSON.stringify(value);
  headers(res);
  res.statusCode = status;
  res.setHeader('content-length', Buffer.byteLength(body));
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_REQUEST_BYTES) throw new Error('REQUEST_BODY_TOO_LARGE');
    chunks.push(Buffer.from(chunk));
  }
  if (!total) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('INVALID_JSON'); }
}

function clampInt(value, fallback, min, max) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}

function normalizeUrl(value) {
  try {
    const url = new URL(String(value));
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    url.hash = '';
    return url.href;
  } catch { return null; }
}

function hostOf(value) {
  try { return new URL(value).hostname.replace(/^www\./i, '').toLowerCase(); }
  catch { return ''; }
}

function makeDirectResult(url) {
  const host = hostOf(url);
  return {
    rank: 0, title: host || url, url, originalUrl: url, finalUrl: url, domain: host,
    type: /\.pdf(?:$|\?)/i.test(url) ? 'doc' : 'web', source: 'direct-url', providers: ['direct-url'],
    providerRanks: {}, snippet: '', relevanceScore: null, relevanceBand: 'not-ranked',
    authoritySignals: { domainSignalOnly: true }
  };
}

function getOrigin(req) {
  const forwardedProto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
  const forwardedHost = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  if (!forwardedHost || /[\s/\\]/.test(forwardedHost)) throw new Error('INVALID_REQUEST_HOST');
  const protocol = forwardedProto === 'http' && /^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(forwardedHost) ? 'http' : 'https';
  return `${protocol}://${forwardedHost}`;
}

async function invokeExtractor(req, urls, input, started) {
  if (!urls.length) return { ok: true, requested: true, count: 0, succeeded: 0, failed: 0, results: [], latency_ms: 0 };
  const origin = getOrigin(req);
  const timeoutMs = Math.max(1000, Math.min(39_000, 52_000 - (Date.now() - started)));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const payload = {
      urls,
      depth: clampInt(input.depth, 0, 0, 3),
      max_pages: clampInt(input.maxPages, urls.length, urls.length, 100),
      same_domain: input.sameDomain !== false,
      include_ai_context: input.includeAiContext === true,
      ...(input.maxText ? { max_text: clampInt(input.maxText, 350_000, 1000, 1_000_000) } : {})
    };
    const response = await fetch(`${origin}/api/extract`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    const text = await response.text();
    if (Buffer.byteLength(text) > MAX_OUTPUT_BYTES) throw new Error('EXTRACTOR_RESPONSE_TOO_LARGE');
    let data;
    try { data = JSON.parse(text); }
    catch { throw new Error(`EXTRACTOR_INVALID_JSON_HTTP_${response.status}`); }
    if (!response.ok && !data.results) throw new Error(data.error?.message || data.error?.code || `EXTRACTOR_HTTP_${response.status}`);
    return data;
  } catch (error) {
    return {
      ok: false, requested: true, count: urls.length, succeeded: 0, failed: urls.length, results: [],
      error: { code: error.name === 'AbortError' ? 'EXTRACTOR_TIMEOUT' : 'EXTRACTOR_UNAVAILABLE', message: error.message || 'Extractor request failed' }
    };
  } finally {
    clearTimeout(timer);
  }
}

function buildResult(searchResult, extraction, direct = false, started = Date.now()) {
  const extracted = Array.isArray(extraction?.results) ? extraction.results : [];
  const requestedUrls = Array.isArray(extraction?.requestedUrls)
    ? new Set(extraction.requestedUrls.map(normalizeUrl).filter(Boolean))
    : null;
  const byUrl = new Map();
  for (const page of extracted) {
    const key = normalizeUrl(page.url || page.final_url || '');
    if (key) byUrl.set(key, page);
    const finalKey = normalizeUrl(page.final_url || '');
    if (finalKey) byUrl.set(finalKey, page);
  }
  const rows = (searchResult.results || []).map((source) => {
    const page = byUrl.get(normalizeUrl(source.url)) || byUrl.get(normalizeUrl(source.finalUrl || '')) || null;
    return {
      ...source,
      title: page?.title || source.title,
      description: page?.description || source.description || null,
      author: page?.author || source.author || null,
      publishedAt: page?.published_at || source.publishedAt || null,
      canonicalUrl: page?.canonical_url || null,
      language: page?.language || source.language || null,
      pageLinks: Array.isArray(page?.links) ? page.links : [],
      finalUrl: page?.final_url || source.finalUrl || source.url,
      contentAvailable: Boolean(page?.ok && page?.text),
      content: page?.text || null,
      contentWordCount: page?.word_count || 0,
      contentCharacterCount: page?.character_count || 0,
      contentFormat: page?.content_format || (page?.content_type?.includes('html') ? 'html' : 'unknown'),
      contentStatus: page?.ok
        ? (page.method || 'extracted')
        : page
          ? 'extraction-failed'
          : extraction?.requested === false || (requestedUrls && !requestedUrls.has(normalizeUrl(source.url)))
            ? 'not-requested'
            : 'not-found-or-fetch-failed',
      extractionQuality: page?.quality ?? null,
      httpStatus: page?.http_status ?? null,
      extraction: page ? { ok: page.ok, method: page.method, stages: page.stages, error: page.error || null, warnings: page.warnings || [] } : null,
      warnings: [...(source.warnings || []), ...(page?.warnings || [])]
    };
  });
  const extraPages = extracted.filter((page) => !rows.some((row) => normalizeUrl(row.url) === normalizeUrl(page.url)));
  for (const page of extraPages) {
    rows.push({
      ...makeDirectResult(page.url), title: page.title || hostOf(page.final_url || page.url),
      finalUrl: page.final_url || page.url, contentAvailable: Boolean(page.ok && page.text),
      content: page.text || null, contentWordCount: page.word_count || 0,
      contentCharacterCount: page.character_count || 0, contentFormat: page.content_format || 'unknown',
      contentStatus: page.ok ? (page.method || 'extracted') : 'extraction-failed',
      extractionQuality: page.quality ?? null, httpStatus: page.http_status ?? null,
      extraction: { ok: page.ok, method: page.method, stages: page.stages, error: page.error || null, warnings: page.warnings || [] },
      warnings: page.warnings || [], parentUrl: page.parent_url || null, crawlDepth: page.depth || 0
    });
  }
  // Detect near-identical extracted pages after fetch, not merely similar snippets.
  // The documents remain available; duplicate annotations let the agent de-weight them.
  const contentFingerprints = [];
  for (const row of rows) {
    if (!row.contentAvailable || !row.content) continue;
    const tokens = String(row.content).toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) || [];
    const shingles = new Set();
    for (let i = 0; i < tokens.length - 4 && shingles.size < 3000; i++) shingles.add(tokens.slice(i, i + 5).join(' '));
    let duplicate = null;
    for (const prior of contentFingerprints) {
      let overlap = 0;
      const [a, b] = shingles.size <= prior.shingles.size ? [shingles, prior.shingles] : [prior.shingles, shingles];
      for (const value of a) if (b.has(value)) overlap++;
      const similarity = overlap / (shingles.size + prior.shingles.size - overlap || 1);
      if (similarity >= 0.88 && Math.min(shingles.size, prior.shingles.size) / Math.max(shingles.size, prior.shingles.size, 1) >= 0.75) {
        duplicate = { url: prior.url, similarity: Number(similarity.toFixed(4)) };
        break;
      }
    }
    row.contentDuplicateOf = duplicate?.url || null;
    row.contentDuplicateSimilarity = duplicate?.similarity ?? null;
    if (!duplicate) contentFingerprints.push({ url: row.url, shingles });
  }
  const successful = rows.filter((r) => r.contentAvailable).length;
  const failedPages = rows.filter((r) => !r.contentAvailable && r.contentStatus !== 'not-requested').length;
  return {
    ok: true,
    version: VERSION,
    query: searchResult.query || null,
    queries: searchResult.agentQueries || [],
    mode: searchResult.mode || 'direct',
    generatedAt: new Date().toISOString(),
    latencyMs: Date.now() - started,
    search: searchResult,
    count: rows.length,
    successful,
    failed: failedPages,
    recursivePages: extraPages.length,
    contentRequested: extraction?.requested !== false,
    extraction: { ok: Boolean(extraction?.ok), count: extraction?.count || extracted.length, succeeded: extraction?.succeeded || 0, failed: extraction?.failed || 0, latencyMs: extraction?.latency_ms || 0, scheduler: extraction?.scheduler || null, error: extraction?.error || null },
    // Source content is carried once, inside results. This index keeps agent-side mapping lightweight.
    sourceDocuments: rows.map((r, index) => ({ index, url: r.url, finalUrl: r.finalUrl, title: r.title, contentAvailable: r.contentAvailable, contentWordCount: r.contentWordCount, contentFormat: r.contentFormat, extractionQuality: r.extractionQuality })),
    results: rows,
    warnings: [...(searchResult.warnings || []), ...(extraction?.error ? [extraction.error.message || extraction.error.code] : [])]
  };
}

export const RETRIEVAL_TESTING = Object.freeze({ normalizeUrl, makeDirectResult, buildResult });

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') { headers(res); res.statusCode = 204; return res.end(); }
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'METHOD_NOT_ALLOWED', message: 'Use POST with a JSON body.' });
  const started = Date.now();
  try {
    const input = await readBody(req);
    if (!input || typeof input !== 'object' || Array.isArray(input)) return send(res, 400, { ok: false, error: 'INVALID_INPUT', message: 'Send a JSON object.' });
    const rawUrls = Array.isArray(input.urls) ? input.urls : input.url ? [input.url] : [];
    const urls = [...new Set(rawUrls.map(normalizeUrl).filter(Boolean))];
    if (urls.length > MAX_URLS) return send(res, 413, { ok: false, error: 'TOO_MANY_URLS', message: `Maximum ${MAX_URLS} direct URLs per retrieval request.` });
    let searchResult;
    let extractionUrls;
    if (String(input.query ?? input.q ?? '').trim()) {
      searchResult = await runSearch(input);
      const fetchContent = input.fetchContent !== false;
      const fetchCount = clampInt(input.fetchCount, clampInt(input.count, DEFAULT_COUNT, 1, 40), 1, 40);
      extractionUrls = fetchContent ? (searchResult.results || []).slice(0, fetchCount).map((x) => x.url) : [];
      searchResult.results = (searchResult.results || []).slice(0, clampInt(input.count, DEFAULT_COUNT, 1, 40));
    } else if (urls.length) {
      searchResult = { ok: true, version: VERSION, query: null, mode: 'direct', generatedAt: new Date().toISOString(), results: urls.map(makeDirectResult), warnings: [] };
      extractionUrls = urls;
    } else {
      return send(res, 400, { ok: false, error: 'MISSING_QUERY_OR_URLS', message: 'Provide query/queries or urls.' });
    }
    if (extractionUrls.length > MAX_URLS) extractionUrls = extractionUrls.slice(0, MAX_URLS);
    const extraction = input.fetchContent === false
      ? { ok: true, requested: false, count: 0, succeeded: 0, failed: 0, results: [], latency_ms: 0 }
      : await invokeExtractor(req, extractionUrls, input, started);
    if (extraction.requested !== false) extraction.requestedUrls = extractionUrls;
    const result = buildResult(searchResult, extraction, urls.length > 0, started);
    const body = JSON.stringify(result);
    if (Buffer.byteLength(body) > MAX_OUTPUT_BYTES) {
      return send(res, 413, { ok: false, error: 'OUTPUT_TOO_LARGE', message: 'The complete extracted content exceeds the 4 MiB response budget. Reduce fetchCount/maxPages or explicitly supply maxText; content was not silently truncated.', outputBytes: Buffer.byteLength(body), maxOutputBytes: MAX_OUTPUT_BYTES });
    }
    headers(res);
    res.statusCode = 200;
    res.setHeader('content-length', Buffer.byteLength(body));
    res.end(body);
  } catch (error) {
    const status = error.message === 'REQUEST_BODY_TOO_LARGE' ? 413 : error.message === 'INVALID_JSON' ? 400 : 500;
    return send(res, status, { ok: false, error: error.message || 'RETRIEVAL_FAILED' });
  }
}
