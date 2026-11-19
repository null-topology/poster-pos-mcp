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
  "assign_supply_payment", "client_groups", "create_category", "create_client_group", "create_dish",
  "create_ingredient", "create_prepack", "create_supply", "create_transaction", "delete_old_dish", "employees",
  "hide_dish", "ingredients", "list_accounts", "menu_snapshot", "payment_methods", "poster_get", "prepacks",
  "product_details", "promotions", "recent_audit", "reference_catalogs", "settings", "stock_levels", "supplies",
  "supply_details", "update_category", "update_client_group", "update_dish", "update_dish_recipe", "update_prepack",
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

/** Server built from fresh modules with its own audit directory, a fake Poster API and an in-memory client. */
async function cargar() {
  vi.resetModules();
  const auditDir = mkdtempSync(path.join(os.tmpdir(), "poster-mcp-nombres-"));
  temporales.push(auditDir);
  for (const k of CONFIGURACION) vi.stubEnv(k, undefined);
  const entorno = { POSTER_ACCOUNTS: "tienda-a,tienda-b", DEFAULT_WRITE_ACCOUNT: "tienda-b", WRITE_DEFAULT_ACCOUNTS: "tienda-b", AUDIT_DIR: auditDir };
  for (const [k, v] of Object.entries(entorno)) vi.stubEnv(k, v);
  vi.spyOn(console, "log").mockImplementation(() => {});
  const { crearServidorMcp } = await import("../src/mcp.js");
  const get = vi.fn(async (_cuenta: string, _metodo: string) => [] as unknown);
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
  it("N1 tools/list returns exactly the 31 English tool names and none of the former Spanish names", async () => {
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
});
