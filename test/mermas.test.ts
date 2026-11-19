// create_write_off (storage.createWriteOff): dry-run by default, every check before the single send,
// the JSON payload byte for byte, the same-day duplicate notice and the read-back with storage.getWaste.
// Poster is faked; there is no network.
import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import * as W from "../src/tools/escritura.js";
import { config } from "../src/config.js";
import type { PosterApi } from "../src/poster.js";

type Obj = Record<string, any>;

afterEach(() => {
  vi.useRealTimers();
});

const LECTURAS: Obj = {
  "storage.getStorages": [
    { storage_id: "1", storage_name: "Almacén central", delete: "0" },
    { storage_id: "2", storage_name: "Barra", delete: "0" },
    { storage_id: "9", storage_name: "Bodega cerrada", delete: "1" },
  ],
  "storage.getWasteReasons": [
    { reason_id: "3", name: "Caducado" },
    { reason_id: "4", name: "Roto" },
  ],
  "menu.getIngredients": [{ ingredient_id: "11", ingredient_name: "Leche", ingredient_unit: "l" }],
  "menu.getProducts": [
    { product_id: "40", product_name: "Latte", type: "2" },
    { product_id: "41", product_name: "Agua embotellada", type: "3" },
    { product_id: "43", product_name: "Galleta", type: "1" },
  ],
  "menu.getPrepacks": [{ product_id: "70", product_name: "Base", unit: "kg" }],
  "storage.getWastes": [],
};

/** The write-off as storage.getWaste documents it, matching LINEAS on storage 1 with reason 3. */
const merma = (o: Obj = {}): Obj => ({
  waste_id: 501,
  total_sum: "1250",
  storage_id: "1",
  date: "2026-11-02 09:30:00",
  reason_id: "3",
  reason_name: "Caducado",
  elements: [
    { type: 10, product_id: 0, modificator_id: 0, count: 1, ingredients: [{ ingredient_id: "11", weight: "0.5", unit: "l", cost: "1000" }] },
    { type: 1, product_id: "41", modificator_id: 0, count: "2", ingredients: [] },
  ],
  ...o,
});

/** Fake Poster API: reads from `lecturas`, storage.getWaste answers `waste`, the write answers `respuesta`. */
function apiMerma(o: { lecturas?: Obj; waste?: unknown; respuesta?: Obj } = {}) {
  const lecturas = { ...LECTURAS, ...o.lecturas };
  const get = vi.fn(async (_cuenta: string, metodo: string, _params?: Obj) => {
    if (metodo === "storage.getWaste") return structuredClone("waste" in o ? o.waste : merma());
    return structuredClone(lecturas[metodo] ?? []);
  });
  const post = vi.fn(async (_cuenta: string, _metodo: string, _cuerpo: Obj, _opciones?: Obj) => o.respuesta ?? { response: 501 });
  return { api: { get, post } as unknown as PosterApi, get, post };
}
const ctx = (api: PosterApi) => ({ api, actor: "prueba" });
/** Calls of `metodo` on the fake API, as their params. */
const llamadas = (get: ReturnType<typeof vi.fn>, metodo: string) => get.mock.calls.filter((c) => c[1] === metodo).map((c) => c[2]);

const FECHA = "2026-11-02 09:30:00";
const LINEAS = [
  { id: 11, cantidad: 0.5 },
  { id: 41, tipo: "producto" as const, cantidad: 2 },
];
type Args = Parameters<typeof W.crearMerma>[1];
const args = (extra: Partial<Args> = {}): Args => ({ cuenta: "cafe-04", storage_id: 1, fecha: FECHA, razon_id: 3, renglones: LINEAS, ...extra });

/** The dry-run changes as campo → despues. */
const despues = (r: Obj) => Object.fromEntries(r.cambios.map((c: Obj) => [c.campo, c.despues]));
/** Local "YYYY-MM-DD HH:MM:SS" in the configured time zone, `ms` after now. */
const local = (ms = 0) => new Date(Date.now() + ms).toLocaleString("sv-SE", { timeZone: config.timezone }).slice(0, 19);
const fijarAhora = () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-19T18:00:00Z"));
};

describe("create_write_off · dry-run", () => {
  it("WO1 a dry-run sends nothing and shows the storage name, date, reason id · name and each line's name, type, quantity and unit", async () => {
    const { api, post } = apiMerma();
    const r: any = await W.crearMerma(ctx(api), args({ renglones: [...LINEAS, { id: 40, tipo: "platillo", cantidad: 1 }, { id: 70, tipo: "precocinado", cantidad: 0.25 }] }));
    expect(post).not.toHaveBeenCalled();
    expect(r).toMatchObject({ modo: "dry-run", metodo: "storage.createWriteOff" });
    expect(despues(r)).toMatchObject({
      almacen: "Almacén central",
      fecha: FECHA,
      razon: "3 · Caducado",
      renglones: [
        { nombre: "Leche", tipo: "insumo", cantidad: 0.5, unidad: "l" },
        { nombre: "Agua embotellada", tipo: "producto", cantidad: 2, unidad: null },
        { nombre: "Latte", tipo: "platillo", cantidad: 1, unidad: null },
        { nombre: "Base", tipo: "precocinado", cantidad: 0.25, unidad: "kg" },
      ],
    });
  });

  it("WO2 the dry-run notices say Poster computes the cost and the contract is not confirmed on a live account", async () => {
    const { api } = apiMerma();
    const r: any = await W.crearMerma(ctx(api), args());
    const avisos = r.avisos.join(" | ");
    expect(avisos).toMatch(/Póster calcula el costo/);
    expect(avisos).toMatch(/no está confirmado en una cuenta real/);
  });

  it("WO3 without razon_id the reason reads as none and no reason_id is sent", async () => {
    const { api } = apiMerma();
    const r: any = await W.crearMerma(ctx(api), args({ razon_id: undefined }));
    expect(despues(r).razon).toBe("ninguna");
    expect(r.payload).not.toHaveProperty("reason_id");
    expect(r.payload.write_off).not.toHaveProperty("reason_id");
  });

  it("WO4 without fecha the date is now in the configured time zone", async () => {
    fijarAhora();
    const { api } = apiMerma();
    const r: any = await W.crearMerma(ctx(api), args({ fecha: undefined }));
    expect(r.payload.date).toBe(local());
    expect(r.payload.write_off.date).toBe(local());
  });
});

