use std::{
    collections::{HashMap, HashSet, VecDeque},
    io::{Cursor, Read},
    net::{IpAddr, SocketAddr},
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, Instant},
};

use anyhow::{anyhow, Context, Result};
use futures_util::{stream, StreamExt};
use http_body_util::BodyExt;
use reqwest::{header, Client, StatusCode};
use scraper::{ElementRef, Html, Selector};
use serde::{Deserialize, Serialize};
use tokio::{net::lookup_host, sync::Semaphore};
use url::Url;
use zip::ZipArchive;
use vercel_runtime::{run, service_fn, Error, Request, Response, ResponseBody};

// IMPORTANT: these are safety bounds, not text-extraction truncation limits.
// The extractor reads the entire response up to MAX_HTML_BYTES, then walks the
// entire DOM without a MAX_TEXT/character cutoff.
const MAX_REDIRECTS: usize = 8;
const MAX_HTML_BYTES: usize = 12 * 1024 * 1024;
const MAX_OUTPUT_BYTES: usize = 3_500_000;
const MAX_BATCH_CONTENT_BYTES: usize = 2_500_000;
const MAX_URL_LEN: usize = 4096;
const MAX_INPUT_BYTES: usize = 1024 * 1024;
const MAX_URLS_PER_REQUEST: usize = 100;
const MAX_CRAWL_PAGES: usize = 100;
const MAX_CRAWL_DEPTH: usize = 3;
const MAX_CRAWL_CONCURRENCY: usize = 4;
const MAX_HOST_CONCURRENCY: usize = 2;
const MAX_OOXML_TOTAL_BYTES: usize = 24 * 1024 * 1024;
const MAX_OOXML_ENTRY_BYTES: usize = 8 * 1024 * 1024;
const ROBOTS_MAX_BYTES: usize = 512 * 1024;
const SCHEDULER_CEILING: usize = 16;
const FETCH_TIMEOUT_SECS: u64 = 10;
const CONNECT_TIMEOUT_SECS: u64 = 4;
const USER_AGENT: &str = "ArixCrawler/4.0 (+https://github.com/carryinsan/Arix-Crawler)";

// Per-process gates protect the serverless instance. The HTTP request itself is capped at 100 URLs, but
// the scheduler can safely accommodate many callers without a hard-coded
// 16-request bottleneck from the earlier version.
static GLOBAL_GATE: OnceLock<Arc<Semaphore>> = OnceLock::new();
static HOST_GATES: OnceLock<Mutex<HashMap<String, Arc<Semaphore>>>> = OnceLock::new();
static CLIENT_CACHE: OnceLock<Mutex<HashMap<String, Client>>> = OnceLock::new();
static ROBOTS_CACHE: OnceLock<Mutex<HashMap<String, (Instant, Vec<(bool, String)>)>>> = OnceLock::new();

#[derive(Debug, Deserialize)]
struct CrawlRequest {
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    urls: Option<Vec<String>>,
    #[serde(default)]
    max_text: Option<usize>,
    #[serde(default)]
    include_ai_context: bool,
    #[serde(default)]
    depth: Option<usize>,
    #[serde(default)]
    max_pages: Option<usize>,
    #[serde(default)]
    same_domain: Option<bool>,
}

#[derive(Debug, Serialize, Clone)]
struct CrawlResponse {
    ok: bool,
    url: String,
    final_url: Option<String>,
    title: Option<String>,
    description: Option<String>,
    language: Option<String>,
    content_type: Option<String>,
    content_format: Option<String>,
    author: Option<String>,
    published_at: Option<String>,
    canonical_url: Option<String>,
    http_status: Option<u16>,
    text: Option<String>,
    links: Vec<String>,
    depth: usize,
    parent_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    ai_context: Option<String>,
    word_count: usize,
    character_count: usize,
    source_html_bytes: usize,
    quality: u8,
    method: String,
    latency_ms: u128,
    stages: Stages,
    warnings: Vec<String>,
    error: Option<Failure>,
}

#[derive(Debug, Default, Serialize, Clone)]
struct Stages {
    validation_ms: u128,
    dns_ms: u128,
    fetch_ms: u128,
    redirect_ms: u128,
    read_ms: u128,
    parse_ms: u128,
    extraction_ms: u128,
    audit_ms: u128,
}

#[derive(Debug, Serialize, Clone)]
struct Failure {
    code: String,
    message: String,
    retryable: bool,
}

#[derive(Debug, Serialize)]
struct BatchResponse {
    ok: bool,
    count: usize,
    succeeded: usize,
    failed: usize,
    latency_ms: u128,
    scheduler: SchedulerInfo,
    results: Vec<CrawlResponse>,
}

#[derive(Debug, Serialize)]
struct SchedulerInfo {
    requested: usize,
    max_urls_per_request: usize,
    concurrency_ceiling: usize,
    strategy: &'static str,
}

#[derive(Debug)]
struct SafeTarget {
    url: Url,
    ip: IpAddr,
}

#[derive(Debug)]
struct FetchResult {
    response: reqwest::Response,
    final_target: SafeTarget,
    redirect_count: usize,
    redirect_ms: u128,
    dns_ms: u128,
}

#[derive(Debug, Default)]
struct ExtractionStats {
    emitted_blocks: usize,
    emitted_words: usize,
    skipped_noise_nodes: usize,
    hidden_nodes: usize,
    paragraphs: usize,
    headings: usize,
    links: usize,
}

#[tokio::main]
async fn main() -> Result<(), Error> {
    run(service_fn(handler)).await
}

