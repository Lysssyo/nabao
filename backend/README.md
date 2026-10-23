# nabao backend

Java 21 / Spring Boot 3.5.7. The current iOS feed reads the collector's daily public
JSON table. Anonymous push registrations remain in the database. Personal investment
plans and screenshots remain on iOS. Earlier quota-evidence APIs remain available
for legacy integration checks.

The implementation uses small quota, run-report and push services with `JdbcTemplate`,
DTOs, controllers, an error handler, and SQL initialization. A static management page
uses the same HTTP service.

## Run locally

Use JDK 21 and Maven 3.9.x. Do not change the machine's default JDK if other projects need it.
For example on this Mac:

```sh
JAVA_HOME=/opt/homebrew/opt/openjdk@21 \
PATH=/opt/homebrew/opt/openjdk@21/bin:$PATH \
/Users/heqiguang/develop/apache-maven-3.9.8/bin/mvn spring-boot:run
```

The default `local` profile uses persistent H2 storage in `backend/.local/`, which is
ignored by Git. Start the command in `backend/`. Public reads work without a key;
observation writes return HTTP 503 until `INTERNAL_API_KEY` is set. Set this variable
in your local environment without committing it.

```sh
curl http://localhost:8080/api/v1/health
curl http://localhost:8080/api/v1/table
curl http://localhost:8080/api/v1/sources
curl 'http://localhost:8080/api/v1/quotas?fundCode=016452'
```

A fresh installation has two sources and **zero observations**. It does not ship
sample observations as current quotas.

## API

The shared contract is [`../docs/contract.md`](../docs/contract.md).

| Method and path | Purpose |
| --- | --- |
| `GET /api/v1/health` | Database availability and configuration states, never secret values |
| `GET /api/v1/table` | Read the current published JSON file; 404 if absent, 503 if invalid |
| `GET /api/v1/sources` | Configured public authors |
| `GET /api/v1/quotas?fundCode=016452` | Most recent data date for each fund/channel/business/period/currency scope |
| `POST /api/v1/push-devices` | Register or refresh an anonymous APNs installation |
| `DELETE /api/v1/push-devices/{installationId}` | Unsubscribe using `X-Installation-Key` |
| `POST /internal/v1/observations` | Atomic batch, protected by `X-Internal-Key` |
| `POST /internal/v1/note-snapshots` | Publish a complete note revision and withdraw removed rows |
| `PUT /internal/v1/runs/{runId}` | Store a completed, sanitized collector run report |
| `GET /internal/v1/runs` | Latest 50 run summaries, protected by `X-Internal-Key` |
| `GET /internal/v1/runs/{runId}` | Full sanitized report, protected by `X-Internal-Key` |
| `GET /admin/` | Management page for task results, public quotas and sources |

An empty query returns `{"items":[]}`. `fundCode` is optional and must be a six-digit
string when supplied. `AGREED` requires at least two source groups and a strict majority.
`INSUFFICIENT` and `CONFLICT` have null top-level `limitKind` and `amountMinor`; the
original observations remain in `votes`.

The internal POST accepts `{"items":[...]}`, at most 500 rows, and returns
`{"accepted":2,"duplicates":0}`. Unknown or disabled authors return 422. Invalid fields
return 400. Wrong or missing key returns 401 when ingestion is configured. An existing
revision with a changed payload returns 409. A failed batch rolls back completely.

### Daily public table

`NABAO_TABLE_FILE` defaults to `../.local/public/latest.json` when starting in
`backend/`. The collector writes dated files and atomically replaces `latest.json`.
The backend reads that file on every request, validates schema version 1, its data
date and source, and 1–44 unique rows within the configured Nasdaq share-code set.
The seven columns are `fundCode`, `fundName`, `feeRate`, `distributorLimit`,
`directLimit`, `trackingError`, and `return1y`; absent metrics remain null. Limits
retain source wording, including paused, unavailable, and qualified channel limits.

Responses use `Cache-Control: no-store`. Missing files return 404; malformed,
oversized (over 256 KiB), or structurally invalid files return 503. There is no
fallback to old database quotas or a previously read file. The file's `dataDate`
remains visible so clients can identify stale data. No model analysis is returned.

### Note publication snapshots

The automatic collector publishes through `/internal/v1/note-snapshots`. Its body is:

