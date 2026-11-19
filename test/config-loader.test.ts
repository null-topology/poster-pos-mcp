// Runtime configuration loader: cargarConfig builds and validates every setting from a plain
// environment object. No variables gives today's values; invalid input fails fast with a message that
// names the variable and the rule and never quotes a configured value; the loader never logs.
import { describe, it, expect, vi, afterEach } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";
import { cargarConfig } from "../src/config.js";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIEZ = Array.from({ length: 10 }, (_, i) => `cafe-${String(i + 1).padStart(2, "0")}`);

// Distinctive values for every secret variable; no loader error may contain any of them.
const SECRETOS: Record<string, string> = {
  MCP_BEARER_TOKEN: "ZqBearer4417ZqBearer4417ZqBearer4417",
  OAUTH_SIGNING_KEY: "ZqSigning8823ZqSigning8823ZqSigning8823",
  OWNER_PASSPHRASE: "ZqPassphrase5590",
  POSTER_MYSQL_URL: "mysql://zquser:ZqDbPass3301@db.example/poster",
  POSTER_TOKEN_TIENDA_A: "ZqPosterToken7712",
  POSTER_TOKEN_CAFE_04: "ZqPosterToken9045",
};

const CONSOLA = ["log", "info", "warn", "error", "debug", "trace", "dir", "table"] as const;
const espiarConsola = () => CONSOLA.map((m) => vi.spyOn(console, m).mockImplementation(() => {}));

afterEach(() => {
  vi.restoreAllMocks();
});

/** Runs the loader and returns the error it throws (fails the test when it does not throw). */
function errorDe(env: Record<string, string | undefined>): Error {
  try {
    cargarConfig(env);
  } catch (e) {
    expect(e).toBeInstanceOf(Error);
    return e as Error;
  }
  throw new Error(`cargarConfig aceptó ${JSON.stringify(env)}`);
}

/** Everything an error can print: message, stack, util.inspect output (with any cause) and JSON. */
const todoDe = (e: Error) => [e.message, e.stack ?? "", inspect(e, { depth: 5 }), JSON.stringify(e)].join("\n");

describe("cargarConfig: defaults", () => {
  it("L1 no variables: every field equals today's value", () => {
    const c = cargarConfig({});
    expect(c.raiz).toBe(RAIZ);
    expect(c.accounts).toEqual(DIEZ);
    expect(c.defaultWriteAccount).toBe("cafe-04");
    expect([...c.writeDefault]).toEqual(["cafe-04"]);
    expect(c.timezone).toBe("America/Merida");
    expect(c.ownerName).toBe("Roy");
    expect(c.networkName).toBe("RUSH Café");
    expect(c.serviceName).toBe("poster-rush");
    expect(c.oauthSubject).toBe("roy");
    expect(c.tokenSource).toBe("gsm");
    expect(c.posterMysqlUrl).toBeUndefined();
    // Existing variables keep their defaults.
    expect(c.port).toBe(3210);
    expect(c.publicBaseUrl).toBe("http://localhost:3210");
    expect(c.gcpProjectId).toBe("");
    expect(c.secretPrefix).toBe("poster-token-");
    expect(c.bearerToken).toBe("");
    expect(c.oauthSigningKey).toBe("");
    expect(c.ownerPassphrase).toBe("");
    expect(c.oauthAllowedRedirects).toEqual(["https://claude.ai/api/mcp/auth_callback", "https://claude.com/api/mcp/auth_callback"]);
    expect(c.auditDir).toBe(path.resolve(RAIZ, "./audit"));
    expect(path.isAbsolute(c.finanzasEnvPath)).toBe(true);
    expect(path.basename(c.finanzasEnvPath)).toBe(".env");
  });

  it("L2 existing variables keep their names and parsing", () => {
    const c = cargarConfig({
      PORT: "4000",
      FINANZAS_ENV_PATH: "/tmp/finanzas.env",
      GCP_PROJECT_ID: "proyecto",
      SECRET_PREFIX: "pt-",
      MCP_BEARER_TOKEN: "b".repeat(40),
      OAUTH_SIGNING_KEY: "k".repeat(64),
      OWNER_PASSPHRASE: "frase-larga-de-prueba",
      OAUTH_ALLOWED_REDIRECTS: " https://a.example/cb , ,https://b.example/cb",
      AUDIT_DIR: "/tmp/auditoria",
    });
    expect(c.port).toBe(4000);
    expect(c.publicBaseUrl).toBe("http://localhost:4000");
    expect(c.finanzasEnvPath).toBe("/tmp/finanzas.env");
    expect(c.gcpProjectId).toBe("proyecto");
    expect(c.secretPrefix).toBe("pt-");
    expect(c.bearerToken).toBe("b".repeat(40));
    expect(c.oauthSigningKey).toBe("k".repeat(64));
    expect(c.ownerPassphrase).toBe("frase-larga-de-prueba");
    expect(c.oauthAllowedRedirects).toEqual(["https://a.example/cb", "https://b.example/cb"]);
    expect(c.auditDir).toBe("/tmp/auditoria");
    expect(cargarConfig({ PUBLIC_BASE_URL: "https://mcp.example/" }).publicBaseUrl).toBe("https://mcp.example");
  });

  it("L3 blank optional values mean their default (target and permissions: none)", () => {
    const c = cargarConfig({ DEFAULT_WRITE_ACCOUNT: " ", WRITE_DEFAULT_ACCOUNTS: "  ", TIMEZONE: " ", OWNER_NAME: "", NETWORK_NAME: "\t ", TOKEN_SOURCE: " ", POSTER_MYSQL_URL: " " });
    expect(c.accounts).toEqual(DIEZ);
    expect(c.defaultWriteAccount).toBeUndefined();
    expect([...c.writeDefault]).toEqual([]);
    expect(c.timezone).toBe("America/Merida");
    expect(c.ownerName).toBe("Roy");
    expect(c.networkName).toBe("RUSH Café");
    expect(c.tokenSource).toBe("gsm");
    expect(c.posterMysqlUrl).toBeUndefined();
  });
});

