// Hardening of /authorize and of JWT verification: one passphrase failure counter per app instance,
// shared by every client (X-Forwarded-For never decides), security headers on the authorization page,
// a retry page that echoes only the nine OAuth request fields (never the posted passphrase or any other
// posted field, and the registered client_name instead of a posted one), logs that keep only the tail
// of X-Forwarded-For, and JWT verification pinned to HS256 for every token type.
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { SignJWT } from "jose";

let crearApp: typeof import("../src/server.js").crearApp;
type App = ReturnType<typeof crearApp>;
const BEARER = "b".repeat(64);
const LLAVE = "k".repeat(64);
const FRASE = "frase-de-prueba-larga";
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const MIN = 60_000;
const VENTANA = 15 * MIN;
const CAMPOS_OAUTH = ["response_type", "client_id", "redirect_uri", "code_challenge", "code_challenge_method", "state", "scope", "resource", "client_name"];

// Plain alphanumerics on purpose: the page escapes & < > " ', so these would show up verbatim if reflected.
const FRASE_DISTINTIVA = "ZqPassphrase7731";
const CAMPO_EXTRA = "zqextrafield";
const VALOR_EXTRA = "ZqExtraValue4402";
const NOMBRE_POSTEADO = "ZqPostedName5521";

// HTML-sensitive characters, carried by every hidden field that request validation lets vary.
const RARO = `"<&'>`;
const NOMBRE_RARO = `Cliente ${RARO} registrado`;
// Loopback redirect URIs are accepted with any path and query, so a registered one can carry them too.
const REDIRECT_RARO = `http://127.0.0.1:8976/cb?a=1&b=${RARO}`;

// Longer than 200 characters; its first and last 200 characters differ.
const XFF_LARGO = [...Array.from({ length: 24 }, (_, i) => `198.51.100.${i + 1}`), "203.0.113.250"].join(", ");
const XFF_COLA = XFF_LARGO.slice(-200);

beforeAll(async () => {
  process.env.MCP_BEARER_TOKEN = BEARER;
  process.env.OAUTH_SIGNING_KEY = LLAVE;
  process.env.OWNER_PASSPHRASE = FRASE;
  ({ crearApp } = await import("../src/server.js"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function registrar(app: App, nombre: string, redirect_uris: string[]) {
  const r = await app.request("/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris, client_name: nombre }) });
  expect(r.status).toBe(201);
  const { client_id } = (await r.json()) as { client_id: string };
  expect(client_id).toBeTruthy();
  return client_id;
}

const postear = (app: App, campos: Record<string, string>, xff?: string) =>
  app.request("/authorize", { method: "POST", headers: xff === undefined ? {} : { "x-forwarded-for": xff }, body: new URLSearchParams(campos) });

/** A valid authorization request `q`, posted to `app`. */
function cliente(app: App, q: Record<string, string>) {
  return {
    app,
    q,
    /** POST /authorize with this request, the given passphrase, optionally an X-Forwarded-For value, and field overrides. */
    intentar: (passphrase: string, xff?: string, extra: Record<string, string> = {}) => postear(app, { ...q, ...extra, passphrase }, xff),
    /** POST /authorize that fails request validation (PKCE method "plain") and carries a wrong passphrase. */
    invalida: (xff?: string) => postear(app, { ...q, code_challenge_method: "plain", passphrase: "mala" }, xff),
  };
}

/** Registers a client on `app` (a fresh app by default) and returns its valid request with all nine OAuth fields. */
async function preparar({ app = crearApp(), nombre = "claude", redirect_uris = [REDIRECT] }: { app?: App; nombre?: string; redirect_uris?: string[] } = {}) {
  const client_id = await registrar(app, nombre, redirect_uris);
  const verifier = randomBytes(32).toString("base64url");
  return cliente(app, {
    response_type: "code",
    client_id,
    redirect_uri: REDIRECT,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    state: "xyz",
    scope: "poster",
    resource: "http://localhost:3210/mcp",
    client_name: nombre,
  });
}

/** Parses every <input> tag of a page into its raw (still escaped) attributes. */
const inputs = (html: string) =>
  (html.match(/<input\b[^>]*>/g) ?? []).map((tag) => Object.fromEntries([...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map((m) => [m[1], m[2]])) as Record<string, string>);

const ENTIDADES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
/** Decodes the character references an HTML escaper may produce. */
const decodificar = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e: string) =>
    e[0] !== "#" ? ENTIDADES[e.toLowerCase()] : String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1))),
  );
/** True when a raw attribute value has no unescaped < > ' and every & starts a character reference. */
const escapado = (s: string) => !/[<>']/.test(s) && !/&(?!(?:#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);)/i.test(s);

function revisarCabeceras(r: Response, html: string) {
  expect(r.headers.get("content-type")).toContain("text/html");
  expect(r.headers.get("x-frame-options")).toBe("DENY");
  expect(r.headers.get("cache-control")).toBe("no-store");
  const estilos = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)];
  expect(estilos).toHaveLength(1);
  const hash = createHash("sha256").update(estilos[0][1], "utf8").digest("base64");
  const csp = r.headers.get("content-security-policy");
  expect(csp).toBe(`default-src 'none'; style-src 'sha256-${hash}'; frame-ancestors 'none'; base-uri 'none'`);
  expect(csp).not.toContain("form-action");
}

