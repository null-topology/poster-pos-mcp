# Unclear write replies and an experimental write probe

## Purpose

1. A write reply whose `response` is `false` or `null` and that carries no error is an unknown outcome, not an
   applied write. Today such a reply is treated as applied, the read-back runs without an id, and the tool says
   "do not repeat" for a write that may never have been created.
2. The live contracts of `storage.createSupply` and `finance.updateTransactions` are not confirmed. Poster's docs
   and its PHP SDK describe a body that differs from the one `create_supply` sends. An experimental tool, off by
   default, sends one fixed, tiny write in one of a few body variants, so the working contract can be found on a
   real account with the normal write gate, approval and audit.
3. A recipe line for an ingredient sold by the piece whose piece weight is 0 gets a net weight of 0 g without any
   sign of trouble. The recipe tools warn about it.

Poster's PHP SDK (`PosterApiCore::makeApiRequest`, `sendRequest` with `$json = true`) sends every POST as a JSON
body with `Content-Type: application/json`. "Documented body" below therefore means a JSON body.

## Unit A: unclear write replies

- In `ejecutar`, after the POST: when the reply carries no error and its `response` is `false` or `null`, whatever
  `success` says, the outcome is unknown (`desconocido`). It is audited as unknown, the read-back does not run, and
  the tool returns an error that says Poster returned no result, the write may or may not have been applied, and a
  read should check before any retry. The error includes the redacted summary of the reply.
- Unchanged: a reply with no `response` and `success` not 1 stays unknown; an error in the reply stays rejected;
  `response` of `true`, a number, an object or an array goes to the read-back as today.

Acceptance:
- `{response: false}`, `{success: 1, response: false}`, `{response: null}` and `{success: 0, response: false}`, each
  with no error, give the unknown outcome: no read-back call, one audit entry with mode `desconocido`, an error text
  that tells the caller to check before retrying. Each test is seen failing on the tree before the change.
- A reply with `response: true` still runs the read-back.

## Unit B: experimental write probe

### Switch
- `EXPERIMENTAL_WRITE_PROBE`: unset or blank = off; exactly `1` = on; any other value stops startup with an error
  that names the variable and not the value.
- Off: the tool is not registered and the tool list is unchanged. On: one more tool, `experimental_write_probe`.

### Tool `experimental_write_probe`
- Inputs: `cuenta` (the write account schema), `probe` (`supply` | `transaction_edit`), `variant` (per probe, below),
  the probe's own fields, and the usual `confirm` (default false) and `permitir_otra_cuenta`.
- Runs through `ejecutar`: the write gate, dry-run by default, the write time budget, the audit and redaction are
  the same as for every write tool. One confirmed call sends one POST.
- The caller never composes the body. The server builds it from validated ids and fixed values.

### Probe `supply`
- Fields: `storage_id`, `supplier_id`, `ingredient_id`, `fecha` (required, `YYYY-MM-DD HH:MM:SS`).
- Checks before anything is sent: the storage, the supplier and the ingredient exist on the account (same reads as
  `create_supply`).
- Fixed line: the ingredient as type 4, quantity 1, unit price 1.00 in the variant's unit. A fixed comment
  `write probe` marks the supply so it can be found and deleted. `account_id` is never sent: a paid supply posts an
  expense.
- Variants, in this order in the tool, its description and the docs:
  - `documented`: JSON `{"supply": {"date", "supplier_id", "storage_id", "supply_comment"}, "ingredient": [{"id", "type": 4, "num": 1, "sum": 1}]}`,
    as the docs example places the line.
  - `documented_nested`: JSON `{"supply": {"date", "supplier_id", "storage_id", "supply_comment", "ingredient": [{"id", "type": 4, "num": 1, "sum": 1}]}}`,
    as the parameter table of `storage.createSupply` lists `ingredient` inside `supply`.
  - `documented_flat`: JSON `{"date", "supplier_id", "storage_id", "supply_comment", "ingredient": [{"id", "type": 4, "num": 1, "sum": 1}]}`.
  - `form_ingredient`: multipart, flat fields `date`, `supplier_id`, `storage_id`, `supply_comment`, and `ingredient` = the line array as a JSON string, `sum` 1.
  - `legacy_unscaled`: multipart exactly as `create_supply` sends today (`ingredients` = JSON string), but `sum` 1, not 100.
- Read-back: only with a positive id in the reply, `storage.getSupply` for that id. The result carries the read as
  returned (redacted): `supply_sum`, each line's quantity and sum, `date`. `ok` is true when the supply reads back
  with that id; no unit verdict is made.

