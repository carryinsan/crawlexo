# Arix Crawler 4.0

**AI-agent-first web search, source ranking, full-page retrieval and bounded recursive crawling.** The AI agent owns query generation. Arix Crawler receives the agent's exact query or URL list and focuses on retrieval quality, page content, provenance, diagnostics and safe execution.

## Project contents

This package combines the uploaded JavaScript search project and Rust crawler project. The complete original source trees are retained under `originals/`; active, consolidated files live at the project root.

## Active architecture

- `api/search.js` — Node.js multi-provider search and ranking.
- `api/retrieve.js` — agent-facing orchestration: exact-query search, ranked source selection, Rust extraction and one structured result.
- `api/extract.rs` — Rust HTTP retrieval, SSRF/redirect checks, robots policy, HTML/document extraction and breadth-first crawl.
- `index.html` — combined search + full-content retrieval console.
- `extractor.html` — legacy extraction console adapted to the real retrieval API.
- `search-console.html` — search-only diagnostics console.
- `originals/` — unmodified copies of both uploaded source archives.

## Search providers

The active search engine includes public search surfaces for Google, Bing, Brave, Bing RSS, Google News RSS and YouTube (when video is explicitly selected), plus opt-in API adapters for OpenAlex, Crossref, Europe PMC and arXiv. The academic adapters call their public metadata APIs; they do not fetch paywalled paper bodies by themselves.

The engine preserves the provided query string. It does not generate synonyms, correct spelling, rewrite the query or decompose it into new questions. Multiple queries are executed only when the caller explicitly supplies them in `queries`.

Search-provider HTML layouts and throttling policies can change. Provider errors are reported in `providers` and `warnings`; the crawler does not bypass consent pages, CAPTCHAs or other access controls.

## Retrieval and ranking

Implemented ranking signals include:

- Field-weighted BM25-style lexical matching over result title, headings/snippet and available preview text.
- Exact quoted-phrase matching and term coverage/proximity-related signals.
- Reciprocal Rank Fusion using original per-provider positions.
- MMR-style greedy diversification with repeated-domain penalties.
- SimHash and MinHash/Jaccard similarity signals over indexed title/snippet text.
- Freshness and domain-indicator signals.
- Post-fetch five-token-shingle similarity annotations over actual extracted page content.

The numeric relevance and domain values are heuristic ranking signals, not calibrated probabilities or independent proof that a publisher is trustworthy. `authoritySignals.domainSignalOnly` explicitly labels the domain indicators as domain-only signals.

Optional Groq reranking is available when configured and requested. It is an external LLM reranker, **not** a cross-encoder. No dense-vector or locally hosted cross-encoder is included.

## Extraction and crawling

The Rust extractor supports:

| Format | Current behavior |
|---|---|
| HTML/XHTML | Static DOM text, headings, paragraphs, links, selected metadata and dynamic-shell warnings |
| PDF | Embedded text extraction via `pdf-extract`; scanned-page OCR is not included |
| DOCX | Text from document, footnotes and endnotes XML |
| PPTX | Text from slide XML, ordered by slide number |
| XLSX | Shared strings and worksheet XML text; not a fully reconstructed workbook model |
| TXT / Markdown / XML / CSV | Text retrieval; valid JSON is pretty-printed |
| RSS / Atom | Feed-level metadata and readable item/entry summaries, links and publication fields where present |

HTML extraction is static. JavaScript is not executed and browser-rendered page bodies are not included. PDF tables, Office styling, workbook formulas/cell types, embedded media, and document layout are not reconstructed as fully typed structures. OCR is not bundled.

Recursive crawling is explicitly caller-controlled through `depth`, `max_pages` and `same_domain`. It uses bounded breadth-first scheduling, a global per-process semaphore and per-host concurrency controls. Links are deduplicated and each target/redirect is revalidated before fetching.

## API endpoints

### `POST /api/search` — discovery only

```json
{
  "query": "\"RBI monetary policy\" AND repo rate -site:example.com",
  "queries": ["\"RBI monetary policy\" AND repo rate -site:example.com"],
  "providers": ["google", "bing", "brave"],
  "sources": ["openalex", "crossref"],
  "type": "web",
  "mode": "deep",
  "count": 20,
  "includeDomains": ["rbi.org.in"],
  "excludeDomains": ["example.com"],
  "dateAfter": "2025-01-01",
  "dateBefore": "2026-12-31"
}
```

Returns search metadata, provider diagnostics, per-provider ranks and ranking signals. It does not promise full page content.

### `POST /api/retrieve` — recommended agent endpoint

Accepts the search fields above plus:

- `fetchContent` (default `true`)
- `fetchCount` (1–40)
- `depth` (0–3)
- `maxPages` (up to 100 in the Rust endpoint; the combined endpoint is constrained by its 40-URL input cap)
- `sameDomain` (default `true`)
- `maxText` (optional explicit per-page text cap)
- `includeAiContext` (optional duplicate source-prefixed context field from Rust; the default response keeps text once in `results`)

