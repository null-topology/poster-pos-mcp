// Stocktake reads: list_stocktakes, stocktake_result and count_sheet. Poster's API cannot create or
// conduct a stocktake, so these tools only read: the stocktake list per storage, the discrepancies of
// one stocktake and a blind count sheet. Poster is faked; there is no network.
import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import * as L from "../src/tools/lectura.js";
import type { PosterApi } from "../src/poster.js";

type Obj = Record<string, any>;

const ALMACENES = [
  { storage_id: "1", storage_name: "Almacén central", delete: "0" },
  { storage_id: "2", storage_name: "Barra", delete: "0" },
];

/**
 * Fake Poster API: `storage.getStorageInventories` answers `db.inventarios[storage_id]`, every other
 * method `db[metodo]` (an empty list when absent). `post` must never be called by a read.
 */
function apiFalsa(db: Obj = {}) {
  const tabla: Obj = { "storage.getStorages": ALMACENES, ...db };
  const get = vi.fn(async (_cuenta: string, metodo: string, params?: Obj) => {
    if (metodo === "storage.getStorageInventories") return structuredClone(tabla.inventarios?.[String(params?.storage_id)] ?? []);
    return structuredClone(tabla[metodo] ?? []);
  });
  const post = vi.fn(async () => ({ error: 1 }));
  return { api: { get, post } as unknown as PosterApi, get, post };
}

/** One stocktake as `storage.getStorageInventories` documents it (money in kopecks). */
const inv = (o: Obj = {}): Obj => ({
  inventory_id: "10",
  storage_id: "1",
  date_start: "2026-11-01 08:00:00",
  date_end: "2026-11-01 20:00:00",
  date_set: "0000-00-00 00:00:00",
  date_inventory: "2026-11-01 21:00:00",
  sum: "123450",
  sum_netto: "100000",
  inventory_status: "1",
  ...o,
});

/** Calls of `metodo` on the fake API, as their params. */
const llamadas = (get: ReturnType<typeof vi.fn>, metodo: string) => get.mock.calls.filter((c) => c[1] === metodo).map((c) => c[2]);

