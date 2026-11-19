// Write outcome, audit and redaction integrity. A read-back failure after an applied write is reported
// as applied; a failed HTTP attempt of the write itself is an unknown outcome; failures before sending
// stay rejected. Audit lines are always valid JSON with every string and key redacted. Known tokens are
// stripped in their literal, URL-encoded and JSON-escaped forms from tool results, tool errors and audit
// lines. Poster is faked (fetch or a fake PosterApi); there is no network.
import { describe, it, expect, vi, afterEach } from "vitest";
import { appendFileSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { PosterApi } from "../src/poster.js";

type Obj = Record<string, any>;

/** Every runtime configuration variable and the token variables of the fixture; each test starts from none. */
const CONFIGURACION = [
  "POSTER_ACCOUNTS", "DEFAULT_WRITE_ACCOUNT", "WRITE_DEFAULT_ACCOUNTS", "TIMEZONE", "OWNER_NAME", "NETWORK_NAME",
  "SERVICE_NAME", "OAUTH_SUBJECT", "TOKEN_SOURCE", "POSTER_MYSQL_URL", "GCP_PROJECT_ID", "AUDIT_DIR",
  "POSTER_TOKEN_TIENDA_A", "POSTER_TOKEN_TIENDA_B",
];
// Synthetic env tokens; only the second has a colon, which URL encoding changes. Both share the
// fragment "ZqU4Token", so a partial leak of either shows up.
const TOKEN_A = "ZqU4TokenAlfa-1101";
const TOKEN_B = "770055:ZqU4TokenBeta~1102";
const CON_ENV: Record<string, string> = {
  TOKEN_SOURCE: "env",
  POSTER_ACCOUNTS: "tienda-a,tienda-b",
  WRITE_DEFAULT_ACCOUNTS: "tienda-b",
  POSTER_TOKEN_TIENDA_A: TOKEN_A,
  POSTER_TOKEN_TIENDA_B: TOKEN_B,
};
const CON_GSM: Record<string, string> = {
  TOKEN_SOURCE: "gsm",
  GCP_PROJECT_ID: "zq-proyecto",
  POSTER_ACCOUNTS: "tienda-a,tienda-b",
  WRITE_DEFAULT_ACCOUNTS: "tienda-b",
};
// A Secret Manager token with a quote, a backslash and a colon. Each fragment between them must stay
// absent: a check for the whole token would pass on JSON text, where the token is escaped.
const TOKEN_GSM = 'ZqAnt"ZqMed\\ZqPos:4402';
const FRAGMENTOS = ["ZqAnt", "ZqMed", "ZqPos"];
const GRUPO = { cuenta: "tienda-b", nombre: "Frecuentes", tipo: "descuento" as const, porcentaje: 10 };
const EVENTO = { actor: "prueba", cuenta: "tienda-b", metodo: "clients.createGroup", herramienta: "create_client_group" };

const temporales: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  vi.doUnmock("@google-cloud/secret-manager");
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
  for (const d of temporales.splice(0)) rmSync(d, { recursive: true, force: true });
});

/**
 * Fresh module graph with `e` on top of no configuration and a fresh audit directory. `gsm` makes the
 * mocked Secret Manager return that token, or fail with that error. stdout is captured.
 */
async function cargar(e: Record<string, string>, gsm?: string | Error) {
  vi.resetModules();
  if (gsm !== undefined) {
    vi.doMock("@google-cloud/secret-manager", () => ({
      SecretManagerServiceClient: class {
        async accessSecretVersion() {
          if (gsm instanceof Error) throw gsm;
          return [{ payload: { data: Buffer.from(gsm) } }];
        }
      },
    }));
  }
  const auditDir = mkdtempSync(path.join(os.tmpdir(), "poster-mcp-integridad-"));
  temporales.push(auditDir);
  for (const k of CONFIGURACION) vi.stubEnv(k, undefined);
  for (const [k, v] of Object.entries({ ...e, AUDIT_DIR: auditDir })) vi.stubEnv(k, v);
  const consola = vi.spyOn(console, "log").mockImplementation(() => {});
  const T = await import("../src/tokens.js");
  const P = await import("../src/poster.js");
  const A = await import("../src/audit.js");
  const W = await import("../src/tools/escritura.js");
  const M = await import("../src/mcp.js");
  /** Lines of the JSONL audit files, in order. */
  const archivo = () =>
    readdirSync(auditDir)
      .filter((f) => f.endsWith(".jsonl"))
      .sort()
      .flatMap((f) => readFileSync(path.join(auditDir, f), "utf8").split("\n").filter(Boolean));
  /** Audit lines written to stdout. */
  const salida = () => consola.mock.calls.map((a) => a.map(String).join(" ")).filter((l) => l.includes('"audit":true'));
  return { T, P, A, W, M, archivo, salida, consola };
}

/** Replaces fetch with `responder`; `posts()` counts the POST requests made. */
function falsearFetch(responder: (url: string, init?: RequestInit) => Response) {
  const f = vi.fn(async (url: string | URL | Request, init?: RequestInit) => responder(String(url), init));
  vi.stubGlobal("fetch", f);
  const posts = () => f.mock.calls.filter(([, i]) => i?.method === "POST").length;
  return { f, posts };
}
const json = (cuerpo: unknown) => new Response(JSON.stringify(cuerpo));

/** MCP server of the loaded graph (the real Poster client unless `api` is given) with an in-memory client. */
async function conectar(M: typeof import("../src/mcp.js"), api?: PosterApi) {
  const [ladoCliente, ladoServidor] = InMemoryTransport.createLinkedPair();
  await M.crearServidorMcp(api).connect(ladoServidor);
  const cliente = new Client({ name: "prueba", version: "0.0.0" });
  await cliente.connect(ladoCliente);
  return async (name: string, args: Obj) => {
    const r = await cliente.callTool({ name, arguments: args });
    return { isError: r.isError === true, texto: (r.content as Array<{ text: string }>)[0]?.text ?? "" };
  };
}