describe("cargarConfig: custom values", () => {
  it("L4 a custom account list, write target, write permissions, timezone and names are applied", () => {
    const c = cargarConfig({
      POSTER_ACCOUNTS: " tienda-a , tienda-b,tienda-c ",
      DEFAULT_WRITE_ACCOUNT: " tienda-b ",
      WRITE_DEFAULT_ACCOUNTS: "tienda-c, ,tienda-b,",
      TIMEZONE: "Asia/Tokyo",
      OWNER_NAME: " Ana ",
      NETWORK_NAME: "Tacos Norte",
      SERVICE_NAME: "tacos-mcp",
      OAUTH_SUBJECT: "ana@tacos.example",
      TOKEN_SOURCE: "mysql",
      POSTER_MYSQL_URL: "mysql://u:p@h/db",
    });
    expect(c.accounts).toEqual(["tienda-a", "tienda-b", "tienda-c"]);
    expect(c.defaultWriteAccount).toBe("tienda-b");
    expect([...c.writeDefault].sort()).toEqual(["tienda-b", "tienda-c"]);
    expect(c.timezone).toBe("Asia/Tokyo");
    expect(c.ownerName).toBe("Ana");
    expect(c.networkName).toBe("Tacos Norte");
    expect(c.serviceName).toBe("tacos-mcp");
    expect(c.oauthSubject).toBe("ana@tacos.example");
    expect(c.tokenSource).toBe("mysql");
    expect(c.posterMysqlUrl).toBe("mysql://u:p@h/db");
  });

  it("L5 with a custom POSTER_ACCOUNTS and nothing else, there is no write target and the permission set is empty", () => {
    const c = cargarConfig({ POSTER_ACCOUNTS: "tienda-a,tienda-b" });
    expect(c.accounts).toEqual(["tienda-a", "tienda-b"]);
    expect(c.defaultWriteAccount).toBeUndefined();
    expect([...c.writeDefault]).toEqual([]);
  });

  it("L6 the order of WRITE_DEFAULT_ACCOUNTS has no effect", () => {
    const base = { POSTER_ACCOUNTS: "tienda-a,tienda-b,tienda-c", DEFAULT_WRITE_ACCOUNT: "tienda-b" };
    const uno = cargarConfig({ ...base, WRITE_DEFAULT_ACCOUNTS: "tienda-c,tienda-b" });
    const otro = cargarConfig({ ...base, WRITE_DEFAULT_ACCOUNTS: "tienda-b,tienda-c" });
    expect([...uno.writeDefault]).toEqual([...otro.writeDefault]);
    expect(uno.defaultWriteAccount).toBe("tienda-b");
    expect(otro.defaultWriteAccount).toBe("tienda-b");
  });

  it("L7 with the default list, the write target and permissions can be changed on their own", () => {
    const c = cargarConfig({ DEFAULT_WRITE_ACCOUNT: "cafe-02", WRITE_DEFAULT_ACCOUNTS: "cafe-02,cafe-07" });
    expect(c.accounts).toEqual(DIEZ);
    expect(c.defaultWriteAccount).toBe("cafe-02");
    expect([...c.writeDefault].sort()).toEqual(["cafe-02", "cafe-07"]);
  });

  it("L8 boundary values that the rules accept", () => {
    const largo = "a".repeat(63);
    expect(cargarConfig({ POSTER_ACCOUNTS: `a,0,a-b,x1y,a--b,${largo}` }).accounts).toEqual(["a", "0", "a-b", "x1y", "a--b", largo]);
    expect(cargarConfig({ SERVICE_NAME: "S".repeat(64) }).serviceName).toBe("S".repeat(64));
    expect(cargarConfig({ SERVICE_NAME: "Tacos_MCP.v2-a" }).serviceName).toBe("Tacos_MCP.v2-a");
    expect(cargarConfig({ OAUTH_SUBJECT: "x".repeat(64) }).oauthSubject).toBe("x".repeat(64));
    expect(cargarConfig({ OAUTH_SUBJECT: "Ana_1-2.3@b" }).oauthSubject).toBe("Ana_1-2.3@b");
    expect(cargarConfig({ OWNER_NAME: "ñ".repeat(100) }).ownerName).toBe("ñ".repeat(100));
    expect(cargarConfig({ NETWORK_NAME: `Tacos <Norte> & "Sur"` }).networkName).toBe(`Tacos <Norte> & "Sur"`);
    expect(cargarConfig({ TIMEZONE: "UTC" }).timezone).toBe("UTC");
  });
});