async fn handler(req: Request) -> Result<Response<ResponseBody>, Error> {
    if req.method() == http::Method::OPTIONS {
        return Ok(Response::builder()
            .status(http::StatusCode::NO_CONTENT)
            .header("access-control-allow-origin", "*")
            .header("access-control-allow-methods", "POST, OPTIONS")
            .header("access-control-allow-headers", "content-type")
            .header("cache-control", "no-store")
            .body(ResponseBody::from(Vec::new()))?);
    }

    if req.method() != http::Method::POST {
        return json_response(405, &serde_json::json!({
            "ok": false,
            "error": {"code": "METHOD_NOT_ALLOWED"}
        }));
    }

    let started = Instant::now();
    let body = match req.into_body().collect().await {
        Ok(collected) => collected.to_bytes(),
        Err(_) => {
            return json_response(400, &serde_json::json!({
                "ok": false,
                "error": {"code": "INVALID_BODY", "message": "Could not read request body"}
            }))
        }
    };

    if body.len() > MAX_INPUT_BYTES {
        return json_response(413, &serde_json::json!({
            "ok": false,
            "error": {"code": "REQUEST_TOO_LARGE", "message": "Request body is too large"}
        }));
    }

    let input: CrawlRequest = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(_) => {
            return json_response(400, &serde_json::json!({
                "ok": false,
                "error": {
                    "code": "INVALID_JSON",
                    "message": "Send JSON: { url: string } or { urls: string[] }"
                }
            }))
        }
    };

    let mut urls = Vec::new();
    for entry in input.urls.unwrap_or_default() {
        split_url_field(&entry, &mut urls);
    }
    if let Some(u) = input.url {
        split_url_field(&u, &mut urls);
    }

    let mut normalized = Vec::with_capacity(urls.len().min(MAX_URLS_PER_REQUEST));
    let mut seen = HashSet::new();
    for raw in urls {
        let u = raw.trim().to_string();
        if u.is_empty() || u.len() > MAX_URL_LEN {
            continue;
        }
        if seen.insert(u.clone()) {
            normalized.push(u);
        }
    }

    if normalized.is_empty() {
        return json_response(400, &serde_json::json!({
            "ok": false,
            "error": {"code": "NO_URLS", "message": "Provide at least one HTTP(S) URL"}
        }));
    }

    if normalized.len() > MAX_URLS_PER_REQUEST {
        return json_response(413, &serde_json::json!({
            "ok": false,
            "error": {
                "code": "TOO_MANY_URLS",
                "message": format!("Maximum {} URLs per request", MAX_URLS_PER_REQUEST)
            }
        }));
    }

    // Full extraction is the default. A caller-provided max_text is explicit and is reported.
    let max_text = input.max_text;
    let include_ai_context = input.include_ai_context;
    let requested = normalized.len();
    let depth_limit = input.depth.unwrap_or(0).min(MAX_CRAWL_DEPTH);
    let same_domain = input.same_domain.unwrap_or(true);
    let max_pages = input.max_pages.unwrap_or(requested).max(requested).min(MAX_CRAWL_PAGES);

    let gate = GLOBAL_GATE
        .get_or_init(|| Arc::new(Semaphore::new(SCHEDULER_CEILING)))
        .clone();

    let mut queue: VecDeque<(String, usize, Option<String>, String)> = VecDeque::new();
    let mut seen = HashSet::new();
    for raw in normalized {
        let root_host = Url::parse(&raw).ok().and_then(|u| u.host_str().map(str::to_ascii_lowercase)).unwrap_or_default();
        if seen.insert(raw.clone()) {
            queue.push_back((raw, 0, None, root_host));
        }
    }

    eprintln!(
        "{{\"event\":\"batch_start\",\"requested\":{},\"max_pages\":{},\"depth\":{},\"concurrency\":{}}}",
        requested, max_pages, depth_limit, MAX_CRAWL_CONCURRENCY
    );

    let mut results: Vec<CrawlResponse> = Vec::new();
    let mut accumulated_content_bytes = 0usize;
    while !queue.is_empty() && results.len() < max_pages {
        let batch_size = MAX_CRAWL_CONCURRENCY.min(max_pages - results.len());
        let mut batch = Vec::with_capacity(batch_size);
        for _ in 0..batch_size {
            if let Some(item) = queue.pop_front() { batch.push(item); } else { break; }
        }

        let pages = stream::iter(batch.into_iter().map(|(url, page_depth, parent_url, root_host)| {
            let gate = gate.clone();
            async move {
                let _permit = match gate.acquire_owned().await {
                    Ok(p) => p,
                    Err(_) => return (failed_response(url, "CRAWLER_SHUTDOWN", "Crawler scheduler is unavailable", false), root_host),
                };
                let page = crawl_one(&url, max_text, include_ai_context, page_depth, parent_url).await;
                (page, root_host)
            }
        }))
        .buffer_unordered(MAX_CRAWL_CONCURRENCY)
        .collect::<Vec<_>>()
        .await;

        for (page, root_host) in pages {
            if page.ok && page.depth < depth_limit && results.len() + queue.len() < max_pages {
                let parent = page.final_url.clone().unwrap_or_else(|| page.url.clone());
                for link in page.links.iter() {
                    if results.len() + queue.len() >= max_pages { break; }
                    let normalized_link = match normalize_public_link(link) { Some(v) => v, None => continue };
                    if same_domain {
                        let host = Url::parse(&normalized_link).ok().and_then(|u| u.host_str().map(str::to_ascii_lowercase)).unwrap_or_default();
                        if host != root_host { continue; }
                    }
                    if seen.insert(normalized_link.clone()) {
                        queue.push_back((normalized_link, page.depth + 1, Some(parent.clone()), root_host.clone()));
                    }
                }
            }
            accumulated_content_bytes = accumulated_content_bytes.saturating_add(page.text.as_ref().map(|x| x.len()).unwrap_or(0));
            if accumulated_content_bytes > MAX_BATCH_CONTENT_BYTES {
                return json_response(413, &serde_json::json!({
                    "ok": false,
                    "error": {
                        "code": "BATCH_CONTENT_BUDGET_EXCEEDED",
                        "message": "Complete extracted content exceeds the 2.5 MB batch text budget. Reduce fetchCount/maxPages or explicitly set max_text. No page text was silently truncated.",
                        "max_content_bytes": MAX_BATCH_CONTENT_BYTES
                    }
                }));
            }
            results.push(page);
            if results.len() >= max_pages { break; }
        }
    }

    let succeeded = results.iter().filter(|r| r.ok).count();
    let failed = results.len().saturating_sub(succeeded);

    eprintln!(
        "{{\"event\":\"batch_end\",\"requested\":{},\"succeeded\":{},\"failed\":{},\"latency_ms\":{}}}",
        requested, succeeded, failed, started.elapsed().as_millis()
    );

    json_response(
        200,
        &BatchResponse {
            ok: failed == 0,
            count: results.len(),
            succeeded,
            failed,
            latency_ms: started.elapsed().as_millis(),
            scheduler: SchedulerInfo {
                requested,
                max_urls_per_request: MAX_URLS_PER_REQUEST,
                concurrency_ceiling: MAX_CRAWL_CONCURRENCY,
                strategy: "bounded breadth-first crawl with global/per-host gates and page isolation",
            },
            results,
        },
    )
}

async fn crawl_one(raw: &str, max_text: Option<usize>, include_ai_context: bool, depth: usize, parent_url: Option<String>) -> CrawlResponse {
    let started = Instant::now();
    let host = Url::parse(raw).ok().and_then(|u| u.host_str().map(str::to_ascii_lowercase)).unwrap_or_default();
    let host_gate = {
        let map = HOST_GATES.get_or_init(|| Mutex::new(HashMap::new()));
        let mut guard = map.lock().unwrap_or_else(|e| e.into_inner());
        guard.entry(host).or_insert_with(|| Arc::new(Semaphore::new(MAX_HOST_CONCURRENCY))).clone()
    };
    let _host_permit = match host_gate.acquire_owned().await {
        Ok(p) => p,
        Err(_) => return failed_response(raw.to_string(), "HOST_SCHEDULER_UNAVAILABLE", "Per-host scheduler unavailable", true),
    };
    match crawl(raw, max_text, include_ai_context).await {
        Ok(mut out) => {
            out.latency_ms = started.elapsed().as_millis();
            out.depth = depth;
            out.parent_url = parent_url;
            eprintln!(
                "{{\"event\":\"page_complete\",\"url\":{},\"ok\":true,\"latency_ms\":{},\"fetch_ms\":{},\"read_ms\":{},\"parse_ms\":{},\"extraction_ms\":{},\"quality\":{},\"characters\":{},\"words\":{},\"source_html_bytes\":{}}}",
                serde_json::to_string(raw).unwrap_or_else(|_| "\"?\"".into()),
                out.latency_ms,
                out.stages.fetch_ms,
                out.stages.read_ms,
                out.stages.parse_ms,
                out.stages.extraction_ms,
                out.quality,
                out.character_count,
                out.word_count,
                out.source_html_bytes
            );
            out
        }
        Err(e) => {
            let retryable = is_retryable_error(&e);
            let message = safe_error(&e);
            eprintln!(
                "{{\"event\":\"page_complete\",\"url\":{},\"ok\":false,\"latency_ms\":{},\"error\":{}}}",
                serde_json::to_string(raw).unwrap_or_else(|_| "\"?\"".into()),
                started.elapsed().as_millis(),
                serde_json::to_string(&message).unwrap_or_else(|_| "\"CRAWL_FAILED\"".into())
            );
            failed_response_with_latency(raw.to_string(), "CRAWL_FAILED", &message, retryable, started.elapsed().as_millis())
        }
    }
}

