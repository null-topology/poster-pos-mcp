# Keep processing methods when a recipe is rewritten

## Purpose

A recipe line in Poster carries five processing methods (cleaning, boiling, frying, stewing, baking). Each one switches on the ingredient's loss rate for that method, so it decides the line's net weight. Three write tools rewrite recipe lines and send them without these methods. Poster's docs give 0 as the default for an omitted method, so a rewrite may reset the methods; this is not confirmed on a live account. The read-back compares gross weight only, so the tool still reports success.

This change makes every rewrite send back the methods it read, and makes the read-back notice when a method or a manual net weight that it can read did not survive. It also makes `update_dish_recipe` keep the dish's modifier groups and options with their ids: before, every write sent them without ids, so Poster recreated them under new ids.

## Poster contract (from the API docs)

- Write lines (`menu.createPrepack`, `menu.updatePrepack`, `menu.createDish`, `menu.updateDish`) accept `clear`, `cook`, `fry`, `stew`, `bake` (0 or 1, default 0), `lock` (0 manual net, 1 automatic net), `brutto`, `netto`.
- Read lines (`menu.getPrepacks`, `menu.getPrepack`, `menu.getProduct`, `menu.getProducts`) expose `pr_in_clear`, `pr_in_cook`, `pr_in_fry`, `pr_in_stew`, `pr_in_bake` (strings "0" or "1"), plus `structure_lock`, `structure_brutto`, `structure_netto`, `structure_type`.
- Mapping: `pr_in_clear` → `clear`, `pr_in_cook` → `cook`, `pr_in_fry` → `fry`, `pr_in_stew` → `stew`, `pr_in_bake` → `bake`.
- `menu.updateDish` keeps a modifier group only when the request carries its `dish_modification_group_id`, and an option only when the request carries its `dish_modification_id`. A group or option sent without an id is created; every current group or option the request does not carry by id is deleted.
- Poster recalculates the yield from netto (field report, not in the docs): a prepack's `out` may be read back as the result of the lines' net weights, not the value sent. `update_prepack` therefore compares the yield only when the caller passed `rendimiento`. Without `rendimiento` the read-back only reports `rendimiento_leido`.

## Affected tools

- `update_prepack`: always re-sends every line, also for a rename or a yield change.
- `hide_dish`: re-sends the dish recipe and the modifier groups it read.
- `update_dish_recipe`: sends the caller's full recipe; lines the caller keeps lost their methods. It also sent the caller's `grupos` without ids, so every write recreated the modifier groups.
- `update_dish` refuses a dish that has a recipe and is not affected.
- `create_prepack` and `create_dish` cannot set methods today. Adding method inputs is out of scope here.

## Requirements

1. One helper reads the methods of a read line. A `pr_in_*` value of "1" or 1 gives 1, "0" or 0 gives 0. An absent, empty or other value means the method is unknown: the write line leaves that key out, and a read-back that gets it does not compare it.
2. Pairing rule (one rule for carrying values over and for the read-back). Lines pair only within the same element type and id. A line first takes the first free line of that item with the same gross weight (compared exactly, as the gross check compares it), in order; the lines left then take the free lines left in occurrence order. A line with no partner is a new line.
3. `update_prepack` without `receta`, and `hide_dish`: every re-sent line carries the known methods it was read with. Gross, net, lock and unit behave as before.
4. `update_prepack` with `receta`: a caller line takes the known methods of its paired existing line, and the unit and lock of that same line when the caller does not give them. An unpaired caller line gets no methods and the new-line defaults (lock 0, unit g). Net defaults to gross as before.
5. `update_dish_recipe`: a caller line takes the known methods of its paired existing line; an unpaired line gets none. Lock defaults to 1 and net to gross, as before.
6. Read-back of the three tools: each sent line is paired with a read line under the pairing rule. Each method that was sent is compared with the value read back, and, for a line sent with `lock: 0`, the net weight is compared within 0.0005 relative or 0.001 absolute, whichever is larger. Read lines of one item with the same gross weight are compared as a multiset of (methods, net): they are assigned so that as many pairs as possible agree before any difference is reported. A known difference gives `ok: false` and is listed under `method_mismatches` (item, method, sent, read) or `net_mismatches` (item, sent, read; read is null when the read value is missing or not a number).
7. A sent method that is read back as unknown is not a mismatch: it is listed under `methods_unverified` as `{ ingredient, type, methods }` with the English note `methods_unverified_note`, and it does not fail `ok`.
8. When the current recipe read lacks some methods of a line that pairs with a caller or re-sent line, those methods cannot be carried over. The dry-run and the applied result of the three tools list them under `methods_not_carried` as `{ ingredient, type, methods }` with the English note `methods_not_carried_note` saying Poster may reset them.
9. `update_prepack` with `rendimiento`: a yield not kept gives `ok: false` and a `yield_alert`. The alert says the recipe itself was applied and the call must not be repeated only when the gross, method and net checks all pass; otherwise it reports the yield difference only.
10. `hide_dish`: `receta_intacta` is true only when the gross, method and net checks all pass. Methods listed under `methods_unverified` do not make it false.
11. The dry-run diff shows the methods, because they are part of the lines in `antes` and `payload`. In `update_dish_recipe`, each readable recipe line in `antes` and `despues` names the methods that are on (` · methods: …`) and marks a line whose existing methods were not all read (` · methods unknown`, or ` · methods unknown: …` for some of them).
12. When a caller line pairs with an existing manual-net line (`structure_lock` 0) and is sent with a default that may lose the manual net weight, the dry-run carries an English notice naming those items: in `update_prepack` a line without `netto`; in `update_dish_recipe` a line without `lock` or without `netto`. The payload does not change and the call is not refused.
13. `update_dish_recipe` modifier groups:
    - `grupos` is optional. When it is omitted, the current groups and options are sent with their `dish_modification_group_id` and `dish_modification_id`, exactly as `hide_dish` sends them, so they are kept.
    - When it is passed, it replaces the set. A passed group whose name matches a current group (trimmed, case-folded) keeps that group's id; within it, an option with the same ingredient id and option type as a current option keeps that option's id. Each current id is claimed at most once, in order. A group or option left unmatched is sent without an id and is created; the current groups and options not claimed are removed. `grupos: []` removes every group.
    - The dry-run and the applied result list the groups and options kept (with ids), created and removed (with ids) under `modifier_groups`.
    - The read-back compares the groups as before. In addition, when a kept group or option id is not read back, the detail lists it under `group_ids_changed`; this does not fail `ok`.
    - The tool description and both READMEs say: omit `grupos` to keep the current groups; passing `grupos` replaces the set.
