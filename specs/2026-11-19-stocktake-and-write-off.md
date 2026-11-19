# Stocktake reads and write-off tool

## Purpose

Give the model what Poster's public API allows for stocktakes, and a way to record waste:

1. List the stocktakes of a storage or of all storages.
2. Show the discrepancies of one stocktake.
3. Print a blind count sheet for a storage.
4. Create a manual write-off (`storage.createWriteOff`), dry-run by default, with the same safety rules as the other write tools.

Poster's public API (v3) has no method that creates, fills or conducts a stocktake. The documented storage methods for stocktakes are read-only: `storage.getStorageInventories` and `storage.getInventoryIngredients`. A stocktake is created and conducted in Poster itself (back office or POS app); the server reads the result. A difference found outside Poster can be recorded as a write-off, which Poster will not show as a stocktake.

## Poster contract (from the public docs, not confirmed on a live account)

- `storage.getStorageInventories` (GET, `storage_id` required): array of `inventory_id`, `storage_id`, `date_start`, `date_end`, `date_set` (backdating; `0000-00-00 00:00:00` when unset), `date_inventory` (same zero value when unset), `sum` and `sum_netto` (kopecks), `inventory_status` (`1` conducted, `0` not). The parameter table spells some fields `data_*`; read `date_*` and fall back to `data_*`.
- `storage.getInventoryIngredients` (GET, `inventory_id` or `storage_id`): object with `ingredients` and `manufactures` (each an object keyed by id or an array) and `prepacks` (object or array). Ingredient and manufacture rows: `item_id`, `item`, `unit`, `estimatedrest`, `factrest`, `difference`, `diffcurrency`, `primecost` (money in currency units, not kopecks). Values not counted come as the string `''` (two single quotes) or an empty string. Prepack rows: `product_id`, `product_name`, `type` (`1` semi-finished, `2` dish), `factrest`.
- `storage.getStorageLeftovers` (GET, `storage_id` optional, `zero_leftovers=true` includes zero stock): `ingredient_id`, `ingredient_name`, `ingredient_unit`, `ingredients_type` (`1` ingredient, `2` product or modifier), `hidden` (`1` hidden).
- `storage.createWriteOff` (POST): the parameter table lists flat `date` (`Y-m-d H:i:s`), `storage_id`, optional `reason_id`, and `ingredient[]` of `id`, `type` (1 product, 2 dish, 3 semi-finished, 4 ingredient, 5 modifier), `weight`, `sum` (cost per unit), optional `packing`, optional `reason` (line comment). The request example nests `storage_id` and `date` under `write_off`. Reply: `response` = write-off id.
- `storage.getWaste` (GET, `waste_id`): `waste_id`, `total_sum` (kopecks), `storage_id`, `date`, `reason_id`, `reason_name`, `elements[]` of `type` (1 product, 2 dish, 3 semi-finished, 8 modifier, 10 ingredient), `product_id`, `modificator_id`, `count`, `ingredients[]` of `ingredient_id`, `weight`, `unit`, `cost`. The element types differ from the write types: an ingredient is written as type 4 and read as type 10.
- `storage.getWastes` (GET, `dateFrom`/`dateTo` as `Ymd`): `waste_id`, `storage_id`, `date`, `reason_id`, `delete`.
- `storage.getWasteReasons` (GET): `reason_id`, `name`.

Unknown until a live write: whether `createWriteOff` reads the nested or the flat fields, the unit of `weight` for kg and litre ingredients, whether `sum` is required and in which unit, and whether `getWaste` field names match the docs.

## Unit 1: stocktake read tools

Three read tools, registered with the read-only annotation, in `src/tools/lectura.ts` and `src/mcp.ts`. Parameters, output keys and descriptions follow the existing read tools (Spanish, no currency word in keys).

### `list_stocktakes`