describe("list_stocktakes", () => {
  it("ST1 without storage_id queries every storage of storage.getStorages and merges the stocktakes", async () => {
    const { api, get } = apiFalsa({
      inventarios: {
        "1": [inv({ inventory_id: "10", storage_id: "1" })],
        "2": [inv({ inventory_id: "20", storage_id: "2", date_end: "2026-11-02 20:00:00" })],
      },
    });
    const r: any = await L.inventarios(api, { cuenta: "cafe-01" });
    expect(llamadas(get, "storage.getStorageInventories")).toEqual([{ storage_id: 1 }, { storage_id: 2 }]);
    expect(r.inventarios.map((x: Obj) => [x.inventario_id, x.storage_id, x.almacen])).toEqual([
      [20, 2, "Barra"],
      [10, 1, "Almacén central"],
    ]);
    expect(r.total).toBe(2);
  });

  it("ST2 a zero date_inventory reads as null, any other value is kept", async () => {
    const { api } = apiFalsa({
      inventarios: { "1": [inv({ inventory_id: "10", date_inventory: "0000-00-00 00:00:00" }), inv({ inventory_id: "11", date_inventory: "2026-11-01 21:00:00" })] },
    });
    const r: any = await L.inventarios(api, { cuenta: "cafe-01", storage_id: 1 });
    const porId = Object.fromEntries(r.inventarios.map((x: Obj) => [x.inventario_id, x]));
    expect(porId[10].fecha_inventario).toBeNull();
    expect(porId[11].fecha_inventario).toBe("2026-11-01 21:00:00");
  });

  it("ST3 retroactiva is true only when date_set carries a date", async () => {
    const { api } = apiFalsa({
      inventarios: { "1": [inv({ inventory_id: "10", date_set: "2026-10-31 23:00:00" }), inv({ inventory_id: "11", date_set: "0000-00-00 00:00:00" }), inv({ inventory_id: "12", date_set: "" })] },
    });
    const r: any = await L.inventarios(api, { cuenta: "cafe-01", storage_id: 1 });
    const porId = Object.fromEntries(r.inventarios.map((x: Obj) => [x.inventario_id, x.retroactiva]));
    expect(porId).toEqual({ 10: true, 11: false, 12: false });
  });

  it("ST4 realizada is true only for inventory_status 1", async () => {
    const { api } = apiFalsa({ inventarios: { "1": [inv({ inventory_id: "10", inventory_status: "1" }), inv({ inventory_id: "11", inventory_status: "0" })] } });
    const r: any = await L.inventarios(api, { cuenta: "cafe-01", storage_id: 1 });
    const porId = Object.fromEntries(r.inventarios.map((x: Obj) => [x.inventario_id, x.realizada]));
    expect(porId).toEqual({ 10: true, 11: false });
  });

  it("ST5 sum and sum_netto are kopecks; costo_total_neto appears only when sum_netto is present", async () => {
    const sinNeto = inv({ inventory_id: "11", sum: "5000" });
    delete sinNeto.sum_netto;
    const { api } = apiFalsa({ inventarios: { "1": [inv({ inventory_id: "10", sum: "123450", sum_netto: "100000" }), sinNeto] } });
    const r: any = await L.inventarios(api, { cuenta: "cafe-01", storage_id: 1 });
    const porId = Object.fromEntries(r.inventarios.map((x: Obj) => [x.inventario_id, x]));
    expect(porId[10].costo_total).toBe(1234.5);
    expect(porId[10].costo_total_neto).toBe(1000);
    expect(porId[11].costo_total).toBe(50);
    expect(porId[11]).not.toHaveProperty("costo_total_neto");
  });

  it("ST6 the documented data_* spellings are read when date_* is absent", async () => {
    const fila = {
      inventory_id: "10", storage_id: "1", data_start: "2026-11-03 08:00:00", data_end: "2026-11-03 20:00:00",
      data_set: "2026-11-02 23:00:00", data_inventory: "2026-11-03 21:00:00", sum: "100", inventory_status: "0",
    };
    const { api } = apiFalsa({ inventarios: { "1": [fila] } });
    const r: any = await L.inventarios(api, { cuenta: "cafe-01", storage_id: 1 });
    expect(r.inventarios[0]).toMatchObject({ inicio: "2026-11-03 08:00:00", fin: "2026-11-03 20:00:00", fecha_inventario: "2026-11-03 21:00:00", retroactiva: true });
  });

  it("ST7 desde and hasta filter on the day of fin, both inclusive", async () => {
    const { api } = apiFalsa({
      inventarios: {
        "1": [
          inv({ inventory_id: "1", date_start: "2026-10-31 08:00:00", date_end: "2026-10-31 23:59:59" }),
          inv({ inventory_id: "2", date_start: "2026-10-31 08:00:00", date_end: "2026-11-01 00:00:00" }),
          inv({ inventory_id: "3", date_start: "2026-11-02 08:00:00", date_end: "2026-11-02 23:59:59" }),
          inv({ inventory_id: "4", date_start: "2026-11-02 08:00:00", date_end: "2026-11-03 00:00:00" }),
        ],
      },
    });
    const r: any = await L.inventarios(api, { cuenta: "cafe-01", storage_id: 1, desde: "2026-11-01", hasta: "2026-11-02" });
    expect(r.inventarios.map((x: Obj) => x.inventario_id)).toEqual([3, 2]);
  });

  it("ST8 rows are sorted by fin descending, then inventario_id descending", async () => {
    const { api } = apiFalsa({
      inventarios: {
        "1": [inv({ inventory_id: "5", date_end: "2026-11-02 20:00:00" }), inv({ inventory_id: "9", date_end: "2026-11-01 20:00:00" })],
        "2": [inv({ inventory_id: "7", storage_id: "2", date_end: "2026-11-02 20:00:00" }), inv({ inventory_id: "3", storage_id: "2", date_end: "2026-11-03 09:00:00" })],
      },
    });
    const r: any = await L.inventarios(api, { cuenta: "cafe-01" });
    expect(r.inventarios.map((x: Obj) => x.inventario_id)).toEqual([3, 7, 5, 9]);
  });

  it("ST9 an unknown storage_id fails with the storages as id=name before any stocktake call", async () => {
    const { api, get } = apiFalsa({ inventarios: { "99": [inv({ storage_id: "99" })] } });
    await expect(L.inventarios(api, { cuenta: "cafe-01", storage_id: 99 })).rejects.toThrow(/Almacén 99 no existe.*1=Almacén central, 2=Barra/);
    expect(llamadas(get, "storage.getStorageInventories")).toEqual([]);
  });

  it("ST10 with storage_id only that storage is queried", async () => {
    const { api, get } = apiFalsa({ inventarios: { "1": [inv({ inventory_id: "10" })], "2": [inv({ inventory_id: "20", storage_id: "2" })] } });
    const r: any = await L.inventarios(api, { cuenta: "cafe-01", storage_id: 2 });
    expect(llamadas(get, "storage.getStorageInventories")).toEqual([{ storage_id: 2 }]);
    expect(r.inventarios.map((x: Obj) => x.inventario_id)).toEqual([20]);
  });

  it("ST11 rows of the same day are sorted by the full date-time of fin, not by id", async () => {
    const { api } = apiFalsa({
      inventarios: { "1": [inv({ inventory_id: "9", date_end: "2026-11-02 09:00:00" }), inv({ inventory_id: "5", date_end: "2026-11-02 20:00:00" })] },
    });
    const r: any = await L.inventarios(api, { cuenta: "cafe-01", storage_id: 1 });
    expect(r.inventarios.map((x: Obj) => x.inventario_id)).toEqual([5, 9]);
  });

  it("ST12 a zero or empty inicio and fin read as null", async () => {
    const { api } = apiFalsa({
      inventarios: {
        "1": [
          inv({ inventory_id: "10", date_start: "0000-00-00 00:00:00", date_end: "" }),
          inv({ inventory_id: "11", date_start: "", date_end: "0000-00-00 00:00:00" }),
        ],
      },
    });
    const r: any = await L.inventarios(api, { cuenta: "cafe-01", storage_id: 1 });
    for (const x of r.inventarios) expect([x.inventario_id, x.inicio, x.fin]).toEqual([x.inventario_id, null, null]);
    expect(r.total).toBe(2);
  });

  describe("ST13 a row without fin is filtered and sorted by inicio; a row with neither is kept only without desde and hasta", () => {
    const sinFin = inv({ inventory_id: "1", date_start: "2026-11-03 08:00:00", date_end: "0000-00-00 00:00:00" });
    const conFin = inv({ inventory_id: "2", date_start: "2026-11-02 08:00:00", date_end: "2026-11-02 20:00:00" });
    const sinFechas = inv({ inventory_id: "3", date_start: "", date_end: "" });
    const anterior = inv({ inventory_id: "4", date_start: "2026-11-01 08:00:00", date_end: "2026-11-01 10:00:00" });
    const db = { inventarios: { "1": [sinFechas, anterior, conFin, sinFin] } };
    it.each([
      ["no range", {}, [1, 2, 4, 3]],
      ["desde", { desde: "2026-11-02" }, [1, 2]],
      ["hasta", { hasta: "2026-11-02" }, [2, 4]],
      ["desde and hasta", { desde: "2026-11-03", hasta: "2026-11-03" }, [1]],
    ])("with %s", async (_caso, rango, esperados) => {
      const { api } = apiFalsa(db);
      const r: any = await L.inventarios(api, { cuenta: "cafe-01", storage_id: 1, ...rango });
      expect(r.inventarios.map((x: Obj) => x.inventario_id)).toEqual(esperados);
    });
  });
});

