# Implemented features and explicit boundaries

This document distinguishes implemented code paths from aspirational roadmap items.

## Implemented in this package

- AI-agent-first exact query input; no query generation, rewriting, synonym expansion, spelling correction or decomposition.
- Up to eight explicitly supplied queries per search call.
- Google, Bing, Brave, Bing RSS, Google News RSS and YouTube public search surfaces.
- OpenAlex, Crossref, Europe PMC and arXiv public metadata adapters.
- Provider pagination controlled by quick/balanced/deep/maximum modes.
- Domain allow/deny filters, source type filters, publication date filters, and provider language/country parameters when supported.
- BM25F-style field matching, phrase and token matching signals, RRF, MMR-style diversity selection, SimHash/MinHash/Jaccard signals and post-fetch content shingle similarity labels.
- Full static HTML extraction plus supported document format text extraction.
- Bounded breadth-first recursive crawl with same-domain option, sitemap/feed autodiscovery is not yet generic; caller can supply exact feed or sitemap URLs as starting URLs.
- SSRF defenses, redirect validation, public IP pinning, robots checks, response/input limits and per-page error isolation.
- Machine-readable API results and extraction diagnostics.

## Not implemented

- Query understanding or AI agent planning (intentionally excluded).
- Query expansion or autonomous query variants (intentionally excluded).
- A trained cross-encoder/dense reranker.
- JavaScript-capable browser rendering.
- OCR.
- Full semantic extraction of PDF tables, spreadsheet formulas, workbook relationships, and document presentation layout.
- Universal official government API and dataset adapters.
- Universal institution-specific RSS catalog.
- Common Crawl query retrieval or a guaranteed archived page body.
- Distributed persistent cache or conditional ETag/Last-Modified revalidation.
- Durable rate limiting, API-key management or user authentication.

## Quality interpretation

Relevance/authority/freshness scores are ranking heuristics. Domain signals indicate domain class and metadata; they are not a guarantee of publisher trustworthiness, factual correctness or source independence. `nearDuplicateOf` and post-fetch duplicate labels are suggestions for downstream handling, not evidence that two pages are identical in every respect.

## Deployment verification

JavaScript build/test checks can run without the Rust toolchain. Rust formatting, compilation and Rust unit tests must be executed with Cargo on the target build pipeline. A green Node-only test suite is not a green end-to-end crawler build.
