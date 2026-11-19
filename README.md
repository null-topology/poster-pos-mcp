# Poster POS MCP server

A remote **Model Context Protocol** server that lets an AI assistant (Claude, from desktop or phone) **read and safely configure Poster POS accounts** across a multi-location restaurant/café network.

I built it to run my own 10-location coffee brand from a chat window: check menus, recipes, ingredients, purchases, balances and staff, and make controlled changes, without opening each POS back office. That setup (its account list, the names shown in texts, write permissions and time zone) is only the default: each of them is set through the environment, see [Configuration](#configuration).

## Why it's interesting

Letting an LLM write to a production POS is risky. The server enforces the safety rules itself, so they don't depend on the model behaving:

| Rule | How it's enforced |
|---|---|
| Account allow-list | Only accounts in `POSTER_ACCOUNTS` (loaded into `CUENTAS` in `src/config.ts`; default `cafe-01` to `cafe-10`) can be touched, including for reads. One exception: `auditoria_reciente` returns this instance's local audit log as written, so it can show entries for accounts since removed from the list |
| Writes limited to a permission set | Only the accounts in `WRITE_DEFAULT_ACCOUNTS` (default `cafe-04` while `POSTER_ACCOUNTS` is unset, empty otherwise; may be set empty) are writable by default. Any other account needs an explicit `permitir_otra_cuenta: true` on that call |
| **Dry-run by default** | Every write with `confirm: false` returns the diff, warnings and the exact payload without touching Poster |
| Apply once, then verify | `confirm: true` writes once (no retries, to avoid duplicates) and **reads back** to verify |
| Audit log | Every dry-run, apply and rejection is logged with who, when, account, method, payload (token-redacted) and result |
| Secrets never exposed | Tokens come from Google Secret Manager, are redacted from errors and logs, and no tool returns them |
| No destructive deletes | Items off the menu are **hidden**, not deleted |

## Tools

- **Read:** accounts, menu snapshot, product detail, ingredients, prepared items, customer groups, promotions, employees, payment methods, settings, purchases, balances, base catalogs, generic `get*` passthrough, recent audit.
- **Write (dry-run first):** customer groups, ingredients, purchases, dish and category updates, recipes, prepared items, categories, transactions, purchase payments, hide dish.

## Stack

TypeScript · Hono · MCP Streamable HTTP (stateless) · OAuth + bearer auth · Google Cloud Run · Secret Manager · Vitest

## Run locally

```bash
npm install
cp .env.example .env   # PORT, TOKEN_SOURCE, MCP_BEARER_TOKEN, ...
npm run dev
npx vitest run
```

`npm run test:live` (`POSTER_LIVE=1`) runs a subset of the reads and dry-runs of some writes against real Poster accounts. It requires `cafe-04` and `cafe-01` in the account list (`POSTER_ACCOUNTS`; the default list has both); the other accounts are not used. It reads from and dry-runs against `cafe-04`, which must hold real data, for example more than 50 products in more than 3 categories (an americano among them), more than 50 ingredients, prepacks with a recipe, employees and positions, payment methods, purchases, storages and suppliers. The test runner sets `WRITE_DEFAULT_ACCOUNTS=cafe-04` over the shell and `.env`, so `cafe-04` is the only account written by default and a `POSTER_ACCOUNTS` without `cafe-04` stops the suite when the configuration loads. `cafe-01` must be listed and is expected to be blocked without `permitir_otra_cuenta`.

Deployment notes (in Spanish): [DEPLOY_CLOUD_RUN.md](DEPLOY_CLOUD_RUN.md). Original Spanish README: [README.es.md](README.es.md).

## Configuration

Runtime settings come from the environment; a local `.env` fills only the variables that are not already set, and `.env.example` lists them all. With none of the variables below set, the server behaves as before, except that the texts which named the network "RUSH" (a tool parameter description and the authorization page) now use the default `NETWORK_NAME`, "RUSH Café". An invalid value of a variable in the table stops the server at startup with an error that names the variable and the rule it breaks, and points to a bad account-list entry by its position (1 = first); the error never quotes the value. Values in the table are trimmed before they are checked, with two exceptions: `SERVICE_NAME`, `OAUTH_SUBJECT` and `TOKEN_SOURCE` are checked as written, and `OWNER_NAME` and `NETWORK_NAME` are checked for control and bidirectional formatting characters before they are trimmed, so a trailing newline or tab stops startup. A local `.env` strips the spaces around unquoted values before any check; values exported in the shell reach the checks unchanged. Under Vitest a local `.env` is not loaded, so the offline tests do not depend on it; `npm run test:live` (`POSTER_LIVE=1`) loads it, except that the test runner pins `WRITE_DEFAULT_ACCOUNTS` (see [Run locally](#run-locally)).

| Variable | Default | Rules |
|---|---|---|
| `POSTER_ACCOUNTS` | `cafe-01,…,cafe-10` | Comma-separated allow-list. Each entry matches `^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$`; empty entries, duplicates and a blank value fail |
| `DEFAULT_WRITE_ACCOUNT` | `cafe-04` when `POSTER_ACCOUNTS` is unset, otherwise none | Account a write tool uses when `cuenta` is omitted; must be in the list. Blank = none, and then every write tool requires `cuenta`. It may be outside `WRITE_DEFAULT_ACCOUNTS`: writes to it then still need `permitir_otra_cuenta: true`, and the write tools' `cuenta` description says so |
| `WRITE_DEFAULT_ACCOUNTS` | `cafe-04` when `POSTER_ACCOUNTS` is unset, otherwise empty | Accounts writable without `permitir_otra_cuenta: true`; each must be in the list. Blank = empty; order has no effect |
| `TIMEZONE` | `America/Merida` | Time zone for "today" and default timestamps: any value `Intl.DateTimeFormat` takes. An IANA name is recommended; UTC offsets such as `+05:00` and aliases such as `EST` also load on current Node versions (which ones load depends on the Node version). The value is stored as `Intl` resolves it, so letter case does not matter (`america/merida` works) and an alias becomes the zone it maps to, which can differ between Node versions. Blank = default |
| `OWNER_NAME` | `Roy` | Shown in the instructions, tool descriptions and write-guard error. 1-100 characters, no control characters and no bidirectional formatting characters (U+200E, U+200F, U+202A-U+202E, U+2066-U+2069). Blank = default |
| `NETWORK_NAME` | `RUSH Café` | Shown in the instructions, tool descriptions and the authorization page (HTML-escaped). Same rules as `OWNER_NAME` |
| `SERVICE_NAME` | `poster-rush` | MCP server name, `/health`, `/`, authorization page title and heading, and startup log. `^[A-Za-z0-9._-]{1,64}$`, checked as written: not trimmed, so a blank or space-padded value fails |
| `OAUTH_SUBJECT` | `roy` | `sub` claim of issued access and refresh tokens. `^[A-Za-z0-9._@-]{1,64}$`, not trimmed, like `SERVICE_NAME`. Tokens issued under an earlier value stay valid until they expire |
| `TOKEN_SOURCE` | `gsm` | Exactly `gsm` or `mysql`, not trimmed: any other value, a space-padded one included, fails. Blank = default |
| `POSTER_MYSQL_URL` | unset | `mysql` only; ignored with `gsm`. Replaces the `DATABASE_URL` line read from the file at `FINANZAS_ENV_PATH`; when unset or blank, that file is read at the first token lookup. With `mysql`, a value that is not a valid URL fails at startup. A generic `DATABASE_URL` in the environment is not used. MySQL connection and query errors name the source of the URL (`POSTER_MYSQL_URL` or the file's `DATABASE_URL` line) and at most the driver's error code, never the URL |

`PORT`, `PUBLIC_BASE_URL`, `FINANZAS_ENV_PATH`, `GCP_PROJECT_ID`, `SECRET_PREFIX`, `MCP_BEARER_TOKEN`, `OAUTH_SIGNING_KEY`, `OWNER_PASSPHRASE`, `OAUTH_ALLOWED_REDIRECTS` and `AUDIT_DIR` work as before, with no new validation.

## Authorization limits

The passphrase step of `/authorize` allows 5 wrong attempts per 15-minute window. The window starts at the first wrong passphrase, and a successful authorization resets the counter. The counter is shared by every client of a server instance, and `X-Forwarded-For` plays no part in the decision. Known limitations of this design (residual risks):

- Anyone who can reach `/authorize` and get a `client_id` from the open `/register` endpoint can keep new authorizations locked by sending five wrong passphrases each time a window ends. While the lock holds, every well-formed `POST /authorize` gets 429 whatever passphrase it carries, the correct one included (a request that fails OAuth parameter validation still gets 400 and the GET page still renders), so no client can complete a new OAuth authorization on that instance. The static bearer token, already issued access tokens and refreshes with already issued refresh tokens keep working, and restarting the instance clears the lock.
- Windows are local to each instance and start at that instance's first failure. With N instances an attacker who reaches all of them gets up to five guesses per instance per window; there is no service-wide limit.

## License

MIT © 2026 Roy Camacho Jácome. See [LICENSE](LICENSE).
