import test from 'node:test';
import assert from 'node:assert/strict';
import { RETRIEVAL_TESTING } from '../api/retrieve.js';

const { normalizeUrl, makeDirectResult, buildResult } = RETRIEVAL_TESTING;

test('direct URL normalization removes fragments and rejects unsafe protocols and userinfo', () => {
  assert.equal(normalizeUrl('https://example.org/page#section'), 'https://example.org/page');
  assert.equal(normalizeUrl('file:///etc/passwd'), null);
  assert.equal(normalizeUrl('https://user:pass@example.org/'), null);
});

test('direct URL sources are marked unranked rather than assigned fabricated scores', () => {
  const row = makeDirectResult('https://example.org/path');
  assert.equal(row.relevanceScore, null);
  assert.equal(row.relevanceBand, 'not-ranked');
  assert.equal(row.authoritySignals.domainSignalOnly, true);
});

test('retrieval maps real extracted text and metadata onto ranked search sources', () => {
  const fullText = 'This is the complete page text that the extractor returned. It is not a search snippet.';
  const built = buildResult({
    query: ' exact agent query ',
    agentQueries: [' exact agent query '],
    mode: 'balanced',
    results: [{ url: 'https://example.org/a', title: 'Search title', relevanceScore: 76, source: 'google' }]
  }, {
    requested: true, ok: true, count: 1, succeeded: 1, failed: 0, latency_ms: 31,
    results: [{
      ok: true, url: 'https://example.org/a', final_url: 'https://example.org/a',
      title: 'Actual page title', description: 'Actual description', author: 'Author Name',
      published_at: '2025-05-01', canonical_url: 'https://example.org/canonical',
      language: 'en', http_status: 200, content_type: 'text/html', content_format: 'html',
      text: fullText, word_count: 16, character_count: fullText.length, quality: 91,
      method: 'full-static-extraction', stages: { fetch_ms: 5 }, warnings: [], links: []
    }]
  }, false, Date.now() - 100);
  assert.equal(built.results[0].content, fullText);
  assert.equal(built.results[0].title, 'Actual page title');
  assert.equal(built.results[0].author, 'Author Name');
  assert.equal(built.results[0].canonicalUrl, 'https://example.org/canonical');
  assert.equal(built.results[0].contentAvailable, true);
  assert.equal(built.results[0].extractionQuality, 91);
  assert.equal(built.results[0].contentStatus, 'full-static-extraction');
  assert.equal(built.contentRequested, true);
  assert.equal(built.successful, 1);
  assert.equal(built.failed, 0);
  assert.equal(built.sourceDocuments[0].contentWordCount, 16);
  assert.ok(built.latencyMs >= 0);
});

test('unrequested content is not counted as failed extraction', () => {
  const built = buildResult({ query: 'x', results: [{ url: 'https://example.org', title: 'Example' }] }, {
    requested: false, ok: true, results: [], succeeded: 0, failed: 0
  }, false, Date.now());
  assert.equal(built.contentRequested, false);
  assert.equal(built.results[0].contentStatus, 'not-requested');
  assert.equal(built.failed, 0);
});

test('near-identical extracted page bodies are annotated but content is retained', () => {
  const text = ('The crawler retrieves the original page content and returns structured source metadata for AI agent workflows. ').repeat(30);
  const built = buildResult({ query: 'crawler', results: [
    { url: 'https://a.example.org/page', title: 'A', relevanceScore: 90 },
    { url: 'https://b.example.org/page', title: 'B', relevanceScore: 80 }
  ] }, {
    requested: true, ok: true, results: [
      { ok: true, url: 'https://a.example.org/page', final_url: 'https://a.example.org/page', text, word_count: 300, quality: 90 },
      { ok: true, url: 'https://b.example.org/page', final_url: 'https://b.example.org/page', text, word_count: 300, quality: 90 }
    ]
  }, false, Date.now());
  assert.equal(built.results[0].content, text);
  assert.equal(built.results[1].content, text);
  assert.equal(built.results[1].contentDuplicateOf, 'https://a.example.org/page');
  assert.ok(built.results[1].contentDuplicateSimilarity >= 0.88);
});

test('results outside fetchCount are marked not-requested, not failed', () => {
  const built = buildResult({
    query: 'crawler',
    results: [
      { url: 'https://example.org/one', title: 'One' },
      { url: 'https://example.org/two', title: 'Two' },
      { url: 'https://example.org/three', title: 'Three' }
    ]
  }, {
    requested: true,
    requestedUrls: ['https://example.org/one'],
    ok: true,
    results: [{ ok: true, url: 'https://example.org/one', final_url: 'https://example.org/one', text: 'Retrieved page body', word_count: 3 }],
    succeeded: 1,
    failed: 0
  }, false, Date.now());
  assert.equal(built.results[0].contentStatus, 'extracted');
  assert.equal(built.results[1].contentStatus, 'not-requested');
  assert.equal(built.results[2].contentStatus, 'not-requested');
  assert.equal(built.successful, 1);
  assert.equal(built.failed, 0);
});