const ctx = (api: PosterApi) => ({ api, actor: "prueba" });
const modos = (lineas: string[]) => lineas.map((l) => JSON.parse(l).modo);

describe("write outcome", () => {
  it("W1 a write whose read-back throws returns aplicado with verificacion.ok false and a do-not-repeat notice, does not throw, and writes one aplicado audit entry", async () => {
    const { W, archivo, salida } = await cargar(CON_ENV);
    let lecturas = 0;
    const post = vi.fn(async () => ({ response: 77 }));
    const api: PosterApi = {
      get: async () => {
        if (++lecturas === 1) return [] as never;
        throw new Error(`clients.getGroups: Póster sin respuesta JSON: eco ${TOKEN_A}`);
      },
      post: post as never,
    };
    const r: Obj = await W.crearGrupoCliente(ctx(api), { ...GRUPO, confirm: true });
    expect(post).toHaveBeenCalledTimes(1);
    expect(lecturas).toBe(2);
    expect(r.modo).toBe("aplicado");
    expect(r.respuesta).toBe(77);
    expect(r.verificacion).toEqual({ ok: false, detalle: expect.stringContaining("Póster sin respuesta JSON") });
    expect(r.verificacion.detalle).toContain("***");
    expect(r.verificacion.detalle).not.toContain(TOKEN_A);
    expect(r.aviso).toMatch(/se aplicó/i);
    expect(r.aviso).toMatch(/no la repitas/i);

    const lineas = archivo();
    expect(lineas).toHaveLength(1);
    const entrada = JSON.parse(lineas[0]);
    expect(entrada.modo).toBe("aplicado");
    expect(entrada.resultado.verificacion).toEqual(r.verificacion);
    expect(modos(salida())).toEqual(["aplicado"]);
  });

  it("W25 through MCP, a write whose read-back call fails is a normal aplicado result, not a tool error", async () => {
    const { M, archivo } = await cargar(CON_ENV);
    let lecturas = 0;
    const { posts } = falsearFetch((_url, init) => {
      if (init?.method === "POST") return json({ response: 77 });
      return json(++lecturas === 1 ? { response: [] } : { error: 3, message: "lectura no disponible" });
    });
    const llamar = await conectar(M);
    const r = await llamar("create_client_group", { ...GRUPO, confirm: true });
    expect(posts()).toBe(1);
    expect(r.isError).toBe(false);
    const resultado = JSON.parse(r.texto);
    expect(resultado.modo).toBe("aplicado");
    expect(resultado.verificacion.ok).toBe(false);
    expect(resultado.verificacion.detalle).toContain("lectura no disponible");
    expect(resultado.aviso).toMatch(/no la repitas/i);
    expect(modos(archivo())).toEqual(["aplicado"]);
  });

  const FALLOS_HTTP: Array<[string, () => Response]> = [
    ["a network error", () => { throw new TypeError("fetch failed"); }],
    ["a timeout", () => { throw new DOMException("The operation was aborted due to timeout", "TimeoutError"); }],
    ["an HTML body", () => new Response("<html>502 Bad Gateway</html>", { status: 502 })],
    ["a truncated JSON body", () => new Response('{"response": 77', { status: 200 })],
  ];

  it.each(FALLOS_HTTP)("W2 a write whose HTTP attempt fails (%s) fails with the unknown-outcome message and writes one desconocido audit entry and no rechazado entry", async (_caso, fallar) => {
    const { M, archivo, salida } = await cargar(CON_ENV);
    const { posts } = falsearFetch((_url, init) => (init?.method === "POST" ? fallar() : json({ response: [] })));
    const llamar = await conectar(M);
    const r = await llamar("create_client_group", { ...GRUPO, confirm: true });
    expect(posts()).toBe(1);
    expect(r.isError).toBe(true);
    expect(r.texto).toMatch(/puede haberse aplicado/);
    expect(r.texto).toMatch(/lectura antes de reintentar/);
    expect(modos(archivo())).toEqual(["desconocido"]);
    expect(modos(salida())).toEqual(["desconocido"]);
    const entrada = JSON.parse(archivo()[0]);
    expect(entrada.error).toMatch(/Póster sin respuesta JSON/);
    // The entry names the write that may have been applied: its method and the payload attempted.
    expect(entrada.metodo).toBe("clients.createGroup");
    expect(entrada.payload).toMatchObject({ client_groups_name: "Frecuentes", client_groups_discount: 10 });
    expect(JSON.parse(salida()[0]).severity).toBe("WARNING");
  });

  it("W3 a write whose token lookup fails stays rechazado and sends nothing, for the plan read and for the write call", async () => {
    const { M, W, P, archivo } = await cargar(CON_GSM, new Error("Secret Manager no disponible"));
    const { f } = falsearFetch(() => json({ response: [] }));
    const llamar = await conectar(M);
    const r = await llamar("create_client_group", { ...GRUPO, confirm: true });
    expect(r.isError).toBe(true);
    expect(r.texto).toContain("Secret Manager no disponible");
    expect(r.texto).not.toMatch(/puede haberse aplicado/);
    // The plan read works; the lookup inside the write call itself fails.
    const api: PosterApi = { get: async () => [] as never, post: P.posterHttp.post };
    await expect(W.crearGrupoCliente(ctx(api), { ...GRUPO, confirm: true })).rejects.toThrow("Secret Manager no disponible");
    expect(f).not.toHaveBeenCalled();
    expect(modos(archivo())).toEqual(["rechazado", "rechazado"]);
  });

  it("W4 a write denied by permission stays rechazado and sends nothing", async () => {
    const { W, archivo } = await cargar(CON_ENV);
    const post = vi.fn();
    const api: PosterApi = { get: async () => [] as never, post: post as never };
    await expect(W.crearGrupoCliente(ctx(api), { ...GRUPO, cuenta: "tienda-a", confirm: true })).rejects.toThrow(/permitir_otra_cuenta/);
    expect(post).not.toHaveBeenCalled();
    expect(modos(archivo())).toEqual(["rechazado"]);
  });

  it("W5 a write whose plan read fails at the HTTP level stays rechazado: only the write's own HTTP attempt is an unknown outcome", async () => {
    const { W, P, archivo } = await cargar(CON_ENV);
    const { f, posts } = falsearFetch(() => {
      throw new TypeError("fetch failed");
    });
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const api: PosterApi = { get: P.posterHttp.get, post: P.posterHttp.post };
    const p = W.crearGrupoCliente(ctx(api), { ...GRUPO, confirm: true }).then(
      () => null,
      (e: unknown) => e,
    );
    await vi.runAllTimersAsync();
    const e = await p;
    expect(e).toBeInstanceOf(Error);
    expect(e).not.toBeInstanceOf(P.EscrituraIncierta);
    expect(f).toHaveBeenCalledTimes(5);
    expect(posts()).toBe(0);
    expect(modos(archivo())).toEqual(["rechazado"]);
  });

  it("W6 only the HTTP attempt of a write raises EscrituraIncierta, not the method check or the token lookup before it", async () => {
    const { P } = await cargar(CON_ENV);
    const { f } = falsearFetch(() => {
      throw new TypeError("fetch failed");
    });
    const fallo = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e);
    const escritura = await fallo(P.posterHttp.post("tienda-b", "clients.createGroup", {}));
    expect(escritura).toBeInstanceOf(P.EscrituraIncierta);
    expect(f).toHaveBeenCalledTimes(1);
    const metodo = await fallo(P.posterHttp.post("tienda-b", "clients/createGroup", {}));
    const cuenta = await fallo(P.posterHttp.post("tienda-z", "clients.createGroup", {}));
    for (const e of [metodo, cuenta]) {
      expect(e).toBeInstanceOf(Error);
      expect(e).not.toBeInstanceOf(P.EscrituraIncierta);
    }
    expect(f).toHaveBeenCalledTimes(1);
  });
});