- Parameters: `cuenta`, optional `storage_id`, optional `desde` and `hasta` (`YYYY-MM-DD`, inclusive).
- With `storage_id`: it must exist in `storage.getStorages`; otherwise an error that lists the available storages as `id=name`. Without it: every storage from `storage.getStorages`, results merged.
- Row: `inventario_id`, `storage_id`, `almacen` (storage name), `inicio`, `fin` (each null for the zero date or an empty value), `fecha_inventario` (null for the zero date), `retroactiva` (true when `date_set` is set), `realizada` (`inventory_status` is `1`), `costo_total` (`sum` / 100), `costo_total_neto` (`sum_netto` / 100, only when present).
- The date of a stocktake is `fin`, or `inicio` when `fin` is null. `desde`/`hasta` filter on the day of that date. A stocktake with neither date is kept only when neither `desde` nor `hasta` is given.
- Sort by that date descending as a full date-time (two stocktakes of the same day keep their time order), stocktakes with neither date last, then `inventario_id` descending.

### `stocktake_result`

- Parameters: `cuenta`, `inventario_id`, optional `solo_diferencias` (default true), optional `limite` per group (default 200).
- Calls `storage.getInventoryIngredients` with `inventory_id`.
- A reply that is not an object, or that carries none of `ingredients`, `manufactures` and `prepacks` (a null group counts as absent), is an error: `Inventario <id> no existe en <cuenta> o Póster no devolvió renglones`.
- Groups `insumos` (ingredients), `producciones` (manufactures), `platillos_y_precocinados` (prepacks), each normalized from object or array.
- Ingredient and manufacture row: `id`, `nombre`, `unidad`, `calculado` (`estimatedrest`), `real` (`factrest`), `diferencia` (`difference`), `diferencia_costo` (`diffcurrency`), `costo_unitario` (`primecost`). A value that is `''`, empty or not a number becomes null.
- Prepack row: `id`, `nombre`, `tipo` (`precocinado` or `platillo`), `real`.
- With `solo_diferencias`: ingredient and manufacture rows whose `diferencia` is a non-zero number; prepack rows whose `real` is a non-zero number. Without it: every row.
- Ingredient and manufacture rows sorted by the absolute `diferencia_costo` descending, nulls last. Each group, prepacks included, keeps at most `limite` rows and reports `total` rows before the limit and whether it was cut.
- Totals over every ingredient and manufacture row, before the filter and the limit: `faltante_costo` (sum of negative `diferencia_costo`), `sobrante_costo` (sum of positive), `neto`, each rounded to 6 decimals, and `lineas_contadas` (rows with a non-null `real`).
- When no ingredient or manufacture row has a non-null `real` and no prepack row has a non-zero `real`, an `aviso` says that no ingredient or manufacture was counted and the stocktake may not be conducted yet.

### `count_sheet`

- Parameters: `cuenta`, `storage_id`, optional `incluir_ocultos` (default false).
- `storage_id` must exist in `storage.getStorages`.
- Calls `storage.getStorageLeftovers` with `storage_id` and `zero_leftovers=true`.
- Response: `cuenta`, `storage_id`, `almacen`, `total`, `renglones`. Row: `id`, `nombre`, `unidad`, `tipo` (`insumo` or `producto`). No balance, cost or any other stock figure at any level: the sheet is for a blind count.
- Hidden rows left out unless `incluir_ocultos`. Sorted by `nombre`.

### Acceptance

- Every tool reads only (`get` calls only), carries the read-only annotation and goes through the existing account allow-list.
- `list_stocktakes` without `storage_id` merges all storages, and the zero and empty date, backdating, status, kopeck conversion, filter and sort rules hold, including same-day ordering by time and stocktakes without `fin`; an unknown `storage_id` fails before any stocktake call.
- `stocktake_result` fails on a reply without any group, normalizes object and array groups, maps `''` to null, filters, sorts, limits (default 200, prepacks included) and totals as above, and gives the notice only when nothing was counted.
- `count_sheet` output has exactly the keys above at the top and in each row, and the hidden rule holds.

## Unit 2: `create_write_off`

A write tool in `src/tools/escritura.ts` built like `create_supply`, running only through `ejecutar` (dry-run by default, `confirm: true` sends once, read-back, audit).