/** A stocktake result as the docs show it: object-keyed ingredients and prepacks, an array of manufactures. */
const resultado = (): Obj => ({
  ingredients: {
    "1": { item_id: "11", item: "Leche", unit: "l", estimatedrest: "10", factrest: "8", difference: "-2", diffcurrency: "-40", primecost: "20" },
    "2": { item_id: "12", item: "Azúcar", unit: "kg", estimatedrest: "5", factrest: "5", difference: "0", diffcurrency: "0", primecost: "30" },
    "3": { item_id: "13", item: "Café", unit: "kg", estimatedrest: "2", factrest: "2.5", difference: "0.5", diffcurrency: "150", primecost: "300" },
    "4": { item_id: "14", item: "Vasos", unit: "p", estimatedrest: "100", factrest: "''", difference: "''", diffcurrency: "''", primecost: "1.5" },
  },
  manufactures: [{ item_id: "70", item: "Base", unit: "kg", estimatedrest: "1", factrest: "0.8", difference: "-0.2", diffcurrency: "-60", primecost: "300" }],
  prepacks: {
    "1": { product_id: "70", product_name: "Base", type: "1", factrest: "0.8" },
    "2": { product_id: "40", product_name: "Latte", type: "2", factrest: "0" },
    "3": { product_id: "41", product_name: "Moka", type: "2", factrest: "''" },
  },
});
const ids = (g: Obj) => g.renglones.map((x: Obj) => x.id);