describe("audit lines", () => {
  it('W7 a payload comment with token=abc"x\\ and a backslash-quote mix gives valid JSON on stdout and in the JSONL file, with the token value redacted', async () => {
    const { A, archivo, salida } = await cargar(CON_ENV);
    const comentario = 'ver token=abc"x\\ luego \\" y \\\\" y "\\ fin';
    expect(() => A.auditar({ ...EVENTO, modo: "dry-run", payload: { comment: comentario } })).not.toThrow();
    const lineas = [...archivo(), ...salida()];
    expect(lineas).toHaveLength(2);
    for (const linea of lineas) {
      const ev = JSON.parse(linea);
      expect(ev.payload.comment).toContain("token=***");
      expect(ev.payload.comment).not.toContain("abc");
      expect(ev.payload.comment).toContain(' luego \\" y \\\\" y "\\ fin');
    }
  });

  it("W8 a synthetic token inside a nested payload string, and in the other fields of the event, is redacted in both lines", async () => {
    const { A, archivo, salida } = await cargar(CON_ENV);
    const payload = { nivel: { lista: [{ nota: `a ${TOKEN_A} b` }, `url ?token=${encodeURIComponent(TOKEN_B)}&x=1`, [`c ${TOKEN_B}`]] } };
    A.auditar({ ...EVENTO, cliente: `cli ${TOKEN_B}`, modo: "rechazado", payload, resultado: { eco: [`r ${TOKEN_A}`] }, error: `e ${TOKEN_A}` });
    const lineas = [...archivo(), ...salida()];
    expect(lineas).toHaveLength(2);
    for (const linea of lineas) {
      const ev = JSON.parse(linea);
      expect(ev.payload.nivel.lista).toEqual([{ nota: "a *** b" }, "url ?token=***&x=1", ["c ***"]]);
      expect(ev).toMatchObject({ ...EVENTO, cliente: "cli ***", modo: "rechazado", resultado: { eco: ["r ***"] }, error: "e ***" });
      for (const s of [TOKEN_A, TOKEN_B, encodeURIComponent(TOKEN_B), "ZqU4Token"]) expect(linea, s).not.toContain(s);
    }
  });

  const circular: Obj = { nombre: "x" };
  circular.yo = circular;
  const NO_SERIALIZABLES: Array<[string, unknown]> = [
    ["a circular value", circular],
    ["a BigInt", { monto: BigInt(10) }],
  ];

  it.each(NO_SERIALIZABLES)("W9 an event that cannot be serialized (%s) produces the minimal line, with its fields redacted, and no throw", async (_caso, payload) => {
    const { A, archivo, salida } = await cargar(CON_ENV);
    expect(() => A.auditar({ ...EVENTO, herramienta: `crear ${TOKEN_A}`, modo: "aplicado", payload })).not.toThrow();
    const lineas = archivo();
    expect(lineas).toHaveLength(1);
    const ev = JSON.parse(lineas[0]);
    expect(Object.keys(ev).sort()).toEqual(["cuenta", "error", "herramienta", "modo", "ts"]);
    expect(ev).toMatchObject({ cuenta: "tienda-b", herramienta: "crear ***", modo: "aplicado" });
    expect(ev.error).toMatch(/incompleta/);
    const fuera = salida();
    expect(fuera).toHaveLength(1);
    expect(JSON.parse(fuera[0])).toMatchObject({ audit: true, ...ev });
    for (const linea of [...lineas, ...fuera]) expect(linea).not.toContain("ZqU4Token");
  });

  it("W10 an object referenced twice without a cycle is audited in full", async () => {
    const { A, archivo } = await cargar(CON_ENV);
    const comun = { id: 5, nombre: "compartido" };
    A.auditar({ ...EVENTO, modo: "dry-run", payload: { a: comun, b: [comun] } });
    expect(JSON.parse(archivo()[0]).payload).toEqual({ a: comun, b: [comun] });
  });

  it("W11 auditar does not throw when stdout fails, and the JSONL line is still written", async () => {
    const { A, archivo, consola } = await cargar(CON_ENV);
    consola.mockImplementation(() => {
      throw new Error("EPIPE");
    });
    expect(() => A.auditar({ ...EVENTO, modo: "dry-run", payload: { a: 1 } })).not.toThrow();
    expect(modos(archivo())).toEqual(["dry-run"]);
  });
});

