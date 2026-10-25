# nabao backend

Java 21 / Spring Boot 3.5.7. The current iOS feed reads the collector's daily public
JSON table. Anonymous push registrations remain in the database. Personal investment
plans and screenshots remain on iOS. Earlier quota-evidence APIs remain available
for legacy integration checks.

The backend separates HTTP, application use cases, domain rules and external storage.
The Vue 3 management application is built separately and served by the same HTTP service.

## Architecture

Java sources live under `src/main/java/com/nabao/`. `NabaoApplication` is the Spring
Boot entry point; the remaining classes have explicit responsibilities:

| Package | Responsibility |
| --- | --- |
| `web` | HTTP routing, request validation, internal-key authorization, cache/status headers and error-to-HTTP mapping |
| `application` | Daily-table reads/readiness, publication/status reconciliation, legacy ingestion transactions, immutable run uploads, device registration and delivery/retry coordination |
| `application.port` | The specific repository and provider interfaces required by those use cases |
| `domain` | Shared values, legacy author/scope consensus and confirmed-limit semantics; no Spring, HTTP, SQL or file access |
| `infrastructure.file` | Bounded JSON reads, strict file/schema validation and atomic private push-state persistence |
| `infrastructure.jdbc` | SQL queries, row mapping, author locks, token ownership and guarded device-state updates |
| `infrastructure.collector` | Fixed-route authenticated collector control, bounded responses and complete-response deadlines |
| `infrastructure.apns` | HTTP/2 requests, provider response parsing and signing-key/JWT handling |

Controllers call application services. Services depend on domain values and the
repository/provider interfaces; Spring injects their infrastructure implementations.
The application and domain packages do not import HTTP controllers or infrastructure
implementations. Jackson annotations and Bean Validation remain on shared value types
to preserve the wire contract without duplicating every record.

For example, `DailyTableController` calls `DailyTableService`, which reads through
`DailyTableRepository`. `JsonDailyTableRepository` owns bounded file parsing and the
SHA256 of its original bytes. `TableStatusService` separately compares that publication
with `CollectorStatusRepository` data; a reader implementation cannot silently turn
a mismatched status into a successful check. Public values remain the collector's
voting results; the backend does not invent or edit them.

Legacy ingestion keeps transaction boundaries in `QuotaService`; `JdbcQuotaRepository`
performs the same locked/atomic SQL operations, and `QuotaConsensus` computes results
without a database. `PushService` coordinates registration and retries through
`PushDeviceRepository` and `PushGateway`; the JDBC adapter retains token-version and
installation-creation guards against stale in-flight responses. `TablePushState`
coordinates confirmed-limit state through `PushStateRepository`, while
`ConfirmedLimitPolicy` classifies values without reading files.

Use-case failures are `ApplicationFailure` kinds, mapped to the existing HTTP codes
and detail messages by `web.ApiErrors`. This refactor does not change database schemas,
public JSON fields, endpoint URLs or stored fingerprints. Existing legacy HTTP APIs
remain available independently of the current management-page scope.

`ArchitectureTest` enforces the dependency direction using the source tree, without
an additional framework. The full integration suite still exercises real JDBC/H2,
bounded files, HTTP contracts, ownership races and restart/retry behavior.

## Run locally

Use JDK 21 and Maven 3.9.x. Do not change the machine's default JDK if other projects need it.
For example on this Mac:

```sh
JAVA_HOME=/Users/Admin/Library/Java/JavaVirtualMachines/zulu-21.jdk/Contents/Home \
PORT=18081 \
/Users/Admin/dev/tools/apache-maven-3.9.16/bin/mvn spring-boot:run
```

The default `local` profile uses persistent H2 storage in `backend/.local/`, which is
ignored by Git. Start the command in `backend/`. Public reads work without a key;
observation writes return HTTP 503 until `INTERNAL_API_KEY` is set. Set this variable
in your local environment without committing it.

```sh
curl http://localhost:18081/api/v1/health
curl http://localhost:18081/api/v1/readiness
curl http://localhost:18081/api/v1/table
```

A fresh legacy database has two sources and **zero observations**. The current daily
table uses the collector-managed source list (initially five authors) and a separate public JSON file; database seeds
are not the source of that table. No sample observations ship as current quotas.

Port 18081 is used for this project's local development; port 8080 belongs to another
project on this Mac. For the managed local service and iPhone setup, follow
[`../docs/iphone-quickstart.md`](../docs/iphone-quickstart.md) instead of starting a
second server on the same port.

## API

The shared contract is [`../docs/contract.md`](../docs/contract.md).