describe("stocktake_result", () => {
  it("SR1 reads storage.getInventoryIngredients by inventory_id and normalizes object and array groups alike", async () => {
    const comoObjeto = apiFalsa({ "storage.getInventoryIngredients": resultado() });
    const r1: any = await L.inventarioResultado(comoObjeto.api, { cuenta: "cafe-01", inventario_id: 55, solo_diferencias: false });
    expect(llamadas(comoObjeto.get, "storage.getInventoryIngredients")).toEqual([{ inventory_id: 55 }]);
    expect(ids(r1.insumos)).toEqual([13, 11, 12, 14]);
    expect(ids(r1.producciones)).toEqual([70]);
    expect(ids(r1.platillos_y_precocinados)).toEqual([70, 40, 41]);

    const d = resultado();
    const invertido = { ingredients: Object.values(d.ingredients), manufactures: { "1": d.manufactures[0] }, prepacks: Object.values(d.prepacks) };
    const comoLista = apiFalsa({ "storage.getInventoryIngredients": invertido });
    const r2: any = await L.inventarioResultado(comoLista.api, { cuenta: "cafe-01", inventario_id: 55, solo_diferencias: false });
    expect(r2.insumos).toEqual(r1.insumos);
    expect(r2.producciones).toEqual(r1.producciones);
    expect(r2.platillos_y_precocinados).toEqual(r1.platillos_y_precocinados);
    expect(r1.insumos.renglones[1]).toEqual({ id: 11, nombre: "Leche", unidad: "l", calculado: 10, real: 8, diferencia: -2, diferencia_costo: -40, costo_unitario: 20 });
  });

  it("SR2 a value that is '' (two quotes), empty or not a number becomes null; a counted zero stays 0", async () => {
    const d = {
      ingredients: [
        { item_id: "14", item: "Vasos", unit: "p", estimatedrest: "100", factrest: "''", difference: "''", diffcurrency: "''", primecost: "1.5" },
        { item_id: "15", item: "Tapas", unit: "p", estimatedrest: "", factrest: "", difference: "abc", diffcurrency: "", primecost: "" },
        { item_id: "16", item: "Popotes", unit: "p", estimatedrest: "0", factrest: "0", difference: "0", diffcurrency: "0", primecost: "0" },
      ],
      manufactures: [],
      prepacks: [{ product_id: "41", product_name: "Moka", type: "2", factrest: "''" }],
    };
    const { api } = apiFalsa({ "storage.getInventoryIngredients": d });
    const r: any = await L.inventarioResultado(api, { cuenta: "cafe-01", inventario_id: 55, solo_diferencias: false });
    const porId = Object.fromEntries(r.insumos.renglones.map((x: Obj) => [x.id, x]));
    expect(porId[14]).toMatchObject({ calculado: 100, real: null, diferencia: null, diferencia_costo: null, costo_unitario: 1.5 });
    expect(porId[15]).toMatchObject({ calculado: null, real: null, diferencia: null, diferencia_costo: null, costo_unitario: null });
    expect(porId[16]).toMatchObject({ calculado: 0, real: 0, diferencia: 0, diferencia_costo: 0, costo_unitario: 0 });
    expect(r.platillos_y_precocinados.renglones[0].real).toBeNull();
  });

  it("SR3 solo_diferencias (default true) keeps rows with a non-zero difference and prepacks with a non-zero count", async () => {
    const { api } = apiFalsa({ "storage.getInventoryIngredients": resultado() });
    const r: any = await L.inventarioResultado(api, { cuenta: "cafe-01", inventario_id: 55 });
    expect(ids(r.insumos)).toEqual([13, 11]);
    expect(ids(r.producciones)).toEqual([70]);
    expect(ids(r.platillos_y_precocinados)).toEqual([70]);
    const todo: any = await L.inventarioResultado(api, { cuenta: "cafe-01", inventario_id: 55, solo_diferencias: false });
    expect(ids(todo.insumos)).toEqual([13, 11, 12, 14]);
    expect(ids(todo.platillos_y_precocinados)).toEqual([70, 40, 41]);
  });

  it("SR4 ingredient and manufacture rows are sorted by the absolute diferencia_costo descending, nulls last", async () => {
    const fila = (id: string, diff: string) => ({ item_id: id, item: `I${id}`, unit: "kg", estimatedrest: "1", factrest: "1", difference: "1", diffcurrency: diff, primecost: "1" });
    const d = { ingredients: [fila("1", "-5"), fila("2", "''"), fila("3", "100"), fila("4", "-200")], manufactures: [fila("8", "''"), fila("9", "-3")], prepacks: [] };
    const { api } = apiFalsa({ "storage.getInventoryIngredients": d });
    const r: any = await L.inventarioResultado(api, { cuenta: "cafe-01", inventario_id: 55 });
    expect(ids(r.insumos)).toEqual([4, 3, 1, 2]);
    expect(ids(r.producciones)).toEqual([9, 8]);
  });

  it("SR5 limite applies per group; each group reports its total before the limit and whether it was cut", async () => {
    const { api } = apiFalsa({ "storage.getInventoryIngredients": resultado() });
    const r: any = await L.inventarioResultado(api, { cuenta: "cafe-01", inventario_id: 55, limite: 1 });
    expect(r.insumos).toMatchObject({ total: 2, truncado: true });
    expect(ids(r.insumos)).toEqual([13]);
    expect(r.producciones).toMatchObject({ total: 1, truncado: false });
    expect(ids(r.producciones)).toEqual([70]);
  });

  it("SR6 totals cover every ingredient and manufacture row, before the filter and the limit", async () => {
    const { api } = apiFalsa({ "storage.getInventoryIngredients": resultado() });
    const r: any = await L.inventarioResultado(api, { cuenta: "cafe-01", inventario_id: 55, limite: 1 });
    expect(r.totales).toEqual({ faltante_costo: -100, sobrante_costo: 150, neto: 50, lineas_contadas: 4 });
    expect(r).not.toHaveProperty("aviso");
  });

  it("SR7 a stocktake with no counted ingredient, manufacture or prepack carries the notice that it may not be conducted yet", async () => {
    const d = resultado();
    for (const x of [...Object.values(d.ingredients as Obj), ...d.manufactures, ...Object.values(d.prepacks as Obj)]) x.factrest = "''";
    const { api } = apiFalsa({ "storage.getInventoryIngredients": d });
    const r: any = await L.inventarioResultado(api, { cuenta: "cafe-01", inventario_id: 55 });
    expect(r.totales.lineas_contadas).toBe(0);
    expect(r.aviso).toBe("El inventario no tiene ningún insumo ni producción contado: puede que todavía no se haya realizado en Póster.");
  });

  it("SR9 the notice is not shown when a prepack row has a non-zero count", async () => {
    const d = resultado();
    for (const x of [...Object.values(d.ingredients as Obj), ...d.manufactures]) x.factrest = "''";
    const { api } = apiFalsa({ "storage.getInventoryIngredients": d });
    const r: any = await L.inventarioResultado(api, { cuenta: "cafe-01", inventario_id: 55 });
    expect(r.totales.lineas_contadas).toBe(0);
    expect(r.platillos_y_precocinados.renglones).toContainEqual({ id: 70, nombre: "Base", tipo: "precocinado", real: 0.8 });
    expect(r).not.toHaveProperty("aviso");
  });

  it.each([
    ["an object without any group", { error_text: "x" }],
    ["an empty object", {}],
    ["a list", []],
    ["text", "sin datos"],
  ])("SR10 a reply that is %s fails: the stocktake does not exist or Poster returned no rows", async (_caso, respuesta) => {
    const { api } = apiFalsa({ "storage.getInventoryIngredients": respuesta });
    await expect(L.inventarioResultado(api, { cuenta: "cafe-01", inventario_id: 55 })).rejects.toThrow(
      "Inventario 55 no existe en cafe-01 o Póster no devolvió renglones",
    );
  });

  it("SR11 totals are rounded to 6 decimals", async () => {
    const fila = (id: string, diff: string) => ({ item_id: id, item: `I${id}`, unit: "kg", estimatedrest: "1", factrest: "1", difference: "1", diffcurrency: diff, primecost: "1" });
    const d = { ingredients: [fila("1", "-0.123456"), fila("2", "0.000123")], manufactures: [fila("3", "-0.0000004")], prepacks: [] };
    const { api } = apiFalsa({ "storage.getInventoryIngredients": d });
    const r: any = await L.inventarioResultado(api, { cuenta: "cafe-01", inventario_id: 55 });
    expect(r.totales).toEqual({ faltante_costo: -0.123456, sobrante_costo: 0.000123, neto: -0.123333, lineas_contadas: 3 });
  });

  it("SR12 without limite each group keeps 200 rows, prepacks included", async () => {
    const n = 201;
    const d = {
      ingredients: Array.from({ length: n }, (_, i) => ({ item_id: String(i + 1), item: `I${i + 1}`, unit: "kg", estimatedrest: "1", factrest: "2", difference: "1", diffcurrency: String(i + 1), primecost: "1" })),
      manufactures: [],
      prepacks: Array.from({ length: n }, (_, i) => ({ product_id: String(i + 1), product_name: `P${i + 1}`, type: "1", factrest: "1" })),
    };
    const { api } = apiFalsa({ "storage.getInventoryIngredients": d });
    const r: any = await L.inventarioResultado(api, { cuenta: "cafe-01", inventario_id: 55 });
    for (const g of [r.insumos, r.platillos_y_precocinados]) {
      expect(g).toMatchObject({ total: n, truncado: true });
      expect(g.renglones).toHaveLength(200);
    }
    expect(r.producciones).toMatchObject({ total: 0, truncado: false, renglones: [] });
  });

  it("SR8 a prepack row maps type 1 to precocinado and type 2 to platillo", async () => {
    const { api } = apiFalsa({ "storage.getInventoryIngredients": resultado() });
    const r: any = await L.inventarioResultado(api, { cuenta: "cafe-01", inventario_id: 55, solo_diferencias: false });
    expect(r.platillos_y_precocinados.renglones).toEqual([
      { id: 70, nombre: "Base", tipo: "precocinado", real: 0.8 },
      { id: 40, nombre: "Latte", tipo: "platillo", real: 0 },
      { id: 41, nombre: "Moka", tipo: "platillo", real: null },
    ]);
  });
});

