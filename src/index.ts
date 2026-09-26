interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    // Fleet #2382. Everything that isn't a timeout/abort here is a genuine
    // NETWORK-LEVEL failure — DNS resolution, connection refused, TLS handshake,
    // Cloudflare's own "Network connection lost." — meaning `fetch()` itself
    // threw and no HTTP response of any kind was ever received. Until this fix
    // that raw exception was rethrown VERBATIM: a bare `TypeError: fetch failed`
    // (or the Workers-runtime equivalent) names no upstream, carries no class
    // token, and reads exactly like a defect in OUR code — because it says
    // nothing about the call at all. It landed in `error`, the tier that means
    // "Pipeworx has a defect", for every one of the (at the time of writing)
    // ~470 packs that call this helper directly with no wrapper of their own.
    //
    // `dexscreener` hit this independently (fleet #1579) and fixed it with a
    // bespoke per-pack try/catch around `fetchWithTimeout`. That fix is correct
    // but only covers one pack; every other caller of this shared helper still
    // leaked the raw exception. Moving the same fix HERE — the one place that
    // already carries the timeout case — covers every pack that uses
    // `fetchWithTimeout` without a wrapper, for free, and without widening
    // `classifyToolError`'s regex list: the fix is giving the message a proper
    // `upstream_down:` token at the point the two facts (no response was ever
    // received, and which host we were trying to reach) are actually in hand,
    // not teaching the classifier to guess from prose after the fact.
    //
    // Safe on the same grounds as the timeout branch above: no argument a
    // caller passes can make `fetch()` itself throw a connection-level error,
    // so this is always an availability failure, never a caller mistake. Same
    // `markInternalOrigin` treatment — an origin we run that never answered is
    // still ours, not a third party's outage.
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(
      markInternalOrigin(
        `upstream_down: could not reach ${name} at all (${raw.slice(0, 160)}). ` +
          `No request reached ${name}, so this says NOTHING about whether the arguments you passed ` +
          'are valid — do not re-check them on the strength of this error. Retry shortly.',
        url,
      ),
    );
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
/**
 * pod-researcher — podcast prospecting for guest booking and sponsorship.
 *
 * Given a topic and a purpose (guest | sponsor), returns ACTIVE podcasts whose
 * recent episodes cover the topic, each with the best published contact route
 * for that purpose, the episodes that prove the fit, and the caller's own
 * outreach history so nobody pitches the same show twice or pitches someone
 * who said no.
 *
 * Sources: podcast RSS feeds (the Podcast Index open directory for the list of
 * feeds, then each show's own feed and website for episodes and contacts).
 * Plan of record: docs/pod-researcher-plan.md; storage/ingestion design:
 * docs/pod-researcher-design.md (P1-5 is this pack).
 *
 * Two back ends, both passed in by the Pipeworx gateway:
 *   _podIndex   the podcast index RPC (search / getShow / requestRefresh / stats)
 *   _supabase*  per-account engagement, suppression and topic watches
 *   _accountId  the caller's account (null for an anonymous caller)
 * A standalone build has neither and REFUSES every tool: an empty list from a
 * build that cannot reach the index would read as "no podcasts cover this".
 *
 * Contacts (Bruce, 2026-09-24): every address a show itself publishes is
 * returned, labelled holder_type person / role / hosting_account_owner, with
 * source_url and last_observed. A person's address is said to be one, plainly.
 * No address is ever written anywhere by this pack, and record_podcast_outreach
 * refuses an email-shaped argument without repeating it.
 */


const UA = 'pipeworx-pod-researcher/0.1 (+https://pipeworx.io)';

// ─────────────────────────────────────────────────────────────── types

type Purpose = 'guest' | 'sponsor';
const OUTCOMES = ['contacted', 'replied', 'declined', 'booked', 'bounced', 'do_not_contact', 'clear'] as const;
type Outcome = (typeof OUTCOMES)[number];

interface PodIndexRpc {
  search(args: Record<string, unknown>): Promise<Record<string, unknown>>;
  getShow(id: string | number): Promise<Record<string, unknown>>;
  requestRefresh(id: string | number): Promise<Record<string, unknown>>;
  stats(): Promise<Record<string, unknown>>;
}

interface Db {
  url: string;
  key: string;
}

interface Ctx {
  idx: PodIndexRpc;
  db: Db | null;
  account: string | null;
}

type Row = Record<string, unknown>;

// ─────────────────────────────────────────────────────────────── tool defs