// Each case: variables (on top of the distinctive secrets) and what the message must name. Account-list
// errors identify the entry by its 1-based position, counting every comma-separated entry.
const FALLOS: Array<[string, Record<string, string>, RegExp]> = [
  ["uppercase account", { POSTER_ACCOUNTS: "tienda-a,Tienda-B" }, /^POSTER_ACCOUNTS: la entrada 2 /],
  ["account with a dot", { POSTER_ACCOUNTS: "tienda.a" }, /^POSTER_ACCOUNTS: la entrada 1 /],
  ["account with a slash", { POSTER_ACCOUNTS: "tienda/a" }, /^POSTER_ACCOUNTS: la entrada 1 /],
  ["account with a leading hyphen", { POSTER_ACCOUNTS: "tienda-a,-tienda" }, /^POSTER_ACCOUNTS: la entrada 2 /],
  ["account with a trailing hyphen", { POSTER_ACCOUNTS: "tienda-a,tienda-" }, /^POSTER_ACCOUNTS: la entrada 2 /],
  ["account longer than 63 characters", { POSTER_ACCOUNTS: "a".repeat(64) }, /^POSTER_ACCOUNTS: la entrada 1 /],
  ["empty account entry", { POSTER_ACCOUNTS: "tienda-a,,tienda-b" }, /^POSTER_ACCOUNTS: la entrada 2 .*vac/],
  ["trailing comma in the account list", { POSTER_ACCOUNTS: "tienda-a,tienda-b," }, /^POSTER_ACCOUNTS: la entrada 3 .*vac/],
  ["duplicate account", { POSTER_ACCOUNTS: "tienda-a,tienda-b, tienda-a" }, /^POSTER_ACCOUNTS: la entrada 3 repite la entrada 1\b/],
  ["empty POSTER_ACCOUNTS", { POSTER_ACCOUNTS: "" }, /^POSTER_ACCOUNTS/],
  ["whitespace-only POSTER_ACCOUNTS", { POSTER_ACCOUNTS: "   " }, /^POSTER_ACCOUNTS/],
  ["write target outside a custom list", { POSTER_ACCOUNTS: "tienda-a", DEFAULT_WRITE_ACCOUNT: "tienda-z" }, /^DEFAULT_WRITE_ACCOUNT: .*POSTER_ACCOUNTS/],
  ["write target outside the default list", { DEFAULT_WRITE_ACCOUNT: "cafe-11" }, /^DEFAULT_WRITE_ACCOUNT: .*POSTER_ACCOUNTS/],
  ["permission entry outside a custom list", { POSTER_ACCOUNTS: "tienda-a", WRITE_DEFAULT_ACCOUNTS: "tienda-a,cafe-04" }, /^WRITE_DEFAULT_ACCOUNTS: la entrada 2 /],
  ["permission entry outside the default list", { WRITE_DEFAULT_ACCOUNTS: "cafe-04,cafe-99" }, /^WRITE_DEFAULT_ACCOUNTS: la entrada 2 /],
  ["permission entry after an empty one", { WRITE_DEFAULT_ACCOUNTS: "cafe-04,,cafe-99" }, /^WRITE_DEFAULT_ACCOUNTS: la entrada 3 /],
  ["unknown timezone", { TIMEZONE: "Mars/Olympus_Mons" }, /^TIMEZONE/],
  ["unknown TOKEN_SOURCE", { TOKEN_SOURCE: "vault" }, /^TOKEN_SOURCE/],
  ["TOKEN_SOURCE with a leading space", { TOKEN_SOURCE: " mysql" }, /^TOKEN_SOURCE/],
  ["TOKEN_SOURCE with a trailing space", { TOKEN_SOURCE: "gsm " }, /^TOKEN_SOURCE/],
  ["control character in OWNER_NAME", { OWNER_NAME: "Ana\u0007" }, /^OWNER_NAME/],
  ["line break in NETWORK_NAME", { NETWORK_NAME: "Tacos\nNorte" }, /^NETWORK_NAME/],
  ["C1 control character in NETWORK_NAME", { NETWORK_NAME: "Tacos\u0085Norte" }, /^NETWORK_NAME/],
  ["right-to-left override in OWNER_NAME", { OWNER_NAME: "Ana\u202Eetrevni" }, /^OWNER_NAME/],
  ["right-to-left mark in NETWORK_NAME", { NETWORK_NAME: "Tacos\u200FNorte" }, /^NETWORK_NAME/],
  ["first strong isolate in NETWORK_NAME", { NETWORK_NAME: "\u2068Tacos Norte" }, /^NETWORK_NAME/],
  ["OWNER_NAME longer than 100 characters", { OWNER_NAME: "x".repeat(101) }, /^OWNER_NAME/],
  ["SERVICE_NAME with a space", { SERVICE_NAME: "tacos mcp" }, /^SERVICE_NAME/],
  ["SERVICE_NAME with a slash", { SERVICE_NAME: "tacos/mcp" }, /^SERVICE_NAME/],
  ["blank SERVICE_NAME", { SERVICE_NAME: " " }, /^SERVICE_NAME/],
  ["SERVICE_NAME with a leading space", { SERVICE_NAME: " tacos-mcp" }, /^SERVICE_NAME/],
  ["SERVICE_NAME with a trailing space", { SERVICE_NAME: "tacos-mcp " }, /^SERVICE_NAME/],
  ["SERVICE_NAME longer than 64 characters", { SERVICE_NAME: "s".repeat(65) }, /^SERVICE_NAME/],
  ["OAUTH_SUBJECT with a space", { OAUTH_SUBJECT: "ana tacos" }, /^OAUTH_SUBJECT/],
  ["OAUTH_SUBJECT with a colon", { OAUTH_SUBJECT: "ana:tacos" }, /^OAUTH_SUBJECT/],
  ["blank OAUTH_SUBJECT", { OAUTH_SUBJECT: "" }, /^OAUTH_SUBJECT/],
  ["OAUTH_SUBJECT with a leading tab", { OAUTH_SUBJECT: "\tana" }, /^OAUTH_SUBJECT/],
  ["OAUTH_SUBJECT with a trailing space", { OAUTH_SUBJECT: "ana@tacos.example " }, /^OAUTH_SUBJECT/],
  ["OAUTH_SUBJECT longer than 64 characters", { OAUTH_SUBJECT: "o".repeat(65) }, /^OAUTH_SUBJECT/],
  ["malformed POSTER_MYSQL_URL with TOKEN_SOURCE=mysql", { TOKEN_SOURCE: "mysql", POSTER_MYSQL_URL: "mysql://u:p@[db.invalid/poster" }, /^POSTER_MYSQL_URL/],
];