describe("create_write_off · payload", () => {
  it("WO5 confirm sends exactly one storage.createWriteOff as JSON, byte for byte in keys and types", async () => {
    const { api, post } = apiMerma();
    await W.crearMerma(ctx(api), args({
      confirm: true,
      renglones: [
        { id: 11, cantidad: 0.5, comentario: "Se cortó" },
        { id: 41, tipo: "producto", cantidad: 2 },
        { id: 40, tipo: "platillo", cantidad: 1 },
        { id: 70, tipo: "precocinado", cantidad: 0.25 },
      ],
    }));
    expect(post).toHaveBeenCalledTimes(1);
    const [cuenta, metodo, cuerpo, opciones] = post.mock.calls[0];
    expect(cuenta).toBe("cafe-04");
    expect(metodo).toBe("storage.createWriteOff");
    expect(opciones?.form).not.toBe(true);
    expect(JSON.stringify(cuerpo)).toBe(
      JSON.stringify({
        write_off: { storage_id: 1, date: FECHA, reason_id: 3 },
        storage_id: 1,
        date: FECHA,
        reason_id: 3,
        ingredient: [
          { id: 11, type: 4, weight: 0.5, reason: "Se cortó" },
          { id: 41, type: 1, weight: 2 },
          { id: 40, type: 2, weight: 1 },
          { id: 70, type: 3, weight: 0.25 },
        ],
      }),
    );
  });

  it("WO6 no line carries sum", async () => {
    const { api, post } = apiMerma();
    await W.crearMerma(ctx(api), args({ confirm: true }));
    for (const l of (post.mock.calls[0][2] as Obj).ingredient) expect(l).not.toHaveProperty("sum");
  });

  it("WO28 a blank comentario sends no reason and a padded one is sent trimmed", async () => {
    const { api, post } = apiMerma();
    const r: any = await W.crearMerma(ctx(api), args({
      confirm: true,
      renglones: [
        { id: 11, cantidad: 0.5, comentario: "   " },
        { id: 41, tipo: "producto", cantidad: 2, comentario: "  Botella rota \n" },
      ],
    }));
    expect(r.modo).toBe("aplicado");
    const [blanco, relleno] = (post.mock.calls[0][2] as Obj).ingredient;
    expect(blanco).toEqual({ id: 11, type: 4, weight: 0.5 });
    expect(relleno).toEqual({ id: 41, type: 1, weight: 2, reason: "Botella rota" });
  });
});

