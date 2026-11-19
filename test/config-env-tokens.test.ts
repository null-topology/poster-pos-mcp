// TOKEN_SOURCE=env: each listed account's Poster token comes from POSTER_TOKEN_<ACCOUNT>. The loader
// validates every token at startup (trimmed, then ^[A-Za-z0-9:._~-]{16,}$) and names failing
// variables, never values; tokens are a startup snapshot; lookups never touch Secret Manager or MySQL;
// every env token is redacted from errors and audit entries, looked up or not; the MCP server (module
// reset, fetch faked) calls Poster with the right account's token.
import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { inspect } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { cargarConfig, variableToken } from "../src/config.js";

type Obj = Record<string, any>;

/** Every runtime configuration variable; each module graph starts from none of them plus its fixture. */
const CONFIGURACION = [
  "POSTER_ACCOUNTS", "DEFAULT_WRITE_ACCOUNT", "WRITE_DEFAULT_ACCOUNTS", "TIMEZONE", "OWNER_NAME", "NETWORK_NAME",
  "SERVICE_NAME", "OAUTH_SUBJECT", "TOKEN_SOURCE", "POSTER_MYSQL_URL", "GCP_PROJECT_ID", "AUDIT_DIR",
];
// Synthetic tokens in the valid format; none is a substring of another. Only the second one has a
// colon, the one allowed character that URL encoding changes. None is looked up unless a test says so.
const TOKEN_A = "ZqEnvTokenA.5521-alfa";
const TOKEN_B = "770044:ZqEnvTokenB~beta";
const TOKEN_C = "ZqEnvTokenC_3390_gama";
const TOKENS: Record<string, string> = {
  POSTER_TOKEN_TIENDA_A: TOKEN_A,
  POSTER_TOKEN_TIENDA_B: TOKEN_B,
  POSTER_TOKEN_MI_CAFE_04: TOKEN_C,
};
const CON_ENV: Record<string, string> = {
  TOKEN_SOURCE: "env",
  POSTER_ACCOUNTS: "tienda-a,tienda-b,mi-cafe-04",
  WRITE_DEFAULT_ACCOUNTS: "tienda-b",
  GCP_PROJECT_ID: "zq-proyecto",
  ...TOKENS,
};
const AUTH = { MCP_BEARER_TOKEN: "b".repeat(64), OAUTH_SIGNING_KEY: "k".repeat(64), OWNER_PASSPHRASE: "frase-de-prueba-larga" };
const GRUPO = { nombre: "Frecuentes", tipo: "descuento", porcentaje: 10 };

const temporales: string[] = [];

