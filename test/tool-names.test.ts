// Tool names: tools/list exposes exactly the English names, the former Spanish names are unknown to the
// server (no aliases), and a renamed tool reads, dry-runs and audits as before under its new name.
// Poster is faked; there is no network.
import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { PosterApi } from "../src/poster.js";

type Obj = Record<string, any>;

/** Every tool the server registers, sorted. */
const NOMBRES = [
  "assign_supply_payment", "client_groups", "count_sheet", "create_category", "create_client_group", "create_dish",
  "create_ingredient", "create_prepack", "create_supply", "create_transaction", "create_write_off", "delete_old_dish",
  "employees", "hide_dish", "ingredients", "list_accounts", "list_stocktakes", "menu_snapshot", "payment_methods",
  "poster_get", "prepacks", "product_details", "promotions", "recent_audit", "reference_catalogs", "settings",
  "stock_levels", "stocktake_result", "supplies", "supply_details", "update_category", "update_client_group",
  "update_dish", "update_dish_recipe", "update_prepack",
];
/** Former tool names; none of them may be served. */
const ANTIGUOS = [
  "listar_cuentas", "producto_detalle", "insumos", "precocinados", "grupos_clientes", "promociones", "empleados",
  "metodos_pago", "ajustes", "compras", "compra_detalle", "saldos", "catalogos_base", "auditoria_reciente",
  "crear_grupo_cliente", "actualizar_grupo_cliente", "crear_insumo", "crear_compra", "asignar_pago_compra",
  "actualizar_platillo", "actualizar_categoria", "actualizar_precocinado", "crear_categoria", "crear_precocinado",
  "crear_platillo", "ocultar_platillo", "borrar_platillo_old", "actualizar_receta_platillo", "crear_transaccion",
];
/** Every runtime configuration variable; each server starts from none of them plus the fixture. */
const CONFIGURACION = ["POSTER_ACCOUNTS", "DEFAULT_WRITE_ACCOUNT", "WRITE_DEFAULT_ACCOUNTS", "TIMEZONE", "OWNER_NAME", "NETWORK_NAME", "SERVICE_NAME", "OAUTH_SUBJECT", "TOKEN_SOURCE", "POSTER_MYSQL_URL", "AUDIT_DIR"];
const GRUPO = { cuenta: "tienda-b", nombre: "Frecuentes", tipo: "descuento", porcentaje: 10 };

const temporales: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
  for (const d of temporales.splice(0)) rmSync(d, { recursive: true, force: true });
});

/**
 * Read of the fake Poster API: `lecturas[metodo]`, or an empty list. `menu.getProduct` finds the product
 * of `menu.getProducts` by its id.
 */
function leer(lecturas: Obj, metodo: string, params?: Obj): unknown {
  if (metodo === "menu.getProduct") {
    return structuredClone((lecturas["menu.getProducts"] ?? []).find((p: Obj) => Number(p.product_id) === Number(params?.product_id)));
  }
  return structuredClone(lecturas[metodo] ?? []);
}

/** Server built from fresh modules with its own audit directory, a fake Poster API and an in-memory client. */
async function cargar(lecturas: Obj = {}) {
  vi.resetModules();
  const auditDir = mkdtempSync(path.join(os.tmpdir(), "poster-mcp-nombres-"));
  temporales.push(auditDir);
  for (const k of CONFIGURACION) vi.stubEnv(k, undefined);
  const entorno = { POSTER_ACCOUNTS: "tienda-a,tienda-b", DEFAULT_WRITE_ACCOUNT: "tienda-b", WRITE_DEFAULT_ACCOUNTS: "tienda-b", AUDIT_DIR: auditDir };
  for (const [k, v] of Object.entries(entorno)) vi.stubEnv(k, v);
  vi.spyOn(console, "log").mockImplementation(() => {});
  const { crearServidorMcp } = await import("../src/mcp.js");
  const get = vi.fn(async (_cuenta: string, metodo: string, params?: Obj) => leer(lecturas, metodo, params));
  const post = vi.fn(async () => ({ error: 1 }));
  const [ladoCliente, ladoServidor] = InMemoryTransport.createLinkedPair();
  await crearServidorMcp({ get, post } as unknown as PosterApi).connect(ladoServidor);
  const cliente = new Client({ name: "prueba", version: "0.0.0" });
  await cliente.connect(ladoCliente);
  const llamar = async (name: string, args: Obj) => {
    const r = await cliente.callTool({ name, arguments: args });
    return { isError: r.isError === true, texto: (r.content as Array<{ text: string }>)[0]?.text ?? "" };
  };
  /** Lines of the JSONL audit files, in order. */
  const archivo = () =>
    readdirSync(auditDir)
      .filter((f) => f.endsWith(".jsonl"))
      .sort()
      .flatMap((f) => readFileSync(path.join(auditDir, f), "utf8").split("\n").filter(Boolean));
  return { cliente, llamar, get, post, archivo };
}