/** Leftovers as `storage.getStorageLeftovers` documents them, with stock and cost fields the sheet must drop. */
const SALDOS = [
  { ingredient_id: "12", ingredient_name: "Azúcar", ingredient_unit: "kg", ingredients_type: "1", hidden: "0", ingredient_left: "5", limit_value: "1", prime_cost: "3000", storage_ingredient_sum: "15000" },
  { ingredient_id: "41", ingredient_name: "Agua embotellada", ingredient_unit: "p", ingredients_type: "2", hidden: "0", ingredient_left: "24", limit_value: "0", prime_cost: "1000", storage_ingredient_sum: "24000" },
  { ingredient_id: "15", ingredient_name: "Canela", ingredient_unit: "kg", ingredients_type: "1", hidden: "1", ingredient_left: "0", limit_value: "0", prime_cost: "9000", storage_ingredient_sum: "0" },
  { ingredient_id: "11", ingredient_name: "Leche", ingredient_unit: "l", ingredients_type: "1", hidden: "0", ingredient_left: "-2", limit_value: "3", prime_cost: "2000", storage_ingredient_sum: "-4000" },
];

describe("count_sheet", () => {
  it("CS1 reads storage.getStorageLeftovers with zero_leftovers and returns only id, nombre, unidad and tipo", async () => {
    const { api, get } = apiFalsa({ "storage.getStorageLeftovers": SALDOS });
    const r: any = await L.hojaConteo(api, { cuenta: "cafe-01", storage_id: 1 });
    expect(llamadas(get, "storage.getStorageLeftovers")).toEqual([{ storage_id: 1, zero_leftovers: "true" }]);
    expect(r.renglones.length).toBeGreaterThan(0);
    for (const x of r.renglones) expect(Object.keys(x).sort()).toEqual(["id", "nombre", "tipo", "unidad"]);
    expect(r.renglones.find((x: Obj) => x.id === 11)).toEqual({ id: 11, nombre: "Leche", unidad: "l", tipo: "insumo" });
  });

  it("CS2 hidden rows are left out unless incluir_ocultos", async () => {
    const { api } = apiFalsa({ "storage.getStorageLeftovers": SALDOS });
    const sin: any = await L.hojaConteo(api, { cuenta: "cafe-01", storage_id: 1 });
    expect(ids(sin)).not.toContain(15);
    const con: any = await L.hojaConteo(api, { cuenta: "cafe-01", storage_id: 1, incluir_ocultos: true });
    expect(ids(con)).toContain(15);
  });

  it("CS3 rows are sorted by nombre", async () => {
    const { api } = apiFalsa({ "storage.getStorageLeftovers": SALDOS });
    const r: any = await L.hojaConteo(api, { cuenta: "cafe-01", storage_id: 1, incluir_ocultos: true });
    expect(r.renglones.map((x: Obj) => x.nombre)).toEqual(["Agua embotellada", "Azúcar", "Canela", "Leche"]);
  });

  it("CS4 an unknown storage_id fails with the storages as id=name before the leftovers call", async () => {
    const { api, get } = apiFalsa({ "storage.getStorageLeftovers": SALDOS });
    await expect(L.hojaConteo(api, { cuenta: "cafe-01", storage_id: 99 })).rejects.toThrow(/Almacén 99 no existe.*1=Almacén central, 2=Barra/);
    expect(llamadas(get, "storage.getStorageLeftovers")).toEqual([]);
  });

  it("CS5 ingredients_type 1 reads as insumo and 2 as producto", async () => {
    const { api } = apiFalsa({ "storage.getStorageLeftovers": SALDOS });
    const r: any = await L.hojaConteo(api, { cuenta: "cafe-01", storage_id: 1 });
    expect(Object.fromEntries(r.renglones.map((x: Obj) => [x.id, x.tipo]))).toEqual({ 41: "producto", 12: "insumo", 11: "insumo" });
  });

  it("CS6 the whole response carries no stock or cost field at any level: exact keys at the top and in every row", async () => {
    const { api } = apiFalsa({ "storage.getStorageLeftovers": SALDOS });
    const r: any = await L.hojaConteo(api, { cuenta: "cafe-01", storage_id: 1, incluir_ocultos: true });
    expect(Object.keys(r).sort()).toEqual(["almacen", "cuenta", "renglones", "storage_id", "total"]);
    expect(r).toMatchObject({ cuenta: "cafe-01", storage_id: 1, almacen: "Almacén central", total: 4 });
    expect(r.renglones).toHaveLength(4);
    for (const x of r.renglones) {
      expect(Object.keys(x).sort()).toEqual(["id", "nombre", "tipo", "unidad"]);
      for (const v of Object.values(x)) expect(v === null || typeof v !== "object").toBe(true);
    }
  });
});

