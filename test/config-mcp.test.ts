// The MCP server built from a custom configuration (module reset, Poster HTTP faked, no network):
// account enums, the write target, the write guard and the configured names and timezone.
import { describe, it, expect, vi, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { PosterApi } from "../src/poster.js";

type Obj = Record<string, any>;

const LISTA = ["tienda-a", "tienda-b", "tienda-c"];
const PERSONALIZADA: Record<string, string> = {
  POSTER_ACCOUNTS: LISTA.join(","),
  DEFAULT_WRITE_ACCOUNT: "tienda-b",
  WRITE_DEFAULT_ACCOUNTS: "tienda-b",
  TIMEZONE: "Asia/Tokyo",
  OWNER_NAME: "Ana",
  NETWORK_NAME: "Tacos Norte",
  SERVICE_NAME: "tacos-mcp",
};
const GRUPO = { nombre: "Frecuentes", tipo: "descuento", porcentaje: 10 };
/** Every runtime configuration variable; each server starts from none of them plus its fixture. */
const CONFIGURACION = ["POSTER_ACCOUNTS", "DEFAULT_WRITE_ACCOUNT", "WRITE_DEFAULT_ACCOUNTS", "TIMEZONE", "OWNER_NAME", "NETWORK_NAME", "SERVICE_NAME", "OAUTH_SUBJECT", "TOKEN_SOURCE", "POSTER_MYSQL_URL"];

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

/** Fake Poster API: every read returns an empty list; a write would fail (only dry runs are expected). */
function apiFalsa() {
  const get = vi.fn(async (_cuenta: string, _metodo: string) => [] as unknown);
  const post = vi.fn(async () => ({ error: 1 }));
  return { api: { get, post } as unknown as PosterApi, get, post };
}

/** Builds the server from `entorno` (fresh modules) and connects an in-memory MCP client to it. */
async function conectar(entorno: Record<string, string>) {
  vi.resetModules();
  for (const k of CONFIGURACION) vi.stubEnv(k, undefined);
  for (const [k, v] of Object.entries(entorno)) vi.stubEnv(k, v);
  const { crearServidorMcp } = await import("../src/mcp.js");
  const { api, get, post } = apiFalsa();
  const servidor = crearServidorMcp(api);
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
  const llamar = async (name: string, args: Obj) => {
    const r = await cliente.callTool({ name, arguments: args });
    const texto = (r.content as Array<{ text: string }>)[0]?.text ?? "";
    return { isError: r.isError === true, texto };
  };
  return { cliente, tools, herramienta, llamar, get, post };
}

describe("custom configuration through the MCP server", () => {
  it("M1 tools/list shows the custom list as the cuenta enum of a read and a write tool, and the custom write target as default", async () => {
    const m = await conectar(PERSONALIZADA);
    const lectura = m.herramienta("menu_snapshot").inputSchema;
    const escritura = m.herramienta("crear_grupo_cliente").inputSchema;
    expect(lectura.properties.cuenta.enum).toEqual(LISTA);
    expect(lectura.required).toContain("cuenta");
    expect(escritura.properties.cuenta.enum).toEqual(LISTA);
    expect(escritura.properties.cuenta.default).toBe("tienda-b");
    expect(escritura.required ?? []).not.toContain("cuenta");
    expect(lectura.properties.cuenta.description).toBe("Cuenta Póster de la red Tacos Norte");
    expect(escritura.properties.cuenta.description).toBe("Cuenta destino (por defecto tienda-b)");
  });

  it("M2 the configured names and timezone appear in the server name, instructions and descriptions, and no default literal is left", async () => {
    const m = await conectar(PERSONALIZADA);
    expect(m.cliente.getServerVersion()?.name).toBe("tacos-mcp");
    const instrucciones = m.cliente.getInstructions() ?? "";
    expect(instrucciones).toContain("de la red Tacos Norte.");
    expect(instrucciones).toContain("mostrar el diff a Ana,");
    expect(instrucciones).toContain("si Ana lo pide");
    expect(m.herramienta("crear_grupo_cliente").inputSchema.properties.permitir_otra_cuenta.description).toContain("autorización explícita de Ana.");
    expect(m.herramienta("borrar_platillo_old").description).toContain("cuando Ana pida borrar");
    expect(m.herramienta("crear_compra").inputSchema.properties.fecha.description).toContain("Asia/Tokyo");
    expect(m.herramienta("crear_transaccion").inputSchema.properties.fecha.description).toContain("Asia/Tokyo");
    const todo = `${m.cliente.getServerVersion()?.name}\n${instrucciones}\n${JSON.stringify(m.tools)}`;
    expect(todo).not.toMatch(/Roy|RUSH|cafe-0|Carmen|America\/Merida|poster-rush/);
  });

  it("M3 tools/call of a write tool with cuenta omitted runs its dry run against the write target", async () => {
    const m = await conectar(PERSONALIZADA);
    const r = await m.llamar("crear_grupo_cliente", GRUPO);
    expect(r.isError, r.texto).toBe(false);
    const cuerpo = JSON.parse(r.texto);
    expect(cuerpo.modo).toBe("dry-run");
    expect(cuerpo.cuenta).toBe("tienda-b");
    expect(m.get).toHaveBeenCalledWith("tienda-b", "clients.getGroups");
    expect(m.post).not.toHaveBeenCalled();
  });

  it("M4 the dry run targets DEFAULT_WRITE_ACCOUNT when WRITE_DEFAULT_ACCOUNTS lists several accounts in a different order", async () => {
    // tienda-b is the first entry neither as written nor in account-list order.
    const m = await conectar({ ...PERSONALIZADA, WRITE_DEFAULT_ACCOUNTS: "tienda-c,tienda-a,tienda-b" });
    const r = await m.llamar("crear_grupo_cliente", GRUPO);
    expect(r.isError, r.texto).toBe(false);
    const cuerpo = JSON.parse(r.texto);
    expect(cuerpo.modo).toBe("dry-run");
    expect(cuerpo.cuenta).toBe("tienda-b");
    expect(m.get.mock.calls.map((c) => c[0])).toEqual(["tienda-b"]);
  });

  it("M5 with no write target, cuenta is required and the same call fails validation", async () => {
    const { DEFAULT_WRITE_ACCOUNT: _sin, ...sinDestino } = PERSONALIZADA;
    const m = await conectar({ ...sinDestino, WRITE_DEFAULT_ACCOUNTS: "tienda-a,tienda-b" });
    const esquema = m.herramienta("crear_grupo_cliente").inputSchema;
    expect(esquema.required).toContain("cuenta");
    expect(esquema.properties.cuenta).not.toHaveProperty("default");
    expect(esquema.properties.cuenta.enum).toEqual(LISTA);
    const r = await m.llamar("crear_grupo_cliente", GRUPO);
    expect(r.isError).toBe(true);
    expect(r.texto).toMatch(/Input validation error/);
    expect(r.texto).toMatch(/cuenta/);
    expect(m.get).not.toHaveBeenCalled();
    // An explicit account still works.
    const ok = await m.llamar("crear_grupo_cliente", { ...GRUPO, cuenta: "tienda-a" });
    expect(ok.isError, ok.texto).toBe(false);
    expect(JSON.parse(ok.texto).cuenta).toBe("tienda-a");
  });

  it("M6 listar_cuentas returns the custom list and its write permissions", async () => {
    const m = await conectar({ ...PERSONALIZADA, WRITE_DEFAULT_ACCOUNTS: "tienda-c,tienda-b" });
    const r = await m.llamar("listar_cuentas", {});
    expect(r.isError, r.texto).toBe(false);
    expect(JSON.parse(r.texto)).toEqual([
      { cuenta: "tienda-a", escritura_por_defecto: false },
      { cuenta: "tienda-b", escritura_por_defecto: true },
      { cuenta: "tienda-c", escritura_por_defecto: true },
    ]);
  });

  it("M7 a write to a listed account outside WRITE_DEFAULT_ACCOUNTS without permitir_otra_cuenta is blocked, naming OWNER_NAME", async () => {
    const m = await conectar(PERSONALIZADA);
    const r = await m.llamar("crear_grupo_cliente", { ...GRUPO, cuenta: "tienda-a" });
    expect(r.isError).toBe(true);
    expect(r.texto).toBe(
      'Escritura en "tienda-a" bloqueada: solo tienda-b se escribe por defecto. ' +
        "Para otra cuenta, Ana debe autorizarla explícitamente y la llamada debe incluir permitir_otra_cuenta: true.",
    );
    expect(m.get).not.toHaveBeenCalled();
  });

  it("M8 the same write with permitir_otra_cuenta: true runs its dry run", async () => {
    const m = await conectar(PERSONALIZADA);
    const r = await m.llamar("crear_grupo_cliente", { ...GRUPO, cuenta: "tienda-a", permitir_otra_cuenta: true });
    expect(r.isError, r.texto).toBe(false);
    expect(JSON.parse(r.texto)).toMatchObject({ modo: "dry-run", cuenta: "tienda-a" });
  });

  it("M9 an account outside the list is rejected for writes and reads", async () => {
    const m = await conectar(PERSONALIZADA);
    for (const [name, args] of [
      ["crear_grupo_cliente", { ...GRUPO, cuenta: "cafe-04" }],
      ["crear_grupo_cliente", { ...GRUPO, cuenta: "cafe-04", permitir_otra_cuenta: true }],
      ["menu_snapshot", { cuenta: "cafe-04" }],
    ] as const) {
      const r = await m.llamar(name, args);
      expect(r.isError, `${name} ${JSON.stringify(args)}`).toBe(true);
      expect(r.texto).toMatch(/Input validation error/);
    }
    expect(m.get).not.toHaveBeenCalled();
  });

  it("M10 with an empty permission set, the write guard says no account is writable by default", async () => {
    const m = await conectar({ ...PERSONALIZADA, WRITE_DEFAULT_ACCOUNTS: "", DEFAULT_WRITE_ACCOUNT: "" });
    const r = await m.llamar("crear_grupo_cliente", { ...GRUPO, cuenta: "tienda-b" });
    expect(r.isError).toBe(true);
    expect(r.texto).toMatch(/bloqueada/);
    expect(r.texto).not.toMatch(/solo\s+se escribe/);
    expect(r.texto).toContain("Ana debe autorizarla");
  });
});

// The write target may sit outside WRITE_DEFAULT_ACCOUNTS. The permission texts must then name the
// permission set itself (not the target), and writes to the target still need permitir_otra_cuenta.
describe("permission texts when the write target is outside the permission set", () => {
  const SIN_PERMISO = "Cuenta destino (por defecto tienda-b; escribir en ella requiere permitir_otra_cuenta: true)";

  it("M11 with a multi-account set that excludes the target, the texts name exactly that set", async () => {
    const m = await conectar({ ...PERSONALIZADA, WRITE_DEFAULT_ACCOUNTS: "tienda-c,tienda-a" });
    const esquema = m.herramienta("crear_grupo_cliente").inputSchema;
    expect(m.cliente.getInstructions()).toContain(
      "y solo aplicar con confirm:true tras su OK. Por defecto solo tienda-a, tienda-c; otra cuenta requiere permitir_otra_cuenta:true y autorización explícita. Productos",
    );
    expect(esquema.properties.permitir_otra_cuenta.description).toBe(
      "Requerido en true para escribir en una cuenta distinta de tienda-a, tienda-c. Solo con autorización explícita de Ana.",
    );
    expect(esquema.properties.cuenta.default).toBe("tienda-b");
    expect(esquema.properties.cuenta.description).toBe(SIN_PERMISO);

    const bloqueada = await m.llamar("crear_grupo_cliente", GRUPO);
    expect(bloqueada.isError).toBe(true);
    expect(bloqueada.texto).toBe(
      'Escritura en "tienda-b" bloqueada: solo tienda-a, tienda-c se escribe por defecto. ' +
        "Para otra cuenta, Ana debe autorizarla explícitamente y la llamada debe incluir permitir_otra_cuenta: true.",
    );
    expect(m.get).not.toHaveBeenCalled();
    const conPermiso = await m.llamar("crear_grupo_cliente", { ...GRUPO, permitir_otra_cuenta: true });
    expect(conPermiso.isError, conPermiso.texto).toBe(false);
    expect(JSON.parse(conPermiso.texto)).toMatchObject({ modo: "dry-run", cuenta: "tienda-b" });
    expect(m.get.mock.calls.map((c) => c[0])).toEqual(["tienda-b"]);
    expect(m.post).not.toHaveBeenCalled();
  });

  it("M12 with an empty set and a write target, the texts say no account is writable by default", async () => {
    const m = await conectar({ ...PERSONALIZADA, WRITE_DEFAULT_ACCOUNTS: "" });
    const esquema = m.herramienta("crear_grupo_cliente").inputSchema;
    expect(m.cliente.getInstructions()).toContain(
      "y solo aplicar con confirm:true tras su OK. Ninguna cuenta se escribe por defecto; toda escritura requiere permitir_otra_cuenta:true y autorización explícita. Productos",
    );
    expect(esquema.properties.permitir_otra_cuenta.description).toBe(
      "Requerido en true para escribir en cualquier cuenta. Solo con autorización explícita de Ana.",
    );
    expect(esquema.properties.cuenta.default).toBe("tienda-b");
    expect(esquema.properties.cuenta.description).toBe(SIN_PERMISO);

    const bloqueada = await m.llamar("crear_grupo_cliente", GRUPO);
    expect(bloqueada.isError).toBe(true);
    expect(bloqueada.texto).toBe(
      'Escritura en "tienda-b" bloqueada: ninguna cuenta se escribe por defecto. ' +
        "Para escribir en ella, Ana debe autorizarla explícitamente y la llamada debe incluir permitir_otra_cuenta: true.",
    );
    expect(m.get).not.toHaveBeenCalled();
    const conPermiso = await m.llamar("crear_grupo_cliente", { ...GRUPO, permitir_otra_cuenta: true });
    expect(conPermiso.isError, conPermiso.texto).toBe(false);
    expect(JSON.parse(conPermiso.texto)).toMatchObject({ modo: "dry-run", cuenta: "tienda-b" });
    expect(m.post).not.toHaveBeenCalled();
  });
});