// A distinctive marker placed in each validated variable: the error names the variable (and the
// position for account lists) and the marker appears nowhere in what the error can print.
const MARCAS: Array<[string, Record<string, string>, RegExp, string[]]> = [
  ["POSTER_ACCOUNTS (invalid entry)", { POSTER_ACCOUNTS: "tienda-a,ZqMarcaCuenta" }, /^POSTER_ACCOUNTS: la entrada 2 /, ["ZqMarcaCuenta"]],
  ["POSTER_ACCOUNTS (duplicate)", { POSTER_ACCOUNTS: "zqmarca-dup,tienda-a,zqmarca-dup" }, /^POSTER_ACCOUNTS: la entrada 3 repite la entrada 1\b/, ["zqmarca-dup"]],
  ["DEFAULT_WRITE_ACCOUNT", { POSTER_ACCOUNTS: "tienda-a", DEFAULT_WRITE_ACCOUNT: "zqmarca-destino" }, /^DEFAULT_WRITE_ACCOUNT: /, ["zqmarca-destino"]],
  ["WRITE_DEFAULT_ACCOUNTS", { WRITE_DEFAULT_ACCOUNTS: "cafe-04,zqmarca-permiso" }, /^WRITE_DEFAULT_ACCOUNTS: la entrada 2 /, ["zqmarca-permiso"]],
  ["TIMEZONE", { TIMEZONE: "Zq/MarcaZona" }, /^TIMEZONE: /, ["MarcaZona"]],
  ["OWNER_NAME", { OWNER_NAME: "ZqMarcaDueno\u0007" }, /^OWNER_NAME: /, ["ZqMarcaDueno"]],
  ["NETWORK_NAME", { NETWORK_NAME: "ZqMarcaRed\u202E" }, /^NETWORK_NAME: /, ["ZqMarcaRed"]],
  ["OWNER_NAME (too long)", { OWNER_NAME: `ZqMarcaLargo${"x".repeat(100)}` }, /^OWNER_NAME: /, ["ZqMarcaLargo"]],
  ["SERVICE_NAME", { SERVICE_NAME: "ZqMarcaServicio/x" }, /^SERVICE_NAME: /, ["ZqMarcaServicio"]],
  ["OAUTH_SUBJECT", { OAUTH_SUBJECT: "ZqMarcaSujeto:x" }, /^OAUTH_SUBJECT: /, ["ZqMarcaSujeto"]],
  ["TOKEN_SOURCE", { TOKEN_SOURCE: "ZqMarcaFuente" }, /^TOKEN_SOURCE: /, ["ZqMarcaFuente"]],
  ["POSTER_MYSQL_URL", { TOKEN_SOURCE: "mysql", POSTER_MYSQL_URL: "mysql://zqmarcausuario:ZqMarcaClave@[zqmarca-host.invalid/base" }, /^POSTER_MYSQL_URL: /, ["zqmarcausuario", "ZqMarcaClave", "zqmarca-host"]],
];

