// Unit C of specs/2026-11-20-write-probes.md: an ingredient sold by the piece (ingredient_unit "p") with no piece
// weight (ingredient_weight absent, blank, not a finite number or not above 0) gets a net weight of 0 g in a recipe.
// create_prepack, update_prepack, create_dish and update_dish_recipe warn about it with zero_piece_weight and
// zero_piece_weight_notice; the payload and the read-back do not change and no extra request is made. All names and
// ids below are made up.
import { describe, it, expect, vi } from "vitest";
import * as W from "../src/tools/escritura.js";
import type { PosterApi } from "../src/poster.js";

type Obj = Record<string, any>;
type Line = { ingredient_id: number; tipo?: number; brutto: number };

/** Ingredients by id. 4201 is also a prepack id: ids repeat across the two catalogs. */
const INGREDIENTS = (pieceWeight: Obj = {}): Obj[] => [
  { ingredient_id: "4201", ingredient_name: "Sample bun", ingredient_unit: "p", ingredient_weight: 0, ...pieceWeight },
  { ingredient_id: "4205", ingredient_name: "Sample cookie", ingredient_unit: "p", ingredient_weight: "45" },
  { ingredient_id: "4206", ingredient_name: "Sample flour", ingredient_unit: "kg", ingredient_weight: 0 },
  { ingredient_id: "4207", ingredient_name: "Sample milk", ingredient_unit: "l", ingredient_weight: "0" },
  { ingredient_id: "4208", ingredient_name: "Sample napkin", ingredient_unit: "p" },
];
/** The piece ingredient 4201 with each piece weight that must warn. */
const ZERO_WEIGHTS: [string, Obj][] = [
  ["weight 0", { ingredient_weight: 0 }],
  ['weight "0"', { ingredient_weight: "0" }],
  ["weight absent", { ingredient_weight: undefined }],
  ['weight ""', { ingredient_weight: "" }],
];
const BUN = { id: 4201, name: "Sample bun" };

const PREPACKS = (): Obj[] => [
  { product_id: "4201", product_name: "Sample dough", unit: "kg", out: 100, ingredients: [] },
  { product_id: "4301", product_name: "Sample filling", unit: "kg", out: 500, ingredients: [
    { ingredient_id: "4201", structure_type: "1", structure_brutto: 2, structure_netto: 0, structure_unit: "p", structure_lock: "1" },
    { ingredient_id: "4206", structure_type: "1", structure_brutto: 300, structure_netto: 300, structure_unit: "g", structure_lock: "1" },
  ] },
];
const DISH = (): Obj => ({
  product_id: "8101", product_name: "Sample wrap", menu_category_id: "41", workshop: "2", type: "2", color: "red", weight_flag: "0", out: 0,
  price: { "1": "9000" }, spots: [{ spot_id: "1", price: "9000", visible: "1" }],
  group_modifications: [],
  ingredients: [{ ingredient_id: "4206", structure_type: "1", structure_brutto: 50, structure_netto: 50, structure_lock: "1" }],
});

/** Fake API: reads come from a fixed catalog; every write succeeds with an id. Calls are recorded in order. */
function fakeApi(ingredients: Obj[]) {
  const db: Obj = {
    "menu.getIngredients": ingredients,
    "menu.getPrepacks": PREPACKS(),
    "menu.getProducts": [DISH()],
    "menu.getCategories": [{ category_id: "41", category_name: "Sample wraps", parent_category: "0" }],
  };
  const get = vi.fn(async (_account: string, method: string, params?: Obj) => {
    if (method === "menu.getProduct") return structuredClone(db["menu.getProducts"].find((x: Obj) => Number(x.product_id) === Number(params?.product_id))) as never;
    return structuredClone(db[method]) as never;
  });
  const post = vi.fn(async (_account: string, method: string, _body: Obj) => ({ response: method === "menu.updateDish" || method === "menu.updatePrepack" ? true : 9001 }));
  return { api: { get, post } as unknown as PosterApi, get, post };
}
const ctx = (api: PosterApi) => ({ api, actor: "test" });

// The write account the test configuration sets.
const cuenta = process.env.WRITE_DEFAULT_ACCOUNTS as string;

const TOOLS: Record<string, (api: PosterApi, lines: Line[] | undefined, confirm: boolean) => Promise<Obj>> = {
  create_prepack: (api, lines, confirm) => W.crearPrecocinado(ctx(api), { cuenta, nombre: "Sample new filling", receta: lines!, confirm }),
  update_prepack: (api, lines, confirm) => W.actualizarPrecocinado(ctx(api), { cuenta, product_id: 4301, ...(lines && { receta: lines }), confirm }),
  create_dish: (api, lines, confirm) =>
    W.crearPlatillo(ctx(api), { cuenta, nombre: "Sample new wrap", categoria_id: 41, workshop: 2, precio: 90, receta: lines!, confirm }),
  update_dish_recipe: (api, lines, confirm) => W.actualizarRecetaPlatillo(ctx(api), { cuenta, product_id: 8101, receta: lines!, confirm }),
};

