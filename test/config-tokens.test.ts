// Token lookup with TOKEN_SOURCE=mysql: POSTER_MYSQL_URL replaces the DATABASE_URL line of
// FINANZAS_ENV_PATH, that file is otherwise read lazily, and a generic DATABASE_URL is never used.
// MySQL failures surface as a fresh error that names the source and never the URL. The MySQL driver
// is mocked, or used only on URLs it rejects before connecting (hosts under .invalid); nothing
// connects anywhere.
import { describe, it, expect, vi, afterEach, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { inspect } from "node:util";
import os from "node:os";
import path from "node:path";

const DIR = mkdtempSync(path.join(os.tmpdir(), "poster-mcp-tokens-"));
const ARCHIVO = path.join(DIR, "finanzas.env");
const ARCHIVO_MALFORMADO = path.join(DIR, "malformado.env");
const INEXISTENTE = path.join(DIR, "no-existe.env");
const URL_ARCHIVO = "mysql://archivo:clave@db-archivo.example/finanzas";
const URL_EXPLICITA = "mysql://explicita:clave@db-explicita.example/poster";
const URL_GENERICA = "mysql://generica:clave@db-generica.example/otra";

// Synthetic credentials: no part of these URLs may appear in a surfaced error.
const SECRETA = { usuario: "zqusuario", clave: "ZqClaveDb4471", host: "zq-db.invalid" };
const URL_SECRETA = `mysql://${SECRETA.usuario}:${SECRETA.clave}@${SECRETA.host}:3306/poster`;
const ARCHIVO_SECRETO = { usuario: "zqarchivo", clave: "ZqClaveArchivo8812", host: "zq-archivo.invalid" };

/** Every runtime configuration variable; each test starts from none of them. */
const CONFIGURACION = ["POSTER_ACCOUNTS", "DEFAULT_WRITE_ACCOUNT", "WRITE_DEFAULT_ACCOUNTS", "TIMEZONE", "OWNER_NAME", "NETWORK_NAME", "SERVICE_NAME", "OAUTH_SUBJECT", "TOKEN_SOURCE", "POSTER_MYSQL_URL"];

type Conexion = { execute: (sql: string, params: unknown[]) => Promise<unknown>; end: () => Promise<void> };
let conexiones: string[] = [];
let consultas: unknown[][] = [];

const exito = async (url: string): Promise<Conexion> => ({
  execute: async (_sql, params) => {
    consultas.push(params);
    return [[{ apiToken: `tok-${String(params[0])}` }]];
  },
  end: async () => {},
});

beforeAll(() => {
  writeFileSync(ARCHIVO, `OTRA=1\nDATABASE_URL="${URL_ARCHIVO}"\n`);
  const s = ARCHIVO_SECRETO;
  writeFileSync(ARCHIVO_MALFORMADO, `DATABASE_URL=mysql://${s.usuario}:${s.clave}@[${s.host}/finanzas\n`);
});

afterEach(() => {
  vi.doUnmock("mysql2/promise");
  vi.unstubAllEnvs();
  vi.resetModules();
});

afterAll(() => {
  rmSync(DIR, { recursive: true, force: true });
});

/**
 * Fresh tokens module with `entorno` on top of no configuration variables. `driver` is the mocked
 * createConnection (default: every lookup finds a token), or "real" for the installed mysql2.
 */
async function tokens(entorno: Record<string, string | undefined>, driver: ((url: string) => Promise<Conexion>) | "real" = exito) {
  vi.resetModules();
  conexiones = [];
  consultas = [];
  if (driver === "real") vi.doUnmock("mysql2/promise");
  else {
    vi.doMock("mysql2/promise", () => ({
      createConnection: vi.fn(async (url: string) => {
        conexiones.push(url);
        return driver(url);
      }),
    }));
  }
  for (const k of [...CONFIGURACION, "DATABASE_URL"]) vi.stubEnv(k, undefined);
  for (const [k, v] of Object.entries(entorno)) vi.stubEnv(k, v);
  return import("../src/tokens.js");
}

/** The rejection of `p`, failing the test when it resolves. */
async function rechazo(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(Error);
    return e as Error;
  }
  throw new Error("la promesa no fue rechazada");
}

/** Asserts that `e` is a fresh error: no cause, no copied property, none of `partes` in what it prints. */
function saneado(e: Error, partes: string[]) {
  expect(e.cause).toBeUndefined();
  expect(Object.getOwnPropertyNames(e).sort()).toEqual(["message", "stack"]);
  // util.inspect is what Node prints for an uncaught rejection (the token importer script).
  const texto = [e.message, e.stack ?? "", inspect(e, { depth: 5 }), JSON.stringify(e)].join("\n").toLowerCase();
  for (const p of partes) expect(texto, p).not.toContain(p.toLowerCase());
}