### Probe `transaction_edit`
- Fields: `transaction_id`, `dia` (`YYYY-MM-DD`, the transaction's day).
- The server reads `finance.getTransactions` for that day (`dateFrom` = `dateTo` = `dia` as `Ymd`) and finds the row
  by id. Before anything is sent it refuses unless:
  - the row exists on that day; the not-found error says the row may be on another day and to check `dia`;
  - its type is 0 (expense) or 1 (income); a transfer (type 2) is refused;
  - `binding_type` and `recipient_type` are each 0 or absent. Any other value, documented or not, read as a number
    or not, is refused (fail closed). The docs list binding 1 transfer, 12 shift closing, 13 supply, 14 shift
    transactions and recipient 1 transfer, 12 supplier; their examples also show 11 and 15. The error names the
    field and its value only;
  - the absolute `amount` is at most 100 kopecks;
  - its `comment`, trimmed and case-folded, is exactly `write probe`. A comment that only contains the words, such
    as "Replacement temperature probe" or "my write probe", is refused;
  - `account_id`, `category_id` and `user_id` are positive and the row's date is on `dia`.
- The target is made by hand: the operator creates a new expense of at most 1.00 in the Poster web UI with the
  comment `write probe`, and passes its id and day. A row Poster made itself (a supply, a shift closing, a
  transfer) is never a target.
- Body, JSON, per the docs example: `transaction_id`, `type`, `category` (the row's `category_id`), `user_id`, `date`
  (the row's day as `Ymd`); for type 0 `amount_from` and `account_from` (the row's `account_id`); for type 1
  `amount_to` and `account_to`. Only the amount changes, to 2.00:
  - `amount_currency`: the amount is sent as 2.
  - `amount_kopecks`: the amount is sent as 200.
- Read-back: the same day's row by id, returned as read (redacted). `ok` is true when the row reads back. When it
  does not, the result carries a `note` that the edit may have moved the row to another day, to be read with another
  `dia` before the next variant.

### Results
- Dry-run returns the probe, variant, method, encoding (`json` | `multipart`), the exact wire body (multipart fields
  listed with the string values sent), what the read-back will read, and notices: nothing was sent; send one
  variant per approval; after a reply with no id, check `storage.getSupplies` before trying the next variant; delete
  the probe supply in the web UI after reading it back.
- Every outcome after a POST (applied, rejected, unknown) carries the HTTP status and the redacted reply. The
  transport reports the status for this tool; other tools' results are unchanged by this.
- Redirects: the probe POST is sent with `redirect: "manual"`, so fetch does not follow it. A 3xx status, status 0
  or an `opaqueredirect` response is an unknown outcome carrying that status; no read-back runs. The transport only
  passes the option through to fetch. Other writes keep following redirects.
- The outcome comes first: classification (rejected when the reply carries an error; unknown when it has no
  `response` and `success` is not 1, or when `response` is `false` or `null`; applied otherwise) and the audit entry do not depend on formatting
  the reply. Formatting is best effort: a reply that cannot be formatted (for example one nested too deeply) is
  shown as `reply could not be formatted`. Any failure after the POST returned is an unknown outcome, never a
  rejection.
- Diagnostics: the `reply`, the status note of an unknown outcome and the read-back rows mask the value under any
  key matching `token|secret|password|passwd|api_?key|authorization` (case-insensitive) as `***`, then apply the
  shared redaction. The shared redaction itself is unchanged.
- The status note of an unknown outcome keeps the masked, redacted reply up to 2000 characters; a longer reply is
  clipped and marked `[clipped at 2000 characters]`. This covers a JSON reply the write handler receives (status
  below 500); a 5xx or non-JSON reply is summarised by the transport (see Limitations). Other tools carry no status
  note.
- New keys, notices, errors and the description are English. The description says the tool is experimental, off by
  default, sends a fixed tiny write, never pays a supply, and that the supply has to be deleted by hand. It lists the
  supply variants in the order above, says the transaction target is a new expense of at most 1.00 made by hand in
  the web UI with the comment `write probe` and `binding_type` / `recipient_type` 0 or absent, and that the probe
  POST does not follow redirects.

### Docs
- `.env.example`: commented `EXPERIMENTAL_WRITE_PROBE=1` with one line on what it does.
- README.md: a short "Experimental write probe" section (switch, probes, variants, that the supply is deleted by
  hand). README.es.md: one line pointing to that section.

### Acceptance
- Switch: unset, blank and `1` behave as stated; another value stops startup without echoing it; the tool list
  has 35 tools off and 36 on.
- Each supply variant's dry-run wire body and encoding are pinned exactly; no variant contains `account_id`;
  quantity 1, price 1 and the comment marker are fixed and cannot be set by the caller.
- The supply probe refuses a missing storage, supplier or ingredient, and a missing or malformed `fecha`, before
  any POST.
- The transaction probe refuses, before any POST: a missing row (the error points at another day and `dia`), a
  transfer, a type other than 0 or 1, a non-zero `binding_type` or `recipient_type` (13, 12, 14, 1, 15 and others,
  as text or number), an amount above 100 kopecks, a comment other than `write probe` once trimmed and case-folded
  (including one that only contains the words), a non-positive account, category or user id, and the same id read
  on another day. `binding_type` / `recipient_type` 0 or absent let the edit through. Each variant's body is pinned.
- A confirmed call sends exactly one POST with the variant's encoding (JSON content type, or form data); the
  read-back runs only with a positive id; applied, rejected and unknown results carry the status and the redacted
  reply; a token inside the reply or a read-back row is redacted; a value under a credential-like key (for example
  `access_token`) is masked.
- The probe POST passes `redirect: "manual"` to fetch and other writes do not. Over a real 127.0.0.1 server
  answering 307 to another path, the target is hit 0 times by the probe and the outcome is unknown with status 307;
  another write still follows the redirect.
- A reply too deeply nested to format gives the outcome its fields call for (unknown, rejected or applied) after one
  POST, with the matching audit entry.
- An unknown outcome's status note keeps a long reply up to 2000 characters, redacted before clipping, and marks it.
- An account outside the write set is refused as for other writes.
- Each test is seen failing against a wrong implementation.

## Unit C: piece ingredients without a piece weight

Poster stores a recipe line for an ingredient sold by the piece (`ingredient_unit` `p`) as a count of pieces and
computes its net weight from the ingredient's piece weight (`ingredient_weight` in `menu.getIngredients` rows;
`weight_ingredient` in `menu.createIngredient`/`menu.updateIngredient`). When that weight is 0, the line's net
weight is 0 g, so the recipe's yield and the cost derived from it are wrong, while the write itself succeeds.

- `create_prepack`, `update_prepack`, `create_dish` and `update_dish_recipe` already load `menu.getIngredients`.
  For every ingredient line they send (lines given by the caller and existing lines re-sent unchanged), when the
  ingredient's unit is `p` and its `ingredient_weight` is absent, blank, not a finite number, or not above 0, the
  result carries `zero_piece_weight`: a list of `{id, name}`, one entry per ingredient (not per line), plus a
  `zero_piece_weight_notice` text: these ingredients are sold by the piece and have no piece weight in Poster, so
  their net weight in this recipe is 0 g and the yield and cost are wrong; set the piece weight in Poster first.
- It is a warning only. The write is not refused and nothing else in the payload or the read-back changes. It
  appears in the dry-run and in the confirmed result. With no such line the keys are absent.
- `hide_dish` is out of scope (it does not take recipe lines from the caller). No extra Poster request is made.
- New keys and texts are in English.

Acceptance:
- For each of the four tools, a piece ingredient with weight 0, `"0"`, absent and `""` produces the warning in the
  dry-run and in the confirmed result; a piece ingredient with a positive weight, an ingredient in `kg` or `l`
  with weight 0, and a prepack line do not.
- Two lines of the same ingredient give one entry.
- `update_prepack` without `receta` warns for an existing re-sent piece line with weight 0.
- The POST body is byte-for-byte the same with and without the warning.
- Each test is seen failing on the tree before the change.

## Limitations
- The probe finds which body Poster accepts; it does not prove the unit of `sum` or of transaction amounts. The
  read-back values and the web UI total have to be compared by hand.
- A `packing` variant is left out until a supply entered in the web UI has been read.
- Whether hand-made expenses read back with `binding_type` and `recipient_type` 0 is not confirmed on a live
  account. The guard fails closed until it is; if they carry another value, the rule has to be revisited.
- Redirects on ordinary writes are still followed by fetch; only the probe POST stops at a redirect.
- Unit A stays global: no method is exempted from treating `false` or `null` as unknown without evidence of a real
  success reply that carries one of them.
- Credential-like keys are masked only in the probe's diagnostics. The audit entry and a transport error (a 5xx or
  a non-JSON reply, summarised by the transport before `ejecutar` sees it) keep the shared redaction only, and the
  status note of such an error carries no reply.
- On a 5xx the probe still shows only the transport's excerpt of the reply (300 characters, 120 for a non-JSON
  body), not the 2000-character reply and with no credential-key masking: the transport does not hand the body to
  the write handler, and changing that is a transport change left out of this unit.
- Unit C compares the unit `p` trimmed and case-folded.
