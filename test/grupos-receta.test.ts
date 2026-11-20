// update_dish_recipe and the dish's modifier groups (Y8). Poster's menu.updateDish keeps a group or an option only
// when the request carries its dish_modification_group_id / dish_modification_id and removes everything the request
// does not carry; the fake below follows that contract. Omitted grupos keeps every current group and option with its
// id, as hide_dish does; passed grupos replace the set, keeping the ids of what matches.
// Spec: specs/2026-11-20-recipe-method-flags.md. All names and ids below are made up.
import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import * as W from "../src/tools/escritura.js";
import type { PosterApi } from "../src/poster.js";

type Obj = Record<string, any>;

const METHODS = ["clear", "cook", "fry", "stew", "bake"] as const;

const ingredients = [
  { ingredient_id: "531", ingredient_name: "Test cheese F", ingredient_unit: "kg" },
  { ingredient_id: "532", ingredient_name: "Test herb G", ingredient_unit: "kg" },
  { ingredient_id: "533", ingredient_name: "Test sauce H", ingredient_unit: "l" },
];

/** Dish as menu.getProduct reads it: two modifier groups, one recipe line. */
const wrap = (): Obj => ({
  product_id: "8101", product_name: "Sample wrap", menu_category_id: "41", workshop: "2", type: "2", color: "red", weight_flag: "0", out: 0,
  price: { "1": "9000" }, spots: [{ spot_id: "1", price: "9000", visible: "1" }],
  group_modifications: [
    { dish_modification_group_id: 4101, name: "Sample sauces", num_min: 0, num_max: 2, type: 1, modifications: [
      { dish_modification_id: 6101, name: "Extra cheese", ingredient_id: 531, type: 10, brutto: 20, price: 15, sort_order: 0 },
      { dish_modification_id: 6102, name: "Herb mix", ingredient_id: 532, type: 10, brutto: 5, price: 0, sort_order: 1 },
    ] },
    { dish_modification_group_id: 4102, name: "Sample dips", num_min: 0, num_max: 1, type: 1, modifications: [
      { dish_modification_id: 6103, name: "Dip cup", ingredient_id: 534, type: 3, brutto: 30, price: 10, sort_order: 0 },
    ] },
  ],
  ingredients: [
    { ingredient_id: "533", structure_type: "1", structure_brutto: 50, structure_netto: 50, structure_lock: "1",
      pr_in_clear: "0", pr_in_cook: "0", pr_in_fry: "0", pr_in_stew: "0", pr_in_bake: "0" },
  ],
});

const initial = () => ({
  "menu.getIngredients": ingredients,
  "menu.getPrepacks": [{ product_id: "534", product_name: "Sample dip base", unit: "kg", out: 100, ingredients: [] }],
  "menu.getCategories": [{ category_id: "41", category_name: "Sample wraps", parent_category: "0" }],
  "menu.getProducts": [wrap()],
});

const readBack = (l: Obj): Obj => ({
  ingredient_id: String(l.id),
  structure_type: String(l.type),
  structure_brutto: l.brutto,
  structure_netto: l.netto,
  structure_lock: String(l.lock),
  ...Object.fromEntries(METHODS.map((k) => [`pr_in_${k}`, String(l[k] ?? 0)])),
});

/**
 * Fake API following the menu.updateDish contract for modifier groups: a sent group or option with a current id keeps
 * it, one without an id is created under a new id, and a current group or option not sent is removed. With
 * `reassign`, Poster recreates every group and option under new ids even when the ids were sent.
 */
