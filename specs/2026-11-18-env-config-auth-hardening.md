# Env-driven configuration and auth hardening

Base revision: `50ceab4`.

## Purpose

1. Close these auth weaknesses of the server: a bypassable passphrase
   brute-force limit, a framable and cacheable authorization page that reflects the submitted
   passphrase back into the HTML, JWT verification without a pinned algorithm, and outdated
   `hono` / `@hono/node-server`.
2. Make every deployment-specific runtime value of the server readable from the environment, so it
   can run for any Poster network without code edits.
3. Read Poster tokens from environment variables, so the server runs where configuration arrives
   only through the environment (Unit 3).
4. Report write outcomes accurately, keep the audit log valid and keep known tokens out of results,
   errors and audit entries (Unit 4); delete an old dish only when every spot it reads is hidden
   (Unit 7).
5. English tool names and documentation that matches the code (Units 5 and 6).

Unit 2 on its own keeps runtime behaviour as it was when no new environment variables are set (same
account list, same write target and write permissions, same timezone, same names), with one visible
text change listed under Unit 2 and one changed `/health` value: with `TOKEN_SOURCE` blank, the
`tokens` field now reports `gsm` instead of the empty string (GSM is the token source used in both
cases). Units 1, 4, 5 and 7 change behaviour on purpose, as their sections describe.

The work is split into units.

## Unit 1: auth hardening and dependency bump

### 1.1 Dependency bump

- `hono` to `^4.13.19`, `@hono/node-server` to `^2.1.9`, lockfile updated with `npm install`, not
  `npm audit fix`.
- The lockfile diff contains only these two packages (plus their own transitive changes, if any),
  every `resolved` URL points to `registry.npmjs.org`, and every entry has `integrity`.
- `npm ls hono @hono/node-server` shows one copy of each at the new version.
- `npm audit` is recorded before and after.
- Out of scope, reported only: `body-parser` (via `express`, which the MCP SDK depends on but this
  server never imports), `fast-uri` (via `ajv`), and the dev-only `vitest`/`vite` chain.

### 1.2 Passphrase rate limit independent of client-supplied headers

Today `POST /authorize` counts failures per first `X-Forwarded-For` value. Any client can send a
fresh value per request, so the 5-per-15-minutes limit never triggers.

- One failure counter per app instance replaces the per-IP map. It lives inside `rutasOAuth()`, so
  every `crearApp()` call, and every test that builds an app, starts clean.
- Window: the first wrong passphrase with no open window opens a 15-minute window. Each further
  wrong passphrase inside the window increments the counter. When the counter reaches 5, passphrase
  checks are locked for every client until the window that the first failure opened ends. After
  the window ends, the next wrong passphrase opens a new window.
- Order in `POST /authorize` (unchanged): request validation, then the lock check, then the
  passphrase comparison. Invalid requests (400) do not touch the counter. Requests rejected because
  of the lock (429) neither increment the counter nor extend the window. A correct passphrase while
  locked gets 429 and no redirect.
- A successful authorization resets the counter to zero and closes the window, so the full budget
  of five failures is available again.
- The counter does not depend on the client: every registered `client_id` shares it.
- The window uses the wall clock (`Date.now()`); a host clock step shortens or lengthens it. This
  assumption is stated in a code comment.
- `X-Forwarded-For` is never used for a decision. Logs keep the raw header under the field `xff`,
  limited to its last 200 characters: proxies append to the end, so the tail holds the entries a
  front end added, while earlier entries are whatever the client sent.
- Logs: a wrong passphrase (401) and a locked request (429) each write one WARNING line; a success
  writes one NOTICE line. No log line contains the submitted passphrase.
- Known limitations of this design (residual risks), documented in the README:
  - Anyone who can reach `/authorize` and obtain a `client_id` from the open `/register` can keep
    new authorizations locked by sending five wrong passphrases each time a window ends. While the
    lock holds, every well-formed `POST /authorize` gets 429 whatever passphrase it carries, the
    correct one included (a request that fails OAuth parameter validation still gets 400; the GET
    page still renders). The
    static bearer token, already issued access and refresh tokens, and token refresh at `/token`
    keep working; restarting the instance clears the lock.
  - Windows are local to each instance and start at that instance's first failure. With N
    instances an attacker who reaches all of them gets up to five guesses per instance per window;
    there is no service-wide limit.

### 1.3 Authorization page: headers and hidden fields

Every HTML response from `GET /authorize` and `POST /authorize` (200, 401, 429) carries:

- `X-Frame-Options: DENY`
- `Content-Security-Policy: default-src 'none'; style-src 'sha256-<hash>'; frame-ancestors 'none'; base-uri 'none'`
- `Cache-Control: no-store`

`<hash>` is the base64 SHA-256 of the exact text between `<style>` and `</style>`, including the
leading newline, computed at module load from the same constant that is inlined in the page. There
is no `form-action` directive: it does not fall back to `default-src`, and some browsers apply it
to the redirect that follows the form post, which would block the callback to the client. The 302
redirect and the plain-text 400/503 responses are not HTML and do not need these headers.