const PURPOSE_PROP = {
  type: 'string',
  enum: ['guest', 'sponsor'],
  description: "What you want from the show: 'guest' (book someone onto it) or 'sponsor' (advertise on it). Routes designated for this purpose rank first.",
};
const ID_PROP = {
  type: 'string',
  description: 'The show: a show_id from find_podcast_contacts, the RSS feed URL, or its podcast:guid.',
};

const tools: McpToolExport['tools'] = [
  {
    name: 'find_podcast_contacts',
    description:
      'Find ACTIVE podcasts whose recent episodes cover a topic, each with the best published contact route for booking a guest or buying sponsorship. Searches episode titles and show notes across ~740k podcasts that published in the last year (from the Podcast Index open directory plus each show\'s own RSS feed and website). Every result carries the episodes that prove the fit, the show\'s activity status, and either best_route (with holder_type person / role / hosting_account_owner, its source_url and last_observed date) or route_status "none_found" with what was checked. Routes designated for your purpose rank first; a general contact or a person\'s published address is a labelled fallback. For a signed-in account, shows and people you recorded as contacted, declined, booked or do_not_contact are left out. Use get_podcast_profile for one show in full.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        topic: { type: 'string', description: 'What the show should be about, in plain words, e.g. "AI agents developer infrastructure" or "marathon training".' },
        purpose: PURPOSE_PROP,
        require_route: { type: 'boolean', description: 'true = only shows that have a contact route for this purpose (designated, or a general/person fallback). Default false: shows with no route found are returned too, ranked by fit, with route_status "none_found".' },
        language: { type: 'string', description: 'Feed language code, e.g. "en" (matches en, en-us, en-gb).' },
        country: { type: 'string', description: 'Two-letter country code of the show, when known, e.g. "us".' },
        active_only: { type: 'boolean', description: 'Default true: only shows classified active (publishing on their usual cadence). false also returns overdue, hiatus and dormant shows, labelled.' },
        include_engaged: { type: 'boolean', description: 'Signed-in accounts: default false leaves out shows you already recorded as contacted, replied or booked. true returns them, marked with your last outcome. Declined and do_not_contact are always left out.' },
        limit: { type: 'integer', description: 'Shows per page, 1-50 (default 20).' },
        cursor: { type: 'string', description: 'cursor_next from a previous call, for the next page.' },
      },
      required: ['topic', 'purpose'],
    },
  },
  {
    name: 'get_podcast_profile',
    description:
      "One podcast in full: identity (title, feed URL, website, podcast:guid, Apple id), activity status and feed health, the latest episodes, and EVERY published contact route with holder_type (person / role / hosting_account_owner), purpose, source_url and last_observed. Accepts a show_id, an RSS feed URL (old URLs of moved feeds resolve) or a podcast:guid. For a signed-in account, also returns your outreach history with the show.",
    inputSchema: {
      type: 'object' as const,
      properties: { id: ID_PROP },
      required: ['id'],
    },
  },
  {
    name: 'refresh_podcast',
    description:
      "Ask for one podcast's RSS feed to be read again now rather than at its next scheduled check. Returns the show's current state and when the refresh was queued; new episodes show up in get_podcast_profile once the feed has been read (normally within minutes). Contact routes are re-checked separately, not by this call.",
    inputSchema: {
      type: 'object' as const,
      properties: { id: ID_PROP },
      required: ['id'],
    },
  },
  {
    name: 'watch_podcast_topic',
    description:
      'Signed-in accounts: save a topic x purpose search so get_podcast_topic_changes can report podcasts that newly match it. Records the current matches as the baseline, so get_podcast_topic_changes returns only shows that appear after now. Returns the watch_id.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        topic: { type: 'string', description: 'The topic to watch, as for find_podcast_contacts.' },
        purpose: PURPOSE_PROP,
        require_route: { type: 'boolean', description: 'Only report shows that have a contact route for this purpose. Default false.' },
        language: { type: 'string', description: 'Feed language code, e.g. "en".' },
        country: { type: 'string', description: 'Two-letter country code, e.g. "us".' },
      },
      required: ['topic', 'purpose'],
    },
  },
  {
    name: 'get_podcast_topic_changes',
    description:
      'Signed-in accounts: for your topic watches (or one, by watch_id), the podcasts that match now and did not at the last check, with their best contact route. Each call moves the baseline forward, so a show is reported once.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        watch_id: { type: 'integer', description: 'One watch from watch_podcast_topic. Omit for all of your active watches.' },
      },
    },
  },
  {
    name: 'record_podcast_outreach',
    description:
      "Signed-in accounts: record what happened when you reached out to a podcast, so find_podcast_contacts stops suggesting it. outcome: contacted, replied, declined, booked, bounced, do_not_contact or clear (clear lifts an earlier do_not_contact). Name the show by show_id. For a PERSON-level record (e.g. the host asked never to be contacted about any of their shows), pass scope 'person' and the contact_id of their email route from get_podcast_profile: every show that publishes that address is then left out of your searches. Never pass an email address: a call carrying one is refused and nothing is recorded. History is private to your account.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        show_id: { type: 'integer', description: 'The show, from find_podcast_contacts or get_podcast_profile.' },
        outcome: { type: 'string', enum: [...OUTCOMES], description: 'What happened.' },
        scope: { type: 'string', enum: ['show', 'person'], description: "'show' (default) records against the show; 'person' records against the person behind an email route (needs contact_id)." },
        contact_id: { type: 'integer', description: 'The route you used, from best_route.contact_id or get_podcast_profile routes. Required when scope is person.' },
      },
      required: ['show_id', 'outcome'],
    },
  },
];