/**
 * A client registered as NOMBRE_RARO and a request whose fields carry HTML-sensitive characters wherever
 * validation allows it. response_type, code_challenge_method and client_id are fixed by validation and cannot.
 */
async function prepararRaro() {
  const c = await preparar({ nombre: NOMBRE_RARO, redirect_uris: [REDIRECT, REDIRECT_RARO] });
  const enviado = { ...c.q, redirect_uri: REDIRECT_RARO, code_challenge: `ch${RARO}al`, state: `st${RARO}ate`, scope: `poster ${RARO}`, resource: `http://localhost:3210/mcp?r=${RARO}` };
  return { ...c, enviado };
}

/** The retry page renders exactly the nine OAuth fields, escaped, holding what was posted except client_name, which is the registered one. */
function revisarOcultos(html: string, enviado: Record<string, string>) {
  for (const s of [FRASE_DISTINTIVA, VALOR_EXTRA, CAMPO_EXTRA, NOMBRE_POSTEADO]) expect(html).not.toContain(s);
  const todos = inputs(html);
  const passwords = todos.filter((a) => a.type === "password");
  expect(passwords).toHaveLength(1);
  expect(passwords[0]).not.toHaveProperty("value");
  const ocultos = todos.filter((a) => a.type === "hidden");
  expect(ocultos.map((a) => a.name).sort()).toEqual([...CAMPOS_OAUTH].sort());
  for (const a of ocultos) expect(escapado(a.value ?? ""), `${a.name}="${a.value}"`).toBe(true);
  const valores = Object.fromEntries(ocultos.map((a) => [a.name, decodificar(a.value ?? "")]));
  expect(valores).toEqual({ ...enviado, client_name: NOMBRE_RARO });
  const etiqueta = html.match(/Un cliente \(([^)]*)\)/);
  expect(etiqueta?.[1] === undefined ? undefined : decodificar(etiqueta[1])).toBe(NOMBRE_RARO);
}

/** Captures every console line; each request's own lines are taken with `lineasDe`. */
function espiarConsola() {
  const lineas: string[] = [];
  for (const m of ["log", "info", "warn", "error", "debug"] as const)
    vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void lineas.push(a.map(String).join(" ")));
  return lineas;
}
async function lineasDe(lineas: string[], enviar: () => Response | Promise<Response>) {
  const antes = lineas.length;
  const r = await enviar();
  return { r, nuevas: lineas.slice(antes) };
}