fn failed_response(url: String, code: &str, message: &str, retryable: bool) -> CrawlResponse {
    failed_response_with_latency(url, code, message, retryable, 0)
}

fn failed_response_with_latency(
    url: String,
    code: &str,
    message: &str,
    retryable: bool,
    latency_ms: u128,
) -> CrawlResponse {
    CrawlResponse {
        ok: false,
        url,
        final_url: None,
        title: None,
        description: None,
        language: None,
        content_type: None,
        content_format: None,
        author: None,
        published_at: None,
        canonical_url: None,
        http_status: None,
        text: None,
        links: Vec::new(),
        depth: 0,
        parent_url: None,
        ai_context: None,
        word_count: 0,
        character_count: 0,
        source_html_bytes: 0,
        quality: 0,
        method: "failed-safe".into(),
        latency_ms,
        stages: Stages::default(),
        warnings: Vec::new(),
        error: Some(Failure {
            code: code.into(),
            message: message.into(),
            retryable,
        }),
    }
}

fn json_response<T: Serialize>(
    status: u16,
    value: &T,
) -> Result<Response<ResponseBody>, Error> {
    let status = http::StatusCode::from_u16(status)
        .unwrap_or(http::StatusCode::INTERNAL_SERVER_ERROR);
    let mut bytes = serde_json::to_vec(value)?;
    let mut output_status = status;
    if bytes.len() > MAX_OUTPUT_BYTES {
        output_status = http::StatusCode::PAYLOAD_TOO_LARGE;
        bytes = serde_json::to_vec(&serde_json::json!({
            "ok": false,
            "error": { "code": "OUTPUT_TOO_LARGE", "message": "Complete extraction exceeds the 3.5 MiB response budget. Reduce max_pages or provide an explicit max_text cap; content is never silently truncated." },
            "max_output_bytes": MAX_OUTPUT_BYTES
        }))?;
    }
    Ok(Response::builder()
        .status(output_status)
        .header("access-control-allow-origin", "*")
        .header("content-type", "application/json; charset=utf-8")
        .header("cache-control", "no-store")
        .header("x-content-type-options", "nosniff")
        .body(ResponseBody::from(bytes))?)
}

async fn crawl(raw: &str, max_text: Option<usize>, include_ai_context: bool) -> Result<CrawlResponse> {
    let total = Instant::now();
    let mut stages = Stages::default();
    let mut warnings = Vec::new();

    let validation = Instant::now();
    if raw.len() > MAX_URL_LEN {
        return Err(anyhow!("URL_TOO_LONG"));
    }
    let initial = validate_target(raw).await?;
    stages.validation_ms = validation.elapsed().as_millis();
    robots_allowed(&initial).await?;

    let fetch = Instant::now();
    let fetched = fetch_with_safe_redirects(initial).await?;
    stages.fetch_ms = fetch.elapsed().as_millis();
    stages.dns_ms = fetched.dns_ms;
    stages.redirect_ms = fetched.redirect_ms;

    let status = fetched.response.status();
    let final_url = fetched.final_target.url.to_string();
    let ctype = fetched
        .response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();

    if status == StatusCode::TOO_MANY_REQUESTS {
        return Err(anyhow!("RATE_LIMITED_429"));
    }
    if status == StatusCode::UNAUTHORIZED {
        return Err(anyhow!("AUTHENTICATION_REQUIRED"));
    }
    if status == StatusCode::FORBIDDEN {
        return Err(anyhow!("FORBIDDEN_OR_BOT_PROTECTION"));
    }
    if status.is_client_error() {
        return Err(anyhow!("HTTP_{}", status.as_u16()));
    }
    if status.is_server_error() {
        return Err(anyhow!("UPSTREAM_{}", status.as_u16()));
    }

    let declared_len = fetched.response.content_length();
    if declared_len.is_some_and(|n| n > MAX_HTML_BYTES as u64) {
        return Err(anyhow!("RESPONSE_TOO_LARGE"));
    }

    let read = Instant::now();
    let mut body_stream = fetched.response.bytes_stream();
    let mut bytes = Vec::with_capacity(declared_len.unwrap_or(0).min(MAX_HTML_BYTES as u64) as usize);
    while let Some(chunk) = body_stream.next().await {
        let chunk = chunk.context("BODY_READ_FAILED")?;
        if bytes.len().saturating_add(chunk.len()) > MAX_HTML_BYTES {
            return Err(anyhow!("RESPONSE_TOO_LARGE"));
        }
        bytes.extend_from_slice(&chunk);
    }
    stages.read_ms = read.elapsed().as_millis();

    let path = fetched.final_target.url.path().to_ascii_lowercase();
    let format = detect_format(&ctype, &path);
    let parse = Instant::now();
    let mut title: Option<String> = None;
    let mut description: Option<String> = None;
    let mut language: Option<String> = None;
    let mut author: Option<String> = None;
    let mut published_at: Option<String> = None;
    let mut canonical_url: Option<String> = None;
    let mut links: Vec<String> = Vec::new();
    let mut stats = ExtractionStats::default();
    let mut extra_warnings = Vec::new();
    let mut text = match format.as_str() {
        "html" => {
            let html = String::from_utf8_lossy(&bytes).into_owned();
            let doc = Html::parse_document(&html);
            let (t, d, l, content, st, warnings) = extract_full_document(&doc);
            title = t;
            description = d;
            language = l;
            stats = st;
            extra_warnings.extend(warnings);
            author = select_meta_content(&doc, "meta[name='author'],meta[property='article:author']");
            published_at = select_meta_content(&doc, "meta[property='article:published_time'],meta[name='date'],meta[name='pubdate']");
            canonical_url = select_link_href(&doc, "link[rel='canonical']").and_then(|u| fetched.final_target.url.join(&u).ok().map(|x| x.to_string()));
            links = extract_links(&doc, &fetched.final_target.url);
            if html_indicates_dynamic_shell(&doc, content.split_whitespace().count()) {
                extra_warnings.push("dynamic_shell_detected_static_content_only".into());
            }
            content
        }
        "pdf" => {
            title = Some(fetched.final_target.url.path_segments().and_then(|x| x.last()).unwrap_or("document.pdf").to_string());
            match pdf_extract::extract_text_from_mem(&bytes) {
                Ok(content) => {
                    if content.trim().is_empty() { extra_warnings.push("pdf_text_empty_scanned_or_image_only_pdf_may_need_ocr".into()); }
                    content
                }
                Err(_) => return Err(anyhow!("PDF_TEXT_EXTRACTION_FAILED")),
            }
        }
        "docx" | "pptx" | "xlsx" => {
            let file_name = fetched.final_target.url.path_segments().and_then(|x| x.last()).unwrap_or("office-document").to_string();
            title = Some(file_name);
            extract_office_text(&bytes, &format)?
        }
        "rss" | "atom" => {
            let xml = String::from_utf8_lossy(&bytes).into_owned();
            title = xml_tag_values(&xml, "title").first().cloned().or_else(|| fetched.final_target.url.path_segments().and_then(|x| x.last()).map(str::to_string));
            author = xml_tag_values(&xml, "author").first().cloned().or_else(|| xml_tag_values(&xml, "creator").first().cloned());
            published_at = xml_tag_values(&xml, if format == "atom" { "updated" } else { "pubDate" }).first().cloned().or_else(|| xml_tag_values(&xml, "published").first().cloned());
            description = xml_tag_values(&xml, if format == "atom" { "subtitle" } else { "description" }).first().cloned();
            extract_feed_text(&xml, format == "atom")
        }
        "text" | "markdown" | "json" | "csv" | "xml" => {
            title = fetched.final_target.url.path_segments().and_then(|x| x.last()).map(str::to_string);
            let raw = String::from_utf8_lossy(&bytes).into_owned();
            if format == "json" {
                match serde_json::from_str::<serde_json::Value>(&raw) {
                    Ok(value) => serde_json::to_string_pretty(&value).unwrap_or(raw),
                    Err(_) => { extra_warnings.push("json_content_did_not_parse_as_valid_json".into()); raw }
                }
            } else { raw }
        }
        other => return Err(anyhow!("UNSUPPORTED_CONTENT_TYPE_OR_FORMAT:{}", other)),
    };
    stages.parse_ms = parse.elapsed().as_millis();
    let extract = Instant::now();
    text = normalize_document_text(&text);
    stages.extraction_ms = extract.elapsed().as_millis();
    let _ = (stats.emitted_blocks, stats.links);
    warnings.extend(extra_warnings);

    // A requested cap is explicit caller behavior, never an implicit crawler
    // limit. The boundary is applied only here, after complete extraction.
    if let Some(cap) = max_text {
        let cap = cap.max(1000);
        if text.len() > cap {
            text = truncate_utf8_safely(&text, cap);
            warnings.push("explicit_max_text_cap_applied".into());
        }
    }


    let audit = Instant::now();
    let words = text.split_whitespace().count();
    let lower = text.to_ascii_lowercase();
    let mut quality = quality_score(words, &stats, text.len());

    if words < 30 {
        quality = quality.min(35);
        warnings.push("very_little_meaningful_text".into());
    }
    if lower.contains("enable javascript")
        || lower.contains("checking your browser")
        || lower.contains("verify you are human")
        || lower.contains("just a moment")
    {
        warnings.push("possible_js_or_bot_challenge".into());
        quality = quality.min(25);
    }
    if lower.contains("sign in") && words < 120 {
        warnings.push("possible_auth_wall".into());
        quality = quality.min(45);
    }
    if lower.contains("verify you are human") || lower.contains("checking your browser") {
        warnings.push("possible_bot_challenge_or_access_filter".into());
        quality = quality.min(25);
    }

    stages.audit_ms = audit.elapsed().as_millis();

    // Unlike the previous implementation, low quality does not destroy a
    // complete extraction. The response carries the text plus warnings so the
    // caller can decide whether the page was blocked/dynamic instead of losing
    // the useful portion of the page.
    if quality < 40 {
        warnings.push("low_confidence_but_content_preserved".into());
    }

    let ai_context = include_ai_context.then(|| {
        format!(
            "SOURCE: {}\nTITLE: {}\nQUALITY: {}/100\n\n{}",
            final_url,
            title.as_deref().unwrap_or("Untitled"),
            quality,
            text
        )
    });

    let character_count = text.chars().count();
    let total_ms = total.elapsed().as_millis();
    eprintln!(
        "{{\"event\":\"page_audit\",\"url\":{},\"total_ms\":{},\"characters\":{},\"words\":{},\"quality\":{},\"nodes_skipped\":{},\"hidden_nodes\":{},\"paragraphs\":{},\"headings\":{},\"links\":{}}}",
        serde_json::to_string(&final_url).unwrap_or_else(|_| "\"?\"".into()),
        total_ms,
        character_count,
        words,
        quality,
        stats.skipped_noise_nodes,
        stats.hidden_nodes,
        stats.paragraphs,
        stats.headings,
        stats.links
    );

    Ok(CrawlResponse {
        ok: true,
        url: raw.to_string(),
        final_url: Some(final_url),
        title,
        description,
        language,
        content_type: Some(ctype),
        content_format: Some(format),
        author,
        published_at,
        canonical_url,
        http_status: Some(status.as_u16()),
        text: Some(text),
        links,
        depth: 0,
        parent_url: None,
        ai_context,
        word_count: words,
        character_count,
        source_html_bytes: bytes.len(),
        quality,
        method: "full-static-extraction".into(),
        latency_ms: 0,
        stages,
        warnings,
        error: None,
    })
}