describe("create_write_off · checks before sending", () => {
  const RECHAZOS: Array<[string, Partial<Args>, RegExp]> = [
    ["an unknown storage", { storage_id: 99 }, /Almacén 99 no existe/],
    ["a deleted storage", { storage_id: 9 }, /Almacén 9 no existe/],
    ["an unknown reason, listing the reasons as id=name", { razon_id: 99 }, /Razón de merma 99 no existe.*3=Caducado, 4=Roto/],
    ["an unknown ingredient", { renglones: [{ id: 99, cantidad: 1 }] }, /Insumo 99 no existe/],
    ["an unknown product", { renglones: [{ id: 99, tipo: "producto", cantidad: 1 }] }, /Producto 99 no existe/],
    ["an unknown dish", { renglones: [{ id: 99, tipo: "platillo", cantidad: 1 }] }, /Platillo 99 no existe/],
    ["a dish line whose product is not a dish", { renglones: [{ id: 41, tipo: "platillo", cantidad: 1 }] }, /no platillo \(2\)/],
    ["a product line whose catalog row is a dish (type 2), pointing to tipo platillo", { renglones: [{ id: 40, tipo: "producto", cantidad: 1 }] }, /"Latte" \(40\) es un platillo: usa tipo: "platillo"/],
    ["an unknown semi-finished product", { renglones: [{ id: 99, tipo: "precocinado", cantidad: 1 }] }, /Precocinado 99 no existe/],
    ["a modifier line, which the server cannot verify", { renglones: [{ id: 5, tipo: "modificador", cantidad: 1 }] }, /Renglón 5: no se registran mermas de tipo modificador porque el servidor no tiene cómo verificar que el modificador exista/],
    ["a zero quantity", { renglones: [{ id: 11, cantidad: 0 }] }, /Cantidad inválida/],
    ["a negative quantity", { renglones: [{ id: 11, cantidad: -1 }] }, /Cantidad inválida/],
    ["a NaN quantity", { renglones: [{ id: 11, cantidad: Number.NaN }] }, /Cantidad inválida/],
    ["an infinite quantity", { renglones: [{ id: 11, cantidad: Number.POSITIVE_INFINITY }] }, /Cantidad inválida/],
    ["a malformed fecha", { fecha: "2026-11-02T09:30:00" }, /Fecha inválida/],
    ["no line", { renglones: [] }, /al menos un renglón/],
  ];

  it.each(RECHAZOS)("WO7 refuses %s and sends nothing", async (_caso, extra, mensaje) => {
    const { api, post } = apiMerma();
    await expect(W.crearMerma(ctx(api), args({ confirm: true, ...extra }))).rejects.toThrow(mensaje);
    expect(post).not.toHaveBeenCalled();
  });

  it("WO8 refuses a fecha 61 s after now in the configured time zone, before any Poster call", async () => {
    fijarAhora();
    const { api, get, post } = apiMerma();
    await expect(W.crearMerma(ctx(api), args({ confirm: true, fecha: local(61_000) }))).rejects.toThrow(/posterior a ahora/);
    expect(get).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });

  it("WO9 accepts a fecha 59 s after now", async () => {
    fijarAhora();
    const { api, post } = apiMerma({ waste: merma({ date: local(59_000) }) });
    const r: any = await W.crearMerma(ctx(api), args({ confirm: true, fecha: local(59_000) }));
    expect(r.modo).toBe("aplicado");
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("WO10 refuses an account outside the write set without permitir_otra_cuenta, and allows it with the flag", async () => {
    const { api, get, post } = apiMerma();
    await expect(W.crearMerma(ctx(api), args({ cuenta: "cafe-02", confirm: true }))).rejects.toThrow(/bloqueada/);
    expect(get).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
    const r: any = await W.crearMerma(ctx(api), args({ cuenta: "cafe-02", permitir_otra_cuenta: true }));
    expect(r.modo).toBe("dry-run");
  });

  const ANTES_DE_LEER: Array<[string, Partial<Args>, RegExp]> = [
    ["a month 13", { fecha: "2026-13-02 09:30:00" }, /Fecha inválida/],
    ["a month 00", { fecha: "2026-00-02 09:30:00" }, /Fecha inválida/],
    ["a day 00", { fecha: "2026-11-00 09:30:00" }, /Fecha inválida/],
    ["31 November", { fecha: "2026-11-31 09:30:00" }, /Fecha inválida/],
    ["29 February of a common year", { fecha: "2026-02-29 09:30:00" }, /Fecha inválida/],
    ["29 February of a century that is not a leap year", { fecha: "2100-02-29 09:30:00" }, /Fecha inválida/],
    ["an hour 24", { fecha: "2026-11-02 24:00:00" }, /Fecha inválida/],
    ["a minute 60", { fecha: "2026-11-02 09:60:00" }, /Fecha inválida/],
    ["a second 60", { fecha: "2026-11-02 09:30:60" }, /Fecha inválida/],
    ["a storage_id 0", { storage_id: 0 }, /storage_id/],
    ["a negative storage_id", { storage_id: -1 }, /storage_id/],
    ["a fractional storage_id", { storage_id: 1.5 }, /storage_id/],
    ["a razon_id 0", { razon_id: 0 }, /razon_id/],
    ["a fractional razon_id", { razon_id: 3.5 }, /razon_id/],
    ["a line id 0", { renglones: [{ id: 0, cantidad: 1 }] }, /id de renglón inválido/],
    ["a negative line id", { renglones: [{ id: -11, cantidad: 1 }] }, /id de renglón inválido/],
    ["a fractional line id", { renglones: [{ id: 11.5, cantidad: 1 }] }, /id de renglón inválido/],
    ["two lines with the same type and id", { renglones: [{ id: 41, tipo: "producto", cantidad: 1 }, { id: 41, tipo: "producto", cantidad: 2 }] }, /producto 41.*une las cantidades en un renglón/],
    ["an ingredient line twice, once with the default type", { renglones: [{ id: 11, cantidad: 0.5 }, { id: 11, tipo: "insumo", cantidad: 0.25 }] }, /insumo 11.*une las cantidades en un renglón/],
  ];

  it.each(ANTES_DE_LEER)("WO22 refuses %s before any Poster call", async (_caso, extra, mensaje) => {
    fijarAhora();
    const { api, get, post } = apiMerma();
    await expect(W.crearMerma(ctx(api), args({ confirm: true, ...extra }))).rejects.toThrow(mensaje);
    expect(get).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });

  it.each(["2024-02-29 10:00:00", "2000-02-29 10:00:00"])("WO23 accepts the leap day %s", async (fecha) => {
    fijarAhora();
    const { api } = apiMerma();
    const r: any = await W.crearMerma(ctx(api), args({ fecha }));
    expect(r.payload.date).toBe(fecha);
  });

  it.each([
    ["storage", { "storage.getStorages": [{ storage_id: "1.0", storage_name: "Almacén central", delete: "0" }] }, {}, /Almacén 1 no existe/],
    ["reason", { "storage.getWasteReasons": [{ reason_id: "3.0", name: "Caducado" }] }, {}, /Razón de merma 3 no existe/],
    ["ingredient", { "menu.getIngredients": [{ ingredient_id: "1.1e1", ingredient_name: "Leche", ingredient_unit: "l" }] }, {}, /Insumo 11 no existe/],
    ["product", { "menu.getProducts": [{ product_id: "0x29", product_name: "Agua embotellada", type: "3" }] }, {}, /Producto 41 no existe/],
    ["semi-finished product", { "menu.getPrepacks": [{ product_id: "70.0", product_name: "Base", unit: "kg" }] }, { renglones: [{ id: 70, tipo: "precocinado" as const, cantidad: 1 }] }, /Precocinado 70 no existe/],
  ])("WO24 a %s row matches only when its own id is a positive integer", async (_caso, lecturas, extra, mensaje) => {
    const { api, post } = apiMerma({ lecturas });
    await expect(W.crearMerma(ctx(api), args({ confirm: true, ...extra }))).rejects.toThrow(mensaje);
    expect(post).not.toHaveBeenCalled();
  });

  it("WO25 product lines whose catalog type is 1 or 3 are accepted as producto", async () => {
    const { api } = apiMerma();
    const r: any = await W.crearMerma(ctx(api), args({ renglones: [{ id: 41, tipo: "producto", cantidad: 2 }, { id: 43, tipo: "producto", cantidad: 1 }] }));
    expect(despues(r).renglones).toEqual([
      { nombre: "Agua embotellada", tipo: "producto", cantidad: 2, unidad: null },
      { nombre: "Galleta", tipo: "producto", cantidad: 1, unidad: null },
    ]);
  });

  it("WO26 without fecha now is read once: a clock that steps back during the call refuses nothing", async () => {
    const inicio = new Date("2026-11-19T18:00:00Z").getTime();
    const esperado = new Date(inicio).toLocaleString("sv-SE", { timeZone: config.timezone }).slice(0, 19);
    let t = inicio;
    const reloj = vi.spyOn(Date, "now").mockImplementation(() => {
      const v = t;
      t -= 120_000;
      return v;
    });
    try {
      const { api } = apiMerma();
      const r: any = await W.crearMerma(ctx(api), args({ fecha: undefined }));
      expect(r.payload.date).toBe(esperado);
    } finally {
      reloj.mockRestore();
    }
  });

  it("WO27 permitir_otra_cuenta also applies a confirmed write-off on an account outside the write set", async () => {
    const { api, post } = apiMerma();
    const r: any = await W.crearMerma(ctx(api), args({ cuenta: "cafe-02", permitir_otra_cuenta: true, confirm: true }));
    expect(r).toMatchObject({ modo: "aplicado", cuenta: "cafe-02" });
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0][0]).toBe("cafe-02");
  });
});