// ─────────────────────────────────────────────────────────────── helpers

const EMAIL_SHAPED = /[A-Za-z0-9._%+\-]+@[A-Za-z0-9\-]+(?:\.[A-Za-z0-9\-]+)+/;

/** Any caller-supplied string (declared or not) that looks like an address. */
function hasEmailShapedArg(args: Record<string, unknown>): boolean {
  const walk = (v: unknown): boolean =>
    typeof v === 'string' ? EMAIL_SHAPED.test(v) : Array.isArray(v) ? v.some(walk) : v && typeof v === 'object' ? Object.values(v).some(walk) : false;
  return Object.entries(args).some(([k, v]) => !k.startsWith('_') && walk(v));
}

class Refusal extends Error {}

function iso(epochSeconds: unknown): string | null {
  const n = Number(epochSeconds);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date((n < 1e12 ? n * 1000 : n)).toISOString();
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

function purposeArg(v: unknown): Purpose {
  if (v === 'guest' || v === 'sponsor') return v;
  throw new Refusal("purpose must be 'guest' or 'sponsor'.");
}

function topicArg(v: unknown): string {
  const t = str(v);
  if (!t) throw new Refusal('topic is required: say what the show should be about, e.g. "AI agents developer infrastructure".');
  if (t.length > 200) throw new Refusal('topic is longer than 200 characters; use a few words.');
  return t;
}

function intArg(v: unknown, name: string): number {
  const n = typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isInteger(n) || n <= 0) throw new Refusal(`${name} must be a positive integer.`);
  return n;
}

async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s.trim().toLowerCase()));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const CONTACTS_NOTE =
  'Addresses are as the show itself published them (its RSS feed or website). holder_type says whose they are: "role" is a function inbox (booking@, sponsorships@), "hosting_account_owner" is the podcast hosting account\'s owner address from the RSS feed (often the host, rarely a booking desk), "person" is an individual\'s own address. Treat a person address as a person: one considered message, not a list.';

// ─────────────────────────────────────────────────────────────── Supabase (account data)

/** Account-store reads/writes are ~50 ms; 10 s is generous and keeps the whole
 *  find_podcast_contacts call (store read + index search) inside a client's
 *  patience (fleet #2427). */
const PG_TIMEOUT_MS = 10_000;
/** The index bounds its own search at 20 s (workers/pod-index/src/search.ts);
 *  this is the pack's backstop for the RPC hop itself, so a stalled service
 *  binding still turns into an answer rather than zero bytes. */
const INDEX_RPC_TIMEOUT_MS = 25_000;

function withDeadline<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    t = setTimeout(() => reject(new Error(`${what} gave no answer in ${Math.round(ms / 1000)} s`)), ms);
  });
  p.catch(() => {}); // a late rejection after the deadline must not go unhandled
  return Promise.race([p, timeout]).finally(() => {
    if (t !== null) clearTimeout(t);
  });
}

async function pg(db: Db, path: string, init: RequestInit = {}): Promise<unknown> {
  const res = await fetchWithTimeout(
    `${db.url.replace(/\/+$/, '')}/rest/v1/${path}`,
    {
      ...init,
      headers: {
        apikey: db.key,
        Authorization: `Bearer ${db.key}`,
        'Content-Type': 'application/json',
        'User-Agent': UA,
        ...(init.headers ?? {}),
      },
    },
    'pod-researcher account store',
    PG_TIMEOUT_MS,
  );
  const text = await res.text();
  if (!res.ok) {
    // Only the error CODE travels: a constraint-violation body can quote the
    // failing row, and nothing from a stored row belongs in an error string.
    let code = '';
    try {
      code = String((JSON.parse(text) as { code?: unknown }).code ?? '');
    } catch {
      /* not JSON: no code */
    }
    throw new Error(`the account store answered HTTP ${res.status}${code ? ` (${code.slice(0, 12)})` : ''}; your outreach history could not be read or written. Retry shortly.`);
  }
  return text ? JSON.parse(text) : null;
}