function fakeApi(opts: { reassign?: boolean } = {}) {
  const db = structuredClone(initial()) as Obj;
  let nextGroup = 4201;
  let nextOption = 6201;
  const post = vi.fn(async (_account: string, method: string, body: Obj) => {
    if (method !== "menu.updateDish") return { error: 1 };
    const p = db["menu.getProducts"].find((x: Obj) => Number(x.product_id) === body.dish_id);
    const current: Obj[] = p.group_modifications;
    p.product_name = body.product_name;
    p.spots = Object.entries(body.visible).map(([spot_id, v]) => ({ spot_id, visible: String(v) }));
    p.ingredients = (body.ingredient ?? []).map(readBack);
    p.group_modifications = (body.modificationgroup ?? []).map((g: Obj) => {
      const kept = !opts.reassign && current.find((x) => x.dish_modification_group_id === g.dish_modification_group_id);
      const options: Obj[] = kept ? kept.modifications : [];
      return {
        dish_modification_group_id: kept ? kept.dish_modification_group_id : nextGroup++,
        name: g.name, num_min: g.minNum, num_max: g.maxNum, type: g.type,
        modifications: g.modifications.map((m: Obj, j: number) => {
          const keptOption = options.find((o) => o.dish_modification_id === m.dish_modification_id);
          return {
            dish_modification_id: keptOption ? keptOption.dish_modification_id : nextOption++,
            name: m.name, ingredient_id: m.ingredientId, type: m.type, brutto: m.brutto, price: m.price / 100, sort_order: j,
          };
        }),
      };
    });
    return { response: true };
  });
  const api: PosterApi = {
    get: async (_account, method, params) => {
      if (method === "menu.getProduct") return structuredClone(db["menu.getProducts"].find((x: Obj) => Number(x.product_id) === Number(params?.product_id))) as never;
      return structuredClone(db[method]) as never;
    },
    post: post as never,
  };
  return { api, post, db };
}
const ctx = (api: PosterApi) => ({ api, actor: "test" });
const RECIPE = [{ ingredient_id: 533, brutto: 60 }];
const groupsOf = (r: Obj): Obj[] => r.payload.modificationgroup;
/** Group and option ids a dish reads with, in order. */
const idsOf = (p: Obj) => p.group_modifications.map((g: Obj) => [g.dish_modification_group_id, g.modifications.map((m: Obj) => m.dish_modification_id)]);

const KEPT_ALL = {
  kept_groups: [{ name: "Sample sauces", id: 4101 }, { name: "Sample dips", id: 4102 }],
  created_groups: [],
  removed_groups: [],
  kept_options: [
    { group: "Sample sauces", name: "Extra cheese", id: 6101 },
    { group: "Sample sauces", name: "Herb mix", id: 6102 },
    { group: "Sample dips", name: "Dip cup", id: 6103 },
  ],
  created_options: [],
  removed_options: [],
};

