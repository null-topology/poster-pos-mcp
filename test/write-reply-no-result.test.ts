// Unit A of specs/2026-11-20-write-probes.md: a write reply with no error whose `response` is false or null is an
// unknown outcome, whatever `success` says. It is audited as desconocido, the read-back does not run, and the error
// tells the caller to check with a read before any retry. Poster is a fake PosterApi; there is no network.
import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PosterApi } from "../src/poster.js";

type Obj = Record<string, any>;

const CONFIGURACION = [
  "POSTER_ACCOUNTS", "DEFAULT_WRITE_ACCOUNT", "WRITE_DEFAULT_ACCOUNTS", "TIMEZONE", "OWNER_NAME", "NETWORK_NAME",
  "SERVICE_NAME", "OAUTH_SUBJECT", "TOKEN_SOURCE", "POSTER_MYSQL_URL", "GCP_PROJECT_ID", "AUDIT_DIR",
  "EXPERIMENTAL_WRITE_PROBE", "POSTER_TOKEN_SHOP_A", "POSTER_TOKEN_SHOP_B",
];
const TOKEN_B = "770055:QxR7SampleTokenB~2202";
const ENV: Record<string, string> = {
  TOKEN_SOURCE: "env",
  POSTER_ACCOUNTS: "shop-a,shop-b",
  WRITE_DEFAULT_ACCOUNTS: "shop-b",
  POSTER_TOKEN_SHOP_A: "QxR7SampleTokenA-2201",
  POSTER_TOKEN_SHOP_B: TOKEN_B,
};
const GROUP = { cuenta: "shop-b", nombre: "Sample regulars", tipo: "descuento" as const, porcentaje: 10 };

const temporales: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
  for (const d of temporales.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Fresh module graph with ENV over no configuration and a fresh audit directory. */
async function load() {
  vi.resetModules();
  const auditDir = mkdtempSync(path.join(os.tmpdir(), "poster-mcp-no-result-"));
  temporales.push(auditDir);
  for (const k of CONFIGURACION) vi.stubEnv(k, undefined);
  for (const [k, v] of Object.entries({ ...ENV, AUDIT_DIR: auditDir })) vi.stubEnv(k, v);
  vi.spyOn(console, "log").mockImplementation(() => {});
  const W = await import("../src/tools/escritura.js");
  const audit = () =>
    readdirSync(auditDir)
      .filter((f) => f.endsWith(".jsonl"))
      .sort()
      .flatMap((f) => readFileSync(path.join(auditDir, f), "utf8").split("\n").filter(Boolean))
      .map((l) => JSON.parse(l) as Obj);
  return { W, audit };
}

/** Fake API for create_client_group: the plan read finds no group, the read-back finds the created one. */
function groupApi(reply: Obj) {
  const get = vi.fn(async (_cuenta: string, _metodo: string) => [{ client_groups_id: "31", client_groups_name: "Sample regulars" }] as unknown);
  get.mockImplementationOnce(async () => []);
  const post = vi.fn(async () => reply);
  return { get, post, api: { get, post } as unknown as PosterApi };
}
const outcome = (p: Promise<unknown>): Promise<Obj> => p.then((r) => r as Obj, (e: unknown) => ({ thrown: String((e as Error)?.message ?? e) }));

describe("A unclear write replies: response false or null with no error is an unknown outcome", () => {
  const CASES: [string, Obj, RegExp][] = [
    ["{response: false}", { response: false }, /"response":false/],
    ["{success: 1, response: false}", { success: 1, response: false }, /"success":1,"response":false/],
    ["{response: null}", { response: null }, /"response":null/],
    ["{success: 0, response: false}", { success: 0, response: false }, /"success":0,"response":false/],
  ];
  for (const [name, reply, summary] of CASES) {
    it(`A1 ${name} gives no read-back, one desconocido audit entry and an error that says to check before any retry`, async () => {
      const { W, audit } = await load();
      const { get, post, api } = groupApi(reply);
      const r = await outcome(W.crearGrupoCliente({ api, actor: "test" }, { ...GROUP, confirm: true }));
      expect(r).toHaveProperty("thrown");
      const msg: string = r.thrown;
      expect(msg).toMatch(/Poster returned no result/);
      expect(msg).toMatch(/may or may not have been applied/);
      expect(msg).toMatch(/check with a read before any retry/i);
      expect(msg).toMatch(summary);
      expect(post).toHaveBeenCalledTimes(1);
      // The only read is the one that builds the plan: no read-back.
      expect(get).toHaveBeenCalledTimes(1);
      const entries = audit();
      expect(entries.map((e) => e.modo)).toEqual(["desconocido"]);
      expect(entries[0].metodo).toBe("clients.createGroup");
      expect(entries[0].error).toMatch(/Poster returned no result/);
    });
  }

  it("A2 the summary of a response-null reply in the error is redacted", async () => {
    const { W, audit } = await load();
    const { api } = groupApi({ response: null, message: `token=${TOKEN_B} raw ${TOKEN_B}` });
    const r = await outcome(W.crearGrupoCliente({ api, actor: "test" }, { ...GROUP, confirm: true }));
    expect(r).toHaveProperty("thrown");
    expect(r.thrown).toMatch(/Poster returned no result/);
    expect(r.thrown).toContain("***");
    expect(r.thrown).not.toContain("QxR7SampleTokenB");
    expect(JSON.stringify(audit())).not.toContain("QxR7SampleTokenB");
  });

  it("A3 a reply with response true still runs the read-back and is aplicado", async () => {
    const { W, audit } = await load();
    const { get, post, api } = groupApi({ response: true });
    const r = await outcome(W.crearGrupoCliente({ api, actor: "test" }, { ...GROUP, confirm: true }));
    expect(r).toMatchObject({ modo: "aplicado", respuesta: true });
    expect(post).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledTimes(2);
    expect(audit().map((e) => e.modo)).toEqual(["aplicado"]);
  });

  it("A4 unchanged: a reply with response 0, an object or an array runs the read-back; an error stays rejected; no response and success 0 stays unknown", async () => {
    for (const reply of [{ response: 0 }, { response: { id: 31 } }, { response: [] }]) {
      const { W, audit } = await load();
      const { get, api } = groupApi(reply);
      const r = await outcome(W.crearGrupoCliente({ api, actor: "test" }, { ...GROUP, confirm: true }));
      expect(r.modo).toBe("aplicado");
      expect(get).toHaveBeenCalledTimes(2);
      expect(audit().map((e) => e.modo)).toEqual(["aplicado"]);
    }
    {
      const { W, audit } = await load();
      const { api } = groupApi({ error: 32, response: false });
      const r = await outcome(W.crearGrupoCliente({ api, actor: "test" }, { ...GROUP, confirm: true }));
      expect(r.modo).toBe("rechazado");
      expect(audit().map((e) => e.modo)).toEqual(["rechazado"]);
    }
    {
      const { W, audit } = await load();
      const { api } = groupApi({ success: 0 });
      const r = await outcome(W.crearGrupoCliente({ api, actor: "test" }, { ...GROUP, confirm: true }));
      expect(r.thrown).toMatch(/sin error y sin response/);
      expect(audit().map((e) => e.modo)).toEqual(["desconocido"]);
    }
  });
});