interface Suppression {
  applied: boolean;
  reason?: string;
  hardShows: Set<number>; // declined / do_not_contact: always excluded
  softShows: Map<number, { outcome: string; at: string | null }>; // contacted / replied / booked
  hardPeople: Set<string>;
  softPeople: Set<string>;
  rows: number;
}

function emptySuppression(reason: string): Suppression {
  return { applied: false, reason, hardShows: new Set(), softShows: new Map(), hardPeople: new Set(), softPeople: new Set(), rows: 0 };
}

const PAGE = 1000; // PostgREST caps a response at 1000 rows whatever `limit` says
const MAX_PAGES = 10;

/** The caller's suppression list. Fails CLOSED for a signed-in account: if it
 *  cannot be read, the search is refused rather than run without it, because a
 *  search that silently re-suggests a show someone declined is the one failure
 *  this list exists to prevent. */
async function loadSuppression(ctx: Ctx): Promise<Suppression> {
  if (!ctx.account) return emptySuppression('anonymous caller: no account, so no outreach history to apply');
  if (!ctx.db) throw new Error('the account store is not configured on this deployment, so your outreach history cannot be applied. This is a setup problem, not your arguments.');
  const s = emptySuppression('');
  s.applied = true;
  delete s.reason;
  for (let page = 0; page < MAX_PAGES; page++) {
    const rows = (await pg(
      ctx.db,
      `pod_suppression?account_id=eq.${encodeURIComponent(ctx.account)}&select=scope,subject,latest_outcome,last_at,dnc_at,clear_at&order=last_at.desc&limit=${PAGE}&offset=${page * PAGE}`,
    )) as Row[];
    for (const r of rows) {
      const latest = String(r.latest_outcome);
      const dnc = r.dnc_at && (!r.clear_at || String(r.dnc_at) > String(r.clear_at));
      const hard = dnc || latest === 'declined';
      const soft = !hard && (latest === 'contacted' || latest === 'replied' || latest === 'booked');
      if (r.scope === 'show') {
        const id = Number(r.subject);
        if (hard) s.hardShows.add(id);
        else if (soft) s.softShows.set(id, { outcome: latest, at: str(r.last_at) });
      } else if (r.scope === 'person') {
        const key = String(r.subject);
        if (hard) s.hardPeople.add(key);
        else if (soft) s.softPeople.add(key);
      }
    }
    s.rows += rows.length;
    if (rows.length < PAGE) break;
  }
  return s;
}

// ─────────────────────────────────────────────────────────────── shaping

function shapeRoute(r: Row | null | undefined, match?: unknown) {
  if (!r) return null;
  const holder = String(r.holder_type ?? '');
  return {
    contact_id: r.contact_id ?? null,
    purpose: r.purpose ?? null,
    kind: r.kind ?? null,
    value: r.value ?? null,
    holder_type: holder || null,
    confidence: r.confidence ?? null,
    ...(match ? { match } : {}),
    source: r.source ?? null,
    source_url: r.source_url ?? null,
    first_seen: iso(r.first_seen),
    last_observed: iso(r.last_observed),
    verified_deliverable: r.verified_deliverable == null ? null : Boolean(r.verified_deliverable),
    ...(holder === 'person'
      ? { note: "This is a person's own published address, not a booking desk." }
      : holder === 'hosting_account_owner'
        ? { note: 'Owner address of the hosting account, from the RSS feed; usually reaches the host.' }
        : {}),
  };
}

function shapeSearchShow(s: Row, soft?: { outcome: string; at: string | null }) {
  const cat = (s.catalog ?? {}) as Row;
  const route = (s.route ?? {}) as Row;
  const found = route.status === 'found';
  const { status: _s, match, ...routeRow } = route;
  void _s;
  const score = (s.score ?? {}) as Row;
  return {
    show_id: s.show_id,
    title: s.title ?? cat.title ?? null,
    status: s.status ?? null,
    language: s.language ?? cat.language ?? null,
    categories: str(cat.categories)?.split(',') ?? [],
    feed_url: cat.url ?? null,
    website: cat.link ?? null,
    podcast_guid: cat.podcast_guid ?? null,
    itunes_id: cat.itunes_id ?? null,
    newest_episode_at: iso(cat.pi_newest_item_at),
    fit: {
      matching_episodes: score.matching_episodes ?? null,
      evidence: ((s.evidence as Row[] | undefined) ?? []).map((e) => ({
        title: e.title ?? null,
        published_at: iso(e.published_at),
        snippet: typeof e.snippet === 'string' ? e.snippet.replace(/[«»]/g, '') : null,
        url: e.url ?? null,
      })),
    },
    route_status: found ? 'found' : 'none_found',
    best_route: found ? shapeRoute(routeRow as Row, match) : null,
    route_check: s.route_check ?? null,
    last_polled_at: iso(s.last_polled_at),
    ...(soft ? { your_last_outcome: soft } : {}),
  };
}