```json
{
  "authorId": "configured-author",
  "noteId": "note-id",
  "noteRevision": "publication-sha256",
  "sourcePublishedAt": "2026-10-20T01:00:00Z",
  "sourceUpdatedAt": null,
  "capturedAt": "2026-10-20T02:00:00Z",
  "evidenceRef": "https://www.xiaohongshu.com/explore/note-id",
  "items": []
}
```

`items` contains the same complete observation DTOs as the batch API. Every row must
match the envelope's author, note, revision and timestamps; row evidence references
can include image/row fragments. A snapshot can contain at most one observation per
fund/channel/business/period/currency/data-date key. The snapshot is the complete set
of publishable observations for this processing result, rather than every row in the
original note.

When all source images and a complete model response have been received, the collector
may publish the subset whose fund identity and value can be verified. Unresolved rows
are excluded from voting and the run remains `partial`; publishing that subset does
not mean the entire note passed validation. Missing rows replace the previous
publication's rows, so an uncertain row does not leave an older vote active.

Request failures, missing images, truncated responses and results with no resolvable
rows must not be converted to empty snapshots. An empty array explicitly withdraws
all observations from that note; the collector only uses it for a complete response
that found no quota rows and reported no issues.

`noteRevision` is the publication hash, including the original content revision,
prompt version, model, source timestamps and sorted normalized observations. This
allows a corrected extraction to publish a new immutable revision even when the
original note has not changed. The original content hash remains in local
`capture.json`; `publication.json` records its relationship to the publication hash.

The result is `{"status":"ACTIVATED","accepted":2,"duplicates":0}`. `STALE` means the
revision was stored as evidence but a newer version remains active. `DUPLICATE` is
an unchanged retry; it never refreshes timestamps or reactivates an old version.
Source modification/publication time determines order, with original capture time
breaking ties. The complete revision is immutable: reordered rows are accepted as
an idempotent retry, but changed/removed rows under the same revision return 409.

Activation and observation storage share one transaction and serialize on the source
row. Queries only use a note's active snapshot. Across different notes, each author
still contributes at most one latest vote per scope and date.

Legacy batch ingestion remains available for notes without snapshots. Once a note has
a snapshot, updates must use the snapshot endpoint; the batch endpoint returns 409
instead of adding rows outside the complete manifest. Existing legacy rows can be
adopted by a matching complete snapshot without rewriting evidence.

### Task reports and management page

Open `http://localhost:8080/admin/`. Public quotas and source configuration are readable
without the management key; task reports require `INTERNAL_API_KEY`. The browser holds
the key only in page memory and clears the password input after connecting. It never
puts the key in a URL or browser storage.

The collector first saves its local report, then uploads a sanitized summary. Upload
failure does not change the collection result or delete local evidence. The backend
stores completed reports immutably: an identical PUT is safe to retry; a changed
report under the same run ID returns 409.

The report fields are `runId`, `startedAt`, `finishedAt`, `status`, `discoveryMode`,
`automaticDiscoveryValidated`, `scope: {maxNotesPerAuthor, sourceIds}` and `results`.
Each source result has `authorId`, `status`, `transport`, `discoveredCount`, `issues`,
`notes` and `processing`. Notes contain only `noteId`, `revision`, `captureStatus`
and `issues`; processing entries contain `status`, `stage`, `observationCount`,
optional nullable `published`, and `issues`. `published: true` records that the verified
subset was submitted successfully; `status: partial` still identifies unresolved
parts of the note. Raw note text, images, model responses and secrets are not accepted
fields.

Reports are limited to 60,000 encoded UTF-8 bytes, 20 sources, 100 notes/processing
entries per source, and 100 issue strings of at most 1,000 characters per list.
The page renders source strings as text under a restrictive content policy. It
provides visibility into automatic work; it does not require daily manual imports.

### Evidence and majority rules

- Match the same fund **share code**, date, channel scope, business type, period, and
  currency before comparing values.
- Per author and group, use the latest source update/publish timestamp, then collection
  timestamp. A late-arriving old note cannot replace a newer note.
- An exact retry or a re-fetch of unchanged content is idempotent. It does not change
  the original collection/receipt timestamps or add another vote.
- All revisions remain in `quota_observation`; `quota_note_snapshot` selects complete
  active revisions. A new data date with insufficient evidence is shown as insufficient instead
  of silently using yesterday's agreed quota.
- Known reposts sharing a `sourceGroupId` count as one source. If members of that group
  disagree, none of those observations casts a value vote; their conflict remains visible.