describe("tool names", () => {
  it("N1 tools/list returns exactly the 35 English tool names and none of the former Spanish names", async () => {
    const { cliente } = await cargar();
    const nombres = (await cliente.listTools()).tools.map((t) => t.name).sort();
    expect(nombres).toEqual(NOMBRES);
    for (const antiguo of ANTIGUOS) expect(nombres).not.toContain(antiguo);
  });

  it("N2 a former name is an unknown tool, while its English name reads (client_groups) and dry-runs (create_client_group) as before and is audited under the English name", async () => {
    const { llamar, get, post, archivo } = await cargar();
    for (const [antiguo, args] of [["grupos_clientes", { cuenta: "tienda-b" }], ["crear_grupo_cliente", GRUPO]] as const) {
      const r = await llamar(antiguo, args);
      expect(r.isError).toBe(true);
      expect(r.texto).toContain(`Tool ${antiguo} not found`);
    }
    expect(get).not.toHaveBeenCalled();
    expect(archivo()).toEqual([]);

    const lectura = await llamar("client_groups", { cuenta: "tienda-b" });
    expect(lectura.isError).toBe(false);
    expect(JSON.parse(lectura.texto)).toEqual({ cuenta: "tienda-b", grupos: [] });
    expect(get).toHaveBeenCalledWith("tienda-b", "clients.getGroups");

    const escritura = await llamar("create_client_group", GRUPO);
    expect(escritura.isError).toBe(false);
    expect(JSON.parse(escritura.texto)).toMatchObject({ modo: "dry-run" });
    expect(post).not.toHaveBeenCalled();
    const lineas = archivo().map((l) => JSON.parse(l));
    expect(lineas).toHaveLength(1);
    expect(lineas[0]).toMatchObject({ cuenta: "tienda-b", metodo: "clients.createGroup", herramienta: "create_client_group", modo: "dry-run" });
  });

  /** Poster reads that let every write tool build its plan. */
  const LECTURAS: Obj = {
    "clients.getGroups": [{ client_groups_id: "3", client_groups_name: "VIP", loyalty_type: "2", client_groups_discount: "5", birthday_bonus: "0", use_ewallet: "0", delete: "0" }],
    "menu.getIngredients": [{ ingredient_id: "11", ingredient_name: "Leche", ingredient_unit: "l" }],
    "menu.getCategoriesIngredients": [{ category_id: "2", name: "Lácteos" }],
    "storage.getStorages": [{ storage_id: "1", storage_name: "Almacén", delete: "0" }],
    "storage.getSuppliers": [{ supplier_id: "5", supplier_name: "Proveedor", delete: "0" }],
    "storage.getSupplies": [],
    "storage.getSupply": {
      supply_id: 80, storage_id: 1, supplier_id: 5, account_id: "", date: "2026-11-02 10:00:00", supply_sum: "20.00", supply_comment: "",
      ingredients: [{ ingredient_id: 11, supply_ingredient_num: 1, supply_ingredient_sum: "20.00", ingredient_name: "Leche", ingredient_unit: "l", type: 4 }],
    },
    "finance.getAccounts": [{ account_id: "4", name: "Caja" }],
    "finance.getCategories": [{ category_id: "6", name: "Nómina" }],
    "menu.getCategories": [{ category_id: "3", category_name: "Bebidas", parent_category: "0" }],
    "menu.getPrepacks": [{ product_id: "70", product_name: "Base", unit: "kg", out: 1, ingredients: [{ ingredient_id: "11", structure_type: "1", structure_brutto: 100, structure_netto: 100, structure_lock: "1" }] }],
    "menu.getProducts": [
      { product_id: "40", product_name: "Latte", menu_category_id: "3", workshop: "1", type: "2", color: "white", price: { "1": "4500" }, spots: [{ spot_id: "1", price: "4500", visible: "1" }], ingredients: [], group_modifications: [] },
      { product_id: "50", product_name: "Moka (old)", menu_category_id: "3", workshop: "1", type: "2", color: "white", price: { "1": "5000" }, spots: [{ spot_id: "1", price: "5000", visible: "0" }], ingredients: [], group_modifications: [] },
      {
        product_id: "60", product_name: "Capuchino", menu_category_id: "3", workshop: "1", type: "2", color: "white", price: { "1": "5500" }, spots: [{ spot_id: "1", price: "5500", visible: "1" }],
        ingredients: [{ ingredient_id: "11", structure_unit: "ml", structure_type: "1", structure_brutto: 200, structure_netto: 200, structure_lock: "1" }], group_modifications: [],
      },
    ],
  };
  /** Each write tool with arguments that build a plan from LECTURAS. */
  const ESCRITURAS: Array<[string, Obj]> = [
    ["create_client_group", { nombre: "Frecuentes", tipo: "descuento", porcentaje: 10 }],
    ["update_client_group", { client_groups_id: 3, porcentaje: 7 }],
    ["create_ingredient", { nombre: "Azúcar", categoria_id: 2, unidad: "kg" }],
    ["create_supply", { storage_id: 1, supplier_id: 5, renglones: [{ id: 11, cantidad: 1, costo_unitario: 20 }] }],
    ["assign_supply_payment", { supply_id: 80, account_id: 4 }],
    ["create_write_off", { storage_id: 1, renglones: [{ id: 11, cantidad: 1 }] }],
    ["update_dish", { product_id: 40, precio: 50 }],
    ["update_category", { category_id: 3, nombre: "Bebidas calientes" }],
    ["update_prepack", { product_id: 70, rendimiento: 2 }],
    ["create_category", { nombre: "Postres" }],
    ["create_prepack", { nombre: "Jarabe", receta: [{ ingredient_id: 11, brutto: 10 }] }],
    ["create_dish", { nombre: "Mocha", categoria_id: 3, workshop: 1, precio: 60, receta: [{ ingredient_id: 11, brutto: 200 }] }],
    ["hide_dish", { product_id: 40 }],
    ["delete_old_dish", { product_id: 50 }],
    ["update_dish_recipe", { product_id: 60, receta: [{ ingredient_id: 11, brutto: 150 }], grupos: [] }],
    ["create_transaction", { tipo: "gasto", monto: 100, account_id: 4, category_id: 6 }],
  ];

  it("N3 the write tools are exactly the table below", async () => {
    const { cliente } = await cargar();
    const escrituras = (await cliente.listTools()).tools.filter((t) => t.annotations?.readOnlyHint === false).map((t) => t.name).sort();
    expect(escrituras).toEqual(ESCRITURAS.map(([nombre]) => nombre).sort());
  });

  it.each(ESCRITURAS)("N4 a dry-run of %s is audited under that tool name", async (nombre, args) => {
    const { llamar, post, archivo } = await cargar(LECTURAS);
    const r = await llamar(nombre, { cuenta: "tienda-b", ...args });
    expect(r.isError, r.texto).toBe(false);
    expect(JSON.parse(r.texto)).toMatchObject({ modo: "dry-run" });
    expect(post).not.toHaveBeenCalled();
    const lineas = archivo().map((l) => JSON.parse(l));
    expect(lineas).toHaveLength(1);
    expect(lineas[0]).toMatchObject({ herramienta: nombre, modo: "dry-run" });
  });

  const LECTURA = { readOnlyHint: true, openWorldHint: true };
  const ESCRITURA = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };

  it("N5 every read tool carries the read-only annotations and every write tool the write annotations", async () => {
    const { cliente } = await cargar();
    const escrituras = new Set(ESCRITURAS.map(([nombre]) => nombre));
    const herramientas = (await cliente.listTools()).tools;
    expect(herramientas.map((t) => t.name).sort()).toEqual(NOMBRES);
    for (const t of herramientas) expect(t.annotations, t.name).toEqual(escrituras.has(t.name) ? ESCRITURA : LECTURA);
  });
});
