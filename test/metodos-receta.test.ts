// Processing methods (clear, cook, fry, stew, bake) of recipe lines: the rewrite tools send back the methods
// they read, and their read-back reports a method or a manual net weight that did not survive.
// Spec: specs/2026-11-20-recipe-method-flags.md. All names and ids below are made up.
import { describe, it, expect, vi } from "vitest";
import * as W from "../src/tools/escritura.js";
import type { PosterApi } from "../src/poster.js";

type Obj = Record<string, any>;

const METHODS = ["clear", "cook", "fry", "stew", "bake"] as const;

const ingredients = [
  { ingredient_id: "501", ingredient_name: "Test root A", ingredient_unit: "kg" },
  { ingredient_id: "502", ingredient_name: "Test leaf B", ingredient_unit: "kg" },
  { ingredient_id: "503", ingredient_name: "Test grain C", ingredient_unit: "kg" },
  { ingredient_id: "504", ingredient_name: "Test oil D", ingredient_unit: "l" },
  { ingredient_id: "505", ingredient_name: "Test spice E", ingredient_unit: "kg" },
];

// Prepack lines as menu.getPrepacks reads them. The pr_in_* values mix every shape the helper must handle:
// "1", 1, "0", 0 are known; "", "yes", 2, null and an absent field are unknown.
const prepackLines = (): Obj[] => [
  { ingredient_id: "501", structure_type: "1", structure_unit: "g", structure_brutto: 200, structure_netto: 170, structure_lock: "1",
    pr_in_clear: "1", pr_in_cook: 0, pr_in_fry: "0", pr_in_stew: 1, pr_in_bake: "" },
  { ingredient_id: "502", structure_type: "1", structure_unit: "g", structure_brutto: 100, structure_netto: 100, structure_lock: "0" },
  { ingredient_id: "503", structure_type: "1", structure_unit: "g", structure_brutto: 50, structure_netto: 40, structure_lock: "1",
    pr_in_clear: "0", pr_in_cook: "1", pr_in_fry: "yes", pr_in_stew: 2, pr_in_bake: "0" },
  { ingredient_id: "503", structure_type: "1", structure_unit: "g", structure_brutto: 30, structure_netto: 30, structure_lock: "1",
    pr_in_clear: "1", pr_in_cook: "0", pr_in_fry: "1", pr_in_stew: "0", pr_in_bake: "0" },
  { ingredient_id: "504", structure_type: "2", structure_unit: "g", structure_brutto: 25, structure_netto: 25, structure_lock: "1",
    pr_in_clear: "0", pr_in_cook: "0", pr_in_fry: "1", pr_in_stew: "0", pr_in_bake: null },
];
// Prepack with repeated items, every method known: 505 twice with distinct gross weights and different lock, unit
// and methods; 503 twice with the same gross weight, different lock, net and methods.
const duoLines = (): Obj[] => [
  { ingredient_id: "505", structure_type: "1", structure_unit: "g", structure_brutto: 40, structure_netto: 40, structure_lock: "1",
    pr_in_clear: "1", pr_in_cook: "0", pr_in_fry: "0", pr_in_stew: "0", pr_in_bake: "0" },
  { ingredient_id: "505", structure_type: "1", structure_unit: "ml", structure_brutto: 25, structure_netto: 20, structure_lock: "0",
    pr_in_clear: "0", pr_in_cook: "0", pr_in_fry: "1", pr_in_stew: "0", pr_in_bake: "0" },
  { ingredient_id: "503", structure_type: "1", structure_unit: "g", structure_brutto: 12, structure_netto: 12, structure_lock: "1",
    pr_in_clear: "1", pr_in_cook: "0", pr_in_fry: "0", pr_in_stew: "0", pr_in_bake: "0" },
  { ingredient_id: "503", structure_type: "1", structure_unit: "g", structure_brutto: 12, structure_netto: 9, structure_lock: "0",
    pr_in_clear: "0", pr_in_cook: "1", pr_in_fry: "0", pr_in_stew: "0", pr_in_bake: "0" },
];
const prepacks = () => [
  { product_id: "7001", product_name: "Sample base mix", unit: "kg", out: 365, ingredients: prepackLines() },
  { product_id: "504", product_name: "Sample sauce", unit: "kg", out: 100, ingredients: [] },
  { product_id: "7002", product_name: "Sample duo mix", unit: "kg", out: 81, ingredients: duoLines() },
];

// Dish as menu.getProduct reads it: one manual-net line (lock 0) with methods, one line without pr_in_* fields,
// and a prepack line (type 2) whose id is also an ingredient id.
const dish = (): Obj => ({
  product_id: "8001", product_name: "Sample bowl", menu_category_id: "40", workshop: "2", type: "2", color: "green", weight_flag: "0", out: 0,
  price: { "1": "12000" }, spots: [{ spot_id: "1", price: "12000", visible: "1" }], group_modifications: [],
  ingredients: [
    { ingredient_id: "501", structure_type: "1", structure_brutto: 60, structure_netto: 45, structure_lock: "0",
      pr_in_clear: "1", pr_in_cook: "0", pr_in_fry: "1", pr_in_stew: "0", pr_in_bake: "0" },
    { ingredient_id: "502", structure_type: "1", structure_brutto: 20, structure_netto: 20, structure_lock: "1" },
    { ingredient_id: "504", structure_type: "2", structure_brutto: 15, structure_netto: 15, structure_lock: "1",
      pr_in_clear: 0, pr_in_cook: 1, pr_in_fry: "0", pr_in_stew: "", pr_in_bake: "0" },
  ],
});

const initial = () => ({
  "menu.getIngredients": ingredients,
  "menu.getPrepacks": prepacks(),
  "menu.getCategories": [{ category_id: "40", category_name: "Sample bowls", parent_category: "0" }],
  "menu.getProducts": [dish()],
});

/**
 * A recipe line as this fake reads it back after a write: an omitted method reads as "0" here. What Poster does with
 * an omitted method is not known; a test that needs an unknown read deletes the pr_in_* field in `tamper`.
 */