async fn fetch_with_safe_redirects(mut target: SafeTarget) -> Result<FetchResult> {
    let mut visited = HashSet::new();
    let mut redirect_count = 0usize;
    let mut redirect_ms = 0u128;
    let mut dns_ms = 0u128;

    loop {
        if !visited.insert(target.url.to_string()) {
            return Err(anyhow!("REDIRECT_LOOP"));
        }

        let dns = Instant::now();
        target = validate_target(target.url.as_str()).await?;
        dns_ms += dns.elapsed().as_millis();

        let client = build_client_for(&target)?;
        let request = client
            .get(target.url.clone())
            .header(header::USER_AGENT, USER_AGENT)
            .header(
                header::ACCEPT,
                "text/html,application/xhtml+xml;q=0.98,text/plain;q=0.6,application/pdf;q=0.5,*/*;q=0.1",
            )
            .header(header::ACCEPT_LANGUAGE, "en-US,en;q=0.8")
            .header(header::ACCEPT_ENCODING, "gzip, br, deflate, zstd")
            .header("cache-control", "no-cache");

        let redirect_timer = Instant::now();
        let mut attempt = 0usize;
        let response = loop {
            let response = request.try_clone().ok_or_else(|| anyhow!("REQUEST_NOT_CLONEABLE"))?
                .send().await.context("FETCH_FAILED")?;
            let status = response.status();
            if attempt < 2 && (status == StatusCode::TOO_MANY_REQUESTS || status == StatusCode::BAD_GATEWAY || status == StatusCode::SERVICE_UNAVAILABLE || status == StatusCode::GATEWAY_TIMEOUT) {
                let delay = response.headers().get(header::RETRY_AFTER).and_then(|v| v.to_str().ok()).and_then(|v| v.parse::<u64>().ok()).map(|v| v.min(2)).unwrap_or(if attempt == 0 { 1 } else { 2 });
                drop(response);
                tokio::time::sleep(Duration::from_millis(delay * 1000)).await;
                attempt += 1;
                continue;
            }
            break response;
        };
        redirect_ms += redirect_timer.elapsed().as_millis();

        if !response.status().is_redirection() {
            return Ok(FetchResult {
                response,
                final_target: target,
                redirect_count,
                redirect_ms,
                dns_ms,
            });
        }

        if redirect_count >= MAX_REDIRECTS {
            return Err(anyhow!("REDIRECT_LIMIT"));
        }

        let location = response
            .headers()
            .get(header::LOCATION)
            .ok_or_else(|| anyhow!("REDIRECT_WITHOUT_LOCATION"))?
            .to_str()
            .context("BAD_LOCATION")?;

        let next = target.url.join(location).context("INVALID_REDIRECT")?;
        target = validate_target(next.as_str()).await?;
        robots_allowed(&target).await?;
        redirect_count += 1;
    }
}

fn build_client_for(target: &SafeTarget) -> Result<Client> {
    let host = target.url.host_str().ok_or_else(|| anyhow!("MISSING_HOST"))?;
    let port = target.url.port_or_known_default().unwrap_or(443);
    let key = format!("{}:{}:{}", host, port, target.ip);
    let cache = CLIENT_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some(client) = cache.lock().unwrap_or_else(|e| e.into_inner()).get(&key).cloned() {
        return Ok(client);
    }
    let client = Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(CONNECT_TIMEOUT_SECS))
        .timeout(Duration::from_secs(FETCH_TIMEOUT_SECS))
        .pool_max_idle_per_host(16)
        .pool_idle_timeout(Duration::from_secs(45))
        .http2_adaptive_window(true)
        .gzip(true).brotli(true).deflate(true).zstd(true)
        .user_agent(USER_AGENT)
        .resolve(host.trim_start_matches('[').trim_end_matches(']'), SocketAddr::new(target.ip, port))
        .build()?;
    let mut guard = cache.lock().unwrap_or_else(|e| e.into_inner());
    if guard.len() >= 128 { guard.clear(); }
    guard.insert(key, client.clone());
    Ok(client)
}

