// SERVICE_NAME, NETWORK_NAME and OAUTH_SUBJECT over HTTP (module reset, no network): /health, /,
// the authorization page (escaped) and the subject of issued tokens; bad configuration stops startup.
import { describe, it, expect, vi, afterEach } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { decodeJwt } from "jose";

const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const FRASE = "frase-de-prueba-larga";
const AUTH = { MCP_BEARER_TOKEN: "b".repeat(64), OAUTH_SIGNING_KEY: "k".repeat(64), OWNER_PASSPHRASE: FRASE };
const NUEVAS = ["POSTER_ACCOUNTS", "DEFAULT_WRITE_ACCOUNT", "TIMEZONE", "OWNER_NAME", "NETWORK_NAME", "SERVICE_NAME", "OAUTH_SUBJECT", "TOKEN_SOURCE", "POSTER_MYSQL_URL"];
const RED_RARA = `Tacos <Norte> & "Sur"`;
const RED_RARA_ESCAPADA = "Tacos &#60;Norte&#62; &#38; &#34;Sur&#34;";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  vi.restoreAllMocks();
});

/** A fresh app built with OAuth enabled and `entorno` on top of no new variables. */
async function app(entorno: Record<string, string> = {}) {
  vi.resetModules();
  for (const k of NUEVAS) vi.stubEnv(k, undefined);
  for (const [k, v] of Object.entries({ ...AUTH, ...entorno })) vi.stubEnv(k, v);
  const { crearApp } = await import("../src/server.js");
  return crearApp();
}
type App = Awaited<ReturnType<typeof app>>;

/** Registers a client and returns its valid authorization request plus the PKCE verifier. */
async function solicitud(a: App) {
  const r = await a.request("/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: [REDIRECT], client_name: "claude" }) });
  expect(r.status).toBe(201);
  const { client_id } = (await r.json()) as { client_id: string };
  const verifier = randomBytes(32).toString("base64url");
  const q = {
    response_type: "code",
    client_id,
    redirect_uri: REDIRECT,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    state: "xyz",
    scope: "poster",
    resource: "http://localhost:3210/mcp",
  };
  return { q, verifier };
}

async function pagina(a: App) {
  vi.spyOn(console, "log").mockImplementation(() => {});
  const { q } = await solicitud(a);
  const r = await a.request(`/authorize?${new URLSearchParams(q)}`);
  expect(r.status).toBe(200);
  return r.text();
}

type Tokens = { access_token: string; refresh_token: string };

/** Calls tools/list on /mcp with `token` as bearer. */
const listar = (a: App, token: string) =>
  a.request("/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });

/** Runs the whole authorization-code flow and one refresh; returns the subjects of the issued tokens. */
async function sujetos(a: App) {
  const [t1, t2] = await emitidos(a);
  return [t1.access_token, t1.refresh_token, t2.access_token, t2.refresh_token].map((t) => decodeJwt(t).sub);
}

/** Runs the whole authorization-code flow and one refresh; returns both token pairs. */
async function emitidos(a: App): Promise<[Tokens, Tokens]> {
  vi.spyOn(console, "log").mockImplementation(() => {});
  const { q, verifier } = await solicitud(a);
  const autorizado = await a.request("/authorize", { method: "POST", body: new URLSearchParams({ ...q, client_name: "claude", passphrase: FRASE }) });
  expect(autorizado.status).toBe(302);
  const code = new URL(autorizado.headers.get("location")!).searchParams.get("code")!;
  const canje = await a.request("/token", { method: "POST", body: new URLSearchParams({ grant_type: "authorization_code", code, client_id: q.client_id, redirect_uri: REDIRECT, code_verifier: verifier }) });
  expect(canje.status).toBe(200);
  const t1 = (await canje.json()) as Tokens;
  const renovado = await a.request("/token", { method: "POST", body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: t1.refresh_token }) });
  expect(renovado.status).toBe(200);
  const t2 = (await renovado.json()) as Tokens;
  return [t1, t2];
}