The response includes `search`, `providers`, `results`, `sourceDocuments`, `extraction`, `warnings`, latency, page HTTP status, extracted format, quality score and extraction-stage diagnostics. The page text itself appears in each `results[].content` exactly once.

### `POST /api/extract` — direct URL extraction / recursive crawl

```json
{
  "urls": ["https://example.org/article", "https://example.org/report.pdf"],
  "depth": 1,
  "max_pages": 10,
  "same_domain": true,
  "include_ai_context": false
}
```

`POST /api/crawl` is a compatibility alias for `/api/extract`. The legacy `/api/crawler` alias maps to `/api/search` (the earlier JavaScript search contract); use the explicit endpoints for new integrations.

## Search input options

- `query`: one exact query string.
- `queries`: up to eight caller-supplied query strings. No additional variants are generated.
- `providers`: `google`, `bing`, `brave`, `google-news`, `youtube`.
- `sources`: `openalex`, `crossref`, `europepmc`, `pubmed`, `arxiv`.
- `type`: `web`, `news`, `academic`, `doc`, `gov`, `video`.
- `mode`: `quick`, `balanced`, `deep`, `maximum` (controls provider pagination/search effort, not query generation).
- `includeDomains`/`domains`, `excludeDomains`, `dateAfter`, `dateBefore`, `language`, `country`.

Provider-specific query parameters are applied where a provider supports them. Date and language filters depend on metadata supplied by the source; records without a publication date are excluded when a date range is requested. `language` is only enforceable when a result carries language metadata.

## Safety, resource and platform limits

- Only HTTP(S) fetch targets are accepted; userinfo URLs, local/private/reserved IPs and unsupported ports are rejected.
- DNS results are resolved and the selected public address is pinned into the HTTP client; each redirect destination is revalidated.
- `robots.txt` rules are consulted and cached per origin. Unavailable 4xx robots files are treated as unavailable; access-denied or server-error robots responses conservatively disallow fetching.
- Redirects, request timeouts, response bytes, URLs per request, concurrent fetches and batch content are bounded.
- The Rust response has a 3.5 MB JSON cap and a 2.5 MB aggregate text budget; the Node orchestrator has a 4 MB output guard. Oversize batches return an explicit error rather than silently truncating page text.
- A per-page response is limited to 12 MiB. Large pages/documents may return `RESPONSE_TOO_LARGE` or a batch content-budget error.
- Page fetch failures are represented in the batch response; one page failure does not cancel unrelated page results.

No attempt is made to bypass CAPTCHAs, authentication, paywalls, bot protections, access denials or robots rules.

## Features not included / not claimed

The following parts of a broader future specification are **not** implemented in this package, and are not represented by dummy features:

- Browser-based JavaScript rendering / headless Chrome.
- OCR for scanned PDFs.
- Full structured table reconstruction for PDF/Office documents.
- General-purpose official government API catalog or generic public-dataset index. Those APIs differ by institution and must be selected/configured individually.
- General institutional feed registry. Caller-specified RSS/Atom URLs can be crawled; the built-in search feeds are Google News and Bing RSS.
- Common Crawl as a general search engine. The existing Common Crawl facility is an optional URL-index/metadata lookup for already discovered URLs.
- Local dense-vector or cross-encoder semantic reranking. Optional Groq reranking is external LLM ranking, not a cross-encoder.
- ETag/Last-Modified conditional revalidation and distributed persistent caching. Current caches are process-local and ephemeral.
- Built-in API-key authentication, per-user quotas, WAF or durable global rate limiting.
- Fully exhaustive source discovery. Public search providers can return fewer results or reject automated requests.

These are intentionally disclosed instead of simulated.

## Run checks locally

Node.js 20+:

```bash
npm run build
```

Rust stable toolchain:

```bash
cargo fmt --all -- --check
cargo test --bin arix-extract
cargo check --bin arix-extract
cargo build --release --bin arix-extract
```

A Rust toolchain is needed to verify the extraction binary. If it is unavailable in the build environment, Rust compilation/testing remains unverified even when JavaScript checks pass.

## Deploy

The root `vercel.json` sets function duration limits and compatibility rewrites. Node.js handlers are auto-detected; the Rust handler uses Vercel’s official Rust runtime through `vercel_runtime` 2.x and the root `Cargo.toml`. Root HTML files are served as static assets. Import the **project root** (the directory containing `vercel.json`, `Cargo.toml` and `package.json`). Rust custom-runtime availability and platform duration/body limits must be confirmed in the target Vercel project before production use.

No API key is required for the default public-source adapters. Optional Groq reranking requires `GROQ_API_KEY` and an explicit reranking request.
