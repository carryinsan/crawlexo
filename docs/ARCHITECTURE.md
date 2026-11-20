# Architecture

```text
AI agent
  | exact query / URL list + explicit retrieval controls
  v
/api/retrieve (Node.js orchestration)
  |-- /api/search (Node.js provider fan-out + ranking)
  |       |-- Google / Bing / Brave / RSS / YouTube
  |       |-- OpenAlex / Crossref / Europe PMC / arXiv
  |       `-- RRF + BM25F-style scoring + MMR + duplicate signals
  |
  `-- /api/extract (Rust fetch + extraction + bounded BFS)
          |-- HTTP(S) validation / DNS pinning / redirect checks
          |-- robots rules / per-host and global gates
          |-- HTML / PDF / Office / text / JSON / CSV / XML / RSS / Atom
          `-- structured page results + diagnostics
  v
Agent receives source metadata + full extracted content where available
```

The search service remains independent from page extraction: `/api/search` does not promise page text. `/api/retrieve` composes the two. `/api/extract` accepts direct URLs. The previous `/api/crawler` path collision is avoided by explicit endpoints; the compatibility alias `/api/crawler` maps to search only.

The Rust process uses in-memory per-process caches/semaphores. Serverless instances are ephemeral; these caches are not a shared distributed storage layer.