describe("passphrase rate limit: one counter per app instance", () => {
  it("RL1 a fresh X-Forwarded-For per request does not bypass the limit", async () => {
    const { intentar } = await preparar();
    const s: number[] = [];
    for (const xff of ["198.51.100.1", "198.51.100.2", "198.51.100.3", "198.51.100.4", undefined]) s.push((await intentar("mala", xff)).status);
    s.push((await intentar("mala", "198.51.100.6")).status);
    expect(s).toEqual([401, 401, 401, 401, 401, 429]);
    const ok = await intentar(FRASE, "198.51.100.7");
    expect(ok.status).toBe(429);
    expect(ok.headers.get("location")).toBeNull();
  });

  it("RL2 control: four wrong passphrases then the correct one get a 302", async () => {
    const { intentar } = await preparar();
    const s: number[] = [];
    for (let i = 1; i <= 4; i++) s.push((await intentar("mala", `198.51.100.${10 + i}`)).status);
    expect(s).toEqual([401, 401, 401, 401]);
    const ok = await intentar(FRASE, "198.51.100.20");
    expect(ok.status).toBe(302);
    expect(ok.headers.get("location")).toContain("code=");
  });

  it("RL3 a successful authorization resets the counter to zero, so the full budget of five failures comes back", async () => {
    const { intentar } = await preparar();
    const antes: number[] = [];
    for (let i = 0; i < 4; i++) antes.push((await intentar("mala", "203.0.113.10")).status);
    expect(antes).toEqual([401, 401, 401, 401]);
    expect((await intentar(FRASE, "203.0.113.20")).status).toBe(302);
    const despues: number[] = [];
    for (let i = 0; i < 6; i++) despues.push((await intentar("mala", "203.0.113.10")).status);
    expect(despues).toEqual([401, 401, 401, 401, 401, 429]);
  });

  it("RL4 the lock holds until the window opened by the first failure ends", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = Date.parse("2026-11-19T12:00:00Z");
    vi.setSystemTime(t0);
    const { intentar } = await preparar();
    const s: number[] = [];
    for (let i = 0; i < 5; i++) {
      vi.setSystemTime(t0 + i * MIN);
      s.push((await intentar("mala", `192.0.2.${i + 1}`)).status);
    }
    expect(s).toEqual([401, 401, 401, 401, 401]);
    vi.setSystemTime(t0 + VENTANA - 1);
    const bloqueada = await intentar(FRASE, "192.0.2.50");
    expect(bloqueada.status).toBe(429);
    expect(bloqueada.headers.get("location")).toBeNull();
    vi.setSystemTime(t0 + VENTANA);
    expect((await intentar(FRASE, "192.0.2.51")).status).toBe(302);
  });

  it("RL5 requests rejected by the lock do not extend the window", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = Date.parse("2026-11-19T12:00:00Z");
    vi.setSystemTime(t0);
    const { intentar } = await preparar();
    const s: number[] = [];
    for (let i = 0; i < 5; i++) s.push((await intentar("mala", `192.0.2.${60 + i}`)).status);
    expect(s).toEqual([401, 401, 401, 401, 401]);
    vi.setSystemTime(t0 + 5 * MIN);
    expect((await intentar("mala", "192.0.2.70")).status).toBe(429);
    vi.setSystemTime(t0 + 10 * MIN);
    const bloqueada = await intentar(FRASE, "192.0.2.71");
    expect(bloqueada.status).toBe(429);
    expect(bloqueada.headers.get("location")).toBeNull();
    vi.setSystemTime(t0 + VENTANA - 1);
    expect((await intentar("mala", "192.0.2.72")).status).toBe(429);
    vi.setSystemTime(t0 + VENTANA);
    expect((await intentar(FRASE, "192.0.2.73")).status).toBe(302);
  });

  it("RL6 invalid requests (400) do not count", async () => {
    const { intentar, invalida } = await preparar();
    const s: number[] = [];
    for (let i = 0; i < 5; i++) s.push((await invalida(`192.0.2.${100 + i}`)).status);
    expect(s).toEqual([400, 400, 400, 400, 400]);
    expect((await intentar(FRASE, "192.0.2.120")).status).toBe(302);
  });

  it("RL7 two apps built in the same file do not share the counter", async () => {
    const a = await preparar();
    const s: number[] = [];
    for (let i = 0; i < 6; i++) s.push((await a.intentar("mala")).status);
    expect(s).toEqual([401, 401, 401, 401, 401, 429]);
    const b = await preparar();
    expect((await b.intentar("mala")).status).toBe(401);
    expect((await b.intentar(FRASE)).status).toBe(302);
    expect((await a.intentar(FRASE)).status).toBe(429);
  });

  it("RL8 the counter is shared by every client: failures alternating between two clients lock both", async () => {
    const app = crearApp();
    const a = await preparar({ app });
    const b = await preparar({ app, nombre: "otro" });
    const s: number[] = [];
    for (let i = 0; i < 5; i++) s.push((await (i % 2 === 0 ? a : b).intentar("mala", `198.51.100.${30 + i}`)).status);
    expect(s).toEqual([401, 401, 401, 401, 401]);
    const sexta: number[] = [];
    for (const [i, c] of [a, b].entries()) sexta.push((await c.intentar("mala", `198.51.100.${40 + i}`)).status);
    expect(sexta).toEqual([429, 429]);
    for (const [i, c] of [a, b].entries()) {
      const r = await c.intentar(FRASE, `198.51.100.${50 + i}`);
      expect(r.status).toBe(429);
      expect(r.headers.get("location")).toBeNull();
    }
  });

  it("RL9 the counter is per app, not per registration: a client locked on one app gets a 302 on another", async () => {
    const a = await preparar();
    const s: number[] = [];
    for (let i = 0; i < 6; i++) s.push((await a.intentar("mala")).status);
    expect(s).toEqual([401, 401, 401, 401, 401, 429]);
    const ok = await cliente(crearApp(), a.q).intentar(FRASE);
    expect(ok.status).toBe(302);
    expect(ok.headers.get("location")).toContain("code=");
    expect((await a.intentar(FRASE)).status).toBe(429);
  });

  it("RL10 the window starts at the first failure, not when the app is built", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = Date.parse("2026-11-19T12:00:00Z");
    vi.setSystemTime(t0);
    const { intentar } = await preparar();
    const t1 = t0 + 10 * MIN;
    vi.setSystemTime(t1);
    const s: number[] = [];
    for (let i = 0; i < 6; i++) s.push((await intentar("mala", `192.0.2.${130 + i}`)).status);
    expect(s).toEqual([401, 401, 401, 401, 401, 429]);
    vi.setSystemTime(t0 + VENTANA);
    expect((await intentar(FRASE, "192.0.2.140")).status).toBe(429);
    vi.setSystemTime(t1 + VENTANA - 1);
    const bloqueada = await intentar(FRASE, "192.0.2.141");
    expect(bloqueada.status).toBe(429);
    expect(bloqueada.headers.get("location")).toBeNull();
    vi.setSystemTime(t1 + VENTANA);
    expect((await intentar(FRASE, "192.0.2.142")).status).toBe(302);
  });

  it("RL11 after a locked window ends, a new window starts at one", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = Date.parse("2026-11-19T12:00:00Z");
    vi.setSystemTime(t0);
    const { intentar } = await preparar();
    const primera: number[] = [];
    for (let i = 0; i < 6; i++) primera.push((await intentar("mala", `192.0.2.${150 + i}`)).status);
    expect(primera).toEqual([401, 401, 401, 401, 401, 429]);
    const t1 = t0 + VENTANA + 2 * MIN;
    vi.setSystemTime(t1);
    const segunda: number[] = [];
    for (let i = 0; i < 6; i++) segunda.push((await intentar("mala", `192.0.2.${160 + i}`)).status);
    expect(segunda).toEqual([401, 401, 401, 401, 401, 429]);
    vi.setSystemTime(t1 + VENTANA - 1);
    expect((await intentar(FRASE, "192.0.2.170")).status).toBe(429);
    vi.setSystemTime(t1 + VENTANA);
    expect((await intentar(FRASE, "192.0.2.171")).status).toBe(302);
  });

  it("RL12 control: validation runs before the lock, so an invalid request gets 400 while locked", async () => {
    const { intentar, invalida } = await preparar();
    const s: number[] = [];
    for (let i = 0; i < 6; i++) s.push((await intentar("mala")).status);
    expect(s).toEqual([401, 401, 401, 401, 401, 429]);
    expect((await invalida()).status).toBe(400);
    expect((await intentar(FRASE)).status).toBe(429);
  });
});