describe("create_write_off · duplicate notice", () => {
  it("WO11 lists the same storage's write-offs of that day that are not deleted, with ids and times", async () => {
    const { api, get } = apiMerma({
      lecturas: {
        "storage.getWastes": [
          { waste_id: "801", storage_id: "1", date: "2026-11-02 08:15:00", reason_id: "3", delete: "0" },
          { waste_id: "802", storage_id: "2", date: "2026-11-02 10:00:00", reason_id: "3", delete: "0" },
          { waste_id: "803", storage_id: "1", date: "2026-11-02 11:00:00", reason_id: "4", delete: "1" },
        ],
      },
    });
    const r: any = await W.crearMerma(ctx(api), args());
    expect(get).toHaveBeenCalledWith("cafe-04", "storage.getWastes", { dateFrom: "20261102", dateTo: "20261102" });
    const aviso = r.avisos.find((x: string) => x.includes("801"));
    expect(aviso).toMatch(/08:15:00/);
    expect(r.avisos.join(" ")).not.toMatch(/802|803/);
  });

  it("WO12 gives no duplicate notice when the day has no write-off on that storage", async () => {
    const { api } = apiMerma({ lecturas: { "storage.getWastes": [{ waste_id: "802", storage_id: "2", date: "2026-11-02 10:00:00", delete: "0" }] } });
    const r: any = await W.crearMerma(ctx(api), args());
    expect(r.avisos.join(" ")).not.toMatch(/duplicad/i);
  });

  it("WO29 a same-day write-off whose date is not YYYY-MM-DD HH:MM:SS is listed without hora, never with a slice of the raw value", async () => {
    const lecturas = { "storage.getWastes": [{ waste_id: "801", storage_id: "1", date: "<b>2026-11-02 08:15:00</b>", delete: "0" }] };
    const r: any = await W.crearMerma(ctx(apiMerma({ lecturas }).api), args());
    const aviso = r.avisos.find((x: string) => x.includes("801"));
    expect(aviso).toMatch(/801 \(sin hora\)/);
    expect(aviso).not.toMatch(/08:1|<b>|<\/b>/);
    const aplicada: any = await W.crearMerma(ctx(apiMerma({ lecturas }).api), args({ confirm: true }));
    expect(aplicada.verificacion.detalle.mermas_mismo_dia).toEqual([{ waste_id: 801, hora: "sin hora" }]);
  });

  it("WO30 a confirmed call carries the same-day write-offs found while planning in the verification, read-back or not", async () => {
    const lecturas = {
      "storage.getWastes": [
        { waste_id: "801", storage_id: "1", date: "2026-11-02 08:15:00", delete: "0" },
        { waste_id: "802", storage_id: "2", date: "2026-11-02 10:00:00", delete: "0" },
      ],
    };
    const r: any = await W.crearMerma(ctx(apiMerma({ lecturas }).api), args({ confirm: true }));
    expect(r.verificacion.ok).toBe(true);
    expect(r.verificacion.detalle.mermas_mismo_dia).toEqual([{ waste_id: 801, hora: "08:15:00" }]);
    const sinRelectura: any = await W.crearMerma(ctx(apiMerma({ lecturas, waste: null }).api), args({ confirm: true }));
    expect(sinRelectura.verificacion.ok).toBe(false);
    expect(sinRelectura.verificacion.detalle.mermas_mismo_dia).toEqual([{ waste_id: 801, hora: "08:15:00" }]);
  });
});