describe("Y8 update_dish_recipe without grupos keeps the modifier groups", () => {
  it("Y8 omitted grupos sends every current group and option with its ids, exactly as hide_dish does, and the dry-run lists them as kept", async () => {
    const { api, post } = fakeApi();
    const r: any = await W.actualizarRecetaPlatillo(ctx(api), { cuenta: "cafe-04", product_id: 8101, receta: RECIPE });
    expect(r.modo).toBe("dry-run");
    expect(post).not.toHaveBeenCalled();
    expect(groupsOf(r).map((g) => [g.dish_modification_group_id, g.modifications.map((m: Obj) => m.dish_modification_id)])).toEqual([[4101, [6101, 6102]], [4102, [6103]]]);
    const hidden: any = await W.ocultarPlatillo(ctx(api), { cuenta: "cafe-04", product_id: 8101 });
    expect(groupsOf(r)).toStrictEqual(groupsOf(hidden));
    expect(r.modifier_groups).toEqual(KEPT_ALL);
    expect(r.avisos.join("\n")).toMatch(/grupos was not passed, so the current modifier groups and options are sent with their ids and kept/);
  });

  it("Y8 omitted grupos applied: Poster keeps every group and option id, the check passes and reports no changed ids", async () => {
    const { api, post, db } = fakeApi();
    const r: any = await W.actualizarRecetaPlatillo(ctx(api), { cuenta: "cafe-04", product_id: 8101, receta: RECIPE, confirm: true });
    expect(post).toHaveBeenCalledTimes(1);
    expect(r.modo).toBe("aplicado");
    expect(idsOf(db["menu.getProducts"][0])).toEqual([[4101, [6101, 6102]], [4102, [6103]]]);
    expect(r.verificacion.ok).toBe(true);
    expect(r.verificacion.detalle).not.toHaveProperty("group_ids_changed");
    expect(r.modifier_groups).toEqual(KEPT_ALL);
  });

  it("Y8 a kept id that is not read back (Poster recreated the group) is reported under group_ids_changed", async () => {
    const { api } = fakeApi({ reassign: true });
    const r: any = await W.actualizarRecetaPlatillo(ctx(api), { cuenta: "cafe-04", product_id: 8101, receta: RECIPE, confirm: true });
    expect(r.modo).toBe("aplicado");
    expect(r.verificacion.detalle.group_ids_changed).toEqual({
      groups: [{ name: "Sample sauces", id: 4101 }, { name: "Sample dips", id: 4102 }],
      options: KEPT_ALL.kept_options,
    });
  });

  it("Y8 the update_dish_recipe tool schema does not require grupos and its description says omitting it keeps the groups", async () => {
    const auditDir = mkdtempSync(path.join(os.tmpdir(), "poster-mcp-grupos-"));
    try {
      for (const k of ["POSTER_ACCOUNTS", "DEFAULT_WRITE_ACCOUNT", "WRITE_DEFAULT_ACCOUNTS", "TIMEZONE", "AUDIT_DIR"]) vi.stubEnv(k, undefined);
      for (const [k, v] of Object.entries({ POSTER_ACCOUNTS: "cafe-04", DEFAULT_WRITE_ACCOUNT: "cafe-04", WRITE_DEFAULT_ACCOUNTS: "cafe-04", AUDIT_DIR: auditDir })) vi.stubEnv(k, v);
      vi.spyOn(console, "log").mockImplementation(() => {});
      vi.resetModules();
      const { crearServidorMcp } = await import("../src/mcp.js");
      const { api, post } = fakeApi();
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      await crearServidorMcp(api).connect(serverSide);
      const client = new Client({ name: "test", version: "0.0.0" });
      await client.connect(clientSide);
      const tool = (await client.listTools()).tools.find((t) => t.name === "update_dish_recipe")!;
      expect(tool.inputSchema.properties).toHaveProperty("grupos");
      expect(tool.inputSchema.required ?? []).not.toContain("grupos");
      expect(tool.description).toMatch(/omit grupos to keep/i);
      const call = await client.callTool({ name: "update_dish_recipe", arguments: { cuenta: "cafe-04", product_id: 8101, receta: RECIPE } });
      expect(call.isError).not.toBe(true);
      expect(JSON.parse((call.content as Array<{ text: string }>)[0].text)).toMatchObject({ modo: "dry-run", modifier_groups: KEPT_ALL });
      expect(post).not.toHaveBeenCalled();
    } finally {
      rmSync(auditDir, { recursive: true, force: true });
    }
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("Y8 update_dish_recipe with grupos replaces the set and keeps the ids of what matches", () => {
  const GRUPOS = [
    { nombre: " sample SAUCES ", min: 0, max: 2, opciones: [
      { ingredient_id: 531, nombre: "Extra cheese", brutto: 25, precio: 15 },
      { ingredient_id: 533, nombre: "Hot sauce", brutto: 10, precio: 5 },
    ] },
    { nombre: "Sample toppings", min: 0, max: 3, opciones: [{ ingredient_id: 532, nombre: "Herb mix", brutto: 5, precio: 0 }] },
  ];

  it("Y8 a same-name group (trimmed, case-folded) keeps its group id, a same item and option type keeps its option id, the rest is created or removed", async () => {
    const { api } = fakeApi();
    const r: any = await W.actualizarRecetaPlatillo(ctx(api), { cuenta: "cafe-04", product_id: 8101, receta: RECIPE, grupos: GRUPOS });
    expect(r.modo).toBe("dry-run");
    const [sauces, toppings] = groupsOf(r);
    expect(sauces.dish_modification_group_id).toBe(4101);
    expect(sauces.modifications[0]).toMatchObject({ dish_modification_id: 6101, ingredientId: 531, type: 10, brutto: 25 });
    expect(sauces.modifications[1]).not.toHaveProperty("dish_modification_id");
    // Herb mix was in "Sample sauces"; passed under another group it is a new option there, not the old one.
    expect(toppings).not.toHaveProperty("dish_modification_group_id");
    expect(toppings.modifications[0]).not.toHaveProperty("dish_modification_id");
    expect(r.modifier_groups).toEqual({
      kept_groups: [{ name: "sample SAUCES", id: 4101 }],
      created_groups: [{ name: "Sample toppings" }],
      removed_groups: [{ name: "Sample dips", id: 4102 }],
      kept_options: [{ group: "sample SAUCES", name: "Extra cheese", id: 6101 }],
      created_options: [{ group: "sample SAUCES", name: "Hot sauce" }, { group: "Sample toppings", name: "Herb mix" }],
      removed_options: [{ group: "Sample sauces", name: "Herb mix", id: 6102 }, { group: "Sample dips", name: "Dip cup", id: 6103 }],
    });
    expect(r.avisos.join("\n")).toMatch(/current groups and options not passed are removed \(see modifier_groups\)/);
  });

  it("Y8 applied with grupos: the matched ids survive, the check passes, and only the removed group and options are gone", async () => {
    const { api, db } = fakeApi();
    const r: any = await W.actualizarRecetaPlatillo(ctx(api), { cuenta: "cafe-04", product_id: 8101, receta: RECIPE, grupos: GRUPOS, confirm: true });
    expect(r.modo).toBe("aplicado");
    expect(idsOf(db["menu.getProducts"][0])).toEqual([[4101, [6101, 6201]], [4201, [6202]]]);
    expect(r.verificacion.ok).toBe(true);
    expect(r.verificacion.detalle).not.toHaveProperty("group_ids_changed");
  });

  it("Y8 each existing group id and option id is claimed at most once", async () => {
    const { api } = fakeApi();
    const twice = { nombre: "Sample sauces", min: 0, max: 2, opciones: [
      { ingredient_id: 531, nombre: "Extra cheese", brutto: 20, precio: 15 },
      { ingredient_id: 531, nombre: "Double cheese", brutto: 40, precio: 25 },
    ] };
    const r: any = await W.actualizarRecetaPlatillo(ctx(api), { cuenta: "cafe-04", product_id: 8101, receta: RECIPE, grupos: [twice, twice] });
    const [first, second] = groupsOf(r);
    expect(first.dish_modification_group_id).toBe(4101);
    expect(first.modifications.map((m: Obj) => m.dish_modification_id)).toEqual([6101, undefined]);
    expect(second).not.toHaveProperty("dish_modification_group_id");
    expect(second.modifications.map((m: Obj) => m.dish_modification_id)).toEqual([undefined, undefined]);
    expect(r.modifier_groups.kept_groups).toEqual([{ name: "Sample sauces", id: 4101 }]);
    expect(r.modifier_groups.kept_options).toEqual([{ group: "Sample sauces", name: "Extra cheese", id: 6101 }]);
    expect(r.modifier_groups.removed_groups).toEqual([{ name: "Sample dips", id: 4102 }]);
  });

  it("Y8 grupos: [] still removes every group, and the dry-run lists them as removed", async () => {
    const { api, db } = fakeApi();
    const dry: any = await W.actualizarRecetaPlatillo(ctx(api), { cuenta: "cafe-04", product_id: 8101, receta: RECIPE, grupos: [] });
    expect(groupsOf(dry)).toEqual([]);
    expect(dry.modifier_groups).toEqual({
      kept_groups: [], created_groups: [], kept_options: [], created_options: [],
      removed_groups: [{ name: "Sample sauces", id: 4101 }, { name: "Sample dips", id: 4102 }],
      removed_options: KEPT_ALL.kept_options,
    });
    const r: any = await W.actualizarRecetaPlatillo(ctx(api), { cuenta: "cafe-04", product_id: 8101, receta: RECIPE, grupos: [], confirm: true });
    expect(db["menu.getProducts"][0].group_modifications).toEqual([]);
    expect(r.verificacion.ok).toBe(true);
  });
});