function routeCounts(shows: ReturnType<typeof shapeSearchShow>[]) {
  const c = { returned: shows.length, designated_for_purpose: 0, general_fallback: 0, none_found: 0, best_route_is_person_address: 0, never_crawled_for_contacts: 0 };
  for (const s of shows) {
    if (!s.best_route) c.none_found++;
    else if ((s.best_route as { match?: string }).match === 'designated_for_purpose') c.designated_for_purpose++;
    else c.general_fallback++;
    if (s.best_route?.holder_type === 'person') c.best_route_is_person_address++;
    if (s.route_check && (s.route_check as Row).crawled_at == null && !s.best_route) c.never_crawled_for_contacts++;
  }
  return c;
}

function dataAsOf(r: Row) {
  const d = (r.data_as_of ?? {}) as Row;
  return {
    directory_dump: str(d.t0_dump_last_modified),
    directory_reconciled_at: iso(d.t0_reconciled_at),
    oldest_feed_poll_among_results: iso(d.oldest_poll_among_results),
  };
}

// ─────────────────────────────────────────────────────────────── tools

async function runSearch(ctx: Ctx, a: { topic: string; purpose: Purpose; require_route: boolean; language: string | null; country: string | null; active_only: boolean; limit: number; cursor: string | null }, sup: Suppression, includeEngaged: boolean) {
  const excludeShows = [...sup.hardShows, ...(includeEngaged ? [] : [...sup.softShows.keys()])];
  const excludePeople = [...sup.hardPeople, ...(includeEngaged ? [] : [...sup.softPeople])];
  let r: Row;
  try {
    r = await withDeadline(
      Promise.resolve(
        ctx.idx.search({
          topic: a.topic,
          purpose: a.purpose,
          language: a.language,
          country: a.country,
          active_only: a.active_only,
          require_route: a.require_route,
          limit: a.limit,
          cursor: a.cursor,
          exclude_show_ids: excludeShows,
          exclude_person_keys: excludePeople,
        }),
      ),
      INDEX_RPC_TIMEOUT_MS,
      'the index',
    );
  } catch (e) {
    throw new Error(`the podcast index did not answer (${String((e as Error)?.message ?? e).slice(0, 160)}). Retry shortly; nothing about your arguments was wrong.`);
  }
  if (r.error) throw new Refusal(String(r.message ?? r.error));
  return { r, excludeShows, excludePeople };
}

async function findPodcastContacts(ctx: Ctx, args: Record<string, unknown>) {
  const topic = topicArg(args.topic);
  if (EMAIL_SHAPED.test(topic)) throw new Refusal('topic looks like an email address. Describe what the show is about instead; search by address is not offered.');
  const purpose = purposeArg(args.purpose);
  const limit = Math.min(50, Math.max(1, Number(args.limit ?? 20) || 20));
  const includeEngaged = args.include_engaged === true;
  const sup = await loadSuppression(ctx);
  const a = {
    topic,
    purpose,
    require_route: args.require_route === true,
    language: str(args.language)?.toLowerCase() ?? null,
    country: str(args.country)?.toLowerCase() ?? null,
    active_only: args.active_only !== false,
    limit,
    cursor: str(args.cursor),
  };
  const { r, excludeShows, excludePeople } = await runSearch(ctx, a, sup, includeEngaged);
  const shows = ((r.shows as Row[]) ?? []).map((s) => shapeSearchShow(s, includeEngaged ? sup.softShows.get(Number(s.show_id)) : undefined));
  const cov = (r.coverage ?? {}) as Row;
  const counts = routeCounts(shows);
  return {
    topic,
    purpose,
    filters: { require_route: a.require_route, active_only: a.active_only, language: a.language, country: a.country },
    shows,
    counts,
    coverage: {
      active_shows_searched: cov.t1_searched ?? null,
      shards_answered: cov.shards_answered ?? null,
      of: cov.of ?? null,
      partial: cov.partial ?? null,
      failed_shards: cov.failed_shards ?? [],
      // Stages the index cut at its own deadline (fleet #2427): 'routes' = some
      // candidates never had their routes checked; 'catalog' = shows came back
      // without catalog enrichment. Either one makes `partial` true.
      timed_out_stages: cov.timed_out_stages ?? [],
      index_timings_ms: r.timings ?? null,
      matching_shows: r.total_matching_shows ?? null,
      candidates_considered: r.candidates_considered ?? null,
      candidates_skipped: r.candidates_skipped ?? null,
      search_terms: ((r.query ?? {}) as Row).terms ?? null,
    },
    your_history: sup.applied
      ? { applied: true, shows_left_out: excludeShows.length, people_left_out: excludePeople.length, history_rows: sup.rows }
      : { applied: false, reason: sup.reason },
    cursor_next: r.cursor_next ?? null,
    data_as_of: dataAsOf(r),
    contacts_note: CONTACTS_NOTE,
    ...(shows.length === 0 ? { empty_reason: r.empty_reason ?? 'no shows matched' } : {}),
    ...(counts.best_route_is_person_address > 0
      ? { person_address_warning: `${counts.best_route_is_person_address} of ${counts.returned} results have a person's own address as their best route; no function inbox or form was published for them.` }
      : {}),
  };
}