fn normalize_public_link(raw: &str) -> Option<String> {
    let url = Url::parse(raw).ok()?;
    if !matches!(url.scheme(), "http" | "https") || !url.username().is_empty() || url.password().is_some() { return None; }
    Some(url.to_string())
}

fn detect_format(content_type: &str, path: &str) -> String {
    let ct = content_type.to_ascii_lowercase();
    if path.ends_with(".pdf") || ct.contains("application/pdf") { return "pdf".into(); }
    if path.ends_with(".docx") || ct.contains("wordprocessingml") { return "docx".into(); }
    if path.ends_with(".pptx") || ct.contains("presentationml") { return "pptx".into(); }
    if path.ends_with(".xlsx") || ct.contains("spreadsheetml") { return "xlsx".into(); }
    if ct.contains("text/html") || ct.contains("application/xhtml+xml") || ct.is_empty() { return "html".into(); }
    if path.ends_with(".md") || ct.contains("text/markdown") { return "markdown".into(); }
    if path.ends_with(".csv") || ct.contains("text/csv") { return "csv".into(); }
    if path.ends_with(".json") || ct.contains("application/json") { return "json".into(); }
    if path.ends_with(".rss") || ct.contains("application/rss+xml") { return "rss".into(); }
    if path.ends_with(".atom") || ct.contains("application/atom+xml") { return "atom".into(); }
    if path.ends_with(".xml") || ct.contains("application/xml") || ct.contains("text/xml") { return "xml".into(); }
    if ct.starts_with("text/") { return "text".into(); }
    "unsupported".into()
}

fn select_meta_content(doc: &Html, selector_text: &str) -> Option<String> {
    Selector::parse(selector_text).ok().and_then(|s| doc.select(&s).next())
        .and_then(|n| n.value().attr("content"))
        .map(|s| clean(s.to_string())).filter(|s| !s.is_empty())
}

fn select_link_href(doc: &Html, selector_text: &str) -> Option<String> {
    Selector::parse(selector_text).ok().and_then(|s| doc.select(&s).next())
        .and_then(|n| n.value().attr("href")).map(str::to_string)
}

fn extract_links(doc: &Html, base: &Url) -> Vec<String> {
    let selector = match Selector::parse("a[href]") { Ok(v) => v, Err(_) => return Vec::new() };
    let mut links = HashSet::new();
    for node in doc.select(&selector).take(500) {
        if let Some(href) = node.value().attr("href") {
            if let Ok(url) = base.join(href) {
                if matches!(url.scheme(), "http" | "https") && url.username().is_empty() && url.password().is_none() {
                    let mut clean = url;
                    clean.set_fragment(None);
                    links.insert(clean.to_string());
                }
            }
        }
    }
    let mut out: Vec<String> = links.into_iter().collect();
    out.sort();
    out.truncate(300);
    out
}

fn xml_tag_values(xml: &str, tag: &str) -> Vec<String> {
    let open = format!("<{}", tag);
    let close = format!("</{}>", tag);
    let mut out = Vec::new();
    let mut rest = xml;
    while let Some(start) = rest.find(&open) {
        let after_open = match rest[start..].find('>') { Some(v) => start + v + 1, None => break };
        let end = match rest[after_open..].find(&close) { Some(v) => after_open + v, None => break };
        let value = rest[after_open..end].replace("<![CDATA[", "").replace("]]>", "");
        let cleaned = decode_xml_entities(&value);
        if !cleaned.trim().is_empty() { out.push(cleaned); }
        rest = &rest[end + close.len()..];
    }
    out
}

fn extract_feed_text(xml: &str, atom: bool) -> String {
    let (open, close) = if atom { ("<entry", "</entry>") } else { ("<item", "</item>") };
    let mut rest = xml;
    let mut out = String::new();
    let mut index = 0usize;
    while let Some(start) = rest.find(open) {
        let after = match rest[start..].find('>') { Some(v) => start + v + 1, None => break };
        let end = match rest[after..].find(close) { Some(v) => after + v, None => break };
        let block = &rest[after..end];
        let title = xml_tag_values(block, "title").first().cloned().unwrap_or_default();
        let summary = xml_tag_values(block, if atom { "summary" } else { "description" }).first().cloned()
            .or_else(|| xml_tag_values(block, "encoded").first().cloned()).unwrap_or_default();
        let published = xml_tag_values(block, if atom { "published" } else { "pubDate" }).first().cloned()
            .or_else(|| xml_tag_values(block, "updated").first().cloned()).unwrap_or_default();
        let link = if atom {
            block.find("<link").and_then(|i| block[i..].find("href=").map(|j| i + j + 5))
                .and_then(|i| block[i..].chars().next().filter(|c| *c == '\'' || *c == '"').map(|q| (i + 1, q)))
                .and_then(|(i, q)| block[i..].find(q).map(|end| block[i..i + end].to_string())).unwrap_or_default()
        } else {
            xml_tag_values(block, "link").first().cloned().unwrap_or_default()
        };
        if !out.is_empty() { out.push_str("\n\n"); }
        index += 1;
        out.push_str(&format!("ENTRY {index}\nTITLE: {title}\nPUBLISHED: {published}\nURL: {link}\n{summary}"));
        rest = &rest[end + close.len()..];
    }
    if index == 0 { xml_visible_text(xml) } else { normalize_document_text(&decode_xml_entities(&out)) }
}

fn decode_xml_entities(input: &str) -> String {
    input.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">")
        .replace("&quot;", "\"").replace("&apos;", "'").replace("&#39;", "'")
}

fn xml_visible_text(xml: &str) -> String {
    let xml = xml
        .replace("</w:p>", "\n")
        .replace("</a:p>", "\n")
        .replace("</a:tr>", "\n")
        .replace("</w:tr>", "\n")
        .replace("</w:tc>", " | ")
        .replace("</a:tc>", " | ");
    let xml = xml.as_str();
    let mut out = String::with_capacity(xml.len().min(MAX_OOXML_ENTRY_BYTES));
    let mut in_tag = false;
    for ch in xml.chars() {
        match ch {
            '<' => { in_tag = true; out.push(' '); }
            '>' => { in_tag = false; out.push(' '); }
            _ if !in_tag => out.push(ch),
            _ => {}
        }
    }
    clean(decode_xml_entities(&out))
}