/** Dry-run and confirmed result of one tool call on a fresh fake API. */
async function both(tool: string, ingredients: Obj[], lines: Line[] | undefined) {
  const dry = await TOOLS[tool](fakeApi(ingredients).api, lines, false);
  const f = fakeApi(ingredients);
  const applied = await TOOLS[tool](f.api, lines, true);
  return { dry, applied, ...f };
}

const NOTICE = /sold by the piece[\s\S]*no piece weight in Poster[\s\S]*net weight in this recipe is 0 g[\s\S]*yield and cost are wrong[\s\S]*set the piece weight in Poster first/i;

describe("C piece ingredients without a piece weight", () => {
  for (const tool of Object.keys(TOOLS)) {
    for (const [label, weight] of ZERO_WEIGHTS) {
      it(`C1 ${tool}: a piece ingredient with ${label} warns in the dry-run and in the confirmed result`, async () => {
        const { dry, applied } = await both(tool, INGREDIENTS(weight), [{ ingredient_id: 4201, brutto: 2 }, { ingredient_id: 4206, brutto: 100 }]);
        expect(dry.modo).toBe("dry-run");
        expect(applied.modo).toBe("aplicado");
        for (const r of [dry, applied]) {
          expect(r.zero_piece_weight).toEqual([BUN]);
          expect(r.zero_piece_weight_notice).toMatch(NOTICE);
        }
      });
    }

    it(`C2 ${tool}: a positive piece weight, a kg or l ingredient with weight 0 and a prepack line with a zero-weight ingredient's id do not warn`, async () => {
      const lines = [{ ingredient_id: 4205, brutto: 1 }, { ingredient_id: 4206, brutto: 100 }, { ingredient_id: 4207, brutto: 50 }, { ingredient_id: 4201, tipo: 2, brutto: 30 }];
      const { dry, applied } = await both(tool, INGREDIENTS(), lines);
      expect(applied.modo).toBe("aplicado");
      for (const r of [dry, applied]) {
        expect(r).not.toHaveProperty("zero_piece_weight");
        expect(r).not.toHaveProperty("zero_piece_weight_notice");
      }
    });

    it(`C3 ${tool}: two lines of the same piece ingredient give one entry, and each such ingredient is listed once in line order`, async () => {
      const lines = [{ ingredient_id: 4208, brutto: 1 }, { ingredient_id: 4201, brutto: 2 }, { ingredient_id: 4208, brutto: 3 }, { ingredient_id: 4201, brutto: 1 }];
      const { dry, applied } = await both(tool, INGREDIENTS(), lines);
      for (const r of [dry, applied]) expect(r.zero_piece_weight).toEqual([{ id: 4208, name: "Sample napkin" }, BUN]);
    });

    it(`C4 ${tool}: the POST body, the reads and the read-back are the same with and without the warning`, async () => {
      const lines = [{ ingredient_id: 4201, brutto: 2 }, { ingredient_id: 4206, brutto: 100 }];
      const warned = await both(tool, INGREDIENTS(), lines);
      const clean = await both(tool, INGREDIENTS({ ingredient_weight: 30 }), lines);
      expect(warned.applied.zero_piece_weight).toEqual([BUN]);
      expect(clean.applied).not.toHaveProperty("zero_piece_weight");
      expect(warned.post).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(warned.post.mock.calls)).toBe(JSON.stringify(clean.post.mock.calls));
      expect(JSON.stringify(warned.get.mock.calls)).toBe(JSON.stringify(clean.get.mock.calls));
      expect(JSON.stringify(warned.dry.payload)).toBe(JSON.stringify(clean.dry.payload));
      expect(warned.applied.verificacion).toEqual(clean.applied.verificacion);
    });
  }

  it("C5 update_prepack without receta warns for an existing re-sent piece line with weight 0", async () => {
    const { dry, applied, post } = await both("update_prepack", INGREDIENTS(), undefined);
    expect(post.mock.calls[0][2].ingredient.map((l: Obj) => l.id)).toEqual([4201, 4206]);
    for (const r of [dry, applied]) {
      expect(r.zero_piece_weight).toEqual([BUN]);
      expect(r.zero_piece_weight_notice).toMatch(NOTICE);
    }
  });

  it("C6 a piece weight that is not a finite number or is below 0 warns too", async () => {
    for (const ingredient_weight of ["n/a", -5, "-0.5", null]) {
      const { dry } = await both("create_prepack", INGREDIENTS({ ingredient_weight }), [{ ingredient_id: 4201, brutto: 2 }]);
      expect(dry.zero_piece_weight).toEqual([BUN]);
    }
  });

  it("C7 the piece unit is compared trimmed and case-folded", async () => {
    for (const ingredient_unit of [" p", "P", " P \n"]) {
      const { dry } = await both("create_prepack", INGREDIENTS({ ingredient_unit }), [{ ingredient_id: 4201, brutto: 2 }]);
      expect(dry.zero_piece_weight, JSON.stringify(ingredient_unit)).toEqual([BUN]);
    }
  });
});
