# Poster POS MCP server

A remote **Model Context Protocol** server that lets an AI assistant (Claude, from desktop or phone) **read and safely configure Poster POS accounts** across a multi-location restaurant/café network.

I built it to run my own 10-location coffee brand from a chat window: check menus, recipes, ingredients, purchases, balances and staff, and make controlled changes, without opening each POS back office. That setup (its account list, the names shown in texts, write permissions and time zone) is only the default: each of them is set through the environment, see [Configuration](#configuration).

## Why it's interesting

Letting an LLM write to a production POS is risky. Applying a write (`confirm: true`) and writing outside the default accounts (`permitir_otra_cuenta: true`) are tool arguments the model sets, so the human check before a write is the client's approval of the tool call. The server enforces these rules itself:

| Rule | How it's enforced |
|---|---|
| Account allow-list | Only accounts in `POSTER_ACCOUNTS` (loaded into `CUENTAS` in `src/config.ts`; default `cafe-01` to `cafe-10`) can be touched, including for reads. One exception: `recent_audit` returns this instance's local audit log, unfiltered by account (its output is redacted like every result), so it can show entries for accounts since removed from the list |
| Writes limited to a permission set | Only the accounts in `WRITE_DEFAULT_ACCOUNTS` (default `cafe-04` while `POSTER_ACCOUNTS` is unset, empty otherwise; may be set empty) are writable by default. Any other account needs an explicit `permitir_otra_cuenta: true` on that call |
| **Dry-run by default** | A successful write call with `confirm: false` returns the diff, warnings and a preview of the payload, redacted like every result, and sends no write to Poster (it may read from Poster to build the diff) |
| Apply once, then verify | `confirm: true` writes once (no retries, to avoid duplicates) and **reads back** to verify |
| Audit log | The write handler logs every dry-run, apply, rejection and unknown outcome, best effort (a failing sink never fails the call); arguments rejected by input validation never reach the handler and are not logged. Every entry records time, actor, client, account, tool, method and payload (token-redacted); a dry-run records nothing more; a Poster rejection adds Poster's full reply and the error; an applied write adds Poster's `response` and the read-back result; an unknown outcome, or a failure before the write was sent, adds the error (when the failure came before a plan, the tool is `?`, the method is `-` and the payload is the tool arguments). A write whose HTTP attempt failed once it had started (network error, timeout, a reply that is not JSON) or that got an HTTP 5xx status, whatever its body, is logged as `desconocido`, as is a reply with no `error` and no result (neither `response` nor `success: 1`) and a reply with no `error` whose `response` is false or null, whatever `success` says (no read-back runs, and the error includes the redacted reply): it may have been applied, so check with a read before retrying. Otherwise a reply whose `error` is present and not 0 or null is logged as rejected. An applied write stays `aplicado`: if the read-back itself fails, `verificacion.ok` is false and a notice says not to repeat the write; a read-back that completes but does not match returns `verificacion.ok: false` with its own detail |
| Token redaction | Tokens come from Google Secret Manager, a local MySQL table or `POSTER_TOKEN_<ACCOUNT>` environment variables (`TOKEN_SOURCE`) and travel in the query string of every Poster request. Known tokens (environment tokens from startup, Secret Manager and MySQL tokens once loaded) are masked in tool results, errors and the audit log in their literal, URL-encoded (with uppercase or lowercase hex digits in the `%XX` escapes) and JSON-escaped forms, and any `token=` value is masked. `poster_get` clips a reply whose JSON text exceeds 60 000 characters: the preview is redacted as text before it is clipped, so it may over-redact but never leaves a token prefix, and `bytes` is the character length of the unredacted JSON text |
| Hide first, narrow delete | Items off the menu are **hidden** (`hide_dish`). The one delete, `delete_old_dish` (`menu.removeDish`), checks the dish it reads: the name must end in "(old)" and every spot must be marked hidden (`visible` "0" or 0; `hide_dish` sends 0). A dish with no spots, or with a spot whose visibility is missing or of any other value or type, is refused. The check does not know whether `hide_dish` was used |

## Tools

- **Read:** accounts, menu snapshot, product detail, ingredients, prepared items, customer groups, promotions, employees, payment methods, settings, purchases, balances, stocktakes (`list_stocktakes`), stocktake discrepancies (`stocktake_result`), blind count sheet (`count_sheet`), base catalogs, generic `get*` passthrough, recent audit.
- **Write (dry-run first):** customer groups, ingredients, purchases, write-offs (`create_write_off`), new dishes, dish and category updates, dish recipes, prepared items, categories, transactions, purchase payments, hide dish, delete an old hidden dish.
- **Processing methods:** recipe rewrites (`update_prepack`, `hide_dish`, `update_dish_recipe`) re-send each line's processing methods (clean, boil, fry, stew, bake) as they were read. The read-back reports a sent method or a manual net weight (lock 0) that comes back different; a sent method it cannot read back is listed as unverified, and a method missing from the recipe it read is listed as not carried over (Poster may reset it). A kept manual-net line (lock 0) is sent with the defaults when the caller leaves them out: net equal to gross without `netto`, and in `update_dish_recipe` also lock 1 without `lock`. Its manual net weight may then be lost; the dry-run warns about it. `create_prepack` and `create_dish` cannot set methods yet.
- **Dish modifier groups:** `update_dish_recipe` keeps the dish's modifier groups and options, with their ids, when `grupos` is omitted. Passing `grupos` replaces the set: a group with the same name and, within it, an option with the same ingredient and type keep their ids; the others are created, and the current ones not passed are removed. The dry-run lists the groups and options kept, created and removed.

### Stocktakes

The Poster API cannot create, fill in or conduct a stocktake; staff conduct it in Poster. This server lists the stocktakes, shows a stocktake's discrepancies with their cost, and prints a blind count sheet (items without balances or costs). By default the sheet lists only the items whose balance in that storage is not zero; `include_zero` lists every item, and `omitted_zero_balance` tells how many were left out. A shortage found outside a stocktake can be recorded with `create_write_off`; Poster shows it as a write-off, not as a stocktake.

## Stack

TypeScript · Hono · MCP Streamable HTTP (stateless) · OAuth + bearer auth · Google Cloud Run · Poster tokens from Secret Manager, MySQL or environment variables · Vitest

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
| `TOKEN_SOURCE` | `gsm` | Where Poster API tokens come from: `gsm` (Google Secret Manager), `mysql` (local `poster_accounts` table) or `env` (`POSTER_TOKEN_<ACCOUNT>` variables). Exactly one of the three, not trimmed: any other value, a space-padded one included, fails. Blank = default. `/health` and the startup log report it |
| `MCP_TRANSPORT` | `http` | `http`: an HTTP server on `PORT` with the endpoint `/mcp`; it needs `MCP_BEARER_TOKEN` or OAuth. `stdio`: the MCP client launches the process and talks to it over stdin/stdout; no port is opened, no authentication is needed, and every log line (startup and audit) goes to stderr. Exactly one of the two, not trimmed. Blank = default |
| `POSTER_TOKEN_<ACCOUNT>` | unset | `env` only; ignored with `gsm` and `mysql`. One per account in `POSTER_ACCOUNTS`, named after the account upper-cased with every hyphen replaced by an underscore (`cafe-04` → `POSTER_TOKEN_CAFE_04`); variables for accounts outside the list are not read. With the default list that means ten variables, `POSTER_TOKEN_CAFE_01` to `POSTER_TOKEN_CAFE_10`. Each value is trimmed and must then match `^[A-Za-z0-9:._~-]{16,}$`: at least 16 characters, only ASCII letters, digits and `:` `.` `_` `~` `-` (an `<account id>:<hex>` token fits; that shape is an example, not a verified Poster token format). A missing or blank token, or one outside that format, fails, and one error names every failing variable and never quotes a value. Read once at startup, so a changed token takes effect after a restart; with `gsm` or `mysql` a token is cached for 10 minutes and read again at the first lookup after that. These tokens are removed from error messages and audit entries, including the tokens of accounts never queried |
| `POSTER_MYSQL_URL` | unset | `mysql` only; ignored with `gsm` and `env`. Replaces the `DATABASE_URL` line read from the file at `FINANZAS_ENV_PATH`; when unset or blank, that file is read at the first token lookup. With `mysql`, a value that is not a valid URL fails at startup. A generic `DATABASE_URL` in the environment is not used. MySQL connection and query errors name the source of the URL (`POSTER_MYSQL_URL` or the file's `DATABASE_URL` line) and at most the driver's error code, never the URL |

`PORT`, `PUBLIC_BASE_URL`, `FINANZAS_ENV_PATH`, `GCP_PROJECT_ID`, `SECRET_PREFIX`, `MCP_BEARER_TOKEN`, `OAUTH_SIGNING_KEY`, `OWNER_PASSPHRASE`, `OAUTH_ALLOWED_REDIRECTS` and `AUDIT_DIR` work as before, with no new validation.

On Cloud Run, map each `POSTER_TOKEN_<ACCOUNT>` from Secret Manager with `--set-secrets` (for example `--set-secrets POSTER_TOKEN_CAFE_04=poster-token-cafe-04:latest`) instead of passing the token as a plain environment variable with `--set-env-vars`, where it would show in the service configuration. Running instances keep the token they started with; a rotated token reaches the service with new instances or a new revision.

### Environment-only setup

Where configuration can only be passed as environment variables (no `.env` file, no Google Cloud or MySQL access), set `TOKEN_SOURCE=env` and give every listed account its token. Without `POSTER_ACCOUNTS` the default list applies, and all ten accounts need one (`POSTER_TOKEN_CAFE_01` to `POSTER_TOKEN_CAFE_10`). A minimal setup for two accounts that writes to `shop-north` by default, as the name and value of each variable to enter in the platform's environment settings:

| Variable | Value |
|---|---|
| `TOKEN_SOURCE` | `env` |
| `POSTER_ACCOUNTS` | `shop-north,shop-south` |
| `POSTER_TOKEN_SHOP_NORTH` | the Poster API token of `shop-north` |
| `POSTER_TOKEN_SHOP_SOUTH` | the Poster API token of `shop-south` |
| `DEFAULT_WRITE_ACCOUNT` | `shop-north` |
| `WRITE_DEFAULT_ACCOUNTS` | `shop-north` |
| `MCP_BEARER_TOKEN` | a random secret, for example the output of `openssl rand -hex 32` (HTTP only; leave it out with `MCP_TRANSPORT=stdio`) |

These are values for the platform, not a script to run; each token goes in as it is, without quotes. `GCP_PROJECT_ID`, `SECRET_PREFIX`, `POSTER_MYSQL_URL` and `FINANZAS_ENV_PATH` are not needed; set `PORT` and `PUBLIC_BASE_URL` as your platform requires. Writes to `shop-south` still need `permitir_otra_cuenta: true`. When a token variable is missing or blank, or its token breaks the format rule in the table above, the server stops at startup with an error that names the variable and never quotes its value.

### Run with npx

The server runs without a clone: `npx` fetches the repository at a tag, installs the dependencies, compiles TypeScript through the `prepare` script and starts the server. With the variables above set in the environment:

```bash
npx -y github:null-topology/poster-pos-mcp#v0.5.1
```

- It needs Node.js 20 or later, `git` on the `PATH` and install scripts enabled (no `--ignore-scripts`). The first run builds the package; later runs reuse the npx cache.
- Pin a tag: without `#<tag>` it runs the default branch as it is at that moment.
- A `.env` file in the current directory is not read. The default `AUDIT_DIR` (`./audit`) resolves inside the npx cache, so set `AUDIT_DIR` to a writable directory of your choice.
- Over HTTP the MCP endpoint is `http://<host>:<PORT>/mcp` (default port 3210). The server listens on all interfaces.

To let an MCP client launch the server itself over stdio, set `MCP_TRANSPORT=stdio`; `MCP_BEARER_TOKEN`, OAuth, `PORT` and `PUBLIC_BASE_URL` are then not needed. A client configuration in the common `mcpServers` format:

```json
{
  "mcpServers": {
    "poster": {
      "command": "npx",
      "args": ["-y", "github:null-topology/poster-pos-mcp#v0.5.1"],
      "env": {
        "MCP_TRANSPORT": "stdio",
        "TOKEN_SOURCE": "env",
        "POSTER_ACCOUNTS": "shop-north,shop-south",
        "POSTER_TOKEN_SHOP_NORTH": "<token of shop-north>",
        "POSTER_TOKEN_SHOP_SOUTH": "<token of shop-south>",
        "DEFAULT_WRITE_ACCOUNT": "shop-north",
        "WRITE_DEFAULT_ACCOUNTS": "shop-north",
        "AUDIT_DIR": "/path/to/writable/audit"
      }
    }
  }
}
```

The first launch builds the package before the server answers, which takes about 10-15 seconds; later launches start from the npx cache.

## Authorization limits

The passphrase step of `/authorize` allows 5 wrong attempts per 15-minute window. The window starts at the first wrong passphrase, and a successful authorization resets the counter. The counter is shared by every client of a server instance, and `X-Forwarded-For` plays no part in the decision. Known limitations of this design (residual risks):

- Anyone who can reach `/authorize` and get a `client_id` from the open `/register` endpoint can keep new authorizations locked by sending five wrong passphrases each time a window ends. While the lock holds, every well-formed `POST /authorize` gets 429 whatever passphrase it carries, the correct one included (a request that fails OAuth parameter validation still gets 400 and the GET page still renders), so no client can complete a new OAuth authorization on that instance. The static bearer token, already issued access tokens and refreshes with already issued refresh tokens keep working, and restarting the instance clears the lock.
- Windows are local to each instance and start at that instance's first failure. With N instances an attacker who reaches all of them gets up to five guesses per instance per window; there is no service-wide limit.

## License

MIT © 2026 Roy Camacho Jácome. See [LICENSE](LICENSE).