The retry page (401, 429) renders as hidden inputs only the OAuth request fields that the GET
handler passes: `response_type`, `client_id`, `redirect_uri`, `code_challenge`,
`code_challenge_method`, `state`, `scope`, `resource`, `client_name`. It never renders the
submitted `passphrase` or any other posted field. The page contains exactly one password input,
and it is empty. On the retry page and in the success log, `client_name` comes from the validated
client registration, as on GET, never from the posted body.

Rendering in a real browser is not part of the acceptance evidence.

### 1.4 Pinned JWT algorithm

The shared verifier calls `jwtVerify` with `algorithms: ["HS256"]`, matching what `firmar`
produces. This covers access, refresh, code and client tokens.

### Unit 1 acceptance

New tests. Each test of changed behaviour is observed failing against the base revision before the
change; tests marked "control" protect behaviour that does not change and pass at base. Every test
builds its own app, and each case passes when run alone and in the full file.

- Rate limit, on a fresh app with a valid registered client and request:
  - five wrong passphrases, each with a different `X-Forwarded-For` (and one with none), get 401;
    the sixth wrong one gets 429; then the correct passphrase with yet another `X-Forwarded-For`
    gets 429 with no `Location`;
  - shared across clients: two clients registered on the same app; failures alternate between
    them, five in total; the sixth wrong passphrase and the correct one, from either client, get
    429;
  - per app, not per registration: the same registered `client_id` locked on one app still gets a
    302 with the correct passphrase on a second app built in the same test;
  - control: on another fresh app, four wrong passphrases and then the correct one get a 302;
  - success resets to zero: four wrong, correct (302), then five more wrong get 401 and the sixth
    gets 429;
  - window start: the app is built, the clock moves forward before the first failure, and the
    window ends 15 minutes after that failure, not after app construction;
  - window expiry with a controlled clock: after five wrong passphrases and the end of the window,
    the correct passphrase gets 302;
  - a new window starts at one: after a locked window ends, five wrong passphrases get 401 and the
    sixth gets 429;
  - a locked request does not extend the window: requests during the lock, then the clock moves to
    the original window end, and the correct passphrase gets 302;
  - invalid requests (400) do not count: five invalid requests, then the correct passphrase gets
    302 (control);
  - validation before the lock: while locked, an invalid request gets 400, not 429 (control);
  - two apps built in the same test file do not share the counter.
- Headers: `GET /authorize` (200) and the 401 and 429 retry pages carry all three headers; the test
  extracts the `<style>` content from the returned body, hashes it itself, and compares with the
  CSP value; the CSP has no `form-action`. Control: the successful POST returns 302 whose
  `Location` parses to exactly the registered redirect URI with a non-empty `code` and the posted
  `state`.
- Hidden fields: a 401 and a 429 retry page after posting a distinctive passphrase and an extra
  field do not contain either value, contain exactly one `type="password"` input with no `value`,
  and render exactly the nine OAuth hidden inputs. All nine are populated, values include
  HTML-sensitive characters (`"`, `<`, `&`, `'`), and the decoded values equal what was sent, except
  `client_name`, which equals the registered name even when the POST carries a different one.
- Logs (console spy): the 401, 429 and success lines carry `xff` with the last 200 characters of a
  longer header, and no line contains the submitted passphrase.
- JWT: an access token signed with `OAUTH_SIGNING_KEY` under HS256 is accepted by `/mcp` (control);
  the same claims and key under HS512 get 401. HS512 variants of a client token (`/authorize`), an
  authorization code and a refresh token (`/token`) are rejected while their HS256 twins are
  accepted.
- The existing OAuth flow test still passes.
- `npm ls`, lockfile diff and `npm audit` checks from 1.1.
- The Node adapter starts from the build: `npm run build`, then `node dist/server.js` with a bearer
  token set, and `GET /health` returns 200.

## Unit 2: runtime configuration from the environment

### 2.1 Loader

`src/config.ts` exports `cargarConfig(env: Record<string, string | undefined>)`, a pure function
that builds and validates the whole configuration and throws on invalid input. It does not read
files. The module still loads `.env` as today and then exports
`config = cargarConfig(process.env)`, so startup fails fast on bad configuration.