describe("redaction", () => {
  it("W12 a token that is a prefix of another known token leaves no fragment", async () => {
    const corto = "ZqPrefijoToken-2201";
    const largo = "ZqPrefijoToken-2201-sufijo";
    const { T } = await cargar({ ...CON_ENV, POSTER_TOKEN_TIENDA_A: corto, POSTER_TOKEN_TIENDA_B: largo });
    expect(T.redactar(`a ${largo} b ${corto} c ${largo}${corto} d`)).toBe("a *** b *** c ****** d");
  });

  it("W13 a known token that contains token= leaves no fragment", async () => {
    const tok = "ZqGsmtoken=Secreto-4401";
    const { T } = await cargar(CON_GSM, tok);
    await expect(T.tokenDe("tienda-a")).resolves.toBe(tok);
    expect(T.redactar(`a ${tok} b`)).toBe("a *** b");
    expect(T.redactar(`https://tienda-a.joinposter.com/api/m?token=${encodeURIComponent(tok)}&format=json`)).toBe(
      "https://tienda-a.joinposter.com/api/m?token=***&format=json",
    );
    expect(T.redactar(JSON.stringify({ m: tok }))).toBe('{"m":"***"}');
  });

  it("W14 the percent-encoded and JSON-escaped forms of a cached Secret Manager token are stripped", async () => {
    const { T } = await cargar(CON_GSM, TOKEN_GSM);
    await expect(T.tokenDe("tienda-a")).resolves.toBe(TOKEN_GSM);
    const codificado = encodeURIComponent(TOKEN_GSM);
    const escapado = JSON.stringify(TOKEN_GSM).slice(1, -1);
    expect(codificado).not.toBe(TOKEN_GSM);
    expect(escapado).not.toBe(TOKEN_GSM);
    expect(T.redactar(`a ${codificado} b ${escapado} c ${TOKEN_GSM} d`)).toBe("a *** b *** c *** d");
    expect(T.redactar(JSON.stringify({ m: `x ${TOKEN_GSM}` }))).toBe('{"m":"x ***"}');
  });

  it("W15 the percent-encoded form of an env token is stripped", async () => {
    const { T } = await cargar(CON_ENV);
    expect(encodeURIComponent(TOKEN_B)).not.toBe(TOKEN_B);
    expect(T.redactar(`a ${encodeURIComponent(TOKEN_B)} b`)).toBe("a *** b");
  });

  it('W16 a cached Secret Manager token with " and \\ echoed in the Poster error of a write call is absent from the client result, stdout, the JSONL line and recent_audit', async () => {
    const { M, archivo, salida } = await cargar(CON_GSM, TOKEN_GSM);
    const { posts } = falsearFetch((_url, init) => json(init?.method === "POST" ? { error: 10, message: `Token ${TOKEN_GSM} no válido` } : { response: [] }));
    const llamar = await conectar(M);
    const r = await llamar("create_client_group", { ...GRUPO, confirm: true });
    expect(posts()).toBe(1);
    expect(r.isError).toBe(false);
    const resultado = JSON.parse(r.texto);
    expect(resultado.modo).toBe("rechazado");
    expect(resultado.error).toContain("***");
    const lineas = archivo();
    const fuera = salida();
    expect(modos(lineas)).toEqual(["rechazado"]);
    expect(JSON.parse(lineas[0]).resultado).toEqual({ error: 10, message: "Token *** no válido" });
    expect(fuera).toHaveLength(1);
    const reciente = await llamar("recent_audit", { limite: 5 });
    expect(reciente.isError).toBe(false);
    expect(JSON.parse(reciente.texto)).toHaveLength(1);
    const salidas: Array<[string, string]> = [
      ["client result", r.texto],
      ["JSONL", lineas[0]],
      ["stdout", fuera[0]],
      ["recent_audit", reciente.texto],
    ];
    for (const [donde, texto] of salidas) for (const f of FRAGMENTOS) expect(texto, `${donde}: ${f}`).not.toContain(f);
  });

  it("W17 a token straddling the clip boundary of a Poster error leaves no prefix", async () => {
    const { P } = await cargar(CON_ENV);
    const inicio = JSON.stringify({ error: 1, message: "" }).length - 2;
    const r = { error: 1, message: "x".repeat(290 - inicio) + TOKEN_A + " fin" };
    expect(JSON.stringify(r).indexOf(TOKEN_A)).toBe(290);
    const e = P.errorPoster(r) ?? "";
    expect(e.length).toBeGreaterThan(0);
    expect(e.length).toBeLessThanOrEqual(300);
    expect(e).toContain("***");
    expect(e).not.toContain("ZqU4Tok");
  });

  it("W18 a token straddling the clip boundary of a non-JSON Poster body leaves no prefix", async () => {
    const { P } = await cargar(CON_ENV);
    const cuerpo = "<html>" + "x".repeat(104) + TOKEN_A + "</html>";
    expect(cuerpo.indexOf(TOKEN_A)).toBe(110);
    falsearFetch(() => new Response(cuerpo, { status: 502 }));
    const e = await P.posterHttp.post("tienda-b", "clients.createGroup", {}).then(
      () => null,
      (x: unknown) => x as Error,
    );
    expect(e).toBeInstanceOf(P.EscrituraIncierta);
    expect(e?.message).toContain("HTTP 502");
    expect(e?.message).toContain("***");
    expect(e?.message).not.toContain("ZqU4Tok");
  });

  it("W19 a write rejected without a usable error field returns a redacted, clipped diagnostic of the reply, never the raw reply", async () => {
    const { W, archivo } = await cargar(CON_ENV);
    // The token straddles the 300-character limit of the diagnostic.
    const inicio = JSON.stringify({ success: 0, relleno: "", detail: "" }).length - 2;
    const respuesta = { success: 0, relleno: "y".repeat(293 - inicio), detail: TOKEN_A, cola: "z".repeat(100) };
    const posicion = JSON.stringify(respuesta).indexOf(TOKEN_A);
    expect(posicion).toBeLessThan(300);
    expect(posicion + TOKEN_A.length).toBeGreaterThan(300);
    const api: PosterApi = { get: async () => [] as never, post: (async () => respuesta) as never };
    const r: Obj = await W.crearGrupoCliente(ctx(api), { ...GRUPO, confirm: true });
    expect(r.modo).toBe("rechazado");
    expect(typeof r.error).toBe("string");
    expect(r.error.length).toBeLessThanOrEqual(300);
    expect(r.error).toContain('"success":0');
    expect(r.error).toContain("***");
    expect(JSON.stringify(r)).not.toContain("ZqU4");
    expect(modos(archivo())).toEqual(["rechazado"]);
  });

  it("W20 a rejected write reply { success: 0, detail: <token> } reaches the client without the token", async () => {
    const { M } = await cargar(CON_ENV);
    falsearFetch((_url, init) => json(init?.method === "POST" ? { success: 0, detail: TOKEN_B } : { response: [] }));
    const llamar = await conectar(M);
    const r = await llamar("create_client_group", { ...GRUPO, confirm: true });
    expect(r.isError).toBe(false);
    const resultado = JSON.parse(r.texto);
    expect(resultado.modo).toBe("rechazado");
    expect(typeof resultado.error).toBe("string");
    for (const s of [TOKEN_B, encodeURIComponent(TOKEN_B), "ZqU4Token"]) expect(r.texto, s).not.toContain(s);
  });

  it("W21 a successful poster_get reply containing a known token reaches the client without it", async () => {
    const { M } = await cargar(CON_ENV);
    falsearFetch(() => json({ response: { nota: `eco ${TOKEN_A}`, [`clave ${TOKEN_B}`]: 1 } }));
    const llamar = await conectar(M);
    const r = await llamar("poster_get", { cuenta: "tienda-a", metodo: "clients.getGroups" });
    expect(r.isError).toBe(false);
    expect(JSON.parse(r.texto).respuesta).toEqual({ nota: "eco ***", "clave ***": 1 });
    for (const s of [TOKEN_A, TOKEN_B, "ZqU4Token"]) expect(r.texto, s).not.toContain(s);
  });

  it("W22 an applied-write reply and the read-back row in verificacion.detalle reach the client without a known token", async () => {
    const { M } = await cargar(CON_ENV);
    const fila = { client_groups_id: "77", loyalty_type: "2", client_groups_discount: "5", birthday_bonus: "0", use_ewallet: "0" };
    const releida = { ...fila, client_groups_name: "Frecuentes", client_groups_discount: "10", nota: TOKEN_B };
    let lecturas = 0;
    falsearFetch((_url, init) => {
      if (init?.method === "POST") return json({ response: { client_groups_id: 77, eco: TOKEN_A } });
      return json({ response: [++lecturas === 1 ? { ...fila, client_groups_name: "Viejo" } : releida] });
    });
    const llamar = await conectar(M);
    const r = await llamar("update_client_group", { cuenta: "tienda-b", client_groups_id: 77, nombre: "Frecuentes", porcentaje: 10, confirm: true });
    expect(r.isError).toBe(false);
    const resultado = JSON.parse(r.texto);
    expect(resultado.modo).toBe("aplicado");
    expect(resultado.respuesta).toEqual({ client_groups_id: 77, eco: "***" });
    expect(resultado.verificacion).toEqual({ ok: true, detalle: { ...releida, nota: "***" } });
    for (const s of [TOKEN_A, TOKEN_B, "ZqU4Token"]) expect(r.texto, s).not.toContain(s);
  });

  it("W23 an upstream object key containing a known token is absent from both audit lines", async () => {
    const { W, archivo, salida } = await cargar(CON_ENV);
    const api: PosterApi = {
      get: async () => [] as never,
      post: (async () => ({ error: 5, datos: { [`clave ${TOKEN_A}`]: { [TOKEN_B]: 1 } } })) as never,
    };
    const r: Obj = await W.crearGrupoCliente(ctx(api), { ...GRUPO, confirm: true });
    expect(r.modo).toBe("rechazado");
    const lineas = [...archivo(), ...salida()];
    expect(lineas).toHaveLength(2);
    for (const linea of lineas) {
      expect(JSON.parse(linea).resultado.datos).toEqual({ "clave ***": { "***": 1 } });
      for (const s of [TOKEN_A, TOKEN_B, "ZqU4Token"]) expect(linea, s).not.toContain(s);
    }
  });

  it('W24 a tool result holding token=abc"x\\ stays valid JSON once redacted: the dry-run result and recent_audit', async () => {
    const { M } = await cargar(CON_ENV);
    falsearFetch(() => json({ response: [] }));
    const llamar = await conectar(M);
    const nombre = 'ver token=abc"x\\ luego \\" fin';
    const redactado = 'ver token=***"x\\ luego \\" fin';
    const r = await llamar("create_client_group", { ...GRUPO, nombre });
    expect(r.isError).toBe(false);
    const reciente = await llamar("recent_audit", { limite: 5 });
    expect(reciente.isError).toBe(false);
    const salidas: Array<[string, string]> = [
      ["dry-run", r.texto],
      ["recent_audit", reciente.texto],
    ];
    for (const [donde, texto] of salidas) {
      expect(() => JSON.parse(texto), donde).not.toThrow();
      expect(texto, donde).not.toContain("abc");
      expect(JSON.stringify(JSON.parse(texto)), donde).toContain(JSON.stringify(redactado).slice(1, -1));
    }
    expect(JSON.parse(r.texto).modo).toBe("dry-run");
  });
});