- Parameters: `cuenta`, `confirm`, `permitir_otra_cuenta`, `storage_id`, optional `fecha` (`YYYY-MM-DD HH:MM:SS` in the configured time zone), optional `razon_id`, `renglones` (at least one) of `id`, `tipo` (`insumo` default, `producto`, `platillo`, `precocinado`, `modificador`), `cantidad` (> 0), optional `comentario`. `storage_id`, `razon_id` and each line `id` are positive integers, in the tool schema and again in the handler.
- Checks before any Poster call; each failure is an error:
  - `storage_id`, `razon_id` (when given) and each line `id` are positive integers;
  - `cantidad` is a finite number above zero;
  - a `modificador` line is refused, because the server has no lookup that confirms a modifier exists;
  - two lines with the same `tipo` (default `insumo`) and `id` are refused, with a message to put the quantities in one line;
  - an explicit `fecha` is a real calendar date and clock time: month 1-12, a day that exists in that month (29 February only in leap years, by the Gregorian rule), hour 0-23, minute and second 0-59;
  - now is read once per call. Without `fecha`, the date is local now in the configured time zone and no future check runs. With `fecha`, it is refused when it is later than the local time of now plus 60 seconds, compared as `YYYY-MM-DD HH:MM:SS` text from that same instant.
- Checks against the catalogs, still before sending; a catalog row matches only when its own id is a positive integer (a number, or a string of digits):
  - the storage exists in `storage.getStorages` and is not deleted;
  - `razon_id`, when given, exists in `storage.getWasteReasons`; the error lists the reasons as `id=name`;
  - each line's item exists: ingredients in `menu.getIngredients`, products and dishes in `menu.getProducts`, semi-finished products in `menu.getPrepacks`;
  - a `platillo` line needs a catalog row of type 2; a `producto` line whose catalog row is type 2 is refused with a message to use `tipo: "platillo"`; catalog types 1 and 3 are accepted as `producto`.
- Duplicate notice: `storage.getWastes` for that day; write-offs on the same storage that are not deleted are listed in an `aviso` with their ids and times. The time is taken only from a `date` of the form `YYYY-MM-DD HH:MM:SS`; any other value is listed as `sin hora`. On a confirmed call whose read-back ran, the verification `detalle` carries the same write-offs as `mermas_mismo_dia` (`waste_id`, `hora`).
- Payload, JSON (not multipart): `write_off` `{storage_id, date, reason_id?}` plus the same `storage_id`, `date`, `reason_id?` flat, and `ingredient` as `[{id, type, weight, reason?}]` with `type` 1 product, 2 dish, 3 semi-finished, 4 ingredient, 5 modifier. `reason` is the line's `comentario` trimmed, sent only when it is not blank. No `sum`: Poster computes the cost.
- Dry-run shows the storage name, date, reason (`id · name` or none) and lines (name, type, quantity, unit, trimmed comment), with notices that Poster computes the cost and that the contract follows Poster's docs and is not yet confirmed on a live account.
- Read-back with `storage.getWaste` and the returned id:
  - the id in the write reply (`response`) must be a positive integer (a number or a string of digits); otherwise the verification fails with `Póster no devolvió el id de la merma; no se puede verificar`, nothing is read back, and the result reads as applied, not verified, with the notice not to repeat it;
  - `waste_id` of the reply, when present, must equal the returned id; when absent it is listed as not exposed;
  - storage and reason (when one was sent) compared with what was sent; the day of `date` compared with the day sent, the time not compared. A `date` that does not start with `YYYY-MM-DD` fails with `fecha con formato no reconocido`;
  - each line reads, among the elements no other line used, those whose `type` is the line's read type (producto 1, platillo 2, precocinado 3, insumo 10) first, then those without `type`, which are matched by id alone. An ingredient line reads the rows of the element's `ingredients[]` by `ingredient_id`, quantity `weight`, so an ingredient inside a dish's recipe is not counted as an ingredient line; a product, dish or semi-finished product line reads the element by `product_id`, quantity `count`. Each element is used by at most one line. Ids are read as positive integers only;
  - quantities are never added up: when the element a line reads holds more than one row with the line's id, the line fails with `renglón <id> (<tipo>) aparece <n> veces en la merma` and its quantity is not compared;
  - a quantity equal to what was sent within 0.0005 matches, a difference of exactly 0.0005 included (compared with a margin of 1e-9 for floating-point error);
  - a quantity the reply does not carry is listed as not exposed (`renglón <id>: weight` or `count`); a quantity that is present but not a finite number is a failure;
  - a candidate row without an id is listed as not exposed (`renglón sin id`) and stands for at most one line, which then does not count as missing; a line is missing only when every candidate row exposes an id and none matches;
  - the number of elements compared with the number of lines;
  - any other field that the reply does not carry is listed as not exposed and does not by itself make the check fail; a reply with nothing comparable fails;
  - `cantidades_verificadas` is the number of lines whose quantity was compared; when it is 0 and lines were sent, `nota` says `No se pudo comparar ninguna cantidad: revisa la merma en Póster.` and `ok` is still decided by the failures alone;
  - a quantity mismatch notes that Poster may read `weight` in another unit;
  - `costo_total_leido` is `total_sum` / 100 (kopecks to currency units); a zero cost keeps `ok` as the failures decide and adds `alerta_costo`; a `total_sum` that is absent or not a number is listed as not exposed.