14. `create_prepack` and `create_dish` payloads stay as they are.
15. Both READMEs state what recipe rewrites keep and report, that a kept manual-net line passed without lock and netto is sent with the defaults, and that the create tools cannot set methods yet.

## Acceptance

- `update_prepack` rename only: each sent line has the methods read for it; a line with no `pr_in_*` fields has no method keys.
- `update_prepack` with `receta`: a kept item carries its methods; a new item has no method keys; for an item present more than once, each caller line takes methods, unit and lock from the line it pairs with under the pairing rule (same gross weight first); an extra occurrence gets the new-line defaults.
- `hide_dish`: the sent recipe lines carry the methods read.
- `update_dish_recipe`: kept items carry their methods; new items have none.
- For each of the three tools, a read-back where Poster returns a sent method with the other value gives `ok: false` with `method_mismatches`, also for a method sent as 0 and read as 1; a read-back where a `lock: 0` line comes back with another net weight, or with none, gives `ok: false` with `net_mismatches`; values within tolerance, including numeric strings, give `ok: true`.
- A sent method missing from the read-back gives `ok: true` with `methods_unverified` and its note; `hide_dish` keeps `receta_intacta: true` in that case.
- Repeated lines read back in another order with distinct gross weights pass; repeated lines whose gross weights were exchanged are reported; repeated lines with equal gross weights read back in another order pass, and a real difference among them is reported once.
- Every occurrence of a repeated item is checked, not only the first.
- `methods_not_carried` appears in the dry-run and the applied result when the pre-read lacks a method of a paired line, and is absent otherwise.
- `yield_alert` says not to repeat the call only when the recipe checks pass.
- `hide_dish` gives `receta_intacta: false` on a method or net mismatch.
- The manual-net notice appears for a kept lock-0 line sent with defaults, and not when the caller passes lock 0 and netto.
- `update_dish_recipe` without `grupos` sends the same groups as `hide_dish` and keeps every id; with `grupos`, a same-name group and a same-option keep their ids, the rest are created or removed as listed in `modifier_groups`; an id is claimed once; `grupos: []` removes all; a recreated id is listed under `group_ids_changed`.
- `create_prepack` and `create_dish` payloads are byte-identical to before for the same input.
- Each new test fails against the code before this change, except the pins that guard the read-back branches.
- Fixtures use made-up names and ids.

## Limitations

- None of Poster's live behaviour here is verified on an account; the code depends on these points and they are not confirmed: whether an omitted method resets, whether Poster keeps a manual net weight (`lock: 0`) and how lock 0 and 1 treat `netto`, the scale of `structure_netto`, whether `menu.getProducts` (the fallback read) carries `pr_in_*`, the order in which lines are read back, and how the yield is recalculated. A missing `pr_in_*` field surfaces as `methods_not_carried` or `methods_unverified`, not as a difference.
- Defaults for new lines are unchanged in this unit: an unpaired `update_prepack` caller line gets lock 0 and unit g, and an `update_dish_recipe` line gets lock 1 and net equal to gross. Carrying lock and netto over from a paired manual-net line moves to the next unit, gated on a live lock-0 probe; until then the notice of requirement 12 warns about it.
- The pairing rule compares gross weights exactly, on the raw `structure_brutto` read, the same value the gross check uses. If Poster reads a gross weight in another unit or rounded (prepack lines are noted as read in kg/l and written in g/ml), pass one finds no equal gross weight: carry-over and the read-back then pair by occurrence order, as before this change, and the read-back gross check reports the difference as it did before.
- Option matching compares the option `type` read back with the code written (10 ingredient, 3 prepack, 2 dish). For an ingredient option a read `type` of 1 or 10 both count as an ingredient, since the docs give 1 for an ingredient option and this server writes 10; prepack and dish options need the same code. If a live read gives yet another code, matching options are created instead of kept and the dry-run lists them as created. Not verified live.
- Kept groups under a passed `grupos` are sent in the shape the create path builds (name, type, min and max, options with ingredient, type, name, brutto, price) plus their ids, not the fuller shape `hide_dish` rebuilds from the read. Whether Poster keeps fields that shape leaves out (for example sort order) is not verified.
- Group names are matched after trim and case folding only; names that differ in accents do not match.
- `group_ids_changed` is a report and does not fail `ok`.
- Methods and loss rates cannot be set through the create tools or on ingredients yet.