describe("TOKEN_SOURCE=mysql and POSTER_MYSQL_URL", () => {
  it("K1 POSTER_MYSQL_URL replaces the file: the lookup connects to it and never reads FINANZAS_ENV_PATH", async () => {
    const t = await tokens({ TOKEN_SOURCE: "mysql", POSTER_MYSQL_URL: URL_EXPLICITA, FINANZAS_ENV_PATH: INEXISTENTE, DATABASE_URL: URL_GENERICA });
    await expect(t.tokenDe("cafe-04")).resolves.toBe("tok-cafe-04");
    expect(conexiones).toEqual([URL_EXPLICITA]);
  });

  it("K2 without POSTER_MYSQL_URL, the DATABASE_URL line of FINANZAS_ENV_PATH is used and a generic DATABASE_URL is not", async () => {
    const t = await tokens({ TOKEN_SOURCE: "mysql", FINANZAS_ENV_PATH: ARCHIVO, DATABASE_URL: URL_GENERICA });
    await expect(t.tokenDe("cafe-04")).resolves.toBe("tok-cafe-04");
    expect(conexiones).toEqual([URL_ARCHIVO]);
  });

  it("K3 without POSTER_MYSQL_URL, the file is read lazily: loading succeeds and the first lookup fails on it", async () => {
    const t = await tokens({ TOKEN_SOURCE: "mysql", FINANZAS_ENV_PATH: INEXISTENTE });
    await expect(t.tokenDe("cafe-04")).rejects.toThrow(/ENOENT/);
    expect(conexiones).toEqual([]);
  });

  it("K4 with a custom account list, a listed account is looked up and a default account is rejected", async () => {
    const t = await tokens({ TOKEN_SOURCE: "mysql", POSTER_MYSQL_URL: URL_EXPLICITA, POSTER_ACCOUNTS: "tienda-a,tienda-b", WRITE_DEFAULT_ACCOUNTS: "" });
    await expect(t.tokenDe("tienda-a")).resolves.toBe("tok-tienda-a");
    expect(consultas).toEqual([["tienda-a"]]);
    await expect(t.tokenDe("cafe-04")).rejects.toThrow('Cuenta "cafe-04" fuera de la lista blanca.');
    expect(t.nombreSecreto("tienda-b")).toBe("poster-token-tienda-b");
  });

  it("K5 with TOKEN_SOURCE=gsm, POSTER_MYSQL_URL is not used", async () => {
    const t = await tokens({ TOKEN_SOURCE: "gsm", POSTER_MYSQL_URL: URL_EXPLICITA, GCP_PROJECT_ID: "" });
    await expect(t.tokenDe("cafe-04")).rejects.toThrow("GCP_PROJECT_ID no configurado");
    expect(conexiones).toEqual([]);
  });

  it("K6 the file is read at the first lookup, not at import: a file created after import is used", async () => {
    const tardio = path.join(DIR, "tardio.env");
    const t = await tokens({ TOKEN_SOURCE: "mysql", FINANZAS_ENV_PATH: tardio });
    writeFileSync(tardio, `DATABASE_URL=${URL_ARCHIVO}\n`);
    await expect(t.tokenDe("cafe-04")).resolves.toBe("tok-cafe-04");
    expect(conexiones).toEqual([URL_ARCHIVO]);
  });

  it("K13 an empty DATABASE_URL line is not kept: after the file is corrected the next lookup uses it, and a non-empty URL then stays in use", async () => {
    const corregible = path.join(DIR, "corregible.env");
    writeFileSync(corregible, "DATABASE_URL=\n");
    const t = await tokens({ TOKEN_SOURCE: "mysql", FINANZAS_ENV_PATH: corregible }, async (url) => {
      if (!url) throw Object.assign(new Error("URL vacía"), { code: "ERR_INVALID_URL" });
      return exito(url);
    });
    const e = await rechazo(t.tokenDe("cafe-04"));
    expect(e.message).toMatch(/DATABASE_URL.*FINANZAS_ENV_PATH/);
    writeFileSync(corregible, `DATABASE_URL=${URL_ARCHIVO}\n`);
    await expect(t.tokenDe("cafe-04")).resolves.toBe("tok-cafe-04");
    // A non-empty URL, once read, is kept: a later change to the file is not picked up by another account.
    writeFileSync(corregible, `DATABASE_URL=${URL_EXPLICITA}\n`);
    await expect(t.tokenDe("cafe-05")).resolves.toBe("tok-cafe-05");
    expect(conexiones).toEqual(["", URL_ARCHIVO, URL_ARCHIVO]);
  });
});

