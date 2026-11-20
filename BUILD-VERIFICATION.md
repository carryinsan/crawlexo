# Arix Crawler 4.0 — Build verification record

Verification date: 2026-11-20

## Checks run in the packaging environment

| Check | Result |
|---|---|
| Node.js runtime | Node v22.16.0 available |
| `npm run check` | Passed; syntax checked 2 Node API modules and 3 HTML console scripts |
| `npm test` | Passed; 14 tests, 0 failures |
| `npm run build` | Passed; syntax checks, 14 tests, and static output packaging completed |
| Vercel `public/` output | Passed; all 3 published HTML files are byte-for-byte copies of the root source pages |
| `vercel.json` JSON parse | Passed |
| `package.json` JSON parse | Passed |
| Original archive preservation | Passed; all 17 original non-directory files were compared byte-for-byte against the uploaded ZIPs using SHA-256 |
| ZIP archive integrity | Run after packaging; result recorded in delivery response |

## Checks not run

The packaging environment does not contain `cargo`, `rustc`, `rustfmt` or the Vercel CLI, and the Rust toolchain could not be downloaded because external DNS/network access was unavailable. Consequently, the Rust extractor has **not** been compiled, formatted or unit-tested in this environment, and no live Vercel deployment has been run. The GitHub Actions workflow `.github/workflows/verify.yml` is configured to run Rust formatting, tests, check and release build on a Rust-enabled runner.

No production-provider request, multi-provider integration test, or real-world crawl benchmark was executed. Search provider pages and availability can change or throttle automated requests. A green Node test suite is not proof of an error-free end-to-end deployment.

## Known implementation boundaries

See `docs/FEATURES-AND-LIMITATIONS.md` and the README. In particular, this version does not include browser-based JavaScript rendering, OCR, a trained cross-encoder/dense reranker, universal government API and dataset connectors, a universal institutional feed catalog, a distributed persistent cache, durable rate limiting, or full structured reconstruction of PDF/Office tables and layouts. Common Crawl is an optional URL-index lookup for already discovered URLs, not a general query-search provider.

No guarantee of zero defects is made. Run the Rust CI checks and deploy to a staging Vercel project before production use.