describe("authorization page: security headers", () => {
  it("H1 GET /authorize (200) carries the headers and a CSP hash matching its <style>", async () => {
    const { app, q } = await preparar();
    const r = await app.request(`/authorize?${new URLSearchParams(q)}`);
    expect(r.status).toBe(200);
    revisarCabeceras(r, await r.text());
  });

  it("H2 the 401 retry page carries the headers", async () => {
    const { intentar } = await preparar();
    const r = await intentar("mala");
    expect(r.status).toBe(401);
    revisarCabeceras(r, await r.text());
  });

  it("H3 the 429 retry page carries the headers", async () => {
    const { intentar } = await preparar();
    for (let i = 0; i < 5; i++) expect((await intentar("mala")).status).toBe(401);
    const r = await intentar("mala");
    expect(r.status).toBe(429);
    revisarCabeceras(r, await r.text());
  });

  it("H4 control: the successful POST redirects to exactly the registered URI with a code and the posted state", async () => {
    const { intentar } = await preparar();
    const estado = "s t&u=v";
    const r = await intentar(FRASE, undefined, { state: estado });
    expect(r.status).toBe(302);
    const destino = new URL(r.headers.get("location") ?? "");
    expect(`${destino.origin}${destino.pathname}`).toBe(REDIRECT);
    expect(destino.hash).toBe("");
    expect([...destino.searchParams.keys()].sort()).toEqual(["code", "state"]);
    expect(destino.searchParams.get("code")).toMatch(/\S/);
    expect(destino.searchParams.get("state")).toBe(estado);
  });
});