describe("SERVICE_NAME, NETWORK_NAME and OAUTH_SUBJECT over HTTP", () => {
  it("H1 /health carries SERVICE_NAME in servicio with no other change to its fields, and / names it", async () => {
    const a = await app({ SERVICE_NAME: "tacos-mcp" });
    const salud = await a.request("/health");
    expect(salud.status).toBe(200);
    expect(await salud.json()).toEqual({ ok: true, servicio: "tacos-mcp", tokens: "gsm", oauth: true });
    expect(await (await a.request("/")).text()).toBe("tacos-mcp MCP · endpoint: /mcp");
  });

  it("H2 the authorization page takes its title and heading from SERVICE_NAME and escapes NETWORK_NAME", async () => {
    const html = await pagina(await app({ SERVICE_NAME: "tacos-mcp", NETWORK_NAME: RED_RARA }));
    expect(html).toContain("<title>tacos-mcp · autorizar</title>");
    expect(html).toContain("<h1>Conectar tacos-mcp</h1>");
    expect(html).toContain(`pide acceso a las cuentas Póster de la red ${RED_RARA_ESCAPADA}.</p>`);
    expect(html).not.toContain(RED_RARA);
    expect(html).not.toContain("<Norte>");
    expect(html).not.toContain(`"Sur"`);
    expect(html).not.toMatch(/poster-rush|RUSH/);
  });

  it("H3 issued access and refresh tokens carry OAUTH_SUBJECT as sub", async () => {
    expect(await sujetos(await app({ OAUTH_SUBJECT: "ana@tacos.example" }))).toEqual(Array(4).fill("ana@tacos.example"));
  });

  it("H4 with defaults the authorization page says poster-rush and names the network as RUSH Café", async () => {
    const html = await pagina(await app());
    expect(html).toContain("<title>poster-rush · autorizar</title>");
    expect(html).toContain("<h1>Conectar poster-rush</h1>");
    expect(html).toContain("pide acceso a las cuentas Póster de la red RUSH Café.</p>");
  });

  it("H5 with defaults /health says poster-rush and tokens carry sub roy", async () => {
    const a = await app();
    expect(await (await a.request("/health")).json()).toEqual({ ok: true, servicio: "poster-rush", tokens: "gsm", oauth: true });
    expect(await (await a.request("/")).text()).toBe("poster-rush MCP · endpoint: /mcp");
    expect(await sujetos(a)).toEqual(Array(4).fill("roy"));
  });

  it("H6 an invalid configuration stops startup: importing the server fails and names the variable", async () => {
    await expect(app({ TOKEN_SOURCE: "vault" })).rejects.toThrow(/TOKEN_SOURCE/);
    await expect(app({ POSTER_ACCOUNTS: "tienda-a,Tienda-B" })).rejects.toThrow(/POSTER_ACCOUNTS/);
  });

  it("H7 tokens issued before an OAUTH_SUBJECT change are still accepted after it", async () => {
    const [antes] = await emitidos(await app({ OAUTH_SUBJECT: "ana-antes" }));
    expect(decodeJwt(antes.access_token).sub).toBe("ana-antes");
    // A new instance with another subject and the same signing key.
    const despues = await app({ OAUTH_SUBJECT: "ana-despues" });
    expect((await listar(despues, "token-que-no-firmo-nadie")).status).toBe(401);
    expect((await listar(despues, antes.access_token)).status).toBe(200);
    const r = await despues.request("/token", { method: "POST", body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: antes.refresh_token }) });
    expect(r.status).toBe(200);
    const renovado = (await r.json()) as Tokens;
    expect(decodeJwt(renovado.access_token).sub).toBe("ana-despues");
    expect((await listar(despues, renovado.access_token)).status).toBe(200);
  });

  it("H8 /health reports the configured token source: TOKEN_SOURCE=mysql shows mysql", async () => {
    const a = await app({ TOKEN_SOURCE: "mysql" });
    expect(await (await a.request("/health")).json()).toEqual({ ok: true, servicio: "poster-rush", tokens: "mysql", oauth: true });
  });
});