// ── Through the MCP server ──
const CONFIGURACION = ["POSTER_ACCOUNTS", "DEFAULT_WRITE_ACCOUNT", "WRITE_DEFAULT_ACCOUNTS", "TIMEZONE", "OWNER_NAME", "NETWORK_NAME", "SERVICE_NAME", "OAUTH_SUBJECT", "TOKEN_SOURCE", "POSTER_MYSQL_URL", "AUDIT_DIR"];
const temporales: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
  for (const d of temporales.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Server from fresh modules on accounts tienda-a and tienda-b, with the fake API and an in-memory client. */
async function cargar(db: Obj) {
  vi.resetModules();
  const auditDir = mkdtempSync(path.join(os.tmpdir(), "poster-mcp-inventarios-"));
  temporales.push(auditDir);
  for (const k of CONFIGURACION) vi.stubEnv(k, undefined);
  for (const [k, v] of Object.entries({ POSTER_ACCOUNTS: "tienda-a,tienda-b", WRITE_DEFAULT_ACCOUNTS: "tienda-b", AUDIT_DIR: auditDir })) vi.stubEnv(k, v);
  vi.spyOn(console, "log").mockImplementation(() => {});
  const { crearServidorMcp } = await import("../src/mcp.js");
  const { api, get, post } = apiFalsa(db);
  const [ladoCliente, ladoServidor] = InMemoryTransport.createLinkedPair();
  await crearServidorMcp(api).connect(ladoServidor);
  const cliente = new Client({ name: "prueba", version: "0.0.0" });
  await cliente.connect(ladoCliente);
  const llamar = async (name: string, args: Obj) => {
    const r = await cliente.callTool({ name, arguments: args });
    return { isError: r.isError === true, texto: (r.content as Array<{ text: string }>)[0]?.text ?? "" };
  };
  return { cliente, llamar, get, post };
}

const LLAMADAS: Array<[string, Obj]> = [
  ["list_stocktakes", {}],
  ["stocktake_result", { inventario_id: 55 }],
  ["count_sheet", { storage_id: 1 }],
];
const DB_MCP: Obj = { inventarios: { "1": [inv()] }, "storage.getInventoryIngredients": resultado(), "storage.getStorageLeftovers": SALDOS };

describe("stocktake tools through the MCP server", () => {
  it("SM1 the three tools are listed with the read-only annotations", async () => {
    const { cliente } = await cargar(DB_MCP);
    const herramientas = (await cliente.listTools()).tools.filter((t) => LLAMADAS.some(([n]) => n === t.name));
    expect(herramientas.map((t) => t.name).sort()).toEqual(["count_sheet", "list_stocktakes", "stocktake_result"]);
    for (const t of herramientas) expect(t.annotations, t.name).toEqual({ readOnlyHint: true, openWorldHint: true });
  });

  it.each(LLAMADAS)("SM2 %s reads through get only", async (nombre, args) => {
    const { llamar, get, post } = await cargar(DB_MCP);
    const r = await llamar(nombre, { cuenta: "tienda-a", ...args });
    expect(r.isError, r.texto).toBe(false);
    expect(JSON.parse(r.texto)).toMatchObject({ cuenta: "tienda-a" });
    expect(get).toHaveBeenCalled();
    for (const c of get.mock.calls) expect(c[0]).toBe("tienda-a");
    expect(post).not.toHaveBeenCalled();
  });

  it.each(LLAMADAS)("SM3 %s refuses an account outside the allow-list without calling Poster", async (nombre, args) => {
    const { llamar, get, post } = await cargar(DB_MCP);
    const r = await llamar(nombre, { cuenta: "tienda-z", ...args });
    expect(r.isError).toBe(true);
    expect(get).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });
});