describe("authorization page: only the OAuth request fields are echoed, never the passphrase", () => {
  it("HF1 the 401 retry page renders only the nine OAuth fields, escaped, with the registered client_name", async () => {
    const { intentar, enviado } = await prepararRaro();
    const r = await intentar(FRASE_DISTINTIVA, undefined, { ...enviado, client_name: NOMBRE_POSTEADO, [CAMPO_EXTRA]: VALOR_EXTRA });
    expect(r.status).toBe(401);
    revisarOcultos(await r.text(), enviado);
  });

  it("HF2 the 429 retry page renders only the nine OAuth fields, escaped, with the registered client_name", async () => {
    const { intentar, enviado } = await prepararRaro();
    for (let i = 0; i < 5; i++) expect((await intentar("mala")).status).toBe(401);
    const r = await intentar(FRASE_DISTINTIVA, undefined, { ...enviado, client_name: NOMBRE_POSTEADO, [CAMPO_EXTRA]: VALOR_EXTRA });
    expect(r.status).toBe(429);
    revisarOcultos(await r.text(), enviado);
  });
});

describe("authorization logs", () => {
  it("LG1 a wrong passphrase (401) writes one WARNING line with the last 200 characters of X-Forwarded-For and no passphrase", async () => {
    expect(XFF_LARGO.length).toBeGreaterThan(200);
    expect(XFF_LARGO.slice(0, 200)).not.toBe(XFF_COLA);
    const lineas = espiarConsola();
    const { intentar } = await preparar();
    const { r, nuevas } = await lineasDe(lineas, () => intentar(FRASE_DISTINTIVA, XFF_LARGO));
    expect(r.status).toBe(401);
    expect(nuevas).toHaveLength(1);
    expect(JSON.parse(nuevas[0])).toMatchObject({ severity: "WARNING", xff: XFF_COLA });
    expect(lineas.join("\n")).not.toContain(FRASE_DISTINTIVA);
  });

  it("LG2 each locked request (429) writes one WARNING line with the last 200 characters of X-Forwarded-For and no passphrase", async () => {
    const lineas = espiarConsola();
    const { intentar } = await preparar();
    for (let i = 0; i < 5; i++) expect((await intentar(`ZqWrong${i}`, XFF_LARGO)).status).toBe(401);
    for (const frase of [FRASE_DISTINTIVA, FRASE]) {
      const { r, nuevas } = await lineasDe(lineas, () => intentar(frase, XFF_LARGO));
      expect(r.status).toBe(429);
      expect(nuevas).toHaveLength(1);
      expect(JSON.parse(nuevas[0])).toMatchObject({ severity: "WARNING", xff: XFF_COLA });
    }
    const todo = lineas.join("\n");
    for (const frase of ["ZqWrong", FRASE_DISTINTIVA, FRASE]) expect(todo).not.toContain(frase);
  });

  it("LG3 a success writes one NOTICE line with the last 200 characters of X-Forwarded-For, the registered client_name and no passphrase", async () => {
    const lineas = espiarConsola();
    const { intentar } = await preparar({ nombre: "cliente-registrado" });
    const { r, nuevas } = await lineasDe(lineas, () => intentar(FRASE, XFF_LARGO, { client_name: NOMBRE_POSTEADO }));
    expect(r.status).toBe(302);
    expect(nuevas).toHaveLength(1);
    expect(JSON.parse(nuevas[0])).toMatchObject({ severity: "NOTICE", xff: XFF_COLA, cliente: "cliente-registrado" });
    const todo = lineas.join("\n");
    for (const s of [FRASE, NOMBRE_POSTEADO]) expect(todo).not.toContain(s);
  });
});