async function getPodcast(ctx: Ctx, args: Record<string, unknown>) {
  const id = args.id;
  if (id == null || (typeof id === 'string' && !id.trim())) throw new Refusal('id is required: a show_id, an RSS feed URL or a podcast:guid.');
  let r: Row;
  try {
    r = await ctx.idx.getShow(typeof id === 'number' ? id : String(id).trim());
  } catch (e) {
    throw new Error(`the podcast index did not answer (${String((e as Error)?.message ?? e).slice(0, 160)}). Retry shortly.`);
  }
  if (!r.found) return { found: false, id, reason: r.reason ?? 'no show with this id, feed URL or podcast:guid is in the directory' };
  const cat = (r.catalog ?? {}) as Row;
  const st = (r.state ?? {}) as Row;
  const routes = ((r.routes as Row[]) ?? []).map((x) => shapeRoute(x));
  let history: unknown = { applied: false, reason: 'anonymous caller: no account' };
  if (ctx.account && ctx.db) {
    const rows = (await pg(
      ctx.db,
      `pod_engagement?account_id=eq.${encodeURIComponent(ctx.account)}&show_id=eq.${Number(r.show_id)}&select=scope,outcome,contact_id,at&order=at.desc&limit=50`,
    )) as Row[];
    history = { applied: true, records: rows };
  }
  const lastObserved = routes.map((x) => x?.last_observed).filter((x): x is string => !!x).sort().pop() ?? null;
  return {
    found: true,
    show_id: r.show_id,
    resolved_via: r.resolved_via ?? null,
    title: st.title ?? cat.title ?? null,
    feed_url: st.feed_url ?? cat.url ?? null,
    website: cat.link ?? null,
    podcast_guid: cat.podcast_guid ?? null,
    itunes_id: cat.itunes_id ?? null,
    language: st.language ?? cat.language ?? null,
    categories: str(cat.categories)?.split(',') ?? [],
    status: st.status ?? null,
    feed_health: st.health ?? null,
    last_original_episode_at: iso(st.last_original_at),
    revived_at: iso(st.revived_at),
    episodes: ((r.episodes as Row[]) ?? []).slice(0, 30).map((e) => ({
      title: e.title ?? null,
      published_at: iso(e.published_at),
      url: e.url ?? null,
      episode_type: e.episode_type ?? null,
      is_original: e.is_original == null ? null : Boolean(e.is_original),
    })),
    routes,
    routes_count: routes.length,
    person_addresses: routes.filter((x) => x?.holder_type === 'person').length,
    your_history: history,
    aliases: r.aliases ?? [],
    data_as_of: { last_polled_at: iso(r.last_polled_at), routes_last_observed: lastObserved },
    contacts_note: CONTACTS_NOTE,
  };
}

async function refreshPodcast(ctx: Ctx, args: Record<string, unknown>) {
  const id = args.id;
  if (id == null || (typeof id === 'string' && !id.trim())) throw new Refusal('id is required: a show_id, an RSS feed URL or a podcast:guid.');
  let r: Row;
  try {
    r = await ctx.idx.requestRefresh(typeof id === 'number' ? id : String(id).trim());
  } catch (e) {
    throw new Error(`the podcast index did not answer (${String((e as Error)?.message ?? e).slice(0, 160)}). Retry shortly.`);
  }
  if (!r.queued) return { queued: false, id, reason: r.reason ?? 'no show with this id' };
  const out: Row = { queued: true };
  for (const [k, v] of Object.entries(r)) {
    if (k === 'queued' || k === 'path') continue; // internal routing detail, not the caller's concern
    out[k] = /(_at|_due)$/.test(k) && typeof v === 'number' ? iso(v) : v;
  }
  out.note = 'The feed will be read again shortly; get_podcast_profile shows new episodes once it has been. Contact routes are re-checked separately, not by this call.';
  return out;
}

