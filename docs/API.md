# Arix Crawler 4.0 API

All request bodies are JSON. Use POST for agent integrations.

## `POST /api/search`

Search-only. The exact `query` is sent to selected providers; the `queries` list is executed only as supplied (maximum eight). Returns ranked metadata and provider diagnostics.

## `POST /api/retrieve`

Recommended single-call workflow. Searches, ranks, extracts content for the top `fetchCount` URLs and returns:

- `search`: original search response and provider diagnostics.
- `results`: ranked sources with full extracted text (when retrieval succeeded).
- `sourceDocuments`: lightweight index mapping result positions to URLs and extraction metadata.
- `extraction`: batch statistics.
- `warnings`: provider and extraction failures.

Search body fields: `query`, `queries`, `providers`, `sources`, `type`, `mode`, `count`, `includeDomains`, `excludeDomains`, `dateAfter`, `dateBefore`, `language`, `country`.

Retrieval fields: `fetchContent`, `fetchCount`, `depth`, `maxPages`, `sameDomain`, `maxText`, `includeAiContext`.

## `POST /api/extract`

Direct retrieval. Provide `url` or `urls`; optional `max_text`, `depth`, `max_pages`, `same_domain`, `include_ai_context`.

Example:

```json
{
  "urls": ["https://example.org/"],
  "depth": 1,
  "max_pages": 8,
  "same_domain": true
}
```

## Errors

Errors are JSON and carry stable error codes where applicable, including `INVALID_JSON`, `REQUEST_TOO_LARGE`, `NO_URLS`, `TOO_MANY_URLS`, `PRIVATE_OR_RESERVED_IP`, `ROBOTS_DISALLOWED`, `RESPONSE_TOO_LARGE`, `PDF_TEXT_EXTRACTION_FAILED`, `BATCH_CONTENT_BUDGET_EXCEEDED` and `OUTPUT_TOO_LARGE`.

A page failure is returned as a page result with `ok: false`, error code, retryability and warnings. The batch endpoint may still return HTTP 200 if some pages succeed and others fail.