const BIDI = ["\u200E", "\u200F", "\u202A", "\u202B", "\u202C", "\u202D", "\u202E", "\u2066", "\u2067", "\u2068", "\u2069"];

describe("cargarConfig: failures", () => {
  it.each(FALLOS)("L9 fails: %s", (_caso, env, nombra) => {
    const espias = espiarConsola();
    const e = errorDe({ ...SECRETOS, ...env });
    expect(e.message).toMatch(nombra);
    for (const [k, v] of Object.entries(SECRETOS)) expect(e.message, k).not.toContain(v);
    for (const espia of espias) expect(espia).not.toHaveBeenCalled();
  });

  it("L10 an error raised while secret variables hold distinctive values does not contain those values", () => {
    const e = errorDe({ ...SECRETOS, TOKEN_SOURCE: "mysql", POSTER_ACCOUNTS: "tienda-a,Tienda-B" });
    // The error is the loader's own validation error, not an unrelated failure.
    expect(e.message).toMatch(/^POSTER_ACCOUNTS: la entrada 2 /);
    const texto = todoDe(e);
    for (const v of Object.values(SECRETOS)) expect(texto).not.toContain(v);
  });

  it.each(MARCAS)("L12 a marker in %s never appears in the error it causes", (_caso, env, nombra, marcas) => {
    const e = errorDe(env);
    expect(e.message).toMatch(nombra);
    expect(e.cause).toBeUndefined();
    const texto = todoDe(e).toLowerCase();
    for (const m of marcas) expect(texto, m).not.toContain(m.toLowerCase());
  });

  it("L13 TIMEZONE letter case does not matter: america/merida loads as the default zone with the default place label", () => {
    const porDefecto = cargarConfig({});
    const c = cargarConfig({ TIMEZONE: "america/merida" });
    expect(c.timezone).toBe("America/Merida");
    expect(c.timezone).toBe(porDefecto.timezone);
    expect(c.timezonePlace).toBe("Carmen");
    expect(c.timezonePlace).toBe(porDefecto.timezonePlace);
    const otra = cargarConfig({ TIMEZONE: "ASIA/TOKYO" });
    expect(otra.timezone).toBe("Asia/Tokyo");
    expect(otra.timezonePlace).toBeUndefined();
  });

  it("L14 a malformed POSTER_MYSQL_URL fails only with TOKEN_SOURCE=mysql, with a fresh error that carries no part of it", () => {
    const malformada = "mysql://zqusuario:ZqClave77@[zq-db.invalid/poster";
    const e = errorDe({ TOKEN_SOURCE: "mysql", POSTER_MYSQL_URL: malformada });
    expect(e.message).toMatch(/^POSTER_MYSQL_URL: /);
    expect(e.cause).toBeUndefined();
    expect(Object.getOwnPropertyNames(e).sort()).toEqual(["message", "stack"]);
    for (const parte of ["zqusuario", "ZqClave77", "zq-db.invalid"]) expect(todoDe(e), parte).not.toContain(parte);
    // With gsm, or TOKEN_SOURCE unset or blank, the value is not validated.
    for (const fuente of ["gsm", undefined, " "]) {
      expect(() => cargarConfig({ TOKEN_SOURCE: fuente, POSTER_MYSQL_URL: malformada }), String(fuente)).not.toThrow();
    }
    // The scheme is not checked: any value that parses as a URL is accepted.
    expect(cargarConfig({ TOKEN_SOURCE: "mysql", POSTER_MYSQL_URL: "mariadb://u:p@h/db" }).posterMysqlUrl).toBe("mariadb://u:p@h/db");
  });

  it("L15 every bidirectional formatting character fails in a name; neighbouring format characters do not", () => {
    for (const ch of BIDI) {
      const cp = ch.codePointAt(0)!.toString(16);
      expect(errorDe({ OWNER_NAME: `Ana${ch}Lu` }).message, cp).toMatch(/^OWNER_NAME: /);
      expect(errorDe({ NETWORK_NAME: `Tacos${ch}Norte` }).message, cp).toMatch(/^NETWORK_NAME: /);
    }
    // Zero-width joiner (U+200D) and narrow no-break space (U+202F) sit next to the ranges and are allowed.
    expect(cargarConfig({ OWNER_NAME: "Ana\u200DLu" }).ownerName).toBe("Ana\u200DLu");
    expect(cargarConfig({ NETWORK_NAME: "Tacos\u202FNorte" }).networkName).toBe("Tacos\u202FNorte");
  });

  it("L16 a name is checked for control characters before it is trimmed: a newline or tab at either end fails", () => {
    for (const nombre of ["Ana\n", "Ana\r\n", "Ana\t", "\tAna", "\nAna"]) {
      const caso = JSON.stringify(nombre);
      expect(errorDe({ OWNER_NAME: nombre }).message, caso).toMatch(/^OWNER_NAME: /);
      expect(errorDe({ NETWORK_NAME: nombre }).message, caso).toMatch(/^NETWORK_NAME: /);
    }
    // Spaces at either end are still trimmed away.
    expect(cargarConfig({ OWNER_NAME: " Ana ", NETWORK_NAME: " Tacos Norte " })).toMatchObject({ ownerName: "Ana", networkName: "Tacos Norte" });
  });

  it("L11 the loader logs nothing on success", () => {
    const espias = espiarConsola();
    cargarConfig({ ...SECRETOS, POSTER_ACCOUNTS: "tienda-a", TOKEN_SOURCE: "mysql" });
    for (const espia of espias) expect(espia).not.toHaveBeenCalled();
  });
});