describe("JWT verification pinned to HS256", () => {
  const llave = new TextEncoder().encode(LLAVE);
  /** Complete claims with fixed iss, iat, exp and jti, so twins signed from them differ only in the header algorithm. */
  const claims = (typ: string, extra: Record<string, unknown>) => {
    const iat = Math.floor(Date.now() / 1000);
    return { ...extra, typ, iss: process.env.PUBLIC_BASE_URL!.replace(/\/$/, ""), iat, exp: iat + 3600, jti: randomUUID() };
  };
  const firmar = (alg: "HS256" | "HS512", c: Record<string, unknown>) => new SignJWT(c).setProtectedHeader({ alg }).sign(llave);
  const rpc = (app: App, token: string) =>
    app.request("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
  const canjear = (app: App, campos: Record<string, string>) => app.request("/token", { method: "POST", body: new URLSearchParams(campos) });
  const acceso = claims("access", { sub: "roy", cid: "c".repeat(64) });

  it("J1 control: an HS256 access token signed with OAUTH_SIGNING_KEY is accepted by /mcp", async () => {
    expect((await rpc(crearApp(), await firmar("HS256", acceso))).status).toBe(200);
  });

  it("J2 the same claims and key under HS512 get 401", async () => {
    expect((await rpc(crearApp(), await firmar("HS512", acceso))).status).toBe(401);
  });

  it("J3 a client token under HS512 gets 400 at GET /authorize while its HS256 twin is accepted", async () => {
    const app = crearApp();
    const c = claims("client", { ru: [REDIRECT], n: "forjado" });
    const pedir = async (alg: "HS256" | "HS512") =>
      app.request(`/authorize?${new URLSearchParams({ response_type: "code", client_id: await firmar(alg, c), redirect_uri: REDIRECT, code_challenge: "reto", code_challenge_method: "S256" })}`);
    expect((await pedir("HS256")).status).toBe(200);
    expect((await pedir("HS512")).status).toBe(400);
  });

  it("J4 an authorization code under HS512 gets 400 at /token while its HS256 twin is accepted", async () => {
    const app = crearApp();
    const client_id = "cliente-j4";
    const code_verifier = randomBytes(32).toString("base64url");
    const c = claims("code", { cid: createHash("sha256").update(client_id).digest("hex"), ru: REDIRECT, cc: createHash("sha256").update(code_verifier).digest("base64url") });
    const pedir = async (alg: "HS256" | "HS512", cc: Record<string, unknown>) =>
      canjear(app, { grant_type: "authorization_code", code: await firmar(alg, cc), client_id, redirect_uri: REDIRECT, code_verifier });
    const ok = await pedir("HS256", c);
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { access_token?: string }).access_token).toBeTruthy();
    // Codes are single-use, so the HS512 twin carries its own jti.
    expect((await pedir("HS512", { ...c, jti: randomUUID() })).status).toBe(400);
  });

  it("J5 a refresh token under HS512 gets 400 at /token while its HS256 twin is accepted", async () => {
    const app = crearApp();
    const c = claims("refresh", { sub: "roy", cid: "c".repeat(64) });
    const pedir = async (alg: "HS256" | "HS512") => canjear(app, { grant_type: "refresh_token", refresh_token: await firmar(alg, c) });
    const ok = await pedir("HS256");
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { access_token?: string }).access_token).toBeTruthy();
    expect((await pedir("HS512")).status).toBe(400);
  });
});