| Method and path | Purpose |
| --- | --- |
| `GET /api/v1/health` | Database availability and configuration states, never secret values |
| `GET /api/v1/readiness` | Current table readable: 200 `READY`; missing/invalid: 503 `NOT_READY` |
| `GET /api/v1/table` | Read the current published JSON file; 404 if absent, 503 if invalid |
| `GET /api/v1/sources` | Legacy database sources; not the current collector author configuration |
| `GET /api/v1/quotas?fundCode=016452` | Most recent data date for each fund/channel/business/period/currency scope |
| `POST /api/v1/push-devices` | Register or refresh an anonymous APNs installation |
| `DELETE /api/v1/push-devices/{installationId}` | Unsubscribe using `X-Installation-Key` |
| `POST /internal/v1/observations` | Atomic batch, protected by `X-Internal-Key` |
| `POST /internal/v1/note-snapshots` | Publish a complete note revision and withdraw removed rows |
| `PUT /internal/v1/runs/{runId}` | Store a completed, sanitized collector run report |
| `GET /internal/v1/runs` | Latest 50 run summaries, protected by `X-Internal-Key` |
| `GET /internal/v1/runs/{runId}` | Full sanitized report, protected by `X-Internal-Key` |
| `GET /internal/v1/table-status` | Actual daily table and safe collector status, protected by `X-Internal-Key` |
| `GET /internal/v1/collector` | Current run, session, login and schedule status |
| `POST /internal/v1/collector/runs` | Collect the currently configured authors asynchronously (202) |
| `POST /internal/v1/collector/authors` | Add an author with name and profileUrl (201, full status) |
| `DELETE /internal/v1/collector/authors/{id}` | Remove an author (200, full status) |
| `POST /internal/v1/collector/login` | Start an isolated QR login window (202) |
| `POST /internal/v1/collector/login/complete` | Verify the live authenticated account and commit its session |
| `DELETE /internal/v1/collector/login` | Cancel the staged login without replacing the previous session |
| `GET /internal/v1/collector/login/preview` | Authenticated, non-cacheable PNG of the normal login page |
| `POST /internal/v1/collector/session/check` | Check the actual saved browser session asynchronously (202) |
| `GET /admin/` | Current daily voting results, sorted by distributor limit, and collection summary |

An empty query returns `{"items":[]}`. `fundCode` is optional and must be a six-digit
string when supplied. `AGREED` requires at least two source groups and a strict majority.
`INSUFFICIENT` and `CONFLICT` have null top-level `limitKind` and `amountMinor`; the
original observations remain in `votes`.

The internal POST accepts `{"items":[...]}`, at most 500 rows, and returns
`{"accepted":2,"duplicates":0}`. Unknown or disabled authors return 422. Invalid fields
return 400. Wrong or missing key returns 401 when ingestion is configured. An existing
revision with a changed payload returns 409. A failed batch rolls back completely.

### Collector control