function requireAccount(ctx: Ctx, tool: string): { account: string; db: Db } {
  if (!ctx.account) {
    throw new Refusal(`${tool} requires an API key from a signed-in account: outreach history and watches are kept per account, and an anonymous caller has none. Get a free key at pipeworx.io/signup and call again with it.`);
  }
  if (!ctx.db) throw new Error('the account store is not configured on this deployment. This is a setup problem, not your arguments.');
  return { account: ctx.account, db: ctx.db };
}

async function recordEngagement(ctx: Ctx, args: Record<string, unknown>) {
  // First, before anything can echo it: an address is never an argument here.
  if (hasEmailShapedArg(args)) {
    throw new Refusal('record_podcast_outreach never takes an email address, and one of the arguments looks like one, so nothing was recorded. Name the show by show_id and, for a person-level record, the route by contact_id (both come from find_podcast_contacts or get_podcast_profile).');
  }
  const { account, db } = requireAccount(ctx, 'record_podcast_outreach');
  const showId = intArg(args.show_id, 'show_id');
  const outcome = args.outcome as Outcome;
  if (!OUTCOMES.includes(outcome)) throw new Refusal(`outcome must be one of: ${OUTCOMES.join(', ')}.`);
  const scope = args.scope == null ? 'show' : args.scope;
  if (scope !== 'show' && scope !== 'person') throw new Refusal("scope must be 'show' or 'person'.");
  const contactId = args.contact_id == null ? null : intArg(args.contact_id, 'contact_id');

  const show = await ctx.idx.getShow(showId);
  if (!show.found) throw new Refusal(`show_id ${showId} is not in the directory; nothing was recorded.`);
  let personKey: string | null = null;
  let holder: string | null = null;
  if (contactId != null || scope === 'person') {
    if (contactId == null) throw new Refusal("scope 'person' needs contact_id: the email route of the person, from get_podcast_profile.");
    const route = ((show.routes as Row[]) ?? []).find((x) => Number(x.contact_id) === contactId);
    if (!route) throw new Refusal(`contact_id ${contactId} is not a current route of show ${showId} (get_podcast_profile lists them); nothing was recorded.`);
    holder = str(route.holder_type);
    if (scope === 'person') {
      if (route.kind !== 'email' || typeof route.value !== 'string') {
        throw new Refusal(`contact_id ${contactId} is a ${String(route.kind)} route, not an address, so there is no person to record against. Record it with scope 'show'.`);
      }
      personKey = await sha256Hex(route.value);
    }
  }
  const rows = (await pg(db, 'pod_engagement', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ account_id: account, scope, show_id: showId, person_key: personKey, contact_id: contactId, outcome }),
  })) as Row[];
  const row = rows?.[0] ?? {};
  const effect =
    outcome === 'do_not_contact'
      ? scope === 'person'
        ? 'Every show publishing this person\'s address is now left out of your searches until you record clear on the same route.'
        : 'This show is now left out of your searches until you record clear.'
      : outcome === 'declined'
        ? 'Left out of your searches from now on.'
        : outcome === 'clear'
          ? 'Lifts an earlier do_not_contact or declined for this ' + scope + '.'
          : outcome === 'bounced'
            ? 'Recorded against the route; it does not hide the show.'
            : 'Left out of your searches unless you pass include_engaged: true.';
  return {
    recorded: true,
    id: row.id ?? null,
    scope,
    show_id: showId,
    contact_id: contactId,
    ...(holder ? { route_holder_type: holder } : {}),
    outcome,
    at: row.at ?? null,
    effect,
    visible_to: 'your account only',
  };
}

const MAX_WATCHES = 50;
const WATCH_WINDOW = 50;
const MAX_SEEN = 2000;