describe("write outcome: server errors, read-back calls and failures before the attempt", () => {
  it("W26 a write reply with HTTP status 503 and a success-shaped body gives desconocido with the status in the message; a read reply with the same status and body behaves as before", async () => {
    const { M, archivo, salida } = await cargar(CON_ENV);
    const caido = () => new Response(JSON.stringify({ response: 77 }), { status: 503 });
    const { posts } = falsearFetch((url, init) => (init?.method === "POST" || url.includes("clients.getClients") ? caido() : json({ response: [] })));
    const llamar = await conectar(M);
    const w = await llamar("create_client_group", { ...GRUPO, confirm: true });
    expect(posts()).toBe(1);
    expect(w.isError).toBe(true);
    expect(w.texto).toMatch(/puede haberse aplicado/);
    expect(w.texto).toContain("HTTP 503");
    expect(modos(archivo())).toEqual(["desconocido"]);
    expect(JSON.parse(archivo()[0]).error).toContain("HTTP 503");
    const g = await llamar("poster_get", { cuenta: "tienda-a", metodo: "clients.getClients" });
    expect(g.isError).toBe(false);
    expect(JSON.parse(g.texto).respuesta).toBe(77);
    expect(modos(salida())).toEqual(["desconocido"]);
  });

  it("W27 a finance write whose read-back call fails is aplicado with verificacion.ok false and the do-not-repeat notice, never reported as not found", async () => {
    const { W, archivo } = await cargar(CON_ENV);
    const lecturas: Obj = {
      "finance.getAccounts": [{ account_id: "4", name: "CAJA DE COBRO" }],
      "finance.getCategories": [{ category_id: "6", name: "Nómina" }],
    };
    const post = vi.fn(async () => ({ response: 7001 }));
    const api: PosterApi = {
      get: async (_c, m) => {
        if (m === "finance.getTransactions") throw new Error(`finance.getTransactions: Póster sin respuesta JSON: eco ${TOKEN_A}`);
        return structuredClone(lecturas[m]) as never;
      },
      post: post as never,
    };
    const r: Obj = await W.crearTransaccion(ctx(api), { cuenta: "tienda-b", tipo: "gasto", monto: 1806, account_id: 4, category_id: 6, comentario: "Pago", confirm: true });
    expect(post).toHaveBeenCalledTimes(1);
    expect(r.modo).toBe("aplicado");
    expect(r.verificacion).toEqual({ ok: false, detalle: expect.stringContaining("finance.getTransactions") });
    expect(r.verificacion.detalle).not.toMatch(/No se encontró/);
    expect(r.verificacion.detalle).not.toContain(TOKEN_A);
    expect(r.aviso).toMatch(/no la repitas/i);
    const lineas = archivo();
    expect(modos(lineas)).toEqual(["aplicado"]);
    expect(JSON.parse(lineas[0]).resultado.verificacion).toEqual(r.verificacion);
  });

  it("W28 a failure after the plan is built but before the write is attempted stays rechazado and logs the plan's method and payload", async () => {
    const { W, archivo } = await cargar(CON_ENV);
    const api: PosterApi = {
      get: async () => [] as never,
      post: (async () => {
        throw new Error("Token no disponible");
      }) as never,
    };
    await expect(W.crearGrupoCliente(ctx(api), { ...GRUPO, confirm: true })).rejects.toThrow("Token no disponible");
    const lineas = archivo();
    expect(modos(lineas)).toEqual(["rechazado"]);
    const entrada = JSON.parse(lineas[0]);
    expect(entrada.metodo).toBe("clients.createGroup");
    expect(entrada.payload).toMatchObject({ client_groups_name: "Frecuentes", client_groups_discount: 10 });
    expect(entrada.payload).not.toHaveProperty("confirm");
    expect(entrada.error).toBe("Token no disponible");
  });
});