describe("create_write_off · read-back", () => {
  it("WO13 a matching storage.getWaste reads as ok and reports total_sum in currency units", async () => {
    const { api, get } = apiMerma();
    const r: any = await W.crearMerma(ctx(api), args({ confirm: true }));
    expect(get).toHaveBeenCalledWith("cafe-04", "storage.getWaste", { waste_id: 501 });
    expect(r).toMatchObject({ modo: "aplicado", respuesta: 501 });
    expect(r.verificacion.ok).toBe(true);
    expect(r.verificacion.detalle).toMatchObject({ waste_id: 501, costo_total_leido: 12.5, cantidades_verificadas: 2, fallas: [], no_expuestos: [] });
    for (const k of ["total_sum_leido", "alerta_costo", "nota", "mermas_mismo_dia"]) expect(r.verificacion.detalle).not.toHaveProperty(k);
  });

  it("WO14 a quantity off by more than 0.0005 fails and notes that Poster may read weight in another unit", async () => {
    const w = merma();
    w.elements[0].ingredients[0].weight = "500";
    const { api } = apiMerma({ waste: w });
    const r: any = await W.crearMerma(ctx(api), args({ confirm: true }));
    expect(r.verificacion.ok).toBe(false);
    expect(r.verificacion.detalle.fallas.join(" ")).toMatch(/11/);
    expect(r.verificacion.detalle.nota_unidad).toMatch(/otra unidad/);
  });

  it("WO15 a quantity within 0.0005 matches", async () => {
    const w = merma();
    w.elements[0].ingredients[0].weight = "0.5004";
    w.elements[1].count = "2.0004";
    const { api } = apiMerma({ waste: w });
    const r: any = await W.crearMerma(ctx(api), args({ confirm: true }));
    expect(r.verificacion.ok).toBe(true);
  });

  it("WO16 a product line counts the element's count, not its weight", async () => {
    const w = merma();
    w.elements[1].count = "3";
    const { api } = apiMerma({ waste: w });
    const r: any = await W.crearMerma(ctx(api), args({ confirm: true }));
    expect(r.verificacion.ok).toBe(false);
    expect(r.verificacion.detalle.fallas.join(" ")).toMatch(/41/);
  });

  const DESVIOS: Array<[string, Obj, RegExp]> = [
    ["another storage", { storage_id: "2" }, /almac/i],
    ["another day", { date: "2026-11-03 09:30:00" }, /fecha|día/i],
    ["another reason", { reason_id: "4" }, /raz/i],
    ["a line that is missing", { elements: [merma().elements[0], { type: 1, product_id: "42", modificator_id: 0, count: "2", ingredients: [] }] }, /41/],
    ["more elements than lines", { elements: [...merma().elements, { type: 1, product_id: "42", modificator_id: 0, count: "1", ingredients: [] }] }, /elemento/],
  ];

  it.each(DESVIOS)("WO17 a read-back with %s fails", async (_caso, cambio, mensaje) => {
    const { api } = apiMerma({ waste: merma(cambio) });
    const r: any = await W.crearMerma(ctx(api), args({ confirm: true }));
    expect(r.modo).toBe("aplicado");
    expect(r.verificacion.ok).toBe(false);
    expect(r.verificacion.detalle.fallas.join(" ")).toMatch(mensaje);
  });

  it("WO18 a field the reply does not carry is listed as not exposed and does not fail the check by itself", async () => {
    const w = merma();
    delete w.storage_id;
    delete w.reason_id;
    delete w.total_sum;
    delete w.elements[0].ingredients[0].weight;
    const { api } = apiMerma({ waste: w });
    const r: any = await W.crearMerma(ctx(api), args({ confirm: true }));
    expect(r.verificacion.ok).toBe(true);
    expect(r.verificacion.detalle.no_expuestos).toEqual(expect.arrayContaining(["storage_id", "reason_id", "total_sum", "renglón 11: weight"]));
    expect(r.verificacion.detalle.fallas).toEqual([]);
  });

  it("WO19 without razon_id the reason of the reply is not compared", async () => {
    const { api } = apiMerma({ waste: merma({ reason_id: "4" }) });
    const r: any = await W.crearMerma(ctx(api), args({ confirm: true, razon_id: undefined }));
    expect(r.verificacion.ok).toBe(true);
  });

  it.each([["an empty object", {}], ["null", null]])("WO20 a reply that exposes nothing comparable (%s) does not pass", async (_caso, waste) => {
    const { api } = apiMerma({ waste });
    const r: any = await W.crearMerma(ctx(api), args({ confirm: true }));
    expect(r.modo).toBe("aplicado");
    expect(r.verificacion.ok).toBe(false);
  });

  it("WO21 a zero total_sum keeps the check ok and carries the cost notice", async () => {
    const { api } = apiMerma({ waste: merma({ total_sum: "0" }) });
    const r: any = await W.crearMerma(ctx(api), args({ confirm: true }));
    expect(r.verificacion.ok).toBe(true);
    expect(r.verificacion.detalle.costo_total_leido).toBe(0);
    expect(r.verificacion.detalle.alerta_costo).toMatch(/costo total 0/);
  });

  /** The read-back with the ingredient weight and the product count replaced. */
  const conCantidades = (weight: string, count: string) => {
    const w = merma();
    w.elements[0].ingredients[0].weight = weight;
    w.elements[1].count = count;
    return w;
  };

  it.each([
    ["an ingredient read 0.0005 below", "0.4995", "2"],
    ["an ingredient read 0.0005 above", "0.5005", "2"],
    ["a product read 0.0005 above", "0.5", "2.0005"],
    ["a product read 0.0005 below", "0.5", "1.9995"],
  ])("WO31 %s what was sent matches", async (_caso, weight, count) => {
    const { api } = apiMerma({ waste: conCantidades(weight, count) });
    const r: any = await W.crearMerma(ctx(api), args({ confirm: true }));
    expect(r.verificacion.detalle.fallas).toEqual([]);
    expect(r.verificacion.ok).toBe(true);
  });

  it.each([
    ["an ingredient read 0.0006 below", "0.4994", "2", /renglón 11 \(insumo\): cantidad leída 0.4994, enviada 0.5/],
    ["an ingredient read 0.0006 above", "0.5006", "2", /renglón 11 \(insumo\): cantidad leída 0.5006, enviada 0.5/],
    ["a product read 0.0006 above", "0.5", "2.0006", /renglón 41 \(producto\): cantidad leída 2.0006, enviada 2/],
    ["a product read 0.0006 below", "0.5", "1.9994", /renglón 41 \(producto\): cantidad leída 1.9994, enviada 2/],
  ])("WO32 %s what was sent fails", async (_caso, weight, count, falla) => {
    const { api } = apiMerma({ waste: conCantidades(weight, count) });
    const r: any = await W.crearMerma(ctx(api), args({ confirm: true }));
    expect(r.verificacion.ok).toBe(false);
    expect(r.verificacion.detalle.fallas.join(" | ")).toMatch(falla);
  });

  it("WO33 a read-back date on the same day at another time passes the day comparison", async () => {
    const { api } = apiMerma({ waste: merma({ date: "2026-11-02 23:59:59" }) });
    const r: any = await W.crearMerma(ctx(api), args({ confirm: true }));
    expect(r.verificacion.detalle.fallas).toEqual([]);
    expect(r.verificacion.ok).toBe(true);
  });

  it("WO34 an ingredient line is read only inside elements of type 10, not inside a dish's ingredients", async () => {
    const elements = [
      { type: 2, product_id: "40", modificator_id: 0, count: 1, ingredients: [{ ingredient_id: "11", weight: "0.5" }] },
      merma().elements[1],
    ];
    const { api } = apiMerma({ waste: merma({ elements }) });
    const r: any = await W.crearMerma(ctx(api), args({ confirm: true }));
    expect(r.verificacion.ok).toBe(false);
    expect(r.verificacion.detalle.fallas).toEqual(["renglón 11 (insumo) no aparece en la merma"]);
  });

  it("WO35 a product line does not match an element of another type with the same id", async () => {
    const elements = [merma().elements[0], { type: 3, product_id: "41", modificator_id: 0, count: "2", ingredients: [] }];
    const { api } = apiMerma({ waste: merma({ elements }) });
    const r: any = await W.crearMerma(ctx(api), args({ confirm: true }));
    expect(r.verificacion.ok).toBe(false);
    expect(r.verificacion.detalle.fallas).toEqual(["renglón 41 (producto) no aparece en la merma"]);
  });

  it("WO36 an element without type is matched by id alone", async () => {
    const elements = [
      { product_id: 0, count: 1, ingredients: [{ ingredient_id: "11", weight: "0.5" }] },
      { product_id: "41", count: "2", ingredients: [] },
    ];
    const { api } = apiMerma({ waste: merma({ elements }) });
    const r: any = await W.crearMerma(ctx(api), args({ confirm: true }));
    expect(r.verificacion.detalle.fallas).toEqual([]);
    expect(r.verificacion.detalle.cantidades_verificadas).toBe(2);
  });

  it("WO37 an element is used by at most one line", async () => {
    // Both lines could read the first element by id; the second element is no line's.
    const elements = [
      { product_id: "41", count: "2", ingredients: [{ ingredient_id: "11", weight: "2" }] },
      { product_id: "99", count: "2", ingredients: [{ ingredient_id: "98", weight: "2" }] },
    ];
    const { api } = apiMerma({ waste: merma({ elements }) });
    const r: any = await W.crearMerma(ctx(api), args({ confirm: true, renglones: [{ id: 11, cantidad: 2 }, { id: 41, tipo: "producto", cantidad: 2 }] }));
    expect(r.verificacion.ok).toBe(false);
    expect(r.verificacion.detalle.fallas).toEqual(["renglón 41 (producto) no aparece en la merma"]);
  });

  it.each([
    ["an ingredient weight", (w: Obj) => (w.elements[0].ingredients[0].weight = "abc"), /renglón 11 \(insumo\): weight con valor no numérico/],
    ["a product count", (w: Obj) => (w.elements[1].count = "dos"), /renglón 41 \(producto\): count con valor no numérico/],
  ])("WO38 %s that is present but not a number fails", async (_caso, cambiar, falla) => {
    const w = merma();
    cambiar(w);
    const { api } = apiMerma({ waste: w });
    const r: any = await W.crearMerma(ctx(api), args({ confirm: true }));
    expect(r.verificacion.ok).toBe(false);
    expect(r.verificacion.detalle.fallas.join(" | ")).toMatch(falla);
  });

  it("WO39 a row without an id is not exposed and does not make the line it could be missing", async () => {
    const w = merma();
    delete w.elements[0].ingredients[0].ingredient_id;
    const { api } = apiMerma({ waste: w });
    const r: any = await W.crearMerma(ctx(api), args({ confirm: true }));
    expect(r.verificacion.detalle.fallas).toEqual([]);
    expect(r.verificacion.ok).toBe(true);
    expect(r.verificacion.detalle.no_expuestos).toContain("renglón sin id");
    expect(r.verificacion.detalle.renglones).toContainEqual({ id: 11, tipo: "insumo", enviado: 0.5, leido: null });
    expect(r.verificacion.detalle.cantidades_verificadas).toBe(1);
  });

  it("WO40 a row without an id stands for at most one line", async () => {
    const elements = [
      { count: "1", ingredients: [] },
      { type: 2, product_id: "99", count: "1", ingredients: [] },
    ];
    const { api } = apiMerma({ waste: merma({ elements }) });
    const r: any = await W.crearMerma(ctx(api), args({ confirm: true, renglones: [{ id: 41, tipo: "producto", cantidad: 1 }, { id: 40, tipo: "platillo", cantidad: 1 }] }));
    expect(r.verificacion.ok).toBe(false);
    expect(r.verificacion.detalle.fallas).toEqual(["renglón 40 (platillo) no aparece en la merma"]);
    expect(r.verificacion.detalle.no_expuestos).toContain("renglón sin id");
  });

  it("WO41 when no quantity could be compared the verification says so; ok follows the failures", async () => {
    const w = merma();
    delete w.elements[0].ingredients[0].weight;
    delete w.elements[1].count;
    const { api } = apiMerma({ waste: w });
    const r: any = await W.crearMerma(ctx(api), args({ confirm: true }));
    expect(r.verificacion.ok).toBe(true);
    expect(r.verificacion.detalle.cantidades_verificadas).toBe(0);
    expect(r.verificacion.detalle.nota).toBe("No se pudo comparar ninguna cantidad: revisa la merma en Póster.");
  });

  it.each([["0", 0], ["a negative number", -5], ["a fraction", 1.5], ["text", "abc"], ["an object", { id: 501 }]])(
    "WO42 a write reply whose id is %s is applied, not verified, and says not to repeat it",
    async (_caso, response) => {
      const { api, get, post } = apiMerma({ respuesta: { response } });
      const r: any = await W.crearMerma(ctx(api), args({ confirm: true }));
      expect(post).toHaveBeenCalledTimes(1);
      expect(r.modo).toBe("aplicado");
      expect(r.verificacion).toEqual({ ok: false, detalle: "Póster no devolvió el id de la merma; no se puede verificar" });
      expect(r.aviso).toMatch(/No la repitas/);
      expect(llamadas(get, "storage.getWaste")).toEqual([]);
    },
  );

  it("WO43 a write reply whose id is a numeric string is read back with that id", async () => {
    const { api, get } = apiMerma({ respuesta: { response: "501" } });
    const r: any = await W.crearMerma(ctx(api), args({ confirm: true }));
    expect(llamadas(get, "storage.getWaste")).toEqual([{ waste_id: 501 }]);
    expect(r.verificacion.ok).toBe(true);
  });

  it("WO44 a read-back waste_id other than the returned id fails; an absent one is not exposed", async () => {
    const otra: any = await W.crearMerma(ctx(apiMerma({ waste: merma({ waste_id: 777 }) }).api), args({ confirm: true }));
    expect(otra.verificacion.ok).toBe(false);
    expect(otra.verificacion.detalle.fallas).toEqual(["waste_id leído 777, devuelto 501"]);
    const w = merma();
    delete w.waste_id;
    const sin: any = await W.crearMerma(ctx(apiMerma({ waste: w }).api), args({ confirm: true }));
    expect(sin.verificacion.ok).toBe(true);
    expect(sin.verificacion.detalle.no_expuestos).toEqual(["waste_id"]);
  });

  it("WO45 a read-back date that is not YYYY-MM-DD fails with a fixed text, never with a slice of the raw value", async () => {
    const { api } = apiMerma({ waste: merma({ date: "02/11/2026 09:30" }) });
    const r: any = await W.crearMerma(ctx(api), args({ confirm: true }));
    expect(r.verificacion.ok).toBe(false);
    expect(r.verificacion.detalle.fallas).toEqual(["fecha con formato no reconocido"]);
  });

  it("WO46 two read-back rows of the same item for one line fail instead of adding up", async () => {
    const elements = [
      { type: 10, product_id: 0, count: 1, ingredients: [{ ingredient_id: "11", weight: "0.25" }, { ingredient_id: "11", weight: "0.25" }] },
      { type: 1, product_id: "41", count: "2", ingredients: [] },
    ];
    const { api } = apiMerma({ waste: merma({ elements }) });
    const r: any = await W.crearMerma(ctx(api), args({ confirm: true }));
    expect(r.verificacion.ok).toBe(false);
    expect(r.verificacion.detalle.fallas).toEqual(["renglón 11 (insumo) aparece 2 veces en la merma"]);
    expect(r.verificacion.detalle.renglones).toContainEqual({ id: 11, tipo: "insumo", enviado: 0.5, leido: null });
    expect(r.verificacion.detalle.cantidades_verificadas).toBe(1);
  });
});

