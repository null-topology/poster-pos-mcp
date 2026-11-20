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
- Variants:
  - `documented`: JSON `{"supply": {"date", "supplier_id", "storage_id", "supply_comment"}, "ingredient": [{"id", "type": 4, "num": 1, "sum": 1}]}`.
  - `documented_flat`: JSON `{"date", "supplier_id", "storage_id", "supply_comment", "ingredient": [{"id", "type": 4, "num": 1, "sum": 1}]}`.
  - `form_ingredient`: multipart, flat fields `date`, `supplier_id`, `storage_id`, `supply_comment`, and `ingredient` = the line array as a JSON string, `sum` 1.
  - `legacy_unscaled`: multipart exactly as `create_supply` sends today (`ingredients` = JSON string), but `sum` 1, not 100.
- Read-back: only with a positive id in the reply, `storage.getSupply` for that id. The result carries the read as
  returned (redacted): `supply_sum`, each line's quantity and sum, `date`. `ok` is true when the supply reads back
  with that id; no unit verdict is made.

### Probe `transaction_edit`
- Fields: `transaction_id`, `dia` (`YYYY-MM-DD`, the transaction's day).
- The server reads `finance.getTransactions` for that day (`dateFrom` = `dateTo` = `dia` as `Ymd`) and finds the row
  by id. It refuses unless the row exists, its type is 0 (expense) or 1 (income), the absolute `amount` is at most
  100 kopecks, and its `comment` contains `probe` (case-insensitive). A transfer is refused.
- Body, JSON, per the docs example: `transaction_id`, `type`, `category` (the row's `category_id`), `user_id`, `date`
  (the row's day as `Ymd`); for type 0 `amount_from` and `account_from` (the row's `account_id`); for type 1
  `amount_to` and `account_to`. Only the amount changes, to 2.00:
  - `amount_currency`: the amount is sent as 2.
  - `amount_kopecks`: the amount is sent as 200.
- Read-back: the same day's row by id, returned as read (redacted). `ok` is true when the row reads back.

### Results
- Dry-run returns the probe, variant, method, encoding (`json` | `multipart`), the exact wire body (multipart fields
  listed with the string values sent), what the read-back will read, and notices: nothing was sent; send one
  variant per approval; after a reply with no id, check `storage.getSupplies` before trying the next variant; delete
  the probe supply in the web UI after reading it back.
- Every outcome after a POST (applied, rejected, unknown) carries the HTTP status and the redacted reply. The
  transport reports the status for this tool; other tools' results are unchanged by this.
- New keys, notices, errors and the description are English. The description says the tool is experimental, off by
  default, sends a fixed tiny write, never pays a supply, and that the supply has to be deleted by hand.

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
- The transaction probe refuses a missing row, a transfer, an amount above 100 kopecks and a comment without the
  marker, before any POST; each variant's body is pinned.
- A confirmed call sends exactly one POST with the variant's encoding (JSON content type, or form data); the
  read-back runs only with a positive id; applied, rejected and unknown results carry the status and the redacted
  reply; a token inside the reply is redacted.
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