- Audit as the other writes, tool `create_write_off`, method `storage.createWriteOff`; a confirmed write-off whose read-back does not match is still audited as applied.

### Acceptance

- Dry-run sends nothing; `confirm: true` sends exactly one `storage.createWriteOff` with the payload above, byte for byte in keys and types.
- Each check fails before sending, with the stated message content; the id, quantity, modifier, repeated-line and date checks fail before any Poster call. The future limit accepts 59 seconds ahead and refuses 61.
- The duplicate notice (preview and confirmed), the read-back match, type matching, a repeated read-back row, mismatch at the tolerance boundary in both directions, not-exposed, malformed, missing id, unusable write reply, `waste_id`, zero-cost and no-quantity cases each have a test.
- The write is refused for an account outside the write set without `permitir_otra_cuenta`, and applied with it on a confirmed call, like every write.

## Shared

- Tool count goes from 31 to 35; tests that pin the list and both READMEs' tool lists are updated.
- Both READMEs get a short stocktake section: Poster's API cannot create or conduct a stocktake; staff conduct it in Poster; the server lists stocktakes, shows discrepancies and prints a count sheet; a shortage can be recorded with `create_write_off`, which Poster shows as a write-off, not as a stocktake.
- No version bump in these units.

## Limitations

- Write requests, `storage.createWriteOff` included, follow HTTP redirects, like every write tool of this server.
- Poster does not document the sign of `diffcurrency` and `difference`. `faltante_costo` and `sobrante_costo` assume a negative value is a shortage; this is not confirmed on a live account.
- A local `fecha` that does not exist or is ambiguous in the configured time zone (a daylight-saving change) is not detected; it is sent as given.
- `count_sheet` accepts a deleted storage and does not leave out deleted ingredients.
- When `storage.getWastes` fails, `create_write_off` stops before sending: the write needs the duplicate check.
- The read-back pairs each ingredient line with its own type-10 element. The docs do not show whether Poster groups several ingredients in one element; if it does, the later ingredient lines read back as missing and the result says the write was applied but did not verify. A write-off with two different ingredient lines on a live account settles this; a single-line write-off reads back the same either way.
- The tests check that the tool hands the write-off to the transport without the multipart option; no test checks the HTTP encoding the transport then uses for `storage.createWriteOff`. No test checks that both READMEs keep the stocktake section.

## Exclusions

- Creating, filling or conducting a Poster stocktake.
- A tool that turns counts into write-offs and supplies in one step.
- Sending a cost per unit with a write-off.
- Renaming money keys of existing tools.
