# @pipeworx/pod-researcher

Podcast prospecting for guest booking and sponsorship: given a topic and a purpose, returns active podcasts whose recent episodes cover the topic, each with the best contact route the show itself published, the episodes that prove the fit, and your own outreach history so you never pitch the same show twice.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1683+ live data sources.

## Tools

- `find_podcast_contacts(topic, purpose, require_route?, language?, country?, active_only?, include_engaged?, limit?, cursor?)` — active shows ranked by topical fit, each with `best_route` (or `route_status: "none_found"` plus what was checked), evidence episodes, coverage counts and `data_as_of`. `purpose` is `guest` or `sponsor`; routes designated for that purpose rank first, and a general contact or a person's published address is a labelled fallback. `require_route: true` returns only shows that have one.
- `get_podcast_profile(id)` — one show in full: identity, activity status, feed health, latest episodes, every published route. `id` is a show_id, an RSS feed URL (moved feeds resolve by their old URL) or a podcast:guid.
- `refresh_podcast(id)` — re-read one show's RSS feed now rather than waiting for its next scheduled check.
- `watch_podcast_topic(topic, purpose, ...)` / `get_podcast_topic_changes(watch_id?)` — save a search and get the shows that newly match it.
- `record_podcast_outreach(show_id, outcome, scope?, contact_id?)` — record contacted / replied / declined / booked / bounced / do_not_contact / clear. Declined and do_not_contact shows leave your searches; a `scope: "person"` record hides every show that publishes that person's address. Private to your account.

## Auth

Keyless to search. `watch_podcast_topic`, `get_podcast_topic_changes` and `record_podcast_outreach` need a signed-in account (an API key from pipeworx.io/signup): outreach history is kept per account, and an anonymous caller has none. This pack runs only on the Pipeworx gateway; a standalone build refuses every call rather than returning an empty list.

## Contacts: what is returned and how it is labelled

Every address a show publishes in its own RSS feed or on its own website is returned, labelled:

- `holder_type`: `role` (a function inbox such as booking@ or sponsorships@), `hosting_account_owner` (the `itunes:owner` address from the feed, usually the host), or `person` (an individual's own address).
- `purpose` (`guest`, `sponsor`, `general`) and `confidence` (`designated` when the show invited that purpose in words, `fallback` otherwise), plus `match` on the best route: `designated_for_purpose` or `general_fallback`.
- `source_url` (the page or feed it was read from) and `last_observed`.

Addresses are never synthesised. A global removal list is honoured at serve time. `record_podcast_outreach` never takes an address: a call carrying anything email-shaped is refused without repeating it, and a person-level record stores a SHA-256 of the address, not the address.

## Data sources

- Podcast Index open directory (<https://podcastindex.org>) — which podcasts exist, their feed URLs and identifiers.
- Each show's RSS feed — episodes, publishing cadence, the `itunes:owner` address and invitation lines in episode notes.
- Each show's own website — its guest, advertise and contact pages.

Matching is on words in episode titles and show notes (the latest ~30 episodes per show), so a show that never names the topic in its notes is not found. Generated-content spam is left out by a classifier that also catches some real shows whose episode notes disclose AI assistance. Contact coverage is still growing: `route_check` on each result says whether the show's website has been read yet, so "none found" and "not looked at yet" are distinguishable.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "pod-researcher": {
      "url": "https://gateway.pipeworx.io/pod-researcher/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/pod-researcher/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1683+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/find_podcast_contacts \
  -H 'Content-Type: application/json' \
  -d '{"topic":"AI agents developer infrastructure","purpose":"guest","limit":5}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/find_podcast_contacts`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "pod-researcher": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-pod-researcher"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-pod-researcher
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Pod Researcher data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