fn extract_office_text(bytes: &[u8], format: &str) -> Result<String> {
    if bytes.len() > MAX_HTML_BYTES { return Err(anyhow!("OFFICE_CONTAINER_TOO_LARGE")); }
    let cursor = Cursor::new(bytes);
    let mut archive = ZipArchive::new(cursor).map_err(|_| anyhow!("INVALID_OFFICE_CONTAINER"))?;
    let mut total_uncompressed = 0usize;
    for i in 0..archive.len() {
        let file = archive.by_index(i).map_err(|_| anyhow!("INVALID_OFFICE_ENTRY"))?;
        total_uncompressed = total_uncompressed.saturating_add(file.size() as usize);
        if file.size() as usize > MAX_OOXML_ENTRY_BYTES || total_uncompressed > MAX_OOXML_TOTAL_BYTES {
            return Err(anyhow!("OFFICE_DECOMPRESSION_LIMIT"));
        }
    }
    let names: Vec<String> = (0..archive.len()).filter_map(|i| archive.by_index(i).ok().map(|f| f.name().to_string())).collect();
    let mut out = String::new();
    let mut selected = Vec::new();
    if format == "docx" {
        selected.extend(["word/document.xml".to_string(), "word/footnotes.xml".to_string(), "word/endnotes.xml".to_string()]);
    } else if format == "pptx" {
        selected.extend(names.into_iter().filter(|n| n.starts_with("ppt/slides/slide") && n.ends_with(".xml")));
        selected.sort_by_key(|n| n.split("slide").last().and_then(|s| s.trim_end_matches(".xml").parse::<u32>().ok()).unwrap_or(u32::MAX));
    } else if format == "xlsx" {
        if names.iter().any(|n| n == "xl/sharedStrings.xml") { selected.push("xl/sharedStrings.xml".into()); }
        let mut sheets: Vec<String> = names.into_iter().filter(|n| n.starts_with("xl/worksheets/sheet") && n.ends_with(".xml")).collect();
        sheets.sort();
        selected.extend(sheets);
    }
    if selected.is_empty() { return Err(anyhow!("OFFICE_CONTENT_PARTS_NOT_FOUND")); }
    for name in selected {
        if out.len() > MAX_OOXML_TOTAL_BYTES { return Err(anyhow!("OFFICE_TEXT_LIMIT")); }
        let mut file = match archive.by_name(&name) { Ok(f) => f, Err(_) => continue };
        if file.size() as usize > MAX_OOXML_ENTRY_BYTES { return Err(anyhow!("OFFICE_ENTRY_TOO_LARGE")); }
        let mut xml = String::new();
        file.take(MAX_OOXML_ENTRY_BYTES as u64).read_to_string(&mut xml).map_err(|_| anyhow!("OFFICE_XML_READ_FAILED"))?;
        if format == "xlsx" && name.ends_with("sharedStrings.xml") {
            let values = xml_tag_values(&xml, "t");
            out.push_str("Shared strings:\n");
            for value in values { out.push_str(&value); out.push('\n'); }
        } else {
            out.push_str(&xml_visible_text(&xml));
            out.push_str("\n\n");
        }
    }
    Ok(out)
}

fn robots_path_matches(pattern: &str, path: &str) -> bool {
    if pattern.is_empty() { return false; }
    let pattern = pattern.trim();
    if let Some(prefix) = pattern.strip_suffix('$') { return path == prefix; }
    let parts: Vec<&str> = pattern.split('*').collect();
    let mut offset = 0usize;
    for (i, part) in parts.iter().enumerate() {
        if part.is_empty() { continue; }
        if let Some(found) = path[offset..].find(part) {
            if i == 0 && !pattern.starts_with('*') && found != 0 { return false; }
            offset += found + part.len();
        } else { return false; }
    }
    true
}

async fn robots_allowed(target: &SafeTarget) -> Result<()> {
    let _host = target.url.host_str().ok_or_else(|| anyhow!("MISSING_HOST"))?;
    let robots_key = target.url.origin().ascii_serialization();
    let path = format!("{}{}", target.url.path(), if let Some(q) = target.url.query() { format!("?{}", q) } else { String::new() });
    let cache = ROBOTS_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some((created, rules)) = cache.lock().unwrap_or_else(|e| e.into_inner()).get(&robots_key).cloned() {
        if created.elapsed() < Duration::from_secs(3600) {
            if robots_rules_allow(&rules, &path) { return Ok(()); }
            return Err(anyhow!("ROBOTS_DISALLOWED"));
        }
    }
    let mut robots_url = target.url.clone();
    robots_url.set_path("/robots.txt");
    robots_url.set_query(None);
    robots_url.set_fragment(None);
    let safe = validate_target(robots_url.as_str()).await?;
    let client = build_client_for(&safe)?;
    let response = tokio::time::timeout(Duration::from_secs(3), client.get(safe.url.clone()).header(header::USER_AGENT, USER_AGENT).send()).await
        .map_err(|_| anyhow!("ROBOTS_FETCH_TIMEOUT"))?.map_err(|_| anyhow!("ROBOTS_FETCH_FAILED"))?;
    let status = response.status();
    let mut rules = Vec::new();
    if status == StatusCode::NOT_FOUND || status == StatusCode::GONE {
        // RFC 9309: unavailable robots.txt (4xx) does not disallow crawling.
    } else if status == StatusCode::UNAUTHORIZED || status == StatusCode::FORBIDDEN || status.is_server_error() || status.is_redirection() {
        rules.push((false, "/".to_string()));
    } else if status.is_success() {
        if response.content_length().is_some_and(|n| n > ROBOTS_MAX_BYTES as u64) { return Err(anyhow!("ROBOTS_FILE_TOO_LARGE")); }
        let mut stream = response.bytes_stream();
        let mut bytes = Vec::new();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|_| anyhow!("ROBOTS_BODY_FAILED"))?;
            if bytes.len().saturating_add(chunk.len()) > ROBOTS_MAX_BYTES { return Err(anyhow!("ROBOTS_FILE_TOO_LARGE")); }
            bytes.extend_from_slice(&chunk);
        }
        let text = String::from_utf8_lossy(&bytes);
        let mut agents: Vec<String> = Vec::new();
        let mut group_rules: Vec<(bool, String)> = Vec::new();
        for raw_line in text.lines() {
            let line = raw_line.split('#').next().unwrap_or("").trim();
            if line.is_empty() { continue; }
            let (key, value) = match line.split_once(':') { Some(pair) => pair, None => continue };
            let key = key.trim().to_ascii_lowercase();
            let value = value.trim();
            if key == "user-agent" {
                if !group_rules.is_empty() {
                    if agents.iter().any(|a| a == "*" || a.contains("arixcrawler")) { rules.extend(group_rules.drain(..)); }
                    else { group_rules.clear(); }
                    agents.clear();
                }
                agents.push(value.to_ascii_lowercase());
            } else if key == "allow" && !value.is_empty() {
                group_rules.push((true, value.to_string()));
            } else if key == "disallow" && !value.is_empty() {
                group_rules.push((false, value.to_string()));
            }
        }
        if agents.iter().any(|a| a == "*" || a.contains("arixcrawler")) { rules.extend(group_rules); }
    }
    cache.lock().unwrap_or_else(|e| e.into_inner()).insert(robots_key, (Instant::now(), rules.clone()));
    if robots_rules_allow(&rules, &path) { Ok(()) } else { Err(anyhow!("ROBOTS_DISALLOWED")) }
}

fn robots_rules_allow(rules: &[(bool, String)], path: &str) -> bool {
    let mut best: Option<(usize, bool)> = None;
    for (allow, pattern) in rules {
        if robots_path_matches(pattern, path) {
            let specificity = pattern.chars().filter(|c| *c != '*' && *c != '$').count();
            if best.is_none_or(|(length, old_allow)| specificity > length || (specificity == length && *allow && !old_allow)) {
                best = Some((specificity, *allow));
            }
        }
    }
    best.map(|(_, allow)| allow).unwrap_or(true)
}