async function watchTopic(ctx: Ctx, args: Record<string, unknown>) {
  if (hasEmailShapedArg(args)) throw new Refusal('watch_podcast_topic takes a topic, not an email address; nothing was saved.');
  const { account, db } = requireAccount(ctx, 'watch_podcast_topic');
  const topic = topicArg(args.topic);
  const purpose = purposeArg(args.purpose);
  const existing = (await pg(db, `pod_topic_watches?account_id=eq.${encodeURIComponent(account)}&active=is.true&select=id`)) as Row[];
  if (existing.length >= MAX_WATCHES) throw new Refusal(`you already have ${existing.length} active watches (the limit is ${MAX_WATCHES}).`);
  const a = {
    topic,
    purpose,
    require_route: args.require_route === true,
    language: str(args.language)?.toLowerCase() ?? null,
    country: str(args.country)?.toLowerCase() ?? null,
    active_only: true,
    limit: WATCH_WINDOW,
    cursor: null,
  };
  const sup = await loadSuppression(ctx);
  const { r } = await runSearch(ctx, a, sup, false);
  const seen = ((r.shows as Row[]) ?? []).map((s) => Number(s.show_id));
  const rows = (await pg(db, 'pod_topic_watches', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ account_id: account, topic, purpose, language: a.language, country: a.country, require_route: a.require_route, seen_show_ids: seen, last_checked_at: new Date().toISOString() }),
  })) as Row[];
  return {
    watch_id: rows?.[0]?.id ?? null,
    topic,
    purpose,
    require_route: a.require_route,
    baseline_shows: seen.length,
    note: `The ${seen.length} shows matching now are the baseline; get_podcast_topic_changes reports shows that match after this.`,
    data_as_of: dataAsOf(r),
  };
}

async function getChanges(ctx: Ctx, args: Record<string, unknown>) {
  const { account, db } = requireAccount(ctx, 'get_podcast_topic_changes');
  const filter = args.watch_id == null ? '' : `&id=eq.${intArg(args.watch_id, 'watch_id')}`;
  const watches = (await pg(
    db,
    `pod_topic_watches?account_id=eq.${encodeURIComponent(account)}&active=is.true${filter}&select=id,topic,purpose,language,country,require_route,seen_show_ids,last_checked_at&order=id.asc`,
  )) as Row[];
  if (!watches.length) {
    return { watches: [], note: args.watch_id == null ? 'You have no active topic watches; create one with watch_podcast_topic.' : `No active watch ${String(args.watch_id)} on your account.` };
  }
  const sup = await loadSuppression(ctx);
  const out = [];
  for (const w of watches) {
    const a = {
      topic: String(w.topic),
      purpose: w.purpose as Purpose,
      require_route: w.require_route === true,
      language: str(w.language),
      country: str(w.country),
      active_only: true,
      limit: WATCH_WINDOW,
      cursor: null,
    };
    const { r } = await runSearch(ctx, a, sup, false);
    const seen = new Set(((w.seen_show_ids as number[]) ?? []).map(Number));
    const now = ((r.shows as Row[]) ?? []).map((s) => shapeSearchShow(s));
    const fresh = now.filter((s) => !seen.has(Number(s.show_id)));
    const nextSeen = [...new Set([...fresh.map((s) => Number(s.show_id)), ...seen])].slice(0, MAX_SEEN);
    const checkedAt = new Date().toISOString();
    await pg(db, `pod_topic_watches?id=eq.${Number(w.id)}&account_id=eq.${encodeURIComponent(account)}`, {
      method: 'PATCH',
      body: JSON.stringify({ seen_show_ids: nextSeen, last_checked_at: checkedAt }),
    });
    out.push({
      watch_id: w.id,
      topic: w.topic,
      purpose: w.purpose,
      since: w.last_checked_at ?? null,
      new_shows: fresh,
      new_count: fresh.length,
      matching_now: now.length,
      data_as_of: dataAsOf(r),
    });
  }
  return { watches: out, contacts_note: CONTACTS_NOTE };
}

// ─────────────────────────────────────────────────────────────── dispatch

function contextFrom(args: Record<string, unknown>): Ctx {
  const idx = args._podIndex as PodIndexRpc | undefined;
  if (!idx || typeof (idx as { search?: unknown }).search !== 'function') {
    throw new Error(
      'pod-researcher only runs on the Pipeworx gateway (https://gateway.pipeworx.io/mcp): its podcast index is a Pipeworx service that this standalone build has no connection to, so it cannot answer rather than return an empty list. Connect to the gateway instead. This is a setup problem, not your arguments.',
    );
  }
  const url = str(args._supabaseUrl);
  const key = str(args._supabaseKey);
  const account = str(args._accountId);
  return { idx, db: url && key ? { url, key } : null, account };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const ctx = contextFrom(args);
  try {
    switch (name) {
      case 'find_podcast_contacts':
        return await findPodcastContacts(ctx, args);
      case 'get_podcast_profile':
        return await getPodcast(ctx, args);
      case 'refresh_podcast':
        return await refreshPodcast(ctx, args);
      case 'watch_podcast_topic':
        return await watchTopic(ctx, args);
      case 'get_podcast_topic_changes':
        return await getChanges(ctx, args);
      case 'record_podcast_outreach':
        return await recordEngagement(ctx, args);
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (e) {
    if (e instanceof Refusal) throw new Error(e.message);
    throw e;
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