// ── Through the MCP server ──
const CONFIGURACION = ["POSTER_ACCOUNTS", "DEFAULT_WRITE_ACCOUNT", "WRITE_DEFAULT_ACCOUNTS", "TIMEZONE", "OWNER_NAME", "NETWORK_NAME", "SERVICE_NAME", "OAUTH_SUBJECT", "TOKEN_SOURCE", "POSTER_MYSQL_URL", "AUDIT_DIR"];

describe("create_write_off through the MCP server", () => {
  const temporales: string[] = [];
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.resetModules();
    for (const d of temporales.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  /** Server from fresh modules on accounts tienda-a and tienda-b (tienda-b writable), with its own audit directory. */
  async function cargar(falso: Parameters<typeof apiMerma>[0] = {}) {
    vi.resetModules();
    const auditDir = mkdtempSync(path.join(os.tmpdir(), "poster-mcp-mermas-"));
    temporales.push(auditDir);
    for (const k of CONFIGURACION) vi.stubEnv(k, undefined);
    for (const [k, v] of Object.entries({ POSTER_ACCOUNTS: "tienda-a,tienda-b", WRITE_DEFAULT_ACCOUNTS: "tienda-b", AUDIT_DIR: auditDir })) vi.stubEnv(k, v);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { crearServidorMcp } = await import("../src/mcp.js");
    const { api, post } = apiMerma(falso);
    const [ladoCliente, ladoServidor] = InMemoryTransport.createLinkedPair();
    await crearServidorMcp(api).connect(ladoServidor);
    const cliente = new Client({ name: "prueba", version: "0.0.0" });
    await cliente.connect(ladoCliente);
    const llamar = async (args: Obj) => {
      const r = await cliente.callTool({ name: "create_write_off", arguments: args });
      return { isError: r.isError === true, texto: (r.content as Array<{ text: string }>)[0]?.text ?? "" };
    };
    const archivo = () =>
      readdirSync(auditDir)
        .filter((f) => f.endsWith(".jsonl"))
        .sort()
        .flatMap((f) => readFileSync(path.join(auditDir, f), "utf8").split("\n").filter(Boolean))
        .map((l) => JSON.parse(l));
    return { cliente, llamar, post, archivo };
  }

  const ARGS = { storage_id: 1, fecha: FECHA, razon_id: 3, renglones: [{ id: 11, cantidad: 0.5 }, { id: 41, tipo: "producto", cantidad: 2 }] };

  it("WM1 the tool is listed with the write annotations", async () => {
    const { cliente } = await cargar();
    const t = (await cliente.listTools()).tools.find((x) => x.name === "create_write_off");
    expect(t?.annotations).toEqual({ readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true });
  });

  it("WM2 confirm sends once and audits create_write_off with storage.createWriteOff as applied", async () => {
    const { llamar, post, archivo } = await cargar();
    const r = await llamar({ cuenta: "tienda-b", confirm: true, ...ARGS });
    expect(r.isError, r.texto).toBe(false);
    expect(JSON.parse(r.texto)).toMatchObject({ modo: "aplicado", verificacion: { ok: true } });
    expect(post).toHaveBeenCalledTimes(1);
    expect(archivo()).toEqual([expect.objectContaining({ cuenta: "tienda-b", herramienta: "create_write_off", metodo: "storage.createWriteOff", modo: "aplicado" })]);
  });

  it("WM3 an account outside the write set is refused without permitir_otra_cuenta and audited as rejected", async () => {
    const { llamar, post, archivo } = await cargar();
    const r = await llamar({ cuenta: "tienda-a", confirm: true, ...ARGS });
    expect(r.isError).toBe(true);
    expect(r.texto).toMatch(/bloqueada/);
    expect(post).not.toHaveBeenCalled();
    expect(archivo()).toEqual([expect.objectContaining({ cuenta: "tienda-a", modo: "rechazado" })]);
  });

  it("WM4 a confirmed write-off whose read-back does not match is still audited as applied", async () => {
    const w = merma();
    w.elements[0].ingredients[0].weight = "500";
    const { llamar, post, archivo } = await cargar({ waste: w });
    const r = await llamar({ cuenta: "tienda-b", confirm: true, ...ARGS });
    expect(r.isError, r.texto).toBe(false);
    expect(JSON.parse(r.texto)).toMatchObject({ modo: "aplicado", verificacion: { ok: false } });
    expect(post).toHaveBeenCalledTimes(1);
    const entradas = archivo();
    expect(entradas).toEqual([expect.objectContaining({ cuenta: "tienda-b", herramienta: "create_write_off", modo: "aplicado" })]);
    expect(entradas[0].resultado.verificacion.ok).toBe(false);
  });

  it("WM5 storage_id, razon_id and each line id are positive integers in the tool schema", async () => {
    const { cliente } = await cargar();
    const t = (await cliente.listTools()).tools.find((x) => x.name === "create_write_off");
    const p = t?.inputSchema.properties as Obj;
    for (const s of [p.storage_id, p.razon_id, p.renglones.items.properties.id]) expect(s).toMatchObject({ type: "integer", exclusiveMinimum: 0 });
  });
});