async fn validate_target(raw: &str) -> Result<SafeTarget> {
    if raw.trim().trim_end_matches('/') == "https://brave.com/terms-of-use" {
        return Err(anyhow!("BLACKLISTED_URL"));
    }

    let mut u = Url::parse(raw).context("INVALID_URL")?;
    if u.scheme() != "http" && u.scheme() != "https" {
        return Err(anyhow!("UNSUPPORTED_SCHEME"));
    }
    if !u.username().is_empty() || u.password().is_some() {
        return Err(anyhow!("USERINFO_NOT_ALLOWED"));
    }

    let host = u
        .host_str()
        .ok_or_else(|| anyhow!("MISSING_HOST"))?
        .to_ascii_lowercase();

    if host == "localhost"
        || host.ends_with(".localhost")
        || host.ends_with(".local")
        || host.ends_with(".internal")
        || host.ends_with(".home.arpa")
    {
        return Err(anyhow!("PRIVATE_HOST"));
    }

    let port = u.port_or_known_default().ok_or_else(|| anyhow!("BAD_PORT"))?;
    if port == 0 || !matches!(port, 80 | 443 | 8080 | 8443) {
        return Err(anyhow!("UNSUPPORTED_PORT"));
    }

    let ip = match u.host() {
        Some(url::Host::Ipv4(ip)) => IpAddr::V4(ip),
        Some(url::Host::Ipv6(ip)) => IpAddr::V6(ip),
        _ => {
            let mut addrs = lookup_host((host.as_str(), port))
                .await
                .context("DNS_FAILED")?;
            let mut chosen = None;
            while let Some(sa) = addrs.next() {
                if is_public_ip(sa.ip()) {
                    chosen = Some(sa.ip());
                    break;
                }
            }
            chosen.ok_or_else(|| anyhow!("NO_PUBLIC_IP"))?
        }
    };

    if !is_public_ip(ip) {
        return Err(anyhow!("PRIVATE_OR_RESERVED_IP"));
    }

    Ok(SafeTarget { url: u, ip })
}

fn is_public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let o = v4.octets();
            !(v4.is_private()
                || v4.is_loopback()
                || v4.is_link_local()
                || v4.is_broadcast()
                || v4.is_documentation()
                || o[0] == 0
                || (o[0] == 100 && (64..=127).contains(&o[1]))
                || (o[0] == 100 && (64..=127).contains(&o[1]))
                || (o[0] == 192 && o[1] == 0 && o[2] == 0)
                || (o[0] == 198 && (18..=19).contains(&o[1]))
                || o[0] >= 224)
        }
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return is_public_ip(IpAddr::V4(v4));
            }
            let seg = v6.segments();
            !(v6.is_loopback()
                || v6.is_unspecified()
                || v6.is_unique_local()
                || v6.is_unicast_link_local()
                || v6.is_multicast()
                || (seg[0] == 0x2001 && seg[1] == 0x0db8))
        }
    }
}

fn split_url_field(value: &str, out: &mut Vec<String>) {
    // The UI/API accepts URLs separated by spaces, commas, or newlines.
    // Public HTTP URLs cannot contain raw spaces, so this is unambiguous for
    // the intended input format.
    for token in value.split(|c: char| c == ',' || c == '\n' || c == '\r' || c.is_whitespace()) {
        let token = token.trim();
        if !token.is_empty() {
            out.push(token.to_string());
        }
    }
}

fn extract_full_document(
    doc: &Html,
) -> (
    Option<String>,
    Option<String>,
    Option<String>,
    String,
    ExtractionStats,
    Vec<String>,
) {
    let mut warnings = Vec::new();

    let title = select_first_text(doc, "title");
    let description = Selector::parse("meta[name='description'],meta[property='og:description']")
        .ok()
        .and_then(|s| doc.select(&s).next())
        .and_then(|n| n.value().attr("content"))
        .map(|s| clean(s.to_string()))
        .filter(|x| !x.is_empty());

    let language = Selector::parse("html")
        .ok()
        .and_then(|s| doc.select(&s).next())
        .and_then(|n| n.value().attr("lang"))
        .map(str::to_string);

    let root = Selector::parse("body")
        .ok()
        .and_then(|s| doc.select(&s).next())
        .or_else(|| Some(doc.root_element()));

    let mut out = String::new();
    let mut stats = ExtractionStats::default();

    if let Some(root) = root {
        walk_complete(root, &mut out, &mut stats);
    }

    let text = normalize_document_text(&out);
    if text.is_empty() {
        warnings.push("no_visible_text_found".into());
    }
    if stats.skipped_noise_nodes > 0 {
        warnings.push(format!(
            "filtered_{}_obvious_noise_nodes",
            stats.skipped_noise_nodes
        ));
    }
    if stats.hidden_nodes > 0 {
        warnings.push(format!(
            "ignored_{}_hidden_or_aria_hidden_nodes",
            stats.hidden_nodes
        ));
    }

    (title, description, language, text, stats, warnings)
}

fn walk_complete(node: ElementRef<'_>, out: &mut String, stats: &mut ExtractionStats) {
    let value = node.value();
    let tag = value.name();

    if should_skip_entire_node(&node) {
        stats.skipped_noise_nodes = stats.skipped_noise_nodes.saturating_add(1);
        return;
    }
    if is_hidden_element(&node) {
        stats.hidden_nodes = stats.hidden_nodes.saturating_add(1);
        return;
    }

    let is_block = is_block_tag(tag);
    if is_block && !out.is_empty() {
        out.push_str("\n\n");
    }

    match tag {
        "p" => stats.paragraphs = stats.paragraphs.saturating_add(1),
        "h1" | "h2" | "h3" | "h4" | "h5" | "h6" => {
            stats.headings = stats.headings.saturating_add(1)
        }
        "a" => stats.links = stats.links.saturating_add(1),
        _ => {}
    }

    let mut had_text = false;
    for child in node.children() {
        if let Some(el) = ElementRef::wrap(child) {
            walk_complete(el, out, stats);
        } else if let Some(text) = child.value().as_text() {
            let t = text.trim();
            if !t.is_empty() {
                if !out.is_empty() && !ends_with_separator(out) {
                    out.push(' ');
                }
                out.push_str(t);
                stats.emitted_words = stats
                    .emitted_words
                    .saturating_add(t.split_whitespace().count());
                had_text = true;
            }
        }
    }

    if is_block && (had_text || ends_with_non_separator(out)) {
        out.push_str("\n\n");
        stats.emitted_blocks = stats.emitted_blocks.saturating_add(1);
    }
}

fn extract_raw_visible_document(doc: &Html) -> String {
    let root = Selector::parse("body")
        .ok()
        .and_then(|s| doc.select(&s).next())
        .or_else(|| Some(doc.root_element()));
    let Some(root) = root else {
        return String::new();
    };

    let mut out = String::new();
    walk_raw(root, &mut out);
    normalize_document_text(&out)
}

fn walk_raw(node: ElementRef<'_>, out: &mut String) {
    let tag = node.value().name();
    if matches!(tag, "script" | "style" | "template" | "svg" | "canvas" | "iframe" | "object" | "embed" | "form") {
        return;
    }
    if is_hidden_element(&node) {
        return;
    }

    if is_block_tag(tag) && !out.is_empty() {
        out.push_str("\n\n");
    }

    for child in node.children() {
        if let Some(el) = ElementRef::wrap(child) {
            walk_raw(el, out);
        } else if let Some(text) = child.value().as_text() {
            let t = text.trim();
            if !t.is_empty() {
                if !out.is_empty() && !ends_with_separator(out) {
                    out.push(' ');
                }
                out.push_str(t);
            }
        }
    }
}