- A `LIMITED` observation requires a nonnegative integer in minor currency units.
  `PAUSED`, `UNAVAILABLE`, `UNLIMITED`, and `UNKNOWN` require a null amount.
- Unknown business/period/channel fields stay unknown even when authors agree.
  `DISTRIBUTOR` is not verification of a particular distribution platform.
- `observedForDate` must come from the source. Server receipt time never substitutes for it.

`counted` in `votes` means the row represents one source's vote, including a legitimate
dissenting vote. `exclusionReason` explains known copies or within-group conflicts.
`supportCount` is the largest agreement count, while `sourceCount` counts source groups.
`updatedAt` is the latest server receipt time among the currently selected observations.
Consumers must use `observedForDate`, not `updatedAt`, to assess business data freshness.

The endpoint does not invent a rule expiry duration. Old observations remain dated;
clients must not display them as today's verified values.

### Anonymous push delivery

Registration accepts exactly `installationId` (UUID), `installationSecret` (32–256
URL-safe/Base64 characters), `token` (32–512 lowercase hexadecimal characters in
complete byte pairs), and `environment` (`sandbox` or `production`). iOS generates
and retains the installation ID and a random secret locally. The server stores only
a salted SHA-256 secret hash. This credential permits changing or deleting only that
installation; it is independent of the collector's internal key.

The response contains `installationId`, `status: REGISTERED`, `deliveryEnabled`,
`providerStatus`, and `environment`. A registered device can remain disabled while
Apple provisioning is unavailable. Wrong credentials return 401; malformed requests
return 400. One token/environment pair has one installation owner, enforced by a
database unique constraint; attempts to claim another installation's token return
409. Re-registering an owned token does not send the initial quota feed again.

The first complete public table establishes a baseline. In the default `table` mode,
changes to the data date, share codes, or direct/distributor limits create a persistent
pending digest per installation. Fees, returns, tracking errors, names, row order,
source links, and collection timestamps alone do not notify. Missing or malformed
files suspend polling without changing retry state; registration may wait for the
first complete file to establish its baseline. `NABAO_PUSH_DATA_SOURCE=legacy`
retains the earlier database quota behavior for old integration checks.
Each scheduler tick attempts each eligible device at most once. A provider 200 marks
that digest accepted; APNs acceptance does not prove delivery to the phone.

Transient errors retry after 60, 120, 240, 480, and 960 seconds; the sixth failure and
later failures retry hourly. `Retry-After` can extend an early delay up to one hour.
Other provider rejections retry hourly so a corrected provider configuration can
recover after restart. Pending state survives service restarts and is replaced by
the newest feed; a return to the already acknowledged feed cancels an unsent change.
This scheduler is designed for one backend instance; multiple replicas need a
database delivery lease before enabling more than one scheduler.

410 and `BadDeviceToken` deactivate the token. A 410 timestamp older than the most
recent registration is treated as a transient stale response. Authenticated fresh
registration, including the same token, reactivates a disabled device. Every refresh
increments a token version, so an earlier in-flight result cannot disable or
acknowledge the replacement token. A valid unsubscribe deletes the installation and
is idempotent. It prevents future attempts and completion writes; a request already
in flight or accepted by APNs may still appear on the phone.

Only a generic message, “公开参考额度有更新，请打开纳宝核对定投”, plus `screen: quotas`
is sent. The payload contains no personal plans, amounts, author evidence or device
credentials. The implementation uses HTTP/2, ES256 provider tokens cached for 45
minutes, the configured bundle topic and a public-feed collapse ID. It never follows
provider redirects or logs token/private-key/provider-response content.

Local tests use generated P-256 keys and an HTTP mock on numeric loopback. The optional
`APNS_TEST_ENDPOINT` is accepted only under the `test` Spring profile, with an HTTP
root URL on `127.0.0.1` or `::1`, an explicit port, and no credentials/query/fragment.
Invalid endpoints disable delivery; the setting is never a fallback to Apple.
Leave it empty outside local tests. No Apple account or real device is needed to run
these tests. Real delivery still requires signed iOS provisioning and Apple APNs credentials.

For a database created by the earlier push prototype, apply
[`migrations/001-push-token-ownership.sql`](migrations/001-push-token-ownership.sql)
once before enabling delivery. Fresh databases receive the constraint from
`schema.sql`. The migration intentionally fails if conflicting legacy ownership exists;
resolve those registrations explicitly rather than choosing an owner silently.

