// With none of the new variables set, the MCP server behaves as before: the ten default accounts,
// cafe-04 as write target and permission, and the same texts except the account parameter, which now
// names the network as "RUSH Café".
import { describe, it, expect, vi, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { PosterApi } from "../src/poster.js";

type Obj = Record<string, any>;

const DIEZ = Array.from({ length: 10 }, (_, i) => `cafe-${String(i + 1).padStart(2, "0")}`);
const NUEVAS = ["POSTER_ACCOUNTS", "DEFAULT_WRITE_ACCOUNT", "TIMEZONE", "OWNER_NAME", "NETWORK_NAME", "SERVICE_NAME", "OAUTH_SUBJECT", "TOKEN_SOURCE", "POSTER_MYSQL_URL"];

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

/** Fresh modules with none of the new variables (WRITE_DEFAULT_ACCOUNTS stays at the test default, cafe-04). */
async function modulos() {
  vi.resetModules();
  for (const k of NUEVAS) vi.stubEnv(k, undefined);
  return { mcp: await import("../src/mcp.js"), config: await import("../src/config.js") };
}

async function conectar() {
  const { mcp } = await modulos();
  const get = vi.fn(async (_cuenta: string, _metodo: string) => [] as unknown);
  const post = vi.fn(async () => ({ error: 1 }));
  const servidor = mcp.crearServidorMcp({ get, post } as unknown as PosterApi);
  const [ladoCliente, ladoServidor] = InMemoryTransport.createLinkedPair();
  await servidor.connect(ladoServidor);
  const cliente = new Client({ name: "prueba", version: "0.0.0" });
  await cliente.connect(ladoCliente);
  const { tools } = await cliente.listTools();
  const herramienta = (nombre: string) => {
    const t = tools.find((x) => x.name === nombre);
    if (!t) throw new Error(`sin herramienta ${nombre}`);
    return t as typeof t & { inputSchema: { properties: Record<string, Obj>; required?: string[] } };
  };
  return { cliente, herramienta, get };
}

describe("no new variables: today's behaviour", () => {
  it("D1 tools/list shows the ten default accounts and cafe-04 as write default", async () => {
    const m = await conectar();
    const lectura = m.herramienta("menu_snapshot").inputSchema;
    const escritura = m.herramienta("crear_grupo_cliente").inputSchema;
    expect(lectura.properties.cuenta.enum).toEqual(DIEZ);
    expect(escritura.properties.cuenta.enum).toEqual(DIEZ);
    expect(escritura.properties.cuenta.default).toBe("cafe-04");
    expect(escritura.required ?? []).not.toContain("cuenta");
  });

  it("D2 the default texts are unchanged", async () => {
    const m = await conectar();
    expect(m.cliente.getServerVersion()?.name).toBe("poster-rush");
    expect(m.cliente.getInstructions()).toBe(
      "Herramientas para leer y configurar las cuentas Póster POS de la red RUSH Café. " +
        "Lecturas en cualquier cuenta de la lista blanca. Escrituras: siempre primero en dry-run (confirm:false), mostrar el diff a Roy, " +
        "y solo aplicar con confirm:true tras su OK. Por defecto solo cafe-04; otra cuenta requiere permitir_otra_cuenta:true y autorización explícita. " +
        "Productos fuera de carta se OCULTAN (ocultar_platillo); solo se borran con borrar_platillo_old si Roy lo pide para liberar lugar del plan. Platillos nuevos con receta: crear_platillo. actualizar_platillo no toca platillos con receta; permisos de puestos solo en panel web.",
    );
    const escritura = m.herramienta("crear_grupo_cliente").inputSchema.properties;
    expect(escritura.cuenta.description).toBe("Cuenta destino (por defecto cafe-04)");
    expect(escritura.permitir_otra_cuenta.description).toBe("Requerido en true para escribir en una cuenta distinta de cafe-04. Solo con autorización explícita de Roy.");
    expect(m.herramienta("borrar_platillo_old").description).toBe(
      'menu.removeDish SOLO para platillos ya ocultos cuyo nombre termina en "(old)" (pasaron por ocultar_platillo). ' +
        "Úsalo únicamente cuando Roy pida borrar para liberar lugar del plan de Póster. Dry-run por defecto.",
    );
    expect(m.herramienta("crear_compra").inputSchema.properties.fecha.description).toBe("YYYY-MM-DD HH:MM:SS (hora de Carmen). Por defecto ahora.");
    expect(m.herramienta("crear_transaccion").inputSchema.properties.fecha.description).toBe("YYYY-MM-DD [HH:MM:SS], hora de Carmen (America/Merida). Por defecto ahora.");
  });

  it("D3 the account parameter of read tools names the network as RUSH Café (the one stated text change)", async () => {
    const m = await conectar();
    expect(m.herramienta("menu_snapshot").inputSchema.properties.cuenta.description).toBe("Cuenta Póster de la red RUSH Café");
  });

  it("D4 the write guard, the account listing and an omitted cuenta behave as before", async () => {
    const m = await conectar();
    const { verificarEscritura } = await import("../src/config.js");
    expect(() => verificarEscritura("cafe-02", false)).toThrow(
      'Escritura en "cafe-02" bloqueada: solo cafe-04 se escribe por defecto. ' +
        "Para otra cuenta, Roy debe autorizarla explícitamente y la llamada debe incluir permitir_otra_cuenta: true.",
    );
    expect(() => verificarEscritura("cafe-11", true)).toThrow('Cuenta "cafe-11" fuera de la lista blanca.');
    const cuentas = await m.cliente.callTool({ name: "listar_cuentas", arguments: {} });
    expect(JSON.parse((cuentas.content as Array<{ text: string }>)[0].text)).toEqual(DIEZ.map((c) => ({ cuenta: c, escritura_por_defecto: c === "cafe-04" })));
    const r = await m.cliente.callTool({ name: "crear_grupo_cliente", arguments: { nombre: "Frecuentes", tipo: "descuento", porcentaje: 10 } });
    expect(r.isError ?? false).toBe(false);
    expect(JSON.parse((r.content as Array<{ text: string }>)[0].text)).toMatchObject({ modo: "dry-run", cuenta: "cafe-04" });
    expect(m.get).toHaveBeenCalledWith("cafe-04", "clients.getGroups");
  });
});