fn should_skip_entire_node(node: &ElementRef<'_>) -> bool {
    let tag = node.value().name();
    if matches!(tag, "script" | "style" | "template" | "svg" | "canvas" | "iframe" | "object" | "embed" | "form" | "nav" | "footer") {
        return true;
    }

    let attrs = format!(
        "{} {}",
        node.value().id().unwrap_or(""),
        node.value().attr("class").unwrap_or("")
    )
    .to_ascii_lowercase();

    const STRONG_NOISE: [&str; 18] = [
        "cookie-banner",
        "cookie-consent",
        "consent-banner",
        "consent-manager",
        "advertisement",
        "ad-container",
        "ad-slot",
        "adsbygoogle",
        "sponsored-content",
        "newsletter-signup",
        "newsletter-form",
        "social-share",
        "share-tools",
        "breadcrumb",
        "login-modal",
        "signup-modal",
        "paywall",
        "modal-overlay",
    ];

    STRONG_NOISE.iter().any(|marker| attrs.contains(marker))
}

fn is_hidden_element(node: &ElementRef<'_>) -> bool {
    let v = node.value();
    if v.attr("aria-hidden") == Some("true") {
        return true;
    }
    let style = v.attr("style").unwrap_or("").to_ascii_lowercase();
    style.contains("display:none")
        || style.contains("display: none")
        || style.contains("visibility:hidden")
        || style.contains("visibility: hidden")
        || style.contains("content-visibility:hidden")
        || style.contains("content-visibility: hidden")
}

fn is_block_tag(tag: &str) -> bool {
    matches!(
        tag,
        "address"
            | "article"
            | "aside"
            | "blockquote"
            | "caption"
            | "dd"
            | "div"
            | "dl"
            | "dt"
            | "fieldset"
            | "figcaption"
            | "figure"
            | "h1"
            | "h2"
            | "h3"
            | "h4"
            | "h5"
            | "h6"
            | "header"
            | "hr"
            | "li"
            | "main"
            | "ol"
            | "p"
            | "pre"
            | "section"
            | "table"
            | "tbody"
            | "td"
            | "tfoot"
            | "th"
            | "thead"
            | "tr"
            | "ul"
            | "details"
            | "summary"
    )
}

fn select_first_text(doc: &Html, selector_text: &str) -> Option<String> {
    Selector::parse(selector_text)
        .ok()
        .and_then(|s| doc.select(&s).next())
        .map(|n| clean(n.text().collect::<Vec<_>>().join(" ")))
        .filter(|x| !x.is_empty())
}

fn quality_score(words: usize, stats: &ExtractionStats, chars: usize) -> u8 {
    if words == 0 {
        return 0;
    }

    let mut score = 45i64;
    score += (words.min(12000) / 120) as i64;
    score += (stats.paragraphs.min(80) / 4) as i64;
    score += stats.headings.min(12) as i64 * 2;
    if chars > 1000 {
        score += 10;
    }
    if chars > 10000 {
        score += 10;
    }
    score.clamp(0, 100) as u8
}

fn html_indicates_dynamic_shell(doc: &Html, words: usize) -> bool {
    if words > 80 {
        return false;
    }

    let selectors = [
        "[id*='root']",
        "[id*='app']",
        "[id*='__next']",
        "[id*='svelte']",
        "script[type='application/ld+json']",
    ];

    selectors.iter().any(|s| {
        Selector::parse(s)
            .ok()
            .is_some_and(|sel| doc.select(&sel).next().is_some())
    })
}

fn normalize_document_text(s: &str) -> String {
    // Keep paragraph/block boundaries produced by the DOM walk while
    // collapsing incidental HTML whitespace. No character/word ceiling is
    // applied here.
    let mut out = String::with_capacity(s.len());
    let mut pending_space = false;
    let mut pending_breaks = 0usize;

    for ch in s.chars() {
        if ch == '\n' || ch == '\r' {
            pending_breaks = (pending_breaks + 1).min(2);
            pending_space = false;
            continue;
        }

        if ch.is_whitespace() {
            pending_space = true;
            continue;
        }

        if pending_breaks > 0 {
            while out.ends_with(' ') {
                out.pop();
            }
            if !out.is_empty() {
                out.push_str("\n\n");
            }
            pending_breaks = 0;
            pending_space = false;
        } else if pending_space && !out.is_empty() && !out.ends_with(' ') && !out.ends_with('\n') {
            out.push(' ');
            pending_space = false;
        }

        out.push(ch);
    }

    out.trim().to_string()
}

fn ends_with_separator(s: &str) -> bool {
    s.as_bytes().last().is_some_and(|b| *b == b' ' || *b == b'\n' || *b == b'\r' || *b == b'\t')
}

fn ends_with_non_separator(s: &str) -> bool {
    !s.is_empty() && !ends_with_separator(s)
}

fn truncate_utf8_safely(s: &str, max_bytes: usize) -> String {
    if s.len() <= max_bytes {
        return s.to_string();
    }
    let mut end = max_bytes;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    s[..end].to_string()
}

fn clean(s: String) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn is_retryable_error(e: &anyhow::Error) -> bool {
    let s = e.to_string();
    s.contains("FETCH_FAILED")
        || s.contains("DNS_FAILED")
        || s.contains("BODY_READ_FAILED")
        || s.contains("UPSTREAM_")
        || s.contains("RATE_LIMITED")
        || s.contains("ROBOTS_FETCH_TIMEOUT")
        || s.contains("ROBOTS_FETCH_FAILED")
}

fn safe_error(e: &anyhow::Error) -> String {
    let s = e.to_string();
    if s.len() > 180 {
        s[..180].to_string()
    } else {
        s
    }
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detect_supported_document_formats() {
        assert_eq!(detect_format("text/html", "/page"), "html");
        assert_eq!(detect_format("application/pdf", "/file"), "pdf");
        assert_eq!(detect_format("application/vnd.openxmlformats-officedocument.wordprocessingml.document", "/file"), "docx");
        assert_eq!(detect_format("application/json", "/data"), "json");
        assert_eq!(detect_format("text/csv", "/data"), "csv");
    }

    #[test]
    fn robots_wildcards_and_end_anchor_are_respected() {
        assert!(robots_path_matches("/private/*", "/private/a/b"));
        assert!(robots_path_matches("/exact$", "/exact"));
        assert!(!robots_path_matches("/exact$", "/exact/child"));
        assert!(!robots_path_matches("/private/", "/public/private/"));
    }

    #[test]
    fn robots_longest_match_and_allow_tie_break() {
        let rules = vec![
            (false, "/private/".to_string()),
            (true, "/private/public".to_string()),
        ];
        assert!(robots_rules_allow(&rules, "/private/public/page"));
        assert!(!robots_rules_allow(&rules, "/private/secret"));
        let tie = vec![(false, "/x".to_string()), (true, "/x".to_string())];
        assert!(robots_rules_allow(&tie, "/x/page"));
    }

    #[test]
    fn text_normalization_preserves_paragraph_boundaries() {
        assert_eq!(normalize_document_text("  alpha  beta\n\n gamma  "), "alpha beta\n\ngamma");
    }

    #[test]
    fn office_xml_text_extraction_removes_markup() {
        assert_eq!(xml_visible_text("<w:p><w:r><w:t>Hello</w:t></w:r></w:p>"), "Hello");
    }

    #[test]
    fn reserved_ipv4_ranges_are_rejected() {
        assert!(!is_public_ip("127.0.0.1".parse().unwrap()));
        assert!(!is_public_ip("10.1.2.3".parse().unwrap()));
        assert!(!is_public_ip("169.254.169.254".parse().unwrap()));
        assert!(is_public_ip("8.8.8.8".parse().unwrap()));
    }
}