const readBack = (l: Obj): Obj => ({
  ingredient_id: String(l.id),
  structure_type: String(l.type),
  structure_brutto: l.brutto,
  structure_netto: l.netto,
  structure_lock: String(l.lock),
  ...(l.unit !== undefined && { structure_unit: l.unit }),
  ...Object.fromEntries(METHODS.map((k) => [`pr_in_${k}`, String(l[k] ?? 0)])),
});

interface FakeOptions {
  /** Changes the lines read back after a write, to stand for what Poster kept. */
  tamper?: (lines: Obj[]) => void;
  /** Yield read back after menu.updatePrepack; by default the one sent. */
  yieldRead?: (body: Obj) => number;
}

/** Fake API with state: a write changes what later reads return. */
function fakeApi(opts: FakeOptions = {}) {
  const db = structuredClone(initial()) as Obj;
  const post = vi.fn(async (_account: string, method: string, body: Obj) => {
    if (method === "menu.updatePrepack") {
      const p = db["menu.getPrepacks"].find((x: Obj) => Number(x.product_id) === body.prepack_id);
      p.product_name = body.product_name;
      p.out = opts.yieldRead ? opts.yieldRead(body) : body.out;
      p.ingredients = body.ingredient.map(readBack);
      opts.tamper?.(p.ingredients);
      return { response: true };
    }
    if (method === "menu.updateDish") {
      const p = db["menu.getProducts"].find((x: Obj) => Number(x.product_id) === body.dish_id);
      p.product_name = body.product_name;
      p.spots = Object.entries(body.visible).map(([spot_id, v]) => ({ spot_id, visible: String(v) }));
      p.ingredients = (body.ingredient ?? []).map(readBack);
      opts.tamper?.(p.ingredients);
      return { response: true };
    }
    return { error: 1 };
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
/** The read line of an item (element type and id) after a write. */
const lineOf = (lines: Obj[], id: string, type = "1") => lines.find((l) => l.ingredient_id === id && l.structure_type === type)!;
/** Recipe lines of the body posted by the only write call. */
const sentLines = (post: ReturnType<typeof fakeApi>["post"]) => (post.mock.calls[0][2] as Obj).ingredient as Obj[];

describe("update_prepack keeps processing methods", () => {
  it("rename only: every re-sent line carries the methods read for it, and a line without pr_in_* fields has none", async () => {
    const { api, post } = fakeApi();
    const r: any = await W.actualizarPrecocinado(ctx(api), { cuenta: "cafe-04", product_id: 7001, nombre: "Sample base mix v2" });
    expect(r.modo).toBe("dry-run");
    expect(post).not.toHaveBeenCalled();
    expect(r.payload.ingredient).toStrictEqual([
      { id: 501, type: 1, brutto: 200, netto: 170, lock: 1, unit: "g", clear: 1, cook: 0, fry: 0, stew: 1 },
      { id: 502, type: 1, brutto: 100, netto: 100, lock: 0, unit: "g" },
      { id: 503, type: 1, brutto: 50, netto: 40, lock: 1, unit: "g", clear: 0, cook: 1, bake: 0 },
      { id: 503, type: 1, brutto: 30, netto: 30, lock: 1, unit: "g", clear: 1, cook: 0, fry: 1, stew: 0, bake: 0 },
      { id: 504, type: 2, brutto: 25, netto: 25, lock: 1, unit: "g", clear: 0, cook: 0, fry: 1, stew: 0 },
    ]);
    // The methods are in the lines of both sides of the diff, so an unchanged recipe adds no change.
    expect(r.cambios).toEqual([{ campo: "product_name", antes: "Sample base mix", despues: "Sample base mix v2" }]);
  });

  it("with receta: a kept item carries its methods, a new item has none, a repeated item pairs by occurrence when no gross weight matches, and an extra occurrence takes the new-line defaults", async () => {
    const { api } = fakeApi();
    const r: any = await W.actualizarPrecocinado(ctx(api), {
      cuenta: "cafe-04", product_id: 7001,
      receta: [
        { ingredient_id: 503, brutto: 60 },
        { ingredient_id: 501, brutto: 210, netto: 180 },
        { ingredient_id: 505, brutto: 10 },
        { ingredient_id: 503, brutto: 35 },
        { ingredient_id: 503, brutto: 5 },
        { ingredient_id: 504, tipo: 1, brutto: 15 },
        { ingredient_id: 504, tipo: 2, brutto: 20 },
      ],
    });
    expect(r.modo).toBe("dry-run");
    expect(r.payload.ingredient).toStrictEqual([
      { id: 503, type: 1, brutto: 60, netto: 60, lock: 1, unit: "g", clear: 0, cook: 1, bake: 0 },
      { id: 501, type: 1, brutto: 210, netto: 180, lock: 1, unit: "g", clear: 1, cook: 0, fry: 0, stew: 1 },
      { id: 505, type: 1, brutto: 10, netto: 10, lock: 0, unit: "g" },
      { id: 503, type: 1, brutto: 35, netto: 35, lock: 1, unit: "g", clear: 1, cook: 0, fry: 1, stew: 0, bake: 0 },
      // A third 503 has no existing line to pair with, so it takes no lock or unit from another line (Y4).
      { id: 503, type: 1, brutto: 5, netto: 5, lock: 0, unit: "g" },
      { id: 504, type: 1, brutto: 15, netto: 15, lock: 0, unit: "g" },
      { id: 504, type: 2, brutto: 20, netto: 20, lock: 1, unit: "g", clear: 0, cook: 0, fry: 1, stew: 0 },
    ]);
    // The dry-run diff shows the methods: the first line was 501 and is now the first 503.
    expect(r.cambios).toContainEqual({ campo: "ingredient.0.cook", antes: 0, despues: 1 });
    expect(r.cambios).toContainEqual({ campo: "ingredient.0.stew", antes: 1, despues: undefined });
  });

  it("a read-back that returns a sent method as 0 gives ok false with method_mismatches", async () => {
    const { api } = fakeApi({ tamper: (ls) => { lineOf(ls, "501").pr_in_stew = "0"; } });
    const r: any = await W.actualizarPrecocinado(ctx(api), { cuenta: "cafe-04", product_id: 7001, nombre: "Sample base mix v2", confirm: true });
    expect(r.modo).toBe("aplicado");
    expect(r.verificacion.ok).toBe(false);
    expect(r.verificacion.detalle.method_mismatches).toEqual([{ item: "1_501", method: "stew", sent: 1, read: 0 }]);
    expect(r.verificacion.detalle).not.toHaveProperty("net_mismatches");
  });

  it("a lock 0 line read back with another net weight gives ok false with net_mismatches; a lock 1 line is not compared", async () => {
    const { api } = fakeApi({
      tamper: (ls) => {
        lineOf(ls, "502").structure_netto = 100;
        lineOf(ls, "501").structure_netto = 150;
      },
    });
    const r: any = await W.actualizarPrecocinado(ctx(api), {
      cuenta: "cafe-04", product_id: 7001, confirm: true,
      receta: [{ ingredient_id: 501, brutto: 200, netto: 170 }, { ingredient_id: 502, brutto: 100, netto: 80, lock: 0 }],
    });
    expect(r.modo).toBe("aplicado");
    expect(r.verificacion.ok).toBe(false);
    expect(r.verificacion.detalle.net_mismatches).toEqual([{ item: "1_502", sent: 80, read: 100 }]);
    expect(r.verificacion.detalle).not.toHaveProperty("method_mismatches");
  });

  it("methods read back as sent and nets within 0.0005 relative or 0.001 absolute give ok true; a net just outside does not", async () => {
    const receta = [{ ingredient_id: 501, brutto: 2000, netto: 1800, lock: 0 }, { ingredient_id: 502, brutto: 0.5, netto: 0.4, lock: 0 }];
    const within = fakeApi({
      tamper: (ls) => {
        lineOf(ls, "501").structure_netto = 1800.8; // relative tolerance 0.9
        lineOf(ls, "502").structure_netto = 0.4009; // absolute tolerance 0.001
      },
    });
    const r: any = await W.actualizarPrecocinado(ctx(within.api), { cuenta: "cafe-04", product_id: 7001, receta, confirm: true });
    expect(sentLines(within.post)[0]).toMatchObject({ id: 501, clear: 1, cook: 0, fry: 0, stew: 1 });
    expect(r.verificacion.ok).toBe(true);
    expect(r.verificacion.detalle).not.toHaveProperty("method_mismatches");
    expect(r.verificacion.detalle).not.toHaveProperty("net_mismatches");

    const outside = fakeApi({ tamper: (ls) => { lineOf(ls, "502").structure_netto = 0.4015; } });
    const r2: any = await W.actualizarPrecocinado(ctx(outside.api), { cuenta: "cafe-04", product_id: 7001, receta, confirm: true });
    expect(r2.verificacion.ok).toBe(false);
    expect(r2.verificacion.detalle.net_mismatches).toEqual([{ item: "1_502", sent: 0.4, read: 0.4015 }]);
  });
});

describe("update_prepack yield read-back (Poster recalculates the yield from netto)", () => {
  const sumNetto = (body: Obj) => body.ingredient.reduce((s: number, l: Obj) => s + l.netto, 0);

  it("without rendimiento the read-back does not compare the yield and reports the one read", async () => {
    const { api } = fakeApi({ yieldRead: sumNetto });
    const r: any = await W.actualizarPrecocinado(ctx(api), {
      cuenta: "cafe-04", product_id: 7001, confirm: true,
      receta: [{ ingredient_id: 501, brutto: 200, netto: 150, lock: 0 }, { ingredient_id: 502, brutto: 100 }],
    });
    expect(r.modo).toBe("aplicado");
    expect(r.verificacion.ok).toBe(true);
    expect(r.verificacion.detalle.rendimiento_leido).toBe(250);
    expect(r.verificacion.detalle).not.toHaveProperty("yield_alert");
  });

  it("with rendimiento, a yield Poster did not keep gives ok false and an alert not to repeat the call", async () => {
    const { api } = fakeApi({ yieldRead: sumNetto });
    const r: any = await W.actualizarPrecocinado(ctx(api), {
      cuenta: "cafe-04", product_id: 7001, rendimiento: 65, confirm: true,
      receta: [{ ingredient_id: 501, brutto: 100, netto: 92.86, lock: 0 }],
    });
    expect(r.modo).toBe("aplicado");
    expect(r.verificacion.ok).toBe(false);
    expect(r.verificacion.detalle).toHaveProperty("yield_alert");
    const alert = String(r.verificacion.detalle.yield_alert);
    expect(alert).toMatch(/recalculates the yield from the lines' netto/);
    expect(alert).toMatch(/65/);
    expect(alert).toMatch(/92\.86/);
    expect(alert).toMatch(/recipe itself was applied/);
    expect(alert).toMatch(/do not repeat/i);
    expect(r.verificacion.detalle.rendimiento_leido).toBe(92.86);
  });
});

describe("hide_dish keeps processing methods", () => {
  it("the re-sent recipe lines carry the methods read", async () => {
    const { api, post } = fakeApi();
    const r: any = await W.ocultarPlatillo(ctx(api), { cuenta: "cafe-04", product_id: 8001 });
    expect(r.modo).toBe("dry-run");
    expect(post).not.toHaveBeenCalled();
    expect(r.payload.ingredient).toStrictEqual([
      { id: 501, type: 1, brutto: 60, netto: 45, lock: 0, clear: 1, cook: 0, fry: 1, stew: 0, bake: 0 },
      { id: 502, type: 1, brutto: 20, netto: 20, lock: 1 },
      { id: 504, type: 2, brutto: 15, netto: 15, lock: 1, clear: 0, cook: 1, fry: 0, bake: 0 },
    ]);
    expect(r.cambios.map((c: Obj) => c.campo).sort()).toEqual(["product_name", "visible.1"]);
  });

  it("a read-back that returns a sent method as 0 gives ok false with method_mismatches", async () => {
    const { api } = fakeApi({ tamper: (ls) => { lineOf(ls, "501").pr_in_fry = "0"; } });
    const r: any = await W.ocultarPlatillo(ctx(api), { cuenta: "cafe-04", product_id: 8001, confirm: true });
    expect(r.modo).toBe("aplicado");
    expect(r.verificacion.ok).toBe(false);
    expect(r.verificacion.detalle.method_mismatches).toEqual([{ item: "1_501", method: "fry", sent: 1, read: 0 }]);
    expect(r.verificacion.detalle).not.toHaveProperty("net_mismatches");
  });

  it("a lock 0 line read back with another net weight gives ok false with net_mismatches", async () => {
    const { api } = fakeApi({ tamper: (ls) => { lineOf(ls, "501").structure_netto = 60; } });
    const r: any = await W.ocultarPlatillo(ctx(api), { cuenta: "cafe-04", product_id: 8001, confirm: true });
    expect(r.modo).toBe("aplicado");
    expect(r.verificacion.ok).toBe(false);
    expect(r.verificacion.detalle.net_mismatches).toEqual([{ item: "1_501", sent: 45, read: 60 }]);
    expect(r.verificacion.detalle).not.toHaveProperty("method_mismatches");
  });

  it("methods read back as sent and a net within tolerance give ok true", async () => {
    const { api, post } = fakeApi({ tamper: (ls) => { lineOf(ls, "501").structure_netto = 45.02; } }); // tolerance 0.0225
    const r: any = await W.ocultarPlatillo(ctx(api), { cuenta: "cafe-04", product_id: 8001, confirm: true });
    expect(sentLines(post)[0]).toMatchObject({ id: 501, clear: 1, cook: 0, fry: 1, stew: 0, bake: 0 });
    expect(r.verificacion.ok).toBe(true);
    expect(r.verificacion.detalle).not.toHaveProperty("method_mismatches");
    expect(r.verificacion.detalle).not.toHaveProperty("net_mismatches");
  });
});

describe("update_dish_recipe keeps processing methods", () => {
  it("kept items carry their methods and new items have none", async () => {
    const { api, post } = fakeApi();
    const r: any = await W.actualizarRecetaPlatillo(ctx(api), {
      cuenta: "cafe-04", product_id: 8001, grupos: [],
      receta: [{ ingredient_id: 501, brutto: 70 }, { ingredient_id: 505, brutto: 5 }, { ingredient_id: 504, tipo: 2, brutto: 15 }, { ingredient_id: 502, brutto: 20 }],
    });
    expect(r.modo).toBe("dry-run");
    expect(post).not.toHaveBeenCalled();
    expect(r.payload.ingredient).toStrictEqual([
      { id: 501, type: 1, brutto: 70, netto: 70, lock: 1, clear: 1, cook: 0, fry: 1, stew: 0, bake: 0 },
      { id: 505, type: 1, brutto: 5, netto: 5, lock: 1 },
      { id: 504, type: 2, brutto: 15, netto: 15, lock: 1, clear: 0, cook: 1, fry: 0, bake: 0 },
      { id: 502, type: 1, brutto: 20, netto: 20, lock: 1 },
    ]);
    // The readable recipe of the diff names the methods that are on and marks a line read without them (Y6).
    expect(r.cambios).toContainEqual({ campo: "receta.0", antes: "Test root A · 60 g · methods: clear, fry", despues: "Test root A · 70 g · methods: clear, fry" });
    expect(r.cambios).toContainEqual({ campo: "receta.1", antes: "Test leaf B · 20 g · methods unknown", despues: "Test spice E · 5 g" });
  });

  it("a read-back that returns a sent method as 0 gives ok false with method_mismatches", async () => {
    const { api } = fakeApi({ tamper: (ls) => { lineOf(ls, "501").pr_in_clear = "0"; } });
    const r: any = await W.actualizarRecetaPlatillo(ctx(api), {
      cuenta: "cafe-04", product_id: 8001, grupos: [], confirm: true,
      receta: [{ ingredient_id: 501, brutto: 60, netto: 45, lock: 0 }],
    });
    expect(r.modo).toBe("aplicado");
    expect(r.verificacion.ok).toBe(false);
    expect(r.verificacion.detalle.method_mismatches).toEqual([{ item: "1_501", method: "clear", sent: 1, read: 0 }]);
    expect(r.verificacion.detalle).not.toHaveProperty("net_mismatches");
  });

  it("a lock 0 line read back with another net weight gives ok false with net_mismatches", async () => {
    const { api } = fakeApi({ tamper: (ls) => { lineOf(ls, "501").structure_netto = 60; } });
    const r: any = await W.actualizarRecetaPlatillo(ctx(api), {
      cuenta: "cafe-04", product_id: 8001, grupos: [], confirm: true,
      receta: [{ ingredient_id: 501, brutto: 60, netto: 45, lock: 0 }],
    });
    expect(r.modo).toBe("aplicado");
    expect(r.verificacion.ok).toBe(false);
    expect(r.verificacion.detalle.net_mismatches).toEqual([{ item: "1_501", sent: 45, read: 60 }]);
    expect(r.verificacion.detalle).not.toHaveProperty("method_mismatches");
  });

  it("methods read back as sent and a net within tolerance give ok true", async () => {
    const { api, post } = fakeApi({ tamper: (ls) => { lineOf(ls, "501").structure_netto = 45.02; } }); // tolerance 0.0225
    const r: any = await W.actualizarRecetaPlatillo(ctx(api), {
      cuenta: "cafe-04", product_id: 8001, grupos: [], confirm: true,
      receta: [{ ingredient_id: 501, brutto: 60, netto: 45, lock: 0 }],
    });
    expect(sentLines(post)[0]).toMatchObject({ id: 501, clear: 1, cook: 0, fry: 1, stew: 0, bake: 0 });
    expect(r.verificacion.ok).toBe(true);
    expect(r.verificacion.detalle).not.toHaveProperty("method_mismatches");
    expect(r.verificacion.detalle).not.toHaveProperty("net_mismatches");
  });
});

const ALL_METHODS = [...METHODS];
const RENAME = { cuenta: "cafe-04", product_id: 7001, nombre: "Sample base mix v2" };
/** Swaps the read lines at the first and the last position of an item. */
const swapReads = (ls: Obj[], id: string) => {
  const at = ls.flatMap((l, k) => (l.ingredient_id === id ? [k] : []));
  const [i, j] = [at[0], at[at.length - 1]];
  [ls[i], ls[j]] = [ls[j], ls[i]];
};

describe("Y1 a sent method read back as unknown is reported, not failed", () => {
  it("Y1 update_prepack: a sent method missing from the read-back is listed under methods_unverified with a note, and ok stays true", async () => {
    const { api } = fakeApi({ tamper: (ls) => { delete lineOf(ls, "501").pr_in_stew; } });
    const r: any = await W.actualizarPrecocinado(ctx(api), { ...RENAME, confirm: true });
    expect(r.modo).toBe("aplicado");
    expect(r.verificacion.ok).toBe(true);
    expect(r.verificacion.detalle.methods_unverified).toEqual([{ ingredient: 501, type: 1, methods: ["stew"] }]);
    expect(r.verificacion.detalle.methods_unverified_note).toMatch(/could not be confirmed/);
    expect(r.verificacion.detalle).not.toHaveProperty("method_mismatches");
  });

  it("Y1 hide_dish: methods read back without pr_in_* are unverified, and receta_intacta stays true", async () => {
    const { api } = fakeApi({ tamper: (ls) => { for (const k of METHODS) delete lineOf(ls, "501")[`pr_in_${k}`]; } });
    const r: any = await W.ocultarPlatillo(ctx(api), { cuenta: "cafe-04", product_id: 8001, confirm: true });
    expect(r.verificacion.ok).toBe(true);
    expect(r.verificacion.detalle.receta_intacta).toBe(true);
    expect(r.verificacion.detalle.methods_unverified).toEqual([{ ingredient: 501, type: 1, methods: ALL_METHODS }]);
    expect(r.verificacion.detalle).not.toHaveProperty("method_mismatches");
  });
});

describe("Y2 methods that could not be carried over are listed", () => {
  it("Y2 update_prepack lists, in the dry-run and in the result, the lines whose current methods were not all read", async () => {
    const expected = [
      { ingredient: 501, type: 1, methods: ["bake"] },
      { ingredient: 502, type: 1, methods: ALL_METHODS },
      { ingredient: 503, type: 1, methods: ["fry", "stew"] },
      { ingredient: 504, type: 2, methods: ["bake"] },
    ];
    const dry: any = await W.actualizarPrecocinado(ctx(fakeApi().api), RENAME);
    expect(dry.methods_not_carried).toEqual(expected);
    expect(dry.methods_not_carried_note).toMatch(/Poster may reset them/);
    const done: any = await W.actualizarPrecocinado(ctx(fakeApi().api), { ...RENAME, confirm: true });
    expect(done.modo).toBe("aplicado");
    expect(done.methods_not_carried).toEqual(expected);
  });

  it("Y2 hide_dish and update_dish_recipe list them too; a new line has nothing to carry", async () => {
    const hidden: any = await W.ocultarPlatillo(ctx(fakeApi().api), { cuenta: "cafe-04", product_id: 8001 });
    expect(hidden.methods_not_carried).toEqual([{ ingredient: 502, type: 1, methods: ALL_METHODS }, { ingredient: 504, type: 2, methods: ["stew"] }]);
    const r: any = await W.actualizarRecetaPlatillo(ctx(fakeApi().api), {
      cuenta: "cafe-04", product_id: 8001, grupos: [],
      receta: [{ ingredient_id: 501, brutto: 60, netto: 45, lock: 0 }, { ingredient_id: 502, brutto: 20 }, { ingredient_id: 505, brutto: 5 }],
    });
    expect(r.methods_not_carried).toEqual([{ ingredient: 502, type: 1, methods: ALL_METHODS }]);
  });
});

describe("Y10 a recipe read without its lines lists every sent line as not carried", () => {
  const SENT = [{ ingredient_id: 501, brutto: 60, netto: 45, lock: 0 }, { ingredient_id: 504, tipo: 2, brutto: 15 }];
  const EVERY_LINE = [{ ingredient: 501, type: 1, methods: ALL_METHODS }, { ingredient: 504, type: 2, methods: ALL_METHODS }];
  /** The result of a call, or `{ refused }` with the message when it throws, so a refusal fails an assertion. */
  const settled = (p: Promise<unknown>): Promise<any> => p.then((r) => r, (e: unknown) => ({ refused: String((e as Error)?.message ?? e) }));

  it("Y10 update_dish_recipe, with or without grupos, lists every sent line when the dish reads with no ingredients list, and still sends", async () => {
    for (const grupos of [undefined, []]) {
      for (const confirm of [false, true]) {
        const label = `grupos ${JSON.stringify(grupos)}, confirm ${confirm}`;
        const { api, post, db } = fakeApi();
        delete db["menu.getProducts"][0].ingredients;
        const r = await settled(W.actualizarRecetaPlatillo(ctx(api), { cuenta: "cafe-04", product_id: 8001, receta: SENT, ...(grupos ? { grupos } : {}), confirm }));
        expect(r.refused, label).toBeUndefined();
        expect(r.modo, label).toBe(confirm ? "aplicado" : "dry-run");
        expect(r.methods_not_carried, label).toEqual(EVERY_LINE);
        expect(r.methods_not_carried_note, label).toMatch(/Poster may reset them/);
        expect(post).toHaveBeenCalledTimes(confirm ? 1 : 0);
      }
    }
  });

  it("Y10 update_prepack lists every sent line when the prepack reads with no ingredients list, and still sends", async () => {
    for (const confirm of [false, true]) {
      const { api, post, db } = fakeApi();
      delete db["menu.getPrepacks"][0].ingredients;
      const r = await settled(W.actualizarPrecocinado(ctx(api), { cuenta: "cafe-04", product_id: 7001, receta: SENT, confirm }));
      expect(r.refused, `confirm ${confirm}`).toBeUndefined();
      expect(r.modo).toBe(confirm ? "aplicado" : "dry-run");
      expect(r.methods_not_carried, `confirm ${confirm}`).toEqual(EVERY_LINE);
      expect(post).toHaveBeenCalledTimes(confirm ? 1 : 0);
    }
  });
});

describe("Y3 the yield alert says the recipe was applied only when the recipe checks pass", () => {
  const sumNetto = (body: Obj) => body.ingredient.reduce((s: number, l: Obj) => s + l.netto, 0);
  const tampers: Array<[string, (ls: Obj[]) => void]> = [
    ["a method", (ls) => { lineOf(ls, "501").pr_in_clear = "0"; }],
    ["a manual net", (ls) => { lineOf(ls, "501").structure_netto = 90; }],
    ["a gross weight", (ls) => { lineOf(ls, "501").structure_brutto = 101; }],
  ];
  for (const [what, tamper] of tampers) {
    it(`Y3 ${what} that did not survive leaves only the yield difference in yield_alert`, async () => {
      const { api } = fakeApi({ yieldRead: sumNetto, tamper });
      const r: any = await W.actualizarPrecocinado(ctx(api), {
        cuenta: "cafe-04", product_id: 7001, rendimiento: 65, confirm: true,
        receta: [{ ingredient_id: 501, brutto: 100, netto: 92.86, lock: 0 }],
      });
      expect(r.verificacion.ok).toBe(false);
      const alert = String(r.verificacion.detalle.yield_alert);
      expect(alert).toMatch(/requested yield \(65\) was not kept and Poster read 92\.86/);
      expect(alert).not.toMatch(/recipe itself was applied/);
      expect(alert).not.toMatch(/do not repeat/i);
    });
  }
});

describe("Y4 one pairing rule: same gross weight first, then occurrence order", () => {
  it("Y4 repeated lines read back in another order still pair by gross weight", async () => {
    const { api } = fakeApi({ tamper: (ls) => swapReads(ls, "503") });
    const r: any = await W.actualizarPrecocinado(ctx(api), { ...RENAME, confirm: true });
    expect(r.verificacion.ok).toBe(true);
    expect(r.verificacion.detalle).not.toHaveProperty("method_mismatches");
  });

  it("Y4 repeated lines that exchanged their gross weights are reported", async () => {
    const { api } = fakeApi({
      tamper: (ls) => {
        const [a, b] = ls.filter((l) => l.ingredient_id === "503");
        [a.structure_brutto, b.structure_brutto] = [b.structure_brutto, a.structure_brutto];
      },
    });
    const r: any = await W.actualizarPrecocinado(ctx(api), { ...RENAME, confirm: true });
    expect(r.verificacion.ok).toBe(false);
    expect(r.verificacion.detalle.method_mismatches).toEqual([
      { item: "1_503", method: "clear", sent: 0, read: 1 },
      { item: "1_503", method: "cook", sent: 1, read: 0 },
      { item: "1_503", method: "clear", sent: 1, read: 0 },
      { item: "1_503", method: "cook", sent: 0, read: 1 },
      { item: "1_503", method: "fry", sent: 1, read: 0 },
    ]);
  });

  it("Y4 lines with the same gross weight are compared as a multiset of methods and net", async () => {
    const swapped = fakeApi({ tamper: (ls) => swapReads(ls, "503") });
    const r: any = await W.actualizarPrecocinado(ctx(swapped.api), { cuenta: "cafe-04", product_id: 7002, nombre: "Sample duo mix v2", confirm: true });
    expect(r.verificacion.ok).toBe(true);
    expect(r.verificacion.detalle).not.toHaveProperty("method_mismatches");
    expect(r.verificacion.detalle).not.toHaveProperty("net_mismatches");

    const changed = fakeApi({
      tamper: (ls) => {
        swapReads(ls, "503");
        ls.find((l) => l.ingredient_id === "503" && l.pr_in_cook === "1")!.structure_netto = 10;
      },
    });
    const r2: any = await W.actualizarPrecocinado(ctx(changed.api), { cuenta: "cafe-04", product_id: 7002, nombre: "Sample duo mix v2", confirm: true });
    expect(r2.verificacion.ok).toBe(false);
    expect(r2.verificacion.detalle.net_mismatches).toEqual([{ item: "1_503", sent: 9, read: 10 }]);
    expect(r2.verificacion.detalle).not.toHaveProperty("method_mismatches");
  });

  it("Y4 update_prepack carries methods, lock and unit from the same paired line, matched by gross weight", async () => {
    const { api } = fakeApi();
    const r: any = await W.actualizarPrecocinado(ctx(api), {
      cuenta: "cafe-04", product_id: 7002,
      receta: [{ ingredient_id: 505, brutto: 25, netto: 20 }, { ingredient_id: 505, brutto: 40 }],
    });
    expect(r.payload.ingredient).toStrictEqual([
      { id: 505, type: 1, brutto: 25, netto: 20, lock: 0, unit: "ml", clear: 0, cook: 0, fry: 1, stew: 0, bake: 0 },
      { id: 505, type: 1, brutto: 40, netto: 40, lock: 1, unit: "g", clear: 1, cook: 0, fry: 0, stew: 0, bake: 0 },
    ]);
  });
});

describe("Y5 hide_dish receta_intacta needs the gross, method and net checks", () => {
  it("Y5 a method or a manual net that did not survive makes receta_intacta false", async () => {
    const methods = fakeApi({ tamper: (ls) => { lineOf(ls, "501").pr_in_fry = "0"; } });
    const r: any = await W.ocultarPlatillo(ctx(methods.api), { cuenta: "cafe-04", product_id: 8001, confirm: true });
    expect(r.verificacion.detalle.receta_intacta).toBe(false);
    const net = fakeApi({ tamper: (ls) => { lineOf(ls, "501").structure_netto = 60; } });
    const r2: any = await W.ocultarPlatillo(ctx(net.api), { cuenta: "cafe-04", product_id: 8001, confirm: true });
    expect(r2.verificacion.detalle.receta_intacta).toBe(false);
  });
});

describe("Y6 the readable recipe marks unknown methods", () => {
  it("Y6 a line shows the methods that are on and marks those not read", async () => {
    const r: any = await W.actualizarRecetaPlatillo(ctx(fakeApi().api), {
      cuenta: "cafe-04", product_id: 8001, grupos: [],
      receta: [{ ingredient_id: 504, tipo: 2, brutto: 15 }, { ingredient_id: 501, brutto: 60 }, { ingredient_id: 502, brutto: 20 }],
    });
    expect(r.cambios).toContainEqual({ campo: "receta.0", antes: "Test root A · 60 g · methods: clear, fry", despues: "Sample sauce · 15 g · methods: cook · methods unknown: stew" });
    expect(r.cambios).toContainEqual({ campo: "receta.1", antes: "Test leaf B · 20 g · methods unknown", despues: "Test root A · 60 g · methods: clear, fry" });
    expect(r.cambios).toContainEqual({ campo: "receta.2", antes: "Sample sauce · 15 g · methods: cook · methods unknown: stew", despues: "Test leaf B · 20 g · methods unknown" });
  });
});

describe("Y7 a manual net weight sent with defaults gets a dry-run notice; the payload is unchanged", () => {
  it("Y7 update_dish_recipe: a line paired with an existing lock 0 line, without lock or netto, gets the notice", async () => {
    const r: any = await W.actualizarRecetaPlatillo(ctx(fakeApi().api), { cuenta: "cafe-04", product_id: 8001, grupos: [], receta: [{ ingredient_id: 501, brutto: 60 }] });
    expect(r.payload.ingredient).toStrictEqual([{ id: 501, type: 1, brutto: 60, netto: 60, lock: 1, clear: 1, cook: 0, fry: 1, stew: 0, bake: 0 }]);
    expect(r.avisos).toContain(
      "1_501: these lines pair with an existing manual-net line (lock 0) and are sent with lock 1 or netto = brutto (lock or netto not given), " +
      "so the manual net weight may be lost. Pass lock: 0 and netto to keep it.",
    );
    const kept: any = await W.actualizarRecetaPlatillo(ctx(fakeApi().api), { cuenta: "cafe-04", product_id: 8001, grupos: [], receta: [{ ingredient_id: 501, brutto: 60, netto: 45, lock: 0 }] });
    expect(kept.avisos.join("\n")).not.toMatch(/manual-net line/);
  });

  it("Y7 update_prepack: a line paired with an existing lock 0 line, without netto, gets the notice", async () => {
    const r: any = await W.actualizarPrecocinado(ctx(fakeApi().api), { cuenta: "cafe-04", product_id: 7001, receta: [{ ingredient_id: 502, brutto: 100 }] });
    expect(r.payload.ingredient).toStrictEqual([{ id: 502, type: 1, brutto: 100, netto: 100, lock: 0, unit: "g" }]);
    expect(r.avisos).toContain(
      "1_502: these lines pair with an existing manual-net line (lock 0) and are sent with netto = brutto (no netto given), " +
      "so the manual net weight may be lost. Pass netto to keep it.",
    );
  });
});

describe("Y9 read-back pins", () => {
  it("Y9 a method sent as 0 and read back as 1 is a mismatch (update_prepack and hide_dish)", async () => {
    const prepack = fakeApi({ tamper: (ls) => { lineOf(ls, "501").pr_in_fry = "1"; } });
    const r: any = await W.actualizarPrecocinado(ctx(prepack.api), { ...RENAME, confirm: true });
    expect(r.verificacion.ok).toBe(false);
    expect(r.verificacion.detalle.method_mismatches).toEqual([{ item: "1_501", method: "fry", sent: 0, read: 1 }]);
    const hidden = fakeApi({ tamper: (ls) => { lineOf(ls, "504", "2").pr_in_clear = "1"; } });
    const r2: any = await W.ocultarPlatillo(ctx(hidden.api), { cuenta: "cafe-04", product_id: 8001, confirm: true });
    expect(r2.verificacion.ok).toBe(false);
    expect(r2.verificacion.detalle.method_mismatches).toEqual([{ item: "2_504", method: "clear", sent: 0, read: 1 }]);
  });

  it("Y9 a read line without structure_type is taken as an ingredient line (type 1)", async () => {
    const { api } = fakeApi({
      tamper: (ls) => {
        const l = lineOf(ls, "501");
        delete l.structure_type;
        l.pr_in_stew = "0";
      },
    });
    const r: any = await W.actualizarPrecocinado(ctx(api), { ...RENAME, confirm: true });
    expect(r.verificacion.detalle.method_mismatches).toEqual([{ item: "1_501", method: "stew", sent: 1, read: 0 }]);
  });

  it("Y9 net tolerance edges: 1 over 1800 fails, 0.001 over 0.4 passes, 0.0012 over 0.4 fails", async () => {
    const big = fakeApi({ tamper: (ls) => { lineOf(ls, "501").structure_netto = 1801; } });
    const r: any = await W.actualizarPrecocinado(ctx(big.api), { cuenta: "cafe-04", product_id: 7001, confirm: true, receta: [{ ingredient_id: 501, brutto: 2000, netto: 1800, lock: 0 }] });
    expect(r.verificacion.detalle.net_mismatches).toEqual([{ item: "1_501", sent: 1800, read: 1801 }]);

    const small = [{ ingredient_id: 502, brutto: 0.5, netto: 0.4, lock: 0 }];
    const edge = fakeApi({ tamper: (ls) => { lineOf(ls, "502").structure_netto = 0.401; } });
    const r2: any = await W.actualizarPrecocinado(ctx(edge.api), { cuenta: "cafe-04", product_id: 7001, confirm: true, receta: small });
    expect(r2.verificacion.ok).toBe(true);
    expect(r2.verificacion.detalle).not.toHaveProperty("net_mismatches");

    const over = fakeApi({ tamper: (ls) => { lineOf(ls, "502").structure_netto = 0.4012; } });
    const r3: any = await W.actualizarPrecocinado(ctx(over.api), { cuenta: "cafe-04", product_id: 7001, confirm: true, receta: small });
    expect(r3.verificacion.detalle.net_mismatches).toEqual([{ item: "1_502", sent: 0.4, read: 0.4012 }]);
  });

  it("Y9 a manual net missing from the read-back is a mismatch with read null", async () => {
    const { api } = fakeApi({ tamper: (ls) => { delete lineOf(ls, "501").structure_netto; } });
    const r: any = await W.ocultarPlatillo(ctx(api), { cuenta: "cafe-04", product_id: 8001, confirm: true });
    expect(r.verificacion.ok).toBe(false);
    expect(r.verificacion.detalle.net_mismatches).toEqual([{ item: "1_501", sent: 45, read: null }]);
  });

  it("Y9 a net read back as a numeric string is compared as a number", async () => {
    const hidden = fakeApi({ tamper: (ls) => { lineOf(ls, "501").structure_netto = "45.0000"; } });
    const r: any = await W.ocultarPlatillo(ctx(hidden.api), { cuenta: "cafe-04", product_id: 8001, confirm: true });
    expect(r.verificacion.ok).toBe(true);
    const prepack = fakeApi({ tamper: (ls) => { lineOf(ls, "502").structure_netto = "100.0000"; } });
    const r2: any = await W.actualizarPrecocinado(ctx(prepack.api), { ...RENAME, confirm: true });
    expect(r2.verificacion.ok).toBe(true);
    expect(r2.verificacion.detalle).not.toHaveProperty("net_mismatches");
  });

  it("Y9 a yield off by exactly 1 fails with an alert; a kept yield passes without one", async () => {
    const lost = fakeApi({ yieldRead: () => 301 });
    const r: any = await W.actualizarPrecocinado(ctx(lost.api), { ...RENAME, rendimiento: 300, confirm: true });
    expect(r.verificacion.ok).toBe(false);
    expect(r.verificacion.detalle.yield_alert).toMatch(/requested yield \(300\) was not kept and Poster read 301/);
    const kept = fakeApi({ yieldRead: () => 300 });
    const r2: any = await W.actualizarPrecocinado(ctx(kept.api), { ...RENAME, rendimiento: 300, confirm: true });
    expect(r2.verificacion.ok).toBe(true);
    expect(r2.verificacion.detalle).not.toHaveProperty("yield_alert");
  });

  it("Y9 every occurrence of a repeated item is checked, not only the first", async () => {
    const { api } = fakeApi({ tamper: (ls) => { ls.find((l) => l.ingredient_id === "501" && l.structure_brutto === 80)!.structure_netto = 38; } });
    const r: any = await W.actualizarPrecocinado(ctx(api), {
      cuenta: "cafe-04", product_id: 7001, confirm: true,
      receta: [{ ingredient_id: 501, brutto: 100, netto: 45, lock: 0 }, { ingredient_id: 501, brutto: 80, netto: 35, lock: 0 }],
    });
    expect(r.verificacion.ok).toBe(false);
    expect(r.verificacion.detalle.net_mismatches).toEqual([{ item: "1_501", sent: 35, read: 38 }]);
  });
});

// Regression pin, the one test meant to pass before and after this change: the create tools cannot set methods,
// so their payloads must stay byte-identical. The literals are the pre-change output for the same input.
describe("create tools keep their payloads", () => {
  it("create_prepack and create_dish payloads are byte-identical to the pre-change output", async () => {
    const { api, post } = fakeApi();
    const prepack: any = await W.crearPrecocinado(ctx(api), {
      cuenta: "cafe-04", nombre: "Sample new mix", descripcion: "Mix and rest",
      receta: [{ ingredient_id: 501, brutto: 200 }, { ingredient_id: 503, brutto: 50, netto: 40, lock: 0 }, { ingredient_id: 504, tipo: 2, brutto: 25 }],
    });
    expect(JSON.stringify(prepack.payload)).toBe(
      '{"product_name":"Sample new mix","ingredient":[{"id":501,"type":1,"brutto":200,"netto":200,"lock":1},' +
        '{"id":503,"type":1,"brutto":50,"netto":40,"lock":0},{"id":504,"type":2,"brutto":25,"netto":25,"lock":1}],' +
        '"product_production_description":"Mix and rest"}',
    );
    const dishResult: any = await W.crearPlatillo(ctx(api), {
      cuenta: "cafe-04", nombre: "Sample plate", categoria_id: 40, workshop: 2, precio: 95.5, color: "green", sin_descuento: true,
      receta: [{ ingredient_id: 501, brutto: 60, netto: 45, lock: 0 }, { ingredient_id: 504, tipo: 2, brutto: 15 }],
      grupos: [{ nombre: "Sample side", min: 0, max: 1, opciones: [{ ingredient_id: 505, nombre: "Extra spice", brutto: 3, precio: 7 }] }],
    });
    expect(JSON.stringify(dishResult.payload)).toBe(
      '{"product_name":"Sample plate","menu_category_id":40,"workshop":2,"weight_flag":0,"nodiscount":1,"visible":1,"price":9550,' +
        '"product_color":"green","ingredient":[{"id":501,"type":1,"brutto":60,"netto":45,"lock":0},{"id":504,"type":2,"brutto":15,"netto":15,"lock":1}],' +
        '"modificationgroup":[{"name":"Sample side","type":1,"minNum":0,"maxNum":1,"modifications":[{"ingredientId":505,"type":10,"name":"Extra spice","brutto":3,"price":700}]}]}',
    );
    expect(post).not.toHaveBeenCalled();
  });
});