## Configuration

| Variable | Purpose |
| --- | --- |
| `PORT` | HTTP port, default `8080` |
| `SPRING_PROFILES_ACTIVE` | `local` (default) or `mysql` |
| `INTERNAL_API_KEY` | Shared secret for collector submission; blank disables writes |
| `NABAO_TABLE_FILE` | Current public table path, default `../.local/public/latest.json` |
| `NABAO_PUSH_DATA_SOURCE` | `table` (default) or `legacy`; table mode never queries quota rows |
| `DB_URL` | MySQL JDBC URL |
| `DB_USERNAME` | MySQL user, default `nabao` |
| `DB_PASSWORD` | Required for MySQL profile |
| `APNS_ENABLED` | Explicit delivery switch; defaults to `false` |
| `APNS_TEAM_ID`, `APNS_KEY_ID` | Apple team and signing-key identifiers |
| `APNS_BUNDLE_ID` | Signed application's exact bundle topic |
| `APNS_PRIVATE_KEY_PATH` | Readable PKCS#8 P-256 `.p8` file; mount read-only outside Git |
| `APNS_ENVIRONMENT` | `sandbox` or `production`; must match the device registration |
| `APNS_POLL_DELAY_MS` | Fixed delay between delivery ticks, default `60000` |
| `APNS_TEST_ENDPOINT` | Test-profile-only numeric-loopback HTTP provider mock |

Health reports the model as `MANAGED_BY_COLLECTOR`: this service does not receive model
credentials or determine model connectivity. Consult collector run reports for the
extraction outcome. Push health reports `DISABLED` by default, `NOT_CONFIGURED` when
enabled without required values, `INVALID_CONFIGURATION` for invalid credentials or
endpoint settings, and `READY` after local configuration validation. `READY` does not
mean Apple accepted a request or a phone received a notification.

## MySQL and Docker

The `mysql` profile uses the same schema with MySQL 8.4. Create database `nabao` with
UTF-8 (`utf8mb4`) before startup, then provide the JDBC URL, username, and password.
The root Compose configuration orchestrates the database and service.

The Docker build context is `backend/`:

```sh
docker build -t nabao-backend .
```

The image runs as a non-root user, defaults to the MySQL profile, and runs tests during
the build with `mvn verify`. It needs database environment variables at runtime. SQL initialization creates
missing tables and seeds the two source IDs idempotently. The snapshot/report addition
creates two new tables without altering existing observations. Changes to existing
table columns still require an explicit reviewed migration.

The local integration suite uses H2 in MySQL mode. `scripts/container-smoke.sh` additionally
builds both images and tests a disposable MySQL 8.4 Compose project on port 18080, including
authentication, consensus, duplicate submissions, removed-row withdrawal and restart
persistence. Its generated credentials and reports stay in the ignored `.local/` directory;
its test containers and database volume are removed on exit.

For local collector build networks that require a proxy, set the optional
`NABAO_BUILD_PROXY` to a proxy reachable from the builder. The smoke script passes
Docker's predefined proxy build arguments to the collector build; it does not set
runtime proxy variables or change the backend build. CI leaves this unset.

On 2026-10-20, both source Dockerfile builds and the complete MySQL smoke passed.
The backend build passed 40 tests; the collector build passed 63 tests under Linux
and Node 22. The non-root collector also launched Chromium and verified a local HTML
page. Smoke data is isolated from development data, and these checks do not contact
the authors or a model service.

## Verify

```sh
mvn -B verify
```

JUnit tests exercise real JDBC persistence and HTTP validation: mixed scopes/dates,
source deduplication, same-origin conflicts, revision history, out-of-order arrival,
idempotency, batch rollback, unknown business types, null-vs-zero semantics, and
missing internal-key configuration. Snapshot tests cover removals, empty withdrawal,
late revisions, immutable retries, metadata mismatch, legacy adoption and multi-author
votes. Run-report tests cover authenticated reads/writes, size limits, immutable retry,
raw-field rejection and the management page.

If a corporate Maven mirror blocks public dependencies, use a separate local settings
file pointing to Maven Central rather than editing global credentials or settings.

## Initial scope

This service does not claim the collector is healthy simply because HTTP is up.
Source discovery, browser completeness checks, model extraction and source health live
in the collector. Anonymous registration, provider signing and delivery/retry state
are tested locally. Apple delivery remains a separate provisioning and device check.
Personal risk assessment stays on iOS.
