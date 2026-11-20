import test from 'node:test';
import assert from 'node:assert/strict';
import { SEARCH_TESTING } from '../api/search.js';

const { queryPlan, buildQueries, providerRequests, bm25FieldScore, fusionRank, simHash64, hamming64, jaccardTokens, minHashSignature, minHashSimilarity, filterCandidateSet } = SEARCH_TESTING;

test('agent query is preserved exactly; no expansion or decomposition occurs', () => {
  const query = '  "RBI monetary policy" AND (repo rate OR liquidity) -site:example.com  ';
  const additional = 'Crossref DOI retrieval & scholarly metadata';
  const plan = queryPlan(query, { mode: 'deep', type: 'web', agentQueries: [query, additional] });
  assert.equal(plan.query, query);
  assert.deepEqual(buildQueries(query, plan), [query, additional]);
});

test('search URLs retain the exact query after URL decoding', () => {
  const query = '"RBI policy" AND repo-rate -site:test.in';
  const plan = queryPlan(query, { mode: 'quick', type: 'web', agentQueries: [query] });
  const requests = providerRequests([query], plan, false, { providers: ['google', 'bing', 'brave'], mode: 'quick' });
  assert.ok(requests.length >= 3);
  for (const request of requests) {
    const url = new URL(request.url);
    assert.equal(url.searchParams.get('q'), query);
  }
});

test('retrieval modes increase pagination without rewriting query strings', () => {
  const query = 'exact search syntax filetype:pdf';
  const plan = queryPlan(query, { type: 'web' });
  const quick = providerRequests([query], plan, false, { providers: ['google', 'bing', 'brave'], mode: 'quick' });
  const deep = providerRequests([query], plan, true, { providers: ['google', 'bing', 'brave'], mode: 'deep' });
  assert.ok(deep.length > quick.length);
  assert.ok(deep.every((r) => new URL(r.url).searchParams.get('q') === query));
});

test('specialized source adapters are opt-in and generate source-specific requests', () => {
  const query = 'graph neural network retrieval';
  const plan = queryPlan(query, { type: 'academic' });
  const requests = providerRequests([query], plan, false, { providers: [], sources: ['openalex', 'crossref', 'europepmc', 'arxiv'] });
  assert.deepEqual(new Set(requests.map((x) => x.provider)), new Set(['openalex', 'crossref', 'europepmc', 'arxiv']));
  assert.ok(requests.every((r) => r.type === 'academic'));
});

test('BM25F-style field scoring rewards title and heading matches over snippets', () => {
  const plan = queryPlan('quantum computing error correction', { type: 'web' });
  const results = [
    { title: 'Quantum computing error correction', snippet: 'Overview' },
    { title: 'Computing overview', snippet: 'Quantum computing error correction' }
  ];
  const scores = bm25FieldScore(results, plan);
  assert.ok(scores[0] > scores[1]);
});

test('SimHash and MinHash recognize identical and near-identical text', () => {
  const a = 'Quantum computing error correction uses logical qubits and fault tolerant gate operations';
  const b = 'Quantum computing error correction uses logical qubits and fault tolerant gate operations';
  const c = 'A recipe for lemon cake with butter sugar flour and eggs';
  assert.equal(simHash64(a), simHash64(b));
  assert.equal(hamming64(simHash64(a), simHash64(b)), 0);
  assert.equal(minHashSimilarity(minHashSignature(a), minHashSignature(b)), 1);
  assert.ok(jaccardTokens(a, b) > jaccardTokens(a, c));
});

test('RRF/MMR fusion returns ranked sources and annotates repeated-domain alternatives', () => {
  const plan = queryPlan('federated search retrieval ranking algorithms', { type: 'web' });
  const rows = [
    { title: 'Federated search retrieval ranking algorithms', url: 'https://a.example.org/a', snippet: 'Federated search retrieval ranking algorithms in practice', source: 'google', providerRank: 1, providerRanks: { google: 1, bing: 2 }, providers: ['google', 'bing'] },
    { title: 'Federated search retrieval ranking algorithms guide', url: 'https://a.example.org/b', snippet: 'Federated search retrieval ranking algorithms examples and design', source: 'bing', providerRank: 2, providerRanks: { bing: 2 }, providers: ['bing'] },
    { title: 'Federated retrieval ranking methods', url: 'https://b.example.net/paper', snippet: 'Methods for federated retrieval ranking with evidence', source: 'openalex', providerRank: 1, providerRanks: { openalex: 1 }, providers: ['openalex'] }
  ];
  const ranked = fusionRank(rows, plan);
  assert.equal(ranked.length, 3);
  assert.ok(ranked[0].relevanceScore >= ranked[1].relevanceScore);
  assert.ok(ranked.every((row) => typeof row.simHash === 'string'));
});

test('domain and date filters are applied without changing the original query', () => {
  const plan = queryPlan('sample topic', { type: 'web' });
  const rows = [
    { url: 'https://www.gov.in/a', publishedAt: '2025-01-01' },
    { url: 'https://example.org/b', publishedAt: '2025-01-01' },
    { url: 'https://example.com/c', publishedAt: '2020-01-01' }
  ];
  const filtered = filterCandidateSet(rows, { includeDomains: ['gov.in', 'example.org'], excludeDomains: ['example.org'], dateAfter: '2024-01-01' }, plan);
  assert.deepEqual(filtered.map((x) => x.url), ['https://www.gov.in/a']);
});