The `.env` file is not loaded when the process runs under Vitest (`VITEST` set to a non-empty value), unless
`POSTER_LIVE=1` (the live suite needs the developer's local settings). A developer's `.env` must
not change the results of the offline suite.

All consumers keep reading the module-level `config` (and `CUENTAS`, `esCuenta`,
`verificarEscritura`). Tests that need a non-default configuration set the environment, call
`vi.resetModules()` and import the modules dynamically; tests of the loader itself call
`cargarConfig` with plain objects.

Error messages name the variable and the rule that failed, and never quote a configured value: a
value placed in the wrong variable may be a secret. For `POSTER_ACCOUNTS` and
`WRITE_DEFAULT_ACCOUNTS` they identify the offending entry by its 1-based position. The loader
never logs or dumps the environment.

MySQL errors (connection, URL parsing, query) are re-thrown by `src/tokens.ts` as a fresh `Error`
that names the source (`POSTER_MYSQL_URL`, or the `DATABASE_URL` line of `FINANZAS_ENV_PATH`) and
at most the original error `code` when it is an uppercase identifier. The new error has no `cause`
and carries no property of the original; neither the URL nor any part of it appears in its
message, stack or `util.inspect` output. Domain errors raised by `src/tokens.ts` itself (no active
row, account outside the list) keep their messages.

### 2.2 Variables

"Blank" means set to an empty or whitespace-only string.

| Variable | Default | Rule |
|---|---|---|
| `POSTER_ACCOUNTS` | `cafe-01,…,cafe-10` | Comma-separated Poster account subdomains, entries trimmed. Each entry must match `^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$`. An empty entry, an invalid entry, a duplicate, or a blank value fails startup. |
| `DEFAULT_WRITE_ACCOUNT` (new) | `cafe-04` when `POSTER_ACCOUNTS` is unset; none otherwise | Account a write tool targets when the call omits `cuenta`. Must be in the account list. Blank means none. With none, `cuenta` is required in every write tool. It may be outside `WRITE_DEFAULT_ACCOUNTS`: writes to it then still need `permitir_otra_cuenta: true`, and the write `cuenta` description says so. |
| `WRITE_DEFAULT_ACCOUNTS` | `cafe-04` when `POSTER_ACCOUNTS` is unset; empty otherwise | Existing. Accounts writable without `permitir_otra_cuenta: true`. Empty entries are ignored as today; every other entry must be in the account list. Blank means empty. Its order has no effect. |
| `TIMEZONE` | `America/Merida` | Time zone for "today" and default finance timestamps. Any value `Intl.DateTimeFormat` takes is valid: an IANA name is recommended, and on current Node versions UTC offsets such as `+05:00` and aliases also load (which ones load depends on the Node version). Rejected if `Intl.DateTimeFormat` rejects it, otherwise replaced by `resolvedOptions().timeZone` (so letter case does not matter and an alias becomes the zone it resolves to). Blank means default. |
| `OWNER_NAME` | `Roy` | Who approves writes; used in server instructions, tool descriptions and the write-guard error. |
| `NETWORK_NAME` | `RUSH Café` | Business name in instructions, tool descriptions and the authorization page. |
| `SERVICE_NAME` | `poster-rush` | MCP server name, `/health`, `/`, authorization page title and heading, startup log. The raw value must match `^[A-Za-z0-9._-]{1,64}$`; it is not trimmed, so a blank or padded value fails startup. |
| `OAUTH_SUBJECT` | `roy` | `sub` claim of issued access and refresh tokens. The raw value must match `^[A-Za-z0-9._@-]{1,64}$` (not trimmed; blank or padded fails). Changing it affects attribution only; tokens issued under the old value stay valid. |
| `TOKEN_SOURCE` | `gsm` | Existing. Exactly `gsm` or `mysql` (`env` added in Unit 3), not trimmed; any other value, including a padded one, fails startup (today it silently falls back to GSM). Blank means default. |
| `POSTER_MYSQL_URL` (new) | none | Used only with `TOKEN_SOURCE=mysql`. When set, it replaces the `DATABASE_URL` line read from `FINANZAS_ENV_PATH`; when unset or blank, that file is read lazily at the first lookup as today. With `TOKEN_SOURCE=mysql`, a nonblank value that `new URL()` cannot parse fails startup (the scheme is not checked; mysql2 does not check it either); with `gsm` it is ignored. A generic `DATABASE_URL` in the environment is not used. |

`OWNER_NAME` and `NETWORK_NAME`: blank means default; control characters (C0, C1) and bidirectional
formatting characters (U+200E, U+200F, U+202A to U+202E, U+2066 to U+2069) fail startup; then
trimmed; length 1 to 100; HTML-escaped wherever rendered.

Existing variables (`PORT`, `PUBLIC_BASE_URL`, `FINANZAS_ENV_PATH`, `GCP_PROJECT_ID`,
`SECRET_PREFIX`, `MCP_BEARER_TOKEN`, `OAUTH_SIGNING_KEY`, `OWNER_PASSPHRASE`,
`OAUTH_ALLOWED_REDIRECTS`, `AUDIT_DIR`) keep their names, defaults and validation. Bearer-only
deployments without OAuth variables keep working.

Visible text change with defaults: the authorization page and the account parameter description
said "red RUSH", the server instructions said "red RUSH Café"; all three now use `NETWORK_NAME`,
so with defaults they all say "RUSH Café".

### 2.3 Consumers (runtime code in `src/` only)

- `src/config.ts`: `CUENTAS` becomes the loaded list (`readonly string[]`), `Cuenta` becomes
  `string`, `esCuenta` checks membership at runtime, `verificarEscritura` names `OWNER_NAME`.
- `src/mcp.ts`: account `z.enum` from the loaded list for read and write tools; write-account
  default from `DEFAULT_WRITE_ACCOUNT` (required parameter when none); server name from
  `SERVICE_NAME`; instructions and descriptions (today lines 11, 12, 18, 35-39, 159, 287, 317) use
  `OWNER_NAME`, `NETWORK_NAME`, `TIMEZONE` and the configured default account instead of literals.
- `src/auth.ts`: page title and heading from `SERVICE_NAME`, network from `NETWORK_NAME`, `sub`
  from `OAUTH_SUBJECT`.
- `src/server.ts`: `SERVICE_NAME` in `/health` (`servicio` field), `/` and the startup log. The
  `/health` fields stay the same; the `tokens` field reports the loaded token source, so a blank
  `TOKEN_SOURCE` now shows as `gsm`.
- `src/util.ts`, `src/tools/escritura.ts`: `TIMEZONE` instead of `America/Merida`.
- `src/tools/lectura.ts`: account listing from the loaded list.
- `src/tokens.ts`: `POSTER_MYSQL_URL`; types follow `Cuenta = string`.
- `scripts/subir-tokens-gsm.mts` keeps importing `CUENTAS` and must still type-check.
- Docs: `.env.example`, and the configuration sections of `README.md` and `README.es.md` (the
  allow-list rows that point to `CUENTAS` in `src/config.ts`).

### Unit 2 acceptance

- Loader tests with plain objects:
  - no variables: every field equals today's value;
  - a custom account list, write target, write permissions, timezone and names are applied;
  - with a custom `POSTER_ACCOUNTS` and nothing else, there is no write target and the permission
    set is empty;
  - each of these fails: uppercase, dot, slash, leading or trailing hyphen, empty entry, duplicate,
    blank `POSTER_ACCOUNTS`; a write target or permission entry outside the list; an unknown
    timezone; an unknown `TOKEN_SOURCE`; control characters in a name; an invalid `SERVICE_NAME`
    or `OAUTH_SUBJECT`;
  - an error raised while secret variables hold distinctive values does not contain those values;
  - a distinctive marker placed in each validated variable (account lists, write target, timezone,
    names, identifiers, `TOKEN_SOURCE`, `POSTER_MYSQL_URL`) never appears in the error it causes;
    account-list errors give the entry position;
  - padded `TOKEN_SOURCE`, `SERVICE_NAME`, `OAUTH_SUBJECT` fail; `america/merida` loads as the
    default zone with the default place label; a bidi character in a name fails; a malformed
    `POSTER_MYSQL_URL` fails only with `TOKEN_SOURCE=mysql`.
- MySQL errors: a malformed explicit URL with synthetic credentials, a malformed `DATABASE_URL`
  line in the file, and a mysql2 failure whose message, `input` and `cause` carry the URL all
  surface as the sanitized error (checked through `util.inspect`); "no active row" keeps its
  message; the file is read at the first lookup, not at import.
- Permission texts: with a write target outside a multi-account permission set, and with an empty
  set, the instructions sentence and the `permitir_otra_cuenta` description name exactly the
  permission set, the write `cuenta` description says the target needs `permitir_otra_cuenta`, and
  an omitted-`cuenta` call is blocked without the flag and runs its dry run with it.
- A developer `.env` (with `TOKEN_SOURCE=mysql` and every Unit 2 variable set) or the same values
  exported in the shell do not change the offline suite's results.
- `TIMEZONE`: "today" without an explicit date follows the zone; one zone with daylight saving
  time gives the right date and timestamp on both sides of a change.
- A token issued before an `OAUTH_SUBJECT` change is still accepted after it.
- Through the MCP server built with a custom configuration (module reset, Poster HTTP and token
  lookup faked, no network):
  - `tools/list` shows the custom list as the `cuenta` enum of a read and a write tool, the custom
    write target as default, and the configured names and timezone in the descriptions;
  - `tools/call` of a write tool with `cuenta` omitted runs its dry run against the write target,
    including when `WRITE_DEFAULT_ACCOUNTS` lists several accounts in a different order;
  - with no write target, the same call fails validation;
  - `list_accounts` returns the custom list;
  - a write to a listed account outside `WRITE_DEFAULT_ACCOUNTS` without `permitir_otra_cuenta` is
    blocked; an account outside the list is rejected.
- With no variables, `tools/list` shows the ten default accounts and `cafe-04` as write default.
- `TIMEZONE`: at a fixed instant that falls on different dates in two zones, "today" and the
  default finance timestamp follow the configured zone.
- The authorization page escapes a `NETWORK_NAME` containing `<`, `&` and `"`.
- All existing tests pass unchanged; `tsc --noEmit` is clean, and a one-off type-check that also
  includes `scripts/` and `test/` is clean. The base already fails that wider check at
  `test/http.test.ts` (a response type), so a type-only edit there is allowed.

## Unit 3: Poster tokens from the environment

Lets the server run where configuration can only be passed as environment variables: accounts
(Unit 2) and their Poster API tokens both come from the environment, with no Google Cloud or MySQL
dependency at runtime.

- `TOKEN_SOURCE` accepts exactly `env` in addition to `gsm` and `mysql` (same raw, untrimmed check).
  The default stays `gsm`.
- With `TOKEN_SOURCE=env`, every account in the account list needs `POSTER_TOKEN_<ACCOUNT>`, where
  `<ACCOUNT>` is the account name upper-cased with `-` replaced by `_` (for example
  `POSTER_TOKEN_CAFE_04`). The account alphabet has no `_`, so the mapping is one-to-one.
- The loader validates the tokens at startup: each value is trimmed, and the trimmed value must
  match `^[A-Za-z0-9:._~-]{16,}$` (an `<account id>:<hex>` token fits; that shape is an example,
  not a verified Poster token format). A missing or blank
  variable, or a trimmed value outside that format (whitespace, control characters, quotes,
  backslashes, `%`, `&`, `=`, or fewer than 16 characters), fails startup. The format keeps tokens
  recognizable for redaction in every representation the server produces. The error lists the
  names of all failing variables and never any value.
- Tokens are read once at startup; later changes to the process environment have no effect until
  a restart.
- Lookups for env tokens never import or call Google Secret Manager or MySQL. `POSTER_TOKEN_*`
  variables are ignored with `gsm` and `mysql`.
- `redactar()` strips every env token from the start, including tokens of accounts never looked
  up, in addition to the existing `token=` pattern and cached tokens.
- `/health` and the startup log report `env` as the token source.
- Docs: `.env.example` and the configuration sections of both READMEs. On Cloud Run, map each token
  from Secret Manager with `--set-secrets` rather than a plain-text env var. Env tokens change only
  when the process restarts, while a GSM token is re-read at its first lookup after its 10-minute
  cache entry expires. With the default account list, `env` needs all ten token variables. The
  overview lines of both READMEs list all three token sources.

### Unit 3 acceptance

- Loader: the mapping (`cafe-04` to `POSTER_TOKEN_CAFE_04`); a missing, blank, padded-only or
  whitespace-containing token fails startup with every failing variable named and a distinctive
  marker value absent from the error; a padded valid token is trimmed; a token containing a DEL
  or C1 control character, `"`, `\`, `%`, `&` or `=`, or shorter than 16 characters fails;
  `TOKEN_SOURCE=" env"` fails; with `gsm` and with `mysql`, a valid `POSTER_TOKEN_*` variable is
  ignored and the lookup still goes to that source; with no variables the default stays `gsm`.
- Startup snapshot: changing `process.env` after the configuration loads changes neither lookups
  nor redaction.
- Lookup: with `env`, the token of a listed account is returned without importing GSM or MySQL
  (both mocked and asserted not called); an account outside the list is still rejected.
- Redaction: with `env`, a synthetic token of an account never looked up is stripped by
  `redactar()`, every occurrence of it, not only the first; a synthetic token that appears in a
  Poster error is absent from the tool error returned to the client and from the audit entry.
- `/health` with `env` returns exactly `ok`, `servicio`, `tokens: "env"` and `oauth`, and no token.
- Through the MCP server built with an env-token configuration (module reset, fetch faked): a read
  tool call requests `https://<account>.joinposter.com/api/...` with that account's token,
  URL-encoded; `/health` reports `env`.
- All existing tests pass; `tsc` and the wider check are clean.

## Unit 4: write outcome, audit and redaction integrity

Fixes write results that contradict what happened in Poster, which can make a client repeat an
applied write (for example a duplicate finance transaction), audit entries lost to redaction, and
paths where a known token can reach the client or the audit log.

Redaction:

- Known secrets are every env token and every cached GSM or MySQL token. For each, the redactor
  matches the literal value, its `encodeURIComponent` form, that form with the hex digits of its
  `%XX` escapes in lowercase (the token's own characters keep their case), and its JSON-escaped
  form (`JSON.stringify(token).slice(1, -1)`). `redactar()` finds all matches in one pass over the
  original text, longest first, so a token that contains or is a prefix of another leaves no
  fragment; the `token=` pattern is applied after the known secrets and may also rewrite ordinary
  data that contains `token=` (over-redaction is the intended direction). The pattern is built once
  per walk of a value, not once per string. Two different tokens that cross (one starts inside the
  other and ends beyond it) are not guaranteed to be fully removed.
- Poster error texts (`src/poster.ts`) are redacted before they are clipped to their length limit.
  When a reply looks like JSON but does not parse, the error is a fixed text with the HTTP status
  and the redacted, then clipped, body excerpt; the parser's own message is never used.
- A write reply with no `error` (or `error: 0`) and no result is an unknown outcome (see "Write
  outcome and audit"); the diagnostic of the reply in its message is redacted and clipped, never
  the raw reply.
- Tool results sent to the MCP client are redacted structurally: the value is normalized with one
  JSON round trip, every string and every object key is redacted, booleans and `null` are never
  changed, a number becomes the string `"***"` only when `String(n)` equals a known token made only
  of digits and at least 16 characters long (every other number is unchanged), and the result is
  serialized once, so the text is always valid JSON. This covers
  successful read results and applied-write replies. When the JSON text of a `poster_get` reply
  exceeds 60 000 characters, the clipped preview is redacted as text before it is clipped (it may
  over-redact, it never leaves a token prefix), and `bytes` is the character length of the
  unredacted JSON text. Tool error messages are redacted as text.
- Audit: `auditar` redacts every string value and every object key of the event with the same
  structural walk, then serializes once.
- Key collisions: when two keys of one object redact to the same text, both are kept; the later
  ones get a numeric suffix (` (2)`, ` (3)`), in client results and audit lines alike.
- The contract covers calls that reach a tool handler. A call the MCP SDK rejects on its input
  schema sends nothing to Poster and is not audited.

Write outcome and audit:

- Read-back failure after a successful write: when the write call succeeded and the read-back
  verification throws, the result is `modo: "aplicado"` with
  `verificacion: { ok: false, detalle: <redacted error message> }` and a notice that the write was
  applied and must not be repeated. The audit entry is `aplicado` with the same `verificacion`.
  Nothing is thrown, and a verification that throws never counts as "not found". A read-back that
  completes but does not match returns `verificacion.ok: false` with its own detail, without that
  notice.
- Unknown outcome: when the HTTP attempt of the write fails after it has started (network or DNS
  error, timeout, a reply that is not JSON, or a reply with HTTP status 500 or higher whatever its
  body), the request may have reached Poster. A write reply with no `error` (or `error: 0`) and
  neither a `response` nor `success: 1` is an unknown outcome too: nothing in it shows that the
  write was rejected. A write reply with an `error` other than 0 or `null` stays `rechazado`. Both
  unknown cases use a dedicated error class exported by `src/poster.ts`; its message carries the
  HTTP status of a 5xx reply, of a reply that is not JSON, or of a reply whose body could not be
  read after its headers arrived (the status is kept per attempt, so a later attempt that fails
  before any reply never reports an earlier attempt's status) and, when it can be built, the
  redacted reply summary. The audit entry uses the new mode `desconocido` with the redacted error,
  and the tool fails with a message that says the write may have been attempted and must be
  checked with a read before any retry. Every failure before the attempt starts (validation,
  permission, plan construction, token lookup, method check) stays `rechazado`; when a plan
  exists, that entry carries the plan's method and payload. Read calls keep their current status
  handling.
- The audit stdout line and the JSONL line are always valid JSON, whatever the payload contains
  (for example a comment with `token=` followed by quotes or backslashes). Severity on stdout:
  `aplicado` NOTICE, `desconocido` WARNING, the other modes INFO.
- `auditar` never throws and returns nothing. If an event cannot be serialized to a JSON object,
  it logs a minimal valid line with `ts`, `herramienta`, `cuenta`, `modo` and an `error` saying
  the audit entry is incomplete. `recent_audit` skips lines that do not parse.

Known limitations:

- The transaction amount check uses a 0.5-peso tolerance and does not validate sub-cent amounts.
- A transfer's read-back checks only the source account and the amount.
- A crash that leaves a partial last line in the audit file makes the next appended entry
  unreadable.
- A Secret Manager or MySQL token rotated while a request is in flight is redacted only in its
  new form.
- A digit-only secret placed in `POSTER_ACCOUNTS` by mistake appears in the derived variable name
  of the startup error.
- Result formatting of an extremely deeply nested reply can fail after a write was applied.
- A digit-only token too long to be held exactly by a JSON number is not matched when a reply
  carries it as a number.
- A write reply whose `response` is `false` or `null` and that carries no `error` is an unknown outcome, not an
  applied write: no read-back runs and the caller is told to check with a read before any retry.
- A `create_supply` read-back whose reply has no `supply_sum` reads the total as 0.
- `leerProducto` falls back to `menu.getProducts` when `menu.getProduct` fails or does not return
  the requested product, and treats an absent product list as empty, so a read-back that gets no
  list reports the product as not found.
- Below 500 the HTTP status of a JSON reply is not kept; the reply is classified by its body alone.
- The `create_transaction` read-back reads a missing transaction id in Poster's reply, and a
  missing account in the transaction it reads back, as 0, so a reply without them can match.
- `hide_dish` treats a spot whose visibility is missing, `null` or `"2"` as already hidden, while
  `delete_old_dish` refuses such a spot, so an "(old)" dish with a recipe in that state can be
  neither hidden nor deleted by a tool.
- The dish write tools (`update_dish`, `hide_dish`, `delete_old_dish`, `update_dish_recipe`) read
  the dish type with numeric coercion, so a type such as `"2"` or `["2"]` is read as 2.
- The startup log line that reports the token source is not covered by the automated tests.

### Unit 4 acceptance

With a faked Poster API, no network:

- A write whose read-back throws returns `aplicado` with `verificacion.ok === false`, does not
  throw, and writes one `aplicado` audit entry.
- A write whose HTTP attempt fails (faked `fetch` rejecting) fails with the unknown-outcome
  message and writes one `desconocido` audit entry; no `rechazado` entry is written for it.
- A write that fails before sending (token lookup fails, permission denied) stays `rechazado`.
- A payload comment containing `token=abc"x\` and a backslash-quote mix produces valid JSON on
  stdout and in the JSONL file, with the token value redacted.
- A synthetic token inside a nested payload string is redacted in both lines.
- An event that cannot be serialized (a circular value) produces the minimal line and no throw.
- Redaction, each with a synthetic known token: a token that is a prefix of another known token
  and a token that contains `token=` leave no fragment; the percent-encoded form (with uppercase or
  lowercase hex digits) and the JSON-escaped form are stripped; a cached GSM token containing `"` or `\` echoed in a Poster error is absent from
  the client error, stdout, the JSONL line and `recent_audit`; a token straddling the clip
  boundary of a Poster error leaves no prefix; a write reply `{ success: 0, detail: <token> }`
  with no `error` reaches the client as an unknown outcome without the token; a successful `poster_get` reply and an
  applied-write reply containing the token reach the client without it; an upstream object key
  containing the token is absent from both audit lines.
- A 16-digit synthetic token that equals a number in a read result: the client text parses as
  JSON, the number becomes `"***"` and other numbers are unchanged; a digit-only token shorter
  than 16 characters leaves an equal number unchanged. A token inside a string that itself holds JSON is absent from
  the client text. Two keys that redact to the same text are both present, in the client text and
  in the audit line. A token placed just before the 60 000-character limit of `poster_get` leaves
  no prefix.
- A reply that looks like JSON but does not parse, with the token near the start: the error has
  no fragment of the token and does not contain the parser message.
- A write reply with HTTP status 503 and a success-shaped JSON body gives `desconocido` with the
  status in the message; a read reply with the same status and body behaves as before this unit.
- A finance write whose read-back call fails returns `aplicado`, `verificacion.ok === false` and
  the notice, not "not found".
- A failure before sending with a built plan logs the plan's method and payload; a corrupt line in
  the audit file is skipped by `recent_audit`; a `desconocido` stdout line has severity
  WARNING.
- Existing write and audit tests pass; `tsc` and the wider check are clean.

## Unit 5: English tool names

The 31 MCP tools get English names. Only the names change; descriptions, parameter names,
instructions and result fields stay as they are.

| Old | New |
|---|---|
| `listar_cuentas` | `list_accounts` |
| `producto_detalle` | `product_details` |
| `insumos` | `ingredients` |
| `precocinados` | `prepacks` |
| `grupos_clientes` | `client_groups` |
| `promociones` | `promotions` |
| `empleados` | `employees` |
| `metodos_pago` | `payment_methods` |
| `ajustes` | `settings` |
| `compras` | `supplies` |
| `compra_detalle` | `supply_details` |
| `saldos` | `stock_levels` |
| `catalogos_base` | `reference_catalogs` |
| `auditoria_reciente` | `recent_audit` |
| `crear_grupo_cliente` | `create_client_group` |
| `actualizar_grupo_cliente` | `update_client_group` |
| `crear_insumo` | `create_ingredient` |
| `crear_compra` | `create_supply` |
| `asignar_pago_compra` | `assign_supply_payment` |
| `actualizar_platillo` | `update_dish` |
| `actualizar_categoria` | `update_category` |
| `actualizar_precocinado` | `update_prepack` |
| `crear_categoria` | `create_category` |
| `crear_precocinado` | `create_prepack` |
| `crear_platillo` | `create_dish` |
| `ocultar_platillo` | `hide_dish` |
| `borrar_platillo_old` | `delete_old_dish` |
| `actualizar_receta_platillo` | `update_dish_recipe` |
| `crear_transaccion` | `create_transaction` |

`menu_snapshot` and `poster_get` keep their names.

- Every place that names a tool uses the new name: `registerTool` calls, the `herramienta`
  value of audit events, tool names inside server instructions, tool descriptions, next-step hints
  and error texts, tests, `scripts/redeploy.sh`, both READMEs, `DEPLOY_CLOUD_RUN.md`, and this
  document.
- Several old names are ordinary Spanish words (`insumos`, `compras`, `saldos`, `ajustes`,
  `empleados`, `promociones`, `precocinados`). Only occurrences that refer to a tool change; the
  same word used as plain text, a variable or a Poster field stays.
- The old names are not kept as aliases: a client that calls an old name gets the SDK's
  unknown-tool error. Per-tool approvals saved in a client are tied to the name and have to be
  given again.
- Audit lines written before the change keep the old names; `recent_audit` returns them as
  written.
- The `herramienta` key of audit events keeps its name.

### Unit 5 acceptance

- `tools/list` returns exactly the 31 new names above, with the same annotations, descriptions
  (apart from tool names inside them) and input schemas as before.
- Calling an old name fails; calling the new name behaves as the old one did, including the
  audit `herramienta` value.
- No tool-name reference to an old name remains in `src/`, `test/`, `scripts/`, the READMEs,
  `DEPLOY_CLOUD_RUN.md` or this document, apart from the table above, the note on old audit
  lines, and the test list of former names that checks none of them is served.
- The suite, `tsc` and the wider check are clean.

## Unit 6: documentation accuracy

Text-only. Statements in `README.md`, `README.es.md`, `DEPLOY_CLOUD_RUN.md`, the
transaction-amount texts in `src/`, the `poster_get` description and the `update_dish` refusal text
are brought in line with what the code does. No behaviour changes.

- Safety rules: the server enforces the account allow-list, the default write set, dry-run as the
  default and the per-write checks. Applying a write (`confirm: true`) and writing outside the
  default set (`permitir_otra_cuenta: true`) are tool arguments the model sets, so the human check
  is the client's tool approval. The docs say so instead of claiming the rules do not depend on
  the model.
- Dry-run: a dry-run reads from Poster to build the diff and does not write; the docs say "without
  writing to Poster".
- Tokens: every Poster request carries the token in the query string (Poster API design).
  Redaction covers the token values the server knows (all environment tokens from startup;
  GSM/MySQL tokens once loaded) in their literal, URL-encoded (uppercase or lowercase hex escapes)
  and JSON-escaped forms, and any `token=` value. The docs describe this instead of "never
  exposed".
- Write outcome: the docs describe the outcomes of Unit 4. The no-repeat notice comes with a
  read-back that fails; a read-back that completes but does not match gives
  `verificacion.ok: false` with its own detail.
- Deletes: the docs no longer say there is no delete; they describe the guard of Unit 7, and tool
  lists include `delete_old_dish` and `update_dish_recipe`.
- `update_dish` refusal: for a dish with a recipe, the refusal names `update_dish_recipe` for the
  recipe instead of the web panel.
- Transaction amounts: `create_transaction` sends the amount in pesos. Its description, the
  `monto` parameter text, the header comment in `src/tools/escritura.ts` and `README.es.md` say
  pesos; `README.es.md` contrasts it with `create_supply` and `create_dish`, which send centavos,
  and it and the header comment say the read-back covers the transaction date to today. Other unit
  statements are checked against the code and corrected only where the code
  contradicts them.
- `poster_get` output is cut at 60 000 characters, not bytes; its description says so.
- `DEPLOY_CLOUD_RUN.md`: each refresh issues a new refresh token, so a connection has no absolute
  end; rotating the OAuth signing key revokes OAuth-issued tokens only, and the static bearer
  (`MCP_BEARER_TOKEN`) is rotated separately. Both rotation commands name the project, and the
  configuration is read once at startup, so rotated keys take effect in instances started after
  the redeploy.

### Unit 6 acceptance

- Each statement above is true of the code, with the line it rests on.
- `src/` changes are limited to the transaction-amount description strings, the `poster_get`
  description, the `update_dish` refusal text and comments.
- The suite, `tsc` and the wider check are clean.

## Unit 7: delete guard

`delete_old_dish` deletes a dish through `menu.removeDish`. It reads the product first, in dry-run
and with `confirm: true`, and refuses without writing unless:

- the product is a dish (type 2) and its name ends in "(old)";
- `spots` is a non-empty list and the `visible` of every spot is the string `"0"` or the number
  `0`. A spot whose `visible` is `"1"` or `1` is refused as visible. Any other value or type
  (missing, `null`, a boolean, an array such as `["0"]`, an object, another string) is refused as
  unknown.

The guard checks the product it reads (type, name and spots); it does not know whether `hide_dish`
was used (`hide_dish` sends `visible` 0 and, by default, the suffix " (old)"). After the write, the read-back checks that the dish no
longer appears in `menu.getProducts`.

### Unit 7 acceptance

With a faked Poster API, no network:

- A dish with no spots, an empty or non-list `spots`, a `null` spot, a spot without `visible`, or a
  `visible` of `"2"`, `["0"]`, `{}`, `true`, `false` or `null` is refused in dry-run and with
  `confirm: true`; nothing is sent.
- A spot with `visible` `"1"` or `1` is refused as visible; nothing is sent.
- A dish whose spots all have `visible` `"0"`, or all `0`, is deleted with `menu.removeDish` and
  its read-back is ok.
- The suite, `tsc` and the wider check are clean.

## Exclusions and known limitations

- Write-tool semantics (dry-run, `permitir_otra_cuenta`, `delete_old_dish` beyond the guard of
  Unit 7), `poster_get`
  method scope, refresh-token lifetime and revocation, DCR loopback redirects. These are
  known weaknesses outside this change.
- `/health`: no change to its fields or disclosure policy beyond the service name value, the
  `tokens` value for a blank `TOKEN_SOURCE` (now `gsm`) and the new `env` value (Unit 3).
- Operational helpers and deployment docs keep their fixed names: `scripts/redeploy.sh` (region,
  service name, fixed test list), `scripts/crear-frase-dueno.sh`, the `app=poster-rush` secret
  label in the importer, and `DEPLOY_CLOUD_RUN.md`. Values with commas passed through
  `gcloud --set-env-vars` need gcloud's alternate-delimiter syntax; this is not documented here.
- `FINANZAS_ENV_PATH` keeps its default path.
- Business-specific copy and assumptions stay: milk warnings in dish creation, "pesos" labels, and
  the spot 1 / workshop 1 fallbacks in dish updates.
- Internal constants stay in code: token cache TTL, fetch timeout, 60 000-character truncation, rate-limit
  numbers, token lifetimes.
- Translating Spanish texts other than tool names: descriptions, parameter names, instructions,
  result fields, error texts and code identifiers stay in Spanish.
- The project `tsc` configuration still covers only `src/`; the wider check is a one-off.
- The order of accounts inside the `cuenta` enum of `tools/list` is not part of the contract (zod
  lists numeric-looking names first); membership is.
- Finance timestamps are sent without an offset, as today: in the repeated hour of a daylight
  saving change two instants give the same timestamp.
- Timezone aliases may resolve differently across Node/ICU versions; only letter case is
  normalized reliably.
- An unset `POSTER_ACCOUNTS` and an explicit list equal to the defaults differ: only the unset
  case gives the `cafe-04` write target and permission.
- Write time budget: a read-back that keeps failing retries for about 160 seconds, longer than a
  typical client request timeout, and a slow plan read can let a write go out after the client
  gave up. A client that then retries can duplicate an applied write.
- GSM and MySQL tokens are not format-checked. A very short token makes redaction rewrite matching
  text in results and audit lines; the text stays valid JSON.
- Stricter validation can stop a deployment whose environment used to be accepted (an unknown or
  padded `TOKEN_SOURCE`, a permission outside the list); check the live environment against these
  rules before deploying.

## Risks

- The global lock can be held indefinitely by anyone who can reach `/authorize` (see 1.2). While it
  holds, no new OAuth authorization succeeds, even with the correct passphrase; the static bearer
  path, issued tokens and token refresh are unaffected.
- Startup now fails on configuration that used to be accepted silently (an unknown
  `TOKEN_SOURCE`, a write permission outside the list). This is intended.
- `X-Frame-Options: DENY` would break a client that renders the authorization page in a frame;
  clients are expected to open it in a browser window.
- The CSP is checked by header tests only, not in a browser.
