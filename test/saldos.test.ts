// stock_levels: storage.getStorageLeftovers documents ingredient_left as the total of all storages and
// storage_ingredient_left as the balance of the requested storage, returned when storage_id is applied.
// With storage_id the tool reads the storage's balance. Poster is faked; there is no network.
import { describe, it, expect, vi } from "vitest";
import * as L from "../src/tools/lectura.js";
import type { PosterApi } from "../src/poster.js";

type Obj = Record<string, any>;

/** Fake Poster API: every method answers `db[metodo]` (an empty list when absent). `post` must never be called by a read. */
function apiFalsa(db: Obj) {
  const get = vi.fn(async (_cuenta: string, metodo: string, _params?: Obj) => structuredClone(db[metodo] ?? []));
  const post = vi.fn(async () => ({ error: 1 }));
  return { api: { get, post } as unknown as PosterApi, get, post };
}

/** Leftovers whose total (`ingredient_left`) and storage balance (`storage_ingredient_left`) differ in every row. */
const SALDOS = [
  { ingredient_id: "21", ingredient_name: "Jabón", ingredient_unit: "p", ingredient_left: "8", storage_ingredient_left: "6", limit_value: "0", prime_cost: "500", storage_ingredient_sum: "3000" },
  { ingredient_id: "22", ingredient_name: "Leche", ingredient_unit: "l", ingredient_left: "12", storage_ingredient_left: "-2.5", limit_value: "3", prime_cost: "2000", storage_ingredient_sum: "0" },
  // No storage_ingredient_left at all.
  { ingredient_id: "23", ingredient_name: "Escoba", ingredient_unit: "p", ingredient_left: "-4", limit_value: "0", prime_cost: "1000", storage_ingredient_sum: "0" },
];

const existencias = (r: Obj) => Object.fromEntries(r.saldos.map((x: Obj) => [x.id, x.existencia]));

describe("stock_levels", () => {
  it("SL1 with storage_id existencia is the balance of that storage, storage_ingredient_left", async () => {
    const { api, get, post } = apiFalsa({ "storage.getStorageLeftovers": SALDOS });
    const r: any = await L.saldos(api, { cuenta: "cafe-01", storage_id: 2 });
    expect(get.mock.calls.map((c) => [c[1], c[2]])).toEqual([["storage.getStorageLeftovers", { storage_id: 2 }]]);
    expect(post).not.toHaveBeenCalled();
    expect(existencias(r)).toMatchObject({ 21: 6, 22: -2.5 });
  });

  it("SL2 with storage_id a row without storage_ingredient_left falls back to ingredient_left", async () => {
    const { api } = apiFalsa({ "storage.getStorageLeftovers": SALDOS });
    const r: any = await L.saldos(api, { cuenta: "cafe-01", storage_id: 2 });
    expect(existencias(r)[23]).toBe(-4);
  });

  it("SL3 without storage_id existencia stays ingredient_left, the total of all storages", async () => {
    const { api, get } = apiFalsa({ "storage.getStorageLeftovers": SALDOS });
    const r: any = await L.saldos(api, { cuenta: "cafe-01" });
    expect(get.mock.calls.map((c) => [c[1], c[2]])).toEqual([["storage.getStorageLeftovers", {}]]);
    expect(existencias(r)).toEqual({ 21: 8, 22: 12, 23: -4 });
    expect(r.storage_id).toBe("todos");
  });

  it("SL4 with storage_id solo_negativos keeps the rows that are negative in that storage", async () => {
    const { api } = apiFalsa({ "storage.getStorageLeftovers": SALDOS });
    const r: any = await L.saldos(api, { cuenta: "cafe-01", storage_id: 2, solo_negativos: true });
    expect(r.saldos.map((x: Obj) => x.id)).toEqual([22, 23]);
  });
});