describe("audit lines: severity, malformed events and corrupt files", () => {
  it("W29 the stdout severity is NOTICE for aplicado, WARNING for desconocido and INFO otherwise, and auditar returns nothing", async () => {
    const { A, salida } = await cargar(CON_ENV);
    for (const modo of ["dry-run", "aplicado", "rechazado", "desconocido"] as const) {
      expect(A.auditar({ ...EVENTO, modo, payload: {} })).toBeUndefined();
    }
    expect(salida().map((l) => JSON.parse(l).severity)).toEqual(["INFO", "NOTICE", "INFO", "WARNING"]);
  });

  it("W30 an event that does not serialize to a JSON object, or whose field getter throws, produces the minimal line and no throw", async () => {
    const { A, archivo, salida } = await cargar(CON_ENV);
    const sinObjeto = { ...EVENTO, modo: "dry-run", payload: {}, toJSON: () => undefined };
    const conGetter: Obj = { ...EVENTO, modo: "dry-run", payload: {} };
    Object.defineProperty(conGetter, "cuenta", {
      enumerable: true,
      get: () => {
        throw new Error("getter");
      },
    });
    expect(() => A.auditar(sinObjeto as never)).not.toThrow();
    expect(() => A.auditar(conGetter as never)).not.toThrow();
    const lineas = archivo().map((l) => JSON.parse(l));
    expect(lineas).toHaveLength(2);
    for (const ev of lineas) {
      expect(Object.keys(ev).sort()).toEqual(["cuenta", "error", "herramienta", "modo", "ts"]);
      expect(ev.error).toMatch(/incompleta/);
    }
    expect(lineas[0]).toMatchObject({ cuenta: "tienda-b", herramienta: "create_client_group", modo: "dry-run" });
    expect(lineas[1]).toMatchObject({ cuenta: "?", herramienta: "create_client_group", modo: "dry-run" });
    expect(salida().map((l) => JSON.parse(l).audit)).toEqual([true, true]);
  });

  it("W31 recent_audit skips an audit line that does not parse", async () => {
    const { A, M } = await cargar(CON_ENV);
    A.auditar({ ...EVENTO, modo: "dry-run", payload: { n: 1 } });
    const dir = process.env.AUDIT_DIR ?? "";
    const [diario] = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
    appendFileSync(path.join(dir, diario), '{"ts":"2026-01-01T00:00:00.000Z","modo":\n');
    A.auditar({ ...EVENTO, modo: "aplicado", payload: { n: 2 } });
    const r = await (await conectar(M))("recent_audit", { limite: 10 });
    expect(r.isError).toBe(false);
    expect(JSON.parse(r.texto).map((e: Obj) => [e.modo, e.payload.n])).toEqual([
      ["aplicado", 2],
      ["dry-run", 1],
    ]);
  });

  it("W32 a cached token inside a JSON-encoded payload string is absent from both audit lines", async () => {
    const { T, A, archivo, salida } = await cargar(CON_GSM, TOKEN_GSM);
    await T.tokenDe("tienda-a");
    A.auditar({ ...EVENTO, modo: "dry-run", payload: { nota: JSON.stringify({ t: TOKEN_GSM }) } });
    const lineas = [...archivo(), ...salida()];
    expect(lineas).toHaveLength(2);
    for (const linea of lineas) {
      expect(JSON.parse(linea).payload.nota).toBe('{"t":"***"}');
      for (const f of FRAGMENTOS) expect(linea, f).not.toContain(f);
    }
  });
});