describe("MySQL errors are sanitized", () => {
  it("K7 a malformed explicit POSTER_MYSQL_URL with credentials stops loading with an error that carries no part of it", async () => {
    const malformada = `mysql://${SECRETA.usuario}:${SECRETA.clave}@[${SECRETA.host}/poster`;
    const e = await rechazo(tokens({ TOKEN_SOURCE: "mysql", POSTER_MYSQL_URL: malformada }, "real"));
    expect(e.message).toMatch(/^POSTER_MYSQL_URL: /);
    saneado(e, Object.values(SECRETA));
  });

  it("K8 an explicit URL that parses but that mysql2 rejects surfaces as the sanitized error naming POSTER_MYSQL_URL", async () => {
    // A broken percent-escape in the password: new URL() accepts it, mysql2 cannot decode it.
    const rota = `mysql://${SECRETA.usuario}:${SECRETA.clave}%E0%A4%A@${SECRETA.host}/poster`;
    const t = await tokens({ TOKEN_SOURCE: "mysql", POSTER_MYSQL_URL: rota }, "real");
    const e = await rechazo(t.tokenDe("cafe-04"));
    expect(e.message).toMatch(/POSTER_MYSQL_URL/);
    saneado(e, Object.values(SECRETA));
  });

  it("K9 a malformed DATABASE_URL line in the file surfaces as the sanitized error naming the file source and the code", async () => {
    const t = await tokens({ TOKEN_SOURCE: "mysql", FINANZAS_ENV_PATH: ARCHIVO_MALFORMADO }, "real");
    const e = await rechazo(t.tokenDe("cafe-04"));
    expect(e.message).toMatch(/DATABASE_URL.*FINANZAS_ENV_PATH/);
    expect(e.message).toContain("(ERR_INVALID_URL)");
    saneado(e, Object.values(ARCHIVO_SECRETO));
  });

  it("K10 a connection failure whose message, input and cause carry the URL surfaces as the sanitized error with its code", async () => {
    const t = await tokens({ TOKEN_SOURCE: "mysql", POSTER_MYSQL_URL: URL_SECRETA }, async (url) => {
      throw Object.assign(new Error(`connect ECONNREFUSED ${url}`, { cause: new Error(`no se pudo abrir ${url}`) }), {
        code: "ECONNREFUSED",
        input: url,
        errno: -61,
      });
    });
    const e = await rechazo(t.tokenDe("cafe-04"));
    expect(e.message).toMatch(/POSTER_MYSQL_URL/);
    expect(e.message).toContain("(ECONNREFUSED)");
    expect(conexiones).toEqual([URL_SECRETA]);
    saneado(e, [...Object.values(SECRETA), URL_SECRETA]);
  });

  it("K11 a query failure that carries the URL is sanitized too, and a code that is not an uppercase identifier is left out", async () => {
    const t = await tokens({ TOKEN_SOURCE: "mysql", POSTER_MYSQL_URL: URL_SECRETA }, async (url) => ({
      execute: async () => {
        throw Object.assign(new Error(`consulta fallida en ${url}`), { code: url, sql: `-- ${url}` });
      },
      end: async () => {},
    }));
    const e = await rechazo(t.tokenDe("cafe-04"));
    expect(e.message).toMatch(/POSTER_MYSQL_URL/);
    expect(e.message).not.toMatch(/\(/);
    saneado(e, [...Object.values(SECRETA), URL_SECRETA]);
  });

  it("K14 a driver code that starts with an uppercase identifier but carries anything more, the URL included, is left out whole", async () => {
    const codigos = [`ER_ACCESS_DENIED_ERROR ${URL_SECRETA}`, `ECONNREFUSED:${SECRETA.clave}`, `ER_${SECRETA.usuario}`];
    for (const code of codigos) {
      const t = await tokens({ TOKEN_SOURCE: "mysql", POSTER_MYSQL_URL: URL_SECRETA }, async () => {
        throw Object.assign(new Error("acceso denegado"), { code });
      });
      const e = await rechazo(t.tokenDe("cafe-04"));
      expect(e.message, code).toBe("MySQL: falló la conexión o la consulta con POSTER_MYSQL_URL.");
      saneado(e, [...Object.values(SECRETA), URL_SECRETA]);
    }
  });

  it("K12 no active row keeps its own message", async () => {
    const t = await tokens({ TOKEN_SOURCE: "mysql", POSTER_MYSQL_URL: URL_EXPLICITA }, async () => ({
      execute: async () => [[]],
      end: async () => {},
    }));
    await expect(t.tokenDe("cafe-04")).rejects.toThrow(/^Sin token activo para cafe-04 en poster_accounts$/);
  });
});