afterEach(() => {
  vi.doUnmock("@google-cloud/secret-manager");
  vi.doUnmock("mysql2/promise");
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
  for (const d of temporales.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Runs the loader and returns the error it throws (fails the test when it does not throw). */
function errorDe(env: Record<string, string | undefined>): Error {
  try {
    cargarConfig(env);
  } catch (e) {
    expect(e).toBeInstanceOf(Error);
    return e as Error;
  }
  throw new Error("cargarConfig aceptó la configuración");
}

/** Everything an error can print: message, stack, util.inspect output (with any cause) and JSON. */
const todoDe = (e: Error) => [e.message, e.stack ?? "", inspect(e, { depth: 5 }), JSON.stringify(e)].join("\n");

/** Stubs `entorno` on top of no configuration variables and no POSTER_TOKEN_* of the fixture. */
function entorno(e: Record<string, string>) {
  for (const k of [...CONFIGURACION, ...Object.keys(TOKENS)]) vi.stubEnv(k, undefined);
  for (const [k, v] of Object.entries(e)) vi.stubEnv(k, v);
}

/** A fresh, empty audit directory for one test. */
function dirAuditoria(): string {
  const d = mkdtempSync(path.join(os.tmpdir(), "poster-mcp-env-audit-"));
  temporales.push(d);
  return d;
}

/**
 * A 17-character value that would be a valid token without `c`, placed mid-string, so `c` is the only
 * reason it can fail. `n` is a marker that must not appear in the error.
 */
const conCaracter = (c: string, n: string) => `ZqMarca${c}Larga${n}`;

describe("TOKEN_SOURCE=env: loader", () => {
  it("E1 POSTER_TOKEN_<ACCOUNT> is the account upper-cased with every hyphen replaced by an underscore", () => {
    expect(variableToken("cafe-04")).toBe("POSTER_TOKEN_CAFE_04");
    expect(variableToken("mi-cafe-04")).toBe("POSTER_TOKEN_MI_CAFE_04");
    const c = cargarConfig({
      TOKEN_SOURCE: "env",
      POSTER_ACCOUNTS: "cafe-04,mi-cafe-04",
      POSTER_TOKEN_CAFE_04: "ZqTokenCafe04-alfa",
      POSTER_TOKEN_MI_CAFE_04: "ZqTokenMiCafe04-beta",
    });
    expect(c.tokenSource).toBe("env");
    expect([...c.envTokens]).toEqual([["cafe-04", "ZqTokenCafe04-alfa"], ["mi-cafe-04", "ZqTokenMiCafe04-beta"]]);
  });

  const MALOS: Array<[string, string | undefined]> = [
    ["missing", undefined],
    ["blank", ""],
    ["padded-only", "  \t \n"],
    ["containing a space", conCaracter(" ", "4471")],
    ["containing a tab", conCaracter("\t", "4472")],
    ["containing a newline", conCaracter("\n", "4473")],
    ["containing a no-break space", conCaracter(" ", "4474")],
    ["containing a C0 control character", conCaracter("\u0007", "4475")],
    ["containing a DEL character", conCaracter("\u007F", "4476")],
    ["containing a C1 control character", conCaracter("\u009B", "4477")],
    ["containing a double quote", conCaracter('"', "4478")],
    ["containing a backslash", conCaracter("\\", "4479")],
    ["containing a percent sign", conCaracter("%", "4480")],
    ["containing an ampersand", conCaracter("&", "4481")],
    ["containing an equals sign", conCaracter("=", "4482")],
    ["of 15 characters", "ZqMarcaCort4483"],
    ["containing a plus sign", conCaracter("+", "4484")],
    ["containing a slash", conCaracter("/", "4485")],
    ["containing a hash sign", conCaracter("#", "4486")],
    ["containing a question mark", conCaracter("?", "4487")],
    ["containing a non-ASCII letter", conCaracter("ñ", "4488")],
  ];

  it.each(MALOS)("E2 a token (%s) fails startup, names its variable and quotes no value", (_caso, valor) => {
    const e = errorDe({ TOKEN_SOURCE: "env", POSTER_ACCOUNTS: "tienda-a,tienda-b", POSTER_TOKEN_TIENDA_A: "ZqValidoToken-8810", POSTER_TOKEN_TIENDA_B: valor });
    expect(e.message).toMatch(/^POSTER_TOKEN_\*: /);
    expect(e.message).toContain("POSTER_TOKEN_TIENDA_B");
    expect(e.message).not.toContain("POSTER_TOKEN_TIENDA_A");
    const todo = todoDe(e);
    const marcas = ["ZqMarca", "Larga", "ZqValido", "8810", ...Array.from({ length: 18 }, (_, i) => String(4471 + i))];
    for (const marca of marcas) expect(todo, marca).not.toContain(marca);
  });

  it("E3 every failing variable is named in one error, and only those", () => {
    const e = errorDe({
      TOKEN_SOURCE: "env",
      POSTER_ACCOUNTS: "falta-1,blanco-2,relleno-3,espacio-4,control-5,corto-6,comilla-7,valido-8",
      POSTER_TOKEN_BLANCO_2: "",
      POSTER_TOKEN_RELLENO_3: "   ",
      POSTER_TOKEN_ESPACIO_4: "ZqMarca 5504-Largo",
      POSTER_TOKEN_CONTROL_5: "ZqMarca\u00005505-Largo",
      POSTER_TOKEN_CORTO_6: "ZqMarca5506",
      POSTER_TOKEN_COMILLA_7: 'ZqMarca"5507-Largo',
      POSTER_TOKEN_VALIDO_8: "ZqValidoToken-5508",
    });
    expect(e.message).toMatch(/^POSTER_TOKEN_\*: /);
    for (const v of [
      "POSTER_TOKEN_FALTA_1", "POSTER_TOKEN_BLANCO_2", "POSTER_TOKEN_RELLENO_3", "POSTER_TOKEN_ESPACIO_4",
      "POSTER_TOKEN_CONTROL_5", "POSTER_TOKEN_CORTO_6", "POSTER_TOKEN_COMILLA_7",
    ]) {
      expect(e.message, v).toContain(v);
    }
    expect(e.message).not.toContain("POSTER_TOKEN_VALIDO_8");
    // The rule is stated: the minimum length is part of the message.
    expect(e.message).toContain("16");
    const todo = todoDe(e);
    for (const marca of ["ZqMarca", "Largo", "ZqValido", "5504", "5505", "5506", "5507", "5508"]) expect(todo, marca).not.toContain(marca);
  });

  it("E4 a valid token with surrounding whitespace is trimmed", () => {
    const c = cargarConfig({ TOKEN_SOURCE: "env", POSTER_ACCOUNTS: "tienda-a", POSTER_TOKEN_TIENDA_A: " \t ZqTokenRelleno-7781\r\n" });
    expect(c.envTokens.get("tienda-a")).toBe("ZqTokenRelleno-7781");
  });

  it("E15 a token of exactly 16 characters using every allowed sign loads, and so does an <account id>:<hex> token", () => {
    const limite = "Zq09:._~-Az12345";
    expect(limite).toHaveLength(16);
    const poster = "123456:0123456789abcdef0123456789abcdef";
    const c = cargarConfig({ TOKEN_SOURCE: "env", POSTER_ACCOUNTS: "tienda-a,tienda-b", POSTER_TOKEN_TIENDA_A: limite, POSTER_TOKEN_TIENDA_B: poster });
    expect([...c.envTokens]).toEqual([["tienda-a", limite], ["tienda-b", poster]]);
  });

  it.each([" env", "env ", "env\n", "ENV", "Env"])("E5 TOKEN_SOURCE=%j fails: only the exact lowercase env is valid", (fuente) => {
    const e = errorDe({ TOKEN_SOURCE: fuente, POSTER_ACCOUNTS: "tienda-a", POSTER_TOKEN_TIENDA_A: "ZqTokenFuente-7782" });
    expect(e.message).toMatch(/^TOKEN_SOURCE: /);
    expect(todoDe(e)).not.toContain("ZqTokenFuente-7782");
  });

  it.each([["gsm"], ["mysql"], ["unset"], ["blank"]])("E6 with TOKEN_SOURCE %s, POSTER_TOKEN_* variables are ignored", (fuente) => {
    const valor = fuente === "unset" ? undefined : fuente === "blank" ? " " : fuente;
    // tienda-a has an invalid token and tienda-b none: neither matters outside env.
    const c = cargarConfig({ TOKEN_SOURCE: valor, POSTER_ACCOUNTS: "tienda-a,tienda-b", POSTER_TOKEN_TIENDA_A: "Zq Malo 7783" });
    expect(c.tokenSource).toBe(fuente === "mysql" ? "mysql" : "gsm");
    expect(c.envTokens.size).toBe(0);
  });

  it("E7 with no variables the token source stays gsm and no env token is read", () => {
    const c = cargarConfig({});
    expect(c.tokenSource).toBe("gsm");
    expect(c.envTokens.size).toBe(0);
  });
});

/**
 * Fresh tokens module with `e` on top of no configuration. Secret Manager and mysql2 are mocked with
 * spies on the module factories, the client constructor and createConnection.
 */
async function tokens(e: Record<string, string>) {
  vi.resetModules();
  const cliente = vi.fn();
  const conexion = vi.fn(async () => ({ execute: async () => [[{ apiToken: "ZqDesdeMysql" }]], end: async () => {} }));
  const fabricaGsm = vi.fn(() => ({
    SecretManagerServiceClient: class {
      constructor() {
        cliente();
      }
      async accessSecretVersion() {
        return [{ payload: { data: Buffer.from("ZqDesdeGsm") } }];
      }
    },
  }));
  const fabricaMysql = vi.fn(() => ({ createConnection: conexion }));
  vi.doMock("@google-cloud/secret-manager", fabricaGsm);
  vi.doMock("mysql2/promise", fabricaMysql);
  entorno(e);
  const t = await import("../src/tokens.js");
  return { t, cliente, conexion, fabricaGsm, fabricaMysql };
}

/** Changes the process environment after the modules loaded: one token replaced, one removed, source flipped. */
const TOKEN_NUEVO = "ZqTokenCambiado-0001";
function cambiarEntorno() {
  vi.stubEnv("POSTER_TOKEN_TIENDA_B", TOKEN_NUEVO);
  vi.stubEnv("POSTER_TOKEN_MI_CAFE_04", undefined);
  vi.stubEnv("TOKEN_SOURCE", "gsm");
}

describe("TOKEN_SOURCE=env: lookup", () => {
  it("E8 returns each listed account's token without importing or calling Secret Manager or MySQL", async () => {
    const { t, cliente, conexion, fabricaGsm, fabricaMysql } = await tokens(CON_ENV);
    await expect(t.tokenDe("tienda-b")).resolves.toBe(TOKEN_B);
    await expect(t.tokenDe("mi-cafe-04")).resolves.toBe(TOKEN_C);
    await expect(t.tokenDe("tienda-b")).resolves.toBe(TOKEN_B);
    expect(fabricaGsm).not.toHaveBeenCalled();
    expect(fabricaMysql).not.toHaveBeenCalled();
    expect(cliente).not.toHaveBeenCalled();
    expect(conexion).not.toHaveBeenCalled();
  });

  it("E9 an account outside the list is rejected even when its POSTER_TOKEN_* variable is set", async () => {
    const { t, fabricaGsm, fabricaMysql } = await tokens({ ...CON_ENV, POSTER_TOKEN_CAFE_99: "ZqTokenNoListado-4410" });
    await expect(t.tokenDe("cafe-99")).rejects.toThrow('Cuenta "cafe-99" fuera de la lista blanca.');
    expect(fabricaGsm).not.toHaveBeenCalled();
    expect(fabricaMysql).not.toHaveBeenCalled();
  });

  const OTRAS_FUENTES: Array<[string, Record<string, string>, string]> = [
    ["gsm", { GCP_PROJECT_ID: "zq-proyecto" }, "ZqDesdeGsm"],
    ["mysql", { POSTER_MYSQL_URL: "mysql://zq:zq@db.invalid/poster" }, "ZqDesdeMysql"],
  ];

  it.each(OTRAS_FUENTES)("E16 with TOKEN_SOURCE=%s, a valid POSTER_TOKEN_* variable is ignored and the lookup goes to that source", async (fuente, extra, esperado) => {
    const { t, cliente, conexion, fabricaGsm, fabricaMysql } = await tokens({ ...CON_ENV, GCP_PROJECT_ID: "", TOKEN_SOURCE: fuente, ...extra });
    await expect(t.tokenDe("tienda-a")).resolves.toBe(esperado);
    if (fuente === "gsm") {
      expect(cliente).toHaveBeenCalledTimes(1);
      expect(fabricaMysql).not.toHaveBeenCalled();
    } else {
      expect(conexion).toHaveBeenCalledTimes(1);
      expect(fabricaGsm).not.toHaveBeenCalled();
    }
  });

  it("E17 lookups use the tokens read at startup: a later change to the process environment has no effect", async () => {
    const { t, fabricaGsm, fabricaMysql } = await tokens(CON_ENV);
    cambiarEntorno();
    await expect(t.tokenDe("tienda-b")).resolves.toBe(TOKEN_B);
    await expect(t.tokenDe("mi-cafe-04")).resolves.toBe(TOKEN_C);
    expect(fabricaGsm).not.toHaveBeenCalled();
    expect(fabricaMysql).not.toHaveBeenCalled();
  });
});

describe("TOKEN_SOURCE=env: redaction", () => {
  it("E10 redactar() strips the env token of every listed account from the start, none looked up", async () => {
    const { t } = await tokens(CON_ENV);
    const texto = t.redactar(`a ${TOKEN_A} b "${TOKEN_B}" c ${TOKEN_C}x`);
    for (const tok of [TOKEN_A, TOKEN_B, TOKEN_C]) expect(texto).not.toContain(tok);
    expect(texto).toBe('a *** b "***" c ***x');
  });

  it("E18 redactar() strips every occurrence of an env token, not only the first", async () => {
    const { t } = await tokens(CON_ENV);
    expect(t.redactar(`${TOKEN_C}|${TOKEN_C} y ${TOKEN_C}${TOKEN_C}`)).toBe("***|*** y ******");
  });

  it("E19 redaction uses the tokens read at startup: a later change to the process environment has no effect", async () => {
    const { t } = await tokens(CON_ENV);
    cambiarEntorno();
    expect(t.redactar(`${TOKEN_A} ${TOKEN_B} ${TOKEN_C} ${TOKEN_NUEVO}`)).toBe(`*** *** *** ${TOKEN_NUEVO}`);
  });
});

/** Fake Poster: answers each request with `responder(url, init)` as JSON. */
type Respuesta = (url: string, init?: RequestInit) => unknown;

/**
 * MCP server on the real Poster HTTP client (fresh modules, `e` on top of no configuration, fetch faked,
 * audit written to a fresh directory) with an in-memory MCP client connected.
 */
async function servidor(e: Record<string, string>, responder: Respuesta) {
  vi.resetModules();
  const auditDir = dirAuditoria();
  entorno({ ...e, AUDIT_DIR: auditDir });
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => new Response(JSON.stringify(responder(String(url), init))));
  vi.stubGlobal("fetch", fetch);
  const consola = vi.spyOn(console, "log").mockImplementation(() => {});
  const { crearServidorMcp } = await import("../src/mcp.js");
  const [ladoCliente, ladoServidor] = InMemoryTransport.createLinkedPair();
  await crearServidorMcp().connect(ladoServidor);
  const cliente = new Client({ name: "prueba", version: "0.0.0" });
  await cliente.connect(ladoCliente);
  const llamar = async (name: string, args: Obj) => {
    const r = await cliente.callTool({ name, arguments: args });
    const texto = (r.content as Array<{ text: string }>)[0]?.text ?? "";
    return { isError: r.isError === true, texto };
  };
  const urls = () => fetch.mock.calls.map(([u]) => String(u));
  return { llamar, urls, auditDir, consola };
}

describe("TOKEN_SOURCE=env: MCP server and HTTP", () => {
  it("E11 a read tool requests https://<account>.joinposter.com/api/... with that account's token, URL-encoded", async () => {
    const { llamar, urls } = await servidor(CON_ENV, () => ({ response: [] }));
    expect((await llamar("client_groups", { cuenta: "tienda-b" })).isError).toBe(false);
    expect((await llamar("client_groups", { cuenta: "mi-cafe-04" })).isError).toBe(false);
    const [b, c] = urls();
    expect(urls()).toHaveLength(2);
    expect(b.startsWith("https://tienda-b.joinposter.com/api/clients.getGroups?token=770044%3AZqEnvTokenB~beta&")).toBe(true);
    expect(new URL(b).searchParams.get("token")).toBe(TOKEN_B);
    expect(c.startsWith(`https://mi-cafe-04.joinposter.com/api/clients.getGroups?token=${TOKEN_C}&`)).toBe(true);
  });

  it("E12 env tokens in a Poster error are absent from the tool error returned to the client", async () => {
    const { llamar } = await servidor(CON_ENV, () => ({ error: 10, message: `Token ${TOKEN_A} no coincide con ${TOKEN_B}` }));
    const r = await llamar("client_groups", { cuenta: "tienda-b" });
    expect(r.isError).toBe(true);
    expect(r.texto).toContain("clients.getGroups");
    expect(r.texto).toContain("***");
    for (const tok of [TOKEN_A, TOKEN_B]) expect(r.texto).not.toContain(tok);
  });

  it("E13 env tokens in a Poster write error are absent from the tool result and from the audit entry", async () => {
    const { llamar, auditDir, consola } = await servidor(CON_ENV, (_url, init) =>
      init?.method === "POST" ? { error: 32, message: `Token ${TOKEN_A} sin permiso; recibido ${TOKEN_B}` } : { response: [] },
    );
    const r = await llamar("create_client_group", { cuenta: "tienda-b", ...GRUPO, confirm: true });
    expect(r.isError).toBe(false);
    expect(JSON.parse(r.texto).modo).toBe("rechazado");
    for (const tok of [TOKEN_A, TOKEN_B]) expect(r.texto, "tool result").not.toContain(tok);

    const archivos = readdirSync(auditDir).filter((f) => f.endsWith(".jsonl"));
    expect(archivos).toHaveLength(1);
    const lineas = readFileSync(path.join(auditDir, archivos[0]), "utf8").trim().split("\n");
    expect(lineas).toHaveLength(1);
    const entrada = JSON.parse(lineas[0]);
    expect(entrada.modo).toBe("rechazado");
    expect(entrada.herramienta).toBe("create_client_group");
    expect(lineas[0]).toContain("***");
    const registro = consola.mock.calls.map((a) => a.map(String).join(" ")).filter((l) => l.includes('"audit":true'));
    expect(registro).toHaveLength(1);
    for (const tok of [TOKEN_A, TOKEN_B]) {
      expect(lineas[0], "audit file").not.toContain(tok);
      expect(registro[0], "audit log").not.toContain(tok);
    }
  });

  it("E14 /health with env returns exactly ok, servicio, tokens: env and oauth, and no token", async () => {
    vi.resetModules();
    entorno({ ...CON_ENV, ...AUTH });
    const { crearApp } = await import("../src/server.js");
    const r = await crearApp().request("/health");
    expect(r.status).toBe(200);
    const texto = await r.text();
    expect(JSON.parse(texto)).toStrictEqual({ ok: true, servicio: "poster-rush", tokens: "env", oauth: true });
    for (const tok of [TOKEN_A, TOKEN_B, encodeURIComponent(TOKEN_B), TOKEN_C]) expect(texto, tok).not.toContain(tok);
  });
});