`CollectorController → CollectorService → CollectorGateway → HttpCollectorGateway` keeps HTTP routing, the application boundary and outbound I/O separate. Configure `NABAO_CONTROL_URL` (default `http://127.0.0.1:18082`) and `NABAO_CONTROL_KEY` (defaults to `INTERNAL_API_KEY`). Start the Node collector with `node dist/src/cli.js control`; see [collector setup](../collector/README.md#管理端采集与扫码登录).

All collector management requests require `X-Internal-Key`. Responses, including errors and PNG previews, use `Cache-Control: no-store`. The worker address and routes are fixed by server configuration, never supplied by a request. Raw worker exceptions and credentials are not returned. JSON is limited to128KiB, previews to2MiB, and the55-second timeout covers the complete response body. Redirects are refused. Unavailable workers return503; overlapping work or an unconfirmed login returns409.

Successful JSON responses use the same snapshot shape: `available`, `busy`, `session`, nullable `run`, `schedule`, `login` and the current `sources` (id, name and profileUrl). Starting a run/login/session check returns202 and polling the status tracks it after page refresh. A run reports its true collection outcome; no-new-post keeps the current table and its original date. Session and login states distinguish `restricted` from `expired`; risk pages stop the active browser and pause scheduling until a later explicit check/login succeeds. A restricted-page PNG may remain in worker memory for authenticated inspection, never in public storage. Author configuration accepts 0–50 authors and is stored by the collector. `POST /authors` accepts only `{name, profileUrl}` (at most 4KiB); names are trimmed to 1–80 characters, and profiles must use the exact HTTPS Xiaohongshu profile host/path, without credentials or ports. Query parameters are removed when saved. Invalid input returns400, missing authors404, duplicates or busy workers409. Mutations do not start collection. Fewer than two authors disables collection and scheduling. Signing in still means the user's own collector account; author management is a separate panel.

The Compose collector now runs this service continuously and schedules every360minutes after startup (configurable, minimum60). Port18082 stays inside the Compose network. The Java backend has no read access to the collector's private browser/profile volume and proxies only the allowlisted endpoints.

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

### Current daily-table management

Open `/admin/` and connect with `INTERNAL_API_KEY`. The page reads
`/internal/v1/table-status` and `/internal/v1/collector`, and shows the same daily voting results as iOS: data date,
publication time, last check start, last successful check/publication, adopted/pending
field counts, and the last run's author names and voting-data row counts with collection errors. The historical summary retains its own author snapshot after the current list changes.
The displayed table sorts distributor limits in descending order while preserving
qualified values and their wording. Legacy task/quota/source tabs have been removed.
The key stays in page memory, is
cleared from the input after connection, and is never stored or included in a URL.

`NABAO_STATUS_FILE` defaults to `../.local/status/daily-table.json`. The collector
publishes this allowlisted summary independently of private evidence and watch state.
The backend reads only the configured regular file, at most 64 KiB; it rejects
symlinks, malformed/duplicate/unknown fields, invalid dates, future timestamps and
unknown source/error codes. Raw note text, image/model evidence, private paths,
credentials and signed URLs are not accepted. Responses use `Cache-Control: no-store`.
Missing/wrong management keys return 401; an unconfigured key returns 503.

The response separates `tableState` (`AVAILABLE`, `MISSING`, `INVALID`) from
`summaryState` (`AVAILABLE`, `MISSING`, `INVALID`, `STALE`, `INCONSISTENT`). A valid
table remains visible if status is missing or invalid. Status older than
`NABAO_STATUS_STALE_SECONDS` (default 43200, minimum 60) is marked stale. A SHA-256
digest of exact public bytes, date, publication time and counts bind the summary to
its table; a mismatch hides summary counters/source states until they agree.

`attemptedDate` belongs to the most recent check; `published.dataDate` belongs to the
current file. A next-day check without a new table therefore retains the preceding
table's date and counts. There are five counted fields per row: non-null metrics and
limits other than `待更新` count as adopted, including explicitly qualified values.
Counts describe the published display; they do not expose votes or prove a channel
limit applies to an individual plan. A failed attempt does not advance `lastSuccess`.

`/api/v1/readiness` checks file availability/schema, not age or collector liveness.
The existing `/api/v1/health` contract remains unchanged. A missing daily table does
not block authenticated device unsubscribe or change push configuration status.

### Legacy note publication snapshots

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

### Legacy task reports

Database task reports, quotas and sources remain accessible through the existing
legacy HTTP APIs, independently of the current management page. These do not
represent the current daily table. Legacy quota/source APIs remain readable without
a key; task reports require `INTERNAL_API_KEY`.

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
The current management page renders only the daily voting results and safe collection
summary as text under a restrictive content policy. Raw legacy reports are available
through the authenticated APIs above; daily operation does not require manual imports.

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
| `NABAO_STATUS_FILE` | Safe collector summary path, default `../.local/status/daily-table.json` |
| `NABAO_STATUS_STALE_SECONDS` | Status age warning threshold, default `43200`, minimum `60` |
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

Compose shares `public-data` and a dedicated `status-data` volume read-only with the
backend. The collector alone writes those volumes; private `collector-data` is not
mounted into the backend. Both images initialize the status directory for collector
UID 1000. Only the allowlisted summary is mode 0644 for the backend's different UID;
private evidence/watch JSON retains mode 0600. Existing bind mounts must provide a
writable collector directory and a readable summary for the backend.

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

Daily management tests also cover authenticated reads, independently dated attempts
and publications, missing/invalid/oversized/private-field status, symlinks and file
permissions, stale/mismatched summaries, and readiness without blocking unsubscribe.
After `npm ci` in `collector/`, the admin DOM tests can run separately:

```sh
node --test src/test/js/admin-status.test.mjs
```

If a corporate Maven mirror blocks public dependencies, use a separate local settings
file pointing to Maven Central rather than editing global credentials or settings.

## Initial scope

This service does not claim the collector is healthy simply because HTTP is up.
Source discovery, browser completeness checks, model extraction and source health live
in the collector. Anonymous registration, provider signing and delivery/retry state
are tested locally. Apple delivery remains a separate provisioning and device check.
Personal risk assessment stays on iOS.