describe("redaction: structural results, clipped texts and parse failures", () => {
  it("W33 a digit-only token equal to a number in a read result leaves the client text valid JSON and the number unchanged", async () => {
    const digitos = "1234567890123456";
    const { M } = await cargar({ ...CON_ENV, POSTER_TOKEN_TIENDA_A: digitos });
    falsearFetch(() => json({ response: { precio: 1234567890123456, lista: [1234567890123456, 7], nota: `ref ${digitos}` } }));
    const r = await (await conectar(M))("poster_get", { cuenta: "tienda-a", metodo: "clients.getGroups" });
    expect(r.isError).toBe(false);
    expect(JSON.parse(r.texto).respuesta).toEqual({ precio: 1234567890123456, lista: [1234567890123456, 7], nota: "ref ***" });
  });

  it("W34 a one-character Secret Manager token over-redacts strings but leaves the client text and both audit lines valid JSON with numbers unchanged", async () => {
    const { A, M, archivo, salida } = await cargar(CON_GSM, "1");
    falsearFetch(() => json({ response: { precio: 1500, nombre: "Mesa 1", id: 21 } }));
    const r = await (await conectar(M))("poster_get", { cuenta: "tienda-a", metodo: "clients.getGroups" });
    expect(r.isError).toBe(false);
    expect(JSON.parse(r.texto).respuesta).toEqual({ precio: 1500, nombre: "Mesa ***", id: 21 });
    A.auditar({ ...EVENTO, modo: "dry-run", payload: { porcentaje: 10, nombre: "Grupo 1" } });
    const lineas = [...archivo(), ...salida()];
    expect(lineas).toHaveLength(2);
    for (const linea of lineas) expect(JSON.parse(linea).payload).toEqual({ porcentaje: 10, nombre: "Grupo ***" });
  });

  it("W35 a cached token inside a result string that itself holds JSON is absent from the client text", async () => {
    const { M } = await cargar(CON_GSM, TOKEN_GSM);
    falsearFetch(() => json({ response: { nota: JSON.stringify({ t: TOKEN_GSM }) } }));
    const r = await (await conectar(M))("poster_get", { cuenta: "tienda-a", metodo: "clients.getGroups" });
    expect(r.isError).toBe(false);
    expect(JSON.parse(r.texto).respuesta).toEqual({ nota: '{"t":"***"}' });
    for (const f of FRAGMENTOS) expect(r.texto, f).not.toContain(f);
  });

  it("W36 keys that redact to the same text are all kept, the later ones with a numeric suffix, in the client text and in both audit lines", async () => {
    const { A, M, archivo, salida } = await cargar(CON_ENV);
    const datos = { [TOKEN_A]: "uno", "***": "dos", [TOKEN_B]: "tres" };
    const esperado = { "***": "uno", "*** (2)": "dos", "*** (3)": "tres" };
    falsearFetch(() => json({ response: datos }));
    const r = await (await conectar(M))("poster_get", { cuenta: "tienda-a", metodo: "clients.getGroups" });
    expect(r.isError).toBe(false);
    expect(JSON.parse(r.texto).respuesta).toEqual(esperado);
    A.auditar({ ...EVENTO, modo: "dry-run", payload: datos });
    const lineas = [...archivo(), ...salida()];
    expect(lineas).toHaveLength(2);
    for (const linea of lineas) expect(JSON.parse(linea).payload).toEqual(esperado);
  });

  const TARDIOS: Array<[string, Record<string, string>, string | undefined, string]> = [
    ["a literal env token", CON_ENV, undefined, TOKEN_A],
    ["a percent-encoded env token", CON_ENV, undefined, encodeURIComponent(TOKEN_B)],
    ["a Secret Manager token with a quote and a backslash", CON_GSM, TOKEN_GSM, TOKEN_GSM],
  ];

  it.each(TARDIOS)("W37 %s placed just before the 60 000-character limit of poster_get leaves no prefix", async (_caso, entorno, gsm, valor) => {
    const { M } = await cargar(entorno, gsm);
    // The form the value takes in the JSON text that poster_get clips.
    const forma = JSON.stringify(valor).slice(1, -1);
    const inicio = JSON.stringify({ relleno: "", nota: "" }).length - 2;
    const respuesta = { relleno: "x".repeat(59_996 - inicio), nota: valor, cola: "fin" };
    const posicion = JSON.stringify(respuesta).indexOf(forma);
    expect(posicion).toBeLessThan(60_000);
    expect(posicion + forma.length).toBeGreaterThan(60_000);
    falsearFetch(() => json({ response: respuesta }));
    const r = await (await conectar(M))("poster_get", { cuenta: "tienda-a", metodo: "clients.getGroups" });
    expect(r.isError).toBe(false);
    const recortada: string = JSON.parse(r.texto).respuesta;
    expect(recortada).toContain("truncado");
    expect(recortada).not.toContain(forma.slice(0, 4));
  });

  it("W38 a tool error carrying a known token reaches the client redacted", async () => {
    const { M } = await cargar(CON_ENV);
    const api: PosterApi = {
      get: async () => {
        throw new Error(`eco ${TOKEN_A}`);
      },
      post: (async () => ({})) as never,
    };
    const r = await (await conectar(M, api))("poster_get", { cuenta: "tienda-a", metodo: "clients.getGroups" });
    expect(r.isError).toBe(true);
    expect(r.texto).toBe("eco ***");
  });

  it("W39 a reply that looks like JSON but does not parse, with a token near the start, gives errors with no token fragment and no parser message", async () => {
    const { M, P, archivo, salida } = await cargar(CON_ENV);
    const roto = `{"a": ${TOKEN_A}}`;
    falsearFetch((_url, init) => (init?.method === "POST" ? new Response(roto) : json({ response: [] })));
    const w = await (await conectar(M))("create_client_group", { ...GRUPO, confirm: true });
    expect(w.isError).toBe(true);
    expect(w.texto).toMatch(/puede haberse aplicado/);
    expect(w.texto).toContain("HTTP 200");
    expect(modos(archivo())).toEqual(["desconocido"]);
    // The read path retries five times with waits in between.
    falsearFetch(() => new Response(roto));
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const p = P.posterHttp.get("tienda-a", "clients.getGroups").then(
      () => null,
      (e: unknown) => e as Error,
    );
    await vi.runAllTimersAsync();
    const lectura = await p;
    expect(lectura).toBeInstanceOf(Error);
    expect(lectura?.message).toContain("HTTP 200");
    const textos: Array<[string, string]> = [
      ["write error", w.texto],
      ["JSONL", archivo()[0]],
      ["stdout", salida()[0]],
      ["read error", lectura?.message ?? ""],
    ];
    for (const [donde, texto] of textos) {
      expect(texto, donde).not.toContain("ZqU4");
      expect(texto, donde).not.toMatch(/Unexpected token|not valid JSON|JSON at position/);
    }
  });

  it("W40 two known tokens that cross are a documented limit: the one that starts first leaves no fragment and neither survives whole, though a tail of the other may remain", async () => {
    const cabeza = "ZqHeadOverlap-0001";
    const cola = "Overlap-0001ZqTailSecret";
    const { T } = await cargar({ ...CON_ENV, POSTER_TOKEN_TIENDA_A: cabeza, POSTER_TOKEN_TIENDA_B: cola });
    const texto = T.redactar(`x ${cabeza}ZqTailSecret y`);
    expect(texto.startsWith("x ")).toBe(true);
    expect(texto.endsWith(" y")).toBe(true);
    expect(texto).toContain("***");
    for (const s of [cabeza, cola, "ZqHead"]) expect(texto, s).not.toContain(s);
  });

  it('W41 a cached Secret Manager token with " and \\ echoed in the Poster error of a read is absent from the client error', async () => {
    const { M } = await cargar(CON_GSM, TOKEN_GSM);
    falsearFetch(() => json({ error: 10, message: `Token ${TOKEN_GSM} no válido` }));
    const r = await (await conectar(M))("poster_get", { cuenta: "tienda-a", metodo: "clients.getGroups" });
    expect(r.isError).toBe(true);
    expect(r.texto).toContain("clients.getGroups");
    expect(r.texto).toContain("no válido");
    for (const f of FRAGMENTOS) expect(r.texto, f).not.toContain(f);
  });
});
