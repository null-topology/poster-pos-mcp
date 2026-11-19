// TIMEZONE decides "today" and the default timestamp of finance writes. The fixed instant below is
// 2026-03-09 21:30 in America/Merida (the default) and 2026-03-10 12:30 in Asia/Tokyo.
import { describe, it, expect, vi, afterEach } from "vitest";
import type { PosterApi } from "../src/poster.js";

type Obj = Record<string, any>;

const INSTANTE = new Date("2026-03-10T03:30:00Z");

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.resetModules();
});

/** Every runtime configuration variable other than WRITE_DEFAULT_ACCOUNTS (pinned by vitest.config.ts). */
const CONFIGURACION = ["POSTER_ACCOUNTS", "DEFAULT_WRITE_ACCOUNT", "TIMEZONE", "OWNER_NAME", "NETWORK_NAME", "SERVICE_NAME", "OAUTH_SUBJECT", "TOKEN_SOURCE", "POSTER_MYSQL_URL"];

/** Fresh modules with TIMEZONE set to `zona` (undefined = not set) and every other variable unset. */
async function modulos(zona: string | undefined) {
  vi.resetModules();
  for (const k of CONFIGURACION) vi.stubEnv(k, undefined);
  vi.stubEnv("TIMEZONE", zona);
  return { util: await import("../src/util.js"), W: await import("../src/tools/escritura.js") };
}

/** Fake Poster API with what the dry runs of crear_compra and crear_transaccion read. */
function apiFalsa(): PosterApi {
  const db: Obj = {
    "storage.getStorages": [{ storage_id: "3", storage_name: "Barra", delete: "0" }],
    "storage.getSuppliers": [{ supplier_id: "98", supplier_name: "Proveedor", delete: "0" }],
    "menu.getIngredients": [{ ingredient_id: "662", ingredient_name: "Leche", ingredient_unit: "l" }],
    "storage.getSupplies": [],
    "finance.getAccounts": [{ account_id: "4", name: "CAJA" }],
    "finance.getCategories": [{ category_id: "6", name: "Nómina" }],
  };
  return {
    get: async (_c: string, metodo: string) => structuredClone(db[metodo] ?? []),
    post: vi.fn(async () => ({ error: 1 })),
  } as unknown as PosterApi;
}

const ctx = () => ({ api: apiFalsa(), actor: "test" });
const enInstante = () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(INSTANTE);
};
const transaccion = (W: typeof import("../src/tools/escritura.js")) =>
  W.crearTransaccion(ctx(), { cuenta: "cafe-04", tipo: "gasto", monto: 10, account_id: 4, category_id: 6 }) as Promise<Obj>;
const compra = (W: typeof import("../src/tools/escritura.js")) =>
  W.crearCompra(ctx(), { cuenta: "cafe-04", storage_id: 3, supplier_id: 98, renglones: [{ id: 662, cantidad: 1, costo_unitario: 10 }] }) as Promise<Obj>;

describe("TIMEZONE", () => {
  it("Z1 'today' follows the configured zone", async () => {
    const { util } = await modulos("Asia/Tokyo");
    expect(util.hoyMx(INSTANTE)).toBe("2026-03-10");
  });

  it("Z2 'today' uses America/Merida when TIMEZONE is not set", async () => {
    const { util } = await modulos(undefined);
    expect(util.hoyMx(INSTANTE)).toBe("2026-03-09");
  });

  it("Z3 the default timestamp of crear_transaccion follows the configured zone", async () => {
    const { W } = await modulos("Asia/Tokyo");
    enInstante();
    const r = await transaccion(W);
    expect(r.modo).toBe("dry-run");
    expect(r.payload.date).toBe("2026-03-10 12:30:00");
  });

  it("Z4 the default timestamp of crear_compra follows the configured zone", async () => {
    const { W } = await modulos("Asia/Tokyo");
    enInstante();
    const r = await compra(W);
    expect(r.modo).toBe("dry-run");
    expect(r.payload.date).toBe("2026-03-10 12:30:00");
  });

  it("Z5 both default timestamps use America/Merida when TIMEZONE is not set", async () => {
    const { W } = await modulos(undefined);
    enInstante();
    expect((await transaccion(W)).payload.date).toBe("2026-03-09 21:30:00");
    expect((await compra(W)).payload.date).toBe("2026-03-09 21:30:00");
  });

  it("Z6 'today' without an explicit date follows the configured zone", async () => {
    // Two zones that disagree on the date at the faked instant, so the machine's own zone cannot pass both.
    const tokio = (await modulos("Asia/Tokyo")).util;
    enInstante();
    expect(tokio.hoyMx()).toBe("2026-03-10");
    expect(tokio.promoVigente("2026-03-09")).toBe(false);
    vi.useRealTimers();
    const merida = (await modulos(undefined)).util;
    enInstante();
    expect(merida.hoyMx()).toBe("2026-03-09");
    expect(merida.promoVigente("2026-03-09")).toBe(true);
  });

  it("Z7 a zone with daylight saving time gives the right date and timestamp on both sides of the change", async () => {
    // America/New_York moves from UTC-5 to UTC-4 at 2026-03-08 07:00 UTC. At 04:30 UTC the local date is
    // the previous day under UTC-5 and the same day under UTC-4, so a wrong offset shows in the date.
    const casos = [
      { instante: "2026-03-08T04:30:00Z", hoy: "2026-03-07", fecha: "2026-03-07 23:30:00" }, // UTC-5: 04:30 - 5 h
      { instante: "2026-03-09T04:30:00Z", hoy: "2026-03-09", fecha: "2026-03-09 00:30:00" }, // UTC-4: 04:30 - 4 h
    ];
    const { util, W } = await modulos("America/New_York");
    vi.useFakeTimers({ toFake: ["Date"] });
    for (const c of casos) {
      vi.setSystemTime(new Date(c.instante));
      expect(util.hoyMx(), c.instante).toBe(c.hoy);
      expect((await transaccion(W)).payload.date, c.instante).toBe(c.fecha);
      expect((await compra(W)).payload.date, c.instante).toBe(c.fecha);
    }
  });
});
