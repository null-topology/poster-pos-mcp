// Unit B of specs/2026-11-20-write-probes.md: the experimental write probe. The switch, the tool list, the fixed
// bodies of each variant, the refusals before any POST, the read-back, and the HTTP status and redacted reply of
// every outcome after a POST. Poster is faked (a fake PosterApi, or the real transport over a fake fetch); there is
// no network.
import { describe, it, expect, vi, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { PosterApi } from "../src/poster.js";

type Obj = Record<string, any>;

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROBE = "experimental_write_probe";
/** Every tool the server registers with the probe off, sorted. */
const NAMES_OFF = [
  "assign_supply_payment", "client_groups", "count_sheet", "create_category", "create_client_group", "create_dish",
  "create_ingredient", "create_prepack", "create_supply", "create_transaction", "create_write_off", "delete_old_dish",
  "employees", "hide_dish", "ingredients", "list_accounts", "list_stocktakes", "menu_snapshot", "payment_methods",
  "poster_get", "prepacks", "product_details", "promotions", "recent_audit", "reference_catalogs", "settings",
  "stock_levels", "stocktake_result", "supplies", "supply_details", "update_category", "update_client_group",
  "update_dish", "update_dish_recipe", "update_prepack",
];
const CONFIGURACION = [
  "POSTER_ACCOUNTS", "DEFAULT_WRITE_ACCOUNT", "WRITE_DEFAULT_ACCOUNTS", "TIMEZONE", "OWNER_NAME", "NETWORK_NAME",
  "SERVICE_NAME", "OAUTH_SUBJECT", "TOKEN_SOURCE", "POSTER_MYSQL_URL", "GCP_PROJECT_ID", "AUDIT_DIR",
  "EXPERIMENTAL_WRITE_PROBE", "POSTER_TOKEN_SHOP_A", "POSTER_TOKEN_SHOP_B",
];
// Synthetic env tokens; both share the fragment "QxR7Sample", so a partial leak shows up.
const TOKEN_A = "QxR7SampleTokenA-2301";
const TOKEN_B = "770055:QxR7SampleTokenB~2302";
const ENV: Record<string, string> = {
  TOKEN_SOURCE: "env",
  POSTER_ACCOUNTS: "shop-a,shop-b",
  WRITE_DEFAULT_ACCOUNTS: "shop-b",
  POSTER_TOKEN_SHOP_A: TOKEN_A,
  POSTER_TOKEN_SHOP_B: TOKEN_B,
};

const FECHA = "2026-11-20 10:30:00";
const SUPPLY = { cuenta: "shop-b", probe: "supply" as const, storage_id: 7, supplier_id: 21, ingredient_id: 4101, fecha: FECHA };
const LINE = '[{"id":4101,"type":4,"num":1,"sum":1}]';
/** The wire body of each supply variant: JSON text, or the multipart fields with the string values sent. */
const SUPPLY_WIRE: Record<string, { encoding: string; wire: unknown }> = {
  documented: {
    encoding: "json",
    wire: `{"supply":{"date":"${FECHA}","supplier_id":21,"storage_id":7,"supply_comment":"write probe"},"ingredient":${LINE}}`,
  },
  documented_nested: {
    encoding: "json",
    wire: `{"supply":{"date":"${FECHA}","supplier_id":21,"storage_id":7,"supply_comment":"write probe","ingredient":${LINE}}}`,
  },
  documented_flat: {
    encoding: "json",
    wire: `{"date":"${FECHA}","supplier_id":21,"storage_id":7,"supply_comment":"write probe","ingredient":${LINE}}`,
  },
  form_ingredient: {
    encoding: "multipart",
    wire: [["date", FECHA], ["supplier_id", "21"], ["storage_id", "7"], ["supply_comment", "write probe"], ["ingredient", LINE]],
  },
  legacy_unscaled: {
    encoding: "multipart",
    wire: [["date", FECHA], ["storage_id", "7"], ["supplier_id", "21"], ["supply_comment", "write probe"], ["ingredients", LINE]],
  },
};

const DIA = "2026-11-18";
const row = (id: number, o: Obj = {}) => ({
  transaction_id: String(id), account_id: "3", user_id: "4", category_id: "12", type: "0", amount: "-100",
  date: `${DIA} 09:15:00`, recipient_type: "0", binding_type: "0", comment: "Write PROBE", delete: "0", ...o,
});
const ROWS = [
  row(9001),
  row(9002, { type: "1", amount: "100", account_id: "5", category_id: "13", comment: "  write probe\n" }),
  row(9003, { amount: "-101" }),
  row(9004, { type: "2", amount: "-50" }),
  row(9005, { amount: "-50", recipient_type: "1" }),
  row(9006, { amount: "-50", binding_type: "1" }),
  row(9007, { amount: "-50", comment: "Sample rent" }),
  row(9008, { type: "1", amount: "101" }),
  row(9009, { delete: "1" }),
];
const TX_WIRE: Record<string, string> = {
  "9001 amount_currency": '{"transaction_id":9001,"type":0,"category":12,"user_id":4,"amount_from":2,"account_from":3,"date":"20261118"}',
  "9001 amount_kopecks": '{"transaction_id":9001,"type":0,"category":12,"user_id":4,"amount_from":200,"account_from":3,"date":"20261118"}',
  "9002 amount_currency": '{"transaction_id":9002,"type":1,"category":13,"user_id":4,"amount_to":2,"account_to":5,"date":"20261118"}',
  "9002 amount_kopecks": '{"transaction_id":9002,"type":1,"category":13,"user_id":4,"amount_to":200,"account_to":5,"date":"20261118"}',
};

const READS: Obj = {
  "storage.getStorages": [{ storage_id: "7", storage_name: "Sample bar", delete: "0" }, { storage_id: "8", storage_name: "Sample old bar", delete: "1" }],
  "storage.getSuppliers": [{ supplier_id: "21", supplier_name: "Sample supplier", delete: "0" }, { supplier_id: "22", supplier_name: "Sample old supplier", delete: "1" }],
  "menu.getIngredients": [
    { ingredient_id: "4101", ingredient_name: "Sample flour", ingredient_unit: "kg", delete: "0" },
    { ingredient_id: "4102", ingredient_name: "Sample old flour", ingredient_unit: "kg", delete: "1" },
  ],
  "storage.getSupply": (p: Obj) => ({
    supply_id: String(p.supply_id), storage_id: "7", supplier_id: "21", account_id: "", date: FECHA, supply_sum: "1",
    supply_comment: "write probe", ingredients: [{ ingredient_id: "4101", supply_ingredient_num: "1.0000000", supply_ingredient_sum: "1.00", ingredient_name: "Sample flour" }],
  }),
  "finance.getTransactions": ROWS,
};

const temporales: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
  for (const d of temporales.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Fresh module graph with ENV (plus `extra`) over no configuration and a fresh audit directory. */
async function load(extra: Record<string, string> = {}) {
  vi.resetModules();
  const auditDir = mkdtempSync(path.join(os.tmpdir(), "poster-mcp-probe-"));
  temporales.push(auditDir);
  for (const k of CONFIGURACION) vi.stubEnv(k, undefined);
  for (const [k, v] of Object.entries({ ...ENV, ...extra, AUDIT_DIR: auditDir })) vi.stubEnv(k, v);
  const consola = vi.spyOn(console, "log").mockImplementation(() => {});
  const P = await import("../src/poster.js");
  const W = await import("../src/tools/escritura.js");
  const M = await import("../src/mcp.js");
  const audit = () =>
    readdirSync(auditDir)
      .filter((f) => f.endsWith(".jsonl"))
      .sort()
      .flatMap((f) => readFileSync(path.join(auditDir, f), "utf8").split("\n").filter(Boolean));
  const stdout = () => consola.mock.calls.map((c) => c.map(String).join(" ")).join("\n");
  return { P, W, M, audit, stdout };
}

/** Fake reads from `reads` (a value, or a function of the params); every other method reads an empty list. */
function fakeGet(reads: Obj = READS) {
  return vi.fn(async (_cuenta: string, metodo: string, params?: Obj) => {
    const v = reads[metodo];
    return structuredClone(typeof v === "function" ? v(params ?? {}) : v ?? []) as unknown;
  });
}
/** A fake PosterApi whose post returns `reply`. */
function fakeApi(reply: Obj = { response: 4501 }, reads: Obj = READS) {
  const get = fakeGet(reads);
  const post = vi.fn(async (..._a: unknown[]) => reply);
  return { get, post, api: { get, post } as unknown as PosterApi };
}
/** Replaces fetch: a POST gets `responder()`, anything else fails the test. */
function fakeFetch(responder: () => Response | Promise<Response>) {
  const f = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    if (init?.method !== "POST") throw new Error("unexpected GET through fetch");
    return responder();
  });
  vi.stubGlobal("fetch", f);
  const posts = () => f.mock.calls.filter(([, i]) => i?.method === "POST").map(([, i]) => i as RequestInit);
  return { f, posts };
}
/** Reads faked, the POST through the real transport. */
function transportApi(P: typeof import("../src/poster.js"), reads: Obj = READS) {
  const get = fakeGet(reads);
  return { get, api: { get, post: P.posterHttp.post } as unknown as PosterApi };
}
const wireOf = (init: RequestInit) =>
  init.body instanceof FormData ? [...init.body.entries()] : String(init.body);
const outcome = (p: Promise<unknown>): Promise<Obj> => p.then((r) => r as Obj, (e: unknown) => ({ thrown: String((e as Error)?.message ?? e) }));
const ctx = (api: PosterApi) => ({ api, actor: "test" });

async function connect(M: typeof import("../src/mcp.js"), api: PosterApi) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await M.crearServidorMcp(api).connect(serverSide);
  const client = new Client({ name: "probe-test", version: "0.0.0" });
  await client.connect(clientSide);
  return client;
}

describe("B switch: EXPERIMENTAL_WRITE_PROBE", () => {
  it("B1 unset or blank leaves the probe off; exactly 1 turns it on", async () => {
    const { cargarConfig } = await import("../src/config.js");
    expect(cargarConfig({}).experimentalWriteProbe).toBe(false);
    expect(cargarConfig({ EXPERIMENTAL_WRITE_PROBE: "" }).experimentalWriteProbe).toBe(false);
    expect(cargarConfig({ EXPERIMENTAL_WRITE_PROBE: "   " }).experimentalWriteProbe).toBe(false);
    expect(cargarConfig({ EXPERIMENTAL_WRITE_PROBE: "1" }).experimentalWriteProbe).toBe(true);
  });

  it("B2 any other value stops startup with an error that names the variable and does not echo the value", async () => {
    const { cargarConfig } = await import("../src/config.js");
    for (const v of ["0", "2", " 1", "1 ", "true", "yes", "on", "enable-zq9"]) {
      expect(() => cargarConfig({ EXPERIMENTAL_WRITE_PROBE: v }), JSON.stringify(v)).toThrow(/^EXPERIMENTAL_WRITE_PROBE: /);
    }
    for (const v of ["true", "yes", "enable-zq9"]) {
      let msg = "";
      try {
        cargarConfig({ EXPERIMENTAL_WRITE_PROBE: v });
      } catch (e) {
        msg = String((e as Error).message);
      }
      expect(msg, v).toMatch(/^EXPERIMENTAL_WRITE_PROBE: /);
      expect(msg, v).not.toContain(v);
    }
  });

  it("B3 off (unset or blank) lists the 35 tools; on lists 36, and every other tool is listed exactly as with the probe off", async () => {
    const list = async (extra: Record<string, string>) => {
      const { M } = await load(extra);
      const client = await connect(M, fakeApi().api);
      return (await client.listTools()).tools.sort((x, y) => x.name.localeCompare(y.name));
    };
    const off = await list({});
    expect(off.map((t) => t.name)).toEqual(NAMES_OFF);
    expect(await list({ EXPERIMENTAL_WRITE_PROBE: "" })).toEqual(off);
    const on = await list({ EXPERIMENTAL_WRITE_PROBE: "1" });
    expect(on).toHaveLength(36);
    expect(on.map((t) => t.name).filter((n) => !NAMES_OFF.includes(n))).toEqual([PROBE]);
    expect(on.filter((t) => t.name !== PROBE)).toEqual(off);
    const probe = on.find((t) => t.name === PROBE)!;
    expect(probe.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(probe.description).toMatch(/experimental/i);
    expect(probe.description).toMatch(/off by default/i);
    expect(probe.description).toMatch(/never pays/i);
    expect(probe.description).toMatch(/deleted by hand/i);
  });

  it("B4 a spawned server with another value exits with an error that names the variable and not the value", async () => {
    const child = spawn(process.execPath, ["--import", "tsx", path.join(RAIZ, "src/server.ts")], {
      cwd: RAIZ,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        PATH: process.env.PATH ?? "",
        MCP_TRANSPORT: "stdio",
        TOKEN_SOURCE: "env",
        POSTER_ACCOUNTS: "shop-a,shop-b",
        POSTER_TOKEN_SHOP_A: "9001:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        POSTER_TOKEN_SHOP_B: "9002:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        AUDIT_DIR: mkdtempSync(path.join(os.tmpdir(), "poster-mcp-probe-proc-")),
        EXPERIMENTAL_WRITE_PROBE: "enable-zq9",
      },
    });
    child.stdin.end();
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += String(d)));
    child.stdout.on("data", () => {});
    const code = await new Promise<number | null>((resolve) => {
      const t = setTimeout(() => child.kill("SIGKILL"), 15_000);
      child.on("exit", (c) => {
        clearTimeout(t);
        resolve(c);
      });
    });
    expect(stderr).toContain("EXPERIMENTAL_WRITE_PROBE");
    expect(stderr).not.toContain("enable-zq9");
    expect(code).not.toBeNull();
    expect(code).not.toBe(0);
  }, 30_000);
});

describe("B supply probe", () => {
  for (const [variant, { encoding, wire }] of Object.entries(SUPPLY_WIRE)) {
    it(`B5 ${variant}: the dry-run pins the encoding and the wire body, sends nothing and carries no account_id`, async () => {
      const { W } = await load();
      const { get, post, api } = fakeApi();
      const r = (await W.probarEscritura(ctx(api), { ...SUPPLY, variant } as any)) as Obj;
      expect(post).not.toHaveBeenCalled();
      expect(r).toMatchObject({ modo: "dry-run", probe: "supply", variant, metodo: "storage.createSupply", encoding });
      expect(r.wire_body).toEqual(wire);
      expect(JSON.stringify(r)).not.toContain("account_id");
      expect(r.read_back).toMatch(/storage\.getSupply/);
      expect(r.notices.join("\n")).toMatch(/nothing was sent/i);
      expect(r.notices.join("\n")).toMatch(/one variant per approval/i);
      expect(r.notices.join("\n")).toMatch(/storage\.getSupplies before trying the next variant/);
      expect(r.notices.join("\n")).toMatch(/delete the probe supply in the web UI/i);
      expect(get.mock.calls.map((c) => c[1]).sort()).toEqual(["menu.getIngredients", "storage.getStorages", "storage.getSuppliers"]);
    });
  }

  it("B6 quantity, price, comment and account_id cannot be set: extra arguments leave every wire body unchanged", async () => {
    const { W } = await load();
    const extra = { cantidad: 5, costo_unitario: 9, num: 5, sum: 900, comentario: "Sample note", supply_comment: "Sample note", account_id: 3, renglones: [{ id: 4101, cantidad: 9, costo_unitario: 9 }] };
    for (const [variant, { wire }] of Object.entries(SUPPLY_WIRE)) {
      const { api } = fakeApi();
      const r = (await W.probarEscritura(ctx(api), { ...SUPPLY, ...extra, variant } as any)) as Obj;
      expect(r.wire_body, variant).toEqual(wire);
    }
  });

  it("B7 refuses a missing or deleted storage, supplier or ingredient, and a missing, malformed or unreal fecha, before any POST", async () => {
    const CASES: [string, Obj, RegExp][] = [
      ["missing storage", { storage_id: 9 }, /storage 9/i],
      ["deleted storage", { storage_id: 8 }, /storage 8/i],
      ["missing supplier", { supplier_id: 29 }, /supplier 29/i],
      ["deleted supplier", { supplier_id: 22 }, /supplier 22/i],
      ["missing ingredient", { ingredient_id: 4109 }, /ingredient 4109/i],
      ["deleted ingredient", { ingredient_id: 4102 }, /ingredient 4102/i],
      ["no fecha", { fecha: undefined }, /fecha/],
      ["fecha without a time", { fecha: "2026-11-20" }, /fecha/],
      ["fecha with a T", { fecha: "2026-11-20T10:30:00" }, /fecha/],
      ["unreal fecha", { fecha: "2026-02-30 10:00:00" }, /fecha/],
      ["no storage_id", { storage_id: undefined }, /storage_id/],
    ];
    for (const [name, change, error] of CASES) {
      const { W, audit } = await load();
      const { post, api } = fakeApi();
      const r = await outcome(W.probarEscritura(ctx(api), { ...SUPPLY, ...change, variant: "documented", confirm: true } as any));
      expect(r, name).toHaveProperty("thrown");
      expect(r.thrown, name).toMatch(error);
      expect(post, name).not.toHaveBeenCalled();
      expect(audit().map((l) => JSON.parse(l).modo), name).toEqual(["rechazado"]);
    }
  });

  for (const [variant, { wire }] of Object.entries(SUPPLY_WIRE)) {
    it(`B8 ${variant}: a confirmed call sends exactly one POST through the transport, with the variant's encoding and the pinned body`, async () => {
      const { P, W } = await load();
      const { posts } = fakeFetch(() => new Response(JSON.stringify({ response: 4501 })));
      const { api } = transportApi(P);
      const r = (await W.probarEscritura(ctx(api), { ...SUPPLY, variant, confirm: true } as any)) as Obj;
      expect(r.modo).toBe("aplicado");
      expect(posts()).toHaveLength(1);
      const init = posts()[0];
      if (SUPPLY_WIRE[variant].encoding === "json") {
        expect(init.body).not.toBeInstanceOf(FormData);
        expect((init.headers as Obj)["Content-Type"]).toBe("application/json");
      } else {
        expect(init.body).toBeInstanceOf(FormData);
      }
      expect(wireOf(init)).toEqual(wire);
      expect(r.http_status).toBe(200);
    });
  }

  it("B9 legacy_unscaled sends what create_supply sends for quantity 1 at 0.01 with the same date and comment", async () => {
    const { P, W } = await load();
    const { posts } = fakeFetch(() => new Response(JSON.stringify({ response: 4501 })));
    const { api } = transportApi(P);
    await W.crearCompra(ctx(api), {
      cuenta: "shop-b", storage_id: 7, supplier_id: 21, fecha: FECHA, comentario: "write probe",
      renglones: [{ id: 4101, cantidad: 1, costo_unitario: 0.01 }], confirm: true,
    });
    await W.probarEscritura(ctx(api), { ...SUPPLY, variant: "legacy_unscaled", confirm: true } as any);
    const [supply, probe] = posts();
    expect(supply.body).toBeInstanceOf(FormData);
    expect(wireOf(probe)).toEqual(wireOf(supply));
  });

  it("B10 the read-back reads storage.getSupply only for a positive id in the reply and carries the read as returned", async () => {
    for (const response of [4501, "4502"]) {
      const { W } = await load();
      const { get, api } = fakeApi({ response });
      const r = (await W.probarEscritura(ctx(api), { ...SUPPLY, variant: "documented", confirm: true } as any)) as Obj;
      const reads = get.mock.calls.filter((c) => c[1] === "storage.getSupply");
      expect(reads.map((c) => c[2])).toEqual([{ supply_id: Number(response) }]);
      expect(r.verificacion.ok).toBe(true);
      expect(r.verificacion.detalle).toMatchObject({
        supply_id: String(response), date: FECHA, supply_sum: "1",
        ingredients: [{ ingredient_id: "4101", supply_ingredient_num: "1.0000000", supply_ingredient_sum: "1.00" }],
      });
      expect(JSON.stringify(r.verificacion)).not.toMatch(/unit|scale|centavo|kopeck/i);
    }
    for (const reply of [{ success: 1 }, { response: 0 }, { response: -3 }, { response: { id: 7 } }, { response: true }, { response: "7a" }, { response: 1.5 }]) {
      const { W } = await load();
      const { get, api } = fakeApi(reply);
      const r = (await W.probarEscritura(ctx(api), { ...SUPPLY, variant: "documented", confirm: true } as any)) as Obj;
      expect(get.mock.calls.filter((c) => c[1] === "storage.getSupply"), JSON.stringify(reply)).toHaveLength(0);
      expect(r.modo).toBe("aplicado");
      expect(r.verificacion.ok, JSON.stringify(reply)).toBe(false);
    }
    {
      const { W } = await load();
      const { api } = fakeApi({ response: 4501 }, { ...READS, "storage.getSupply": () => ({ supply_id: "4999" }) });
      const r = (await W.probarEscritura(ctx(api), { ...SUPPLY, variant: "documented", confirm: true } as any)) as Obj;
      expect(r.verificacion.ok).toBe(false);
    }
  });
});

describe("B outcomes after a POST: HTTP status and redacted reply", () => {
  const fragment = "QxR7Sample";
  const run = async (respond: () => Response | Promise<Response>) => {
    const L = await load();
    fakeFetch(respond);
    const { api } = transportApi(L.P);
    const r = await outcome(L.W.probarEscritura(ctx(api), { ...SUPPLY, variant: "documented", confirm: true } as any));
    return { r, ...L };
  };

  it("B11 applied carries the status and the reply, with a token in the reply redacted", async () => {
    const { r, audit, stdout } = await run(() => new Response(JSON.stringify({ response: 4501, note: `echo ${TOKEN_B}` }), { status: 200 }));
    expect(r.modo).toBe("aplicado");
    expect(r.http_status).toBe(200);
    expect(r.reply).toMatchObject({ response: 4501 });
    expect(r.reply.note).toContain("***");
    expect(JSON.stringify(r)).not.toContain(fragment);
    expect(audit().join("\n")).not.toContain(fragment);
    expect(stdout()).not.toContain(fragment);
  });

  it("B12 rejected carries the status and the redacted reply, for a 200 and a 400", async () => {
    for (const status of [200, 400]) {
      const { r, audit } = await run(() => new Response(JSON.stringify({ error: 32, message: `bad ${TOKEN_B}` }), { status }));
      expect(r.modo).toBe("rechazado");
      expect(r.http_status).toBe(status);
      expect(r.reply).toMatchObject({ error: 32 });
      expect(r.reply.message).toContain("***");
      expect(JSON.stringify(r)).not.toContain(fragment);
      expect(audit().map((l) => JSON.parse(l).modo)).toEqual(["rechazado"]);
    }
  });

  it("B13 unknown carries the status and the redacted reply: a 503, a 200 that is not JSON, a reply with no result, and a network failure with no status", async () => {
    const CASES: [string, () => Response | Promise<Response>, RegExp][] = [
      ["503 JSON", () => new Response(JSON.stringify({ error: `busy ${TOKEN_B}` }), { status: 503 }), /HTTP status: 503\./],
      ["200 HTML", () => new Response(`<html>${TOKEN_B}</html>`, { status: 200 }), /HTTP status: 200\./],
      ["200 {}", () => new Response("{}", { status: 200 }), /HTTP status: 200\. Reply: \{\}/],
      ["network", () => Promise.reject(new TypeError("fetch failed")), /HTTP status: none\./],
    ];
    for (const [name, respond, status] of CASES) {
      const { r, audit } = await run(respond);
      expect(r, name).toHaveProperty("thrown");
      expect(r.thrown, name).toMatch(status);
      expect(r.thrown, name).not.toContain(fragment);
      expect(audit().map((l) => JSON.parse(l).modo), name).toEqual(["desconocido"]);
      expect(audit().join("\n"), name).not.toContain(fragment);
    }
    {
      const { r } = await run(() => new Response(JSON.stringify({ response: false, note: `echo ${TOKEN_B}` }), { status: 200 }));
      expect(r.thrown).toMatch(/HTTP status: 200\. Reply: \{"response":false,"note":"echo \*\*\*"\}/);
    }
  });

  it("B14 other write tools' results are unchanged: no http_status or reply keys when applied or rejected", async () => {
    for (const body of [{ response: 31 }, { error: 32 }]) {
      const { P, W } = await load();
      fakeFetch(() => new Response(JSON.stringify(body)));
      const get = vi.fn(async (_c: string, _m: string) => [] as unknown);
      get.mockImplementationOnce(async () => []);
      const r = (await W.crearGrupoCliente(ctx({ get, post: P.posterHttp.post } as unknown as PosterApi), {
        cuenta: "shop-b", nombre: "Sample regulars", tipo: "descuento", porcentaje: 10, confirm: true,
      })) as Obj;
      expect(r.modo).toBe("error" in body ? "rechazado" : "aplicado");
      expect(r).not.toHaveProperty("http_status");
      expect(r).not.toHaveProperty("reply");
    }
  });
});

describe("B transaction_edit probe", () => {
  const TX = { cuenta: "shop-b", probe: "transaction_edit" as const, dia: DIA };

  it("B15 the dry-run reads the day's transactions as Ymd and pins each variant's JSON body", async () => {
    for (const [key, wire] of Object.entries(TX_WIRE)) {
      const [id, variant] = key.split(" ");
      const { W } = await load();
      const { get, post, api } = fakeApi();
      const r = (await W.probarEscritura(ctx(api), { ...TX, transaction_id: Number(id), variant } as any)) as Obj;
      expect(post, key).not.toHaveBeenCalled();
      expect(get.mock.calls.map((c) => [c[1], c[2]]), key).toEqual([["finance.getTransactions", { dateFrom: "20261118", dateTo: "20261118" }]]);
      expect(r, key).toMatchObject({ modo: "dry-run", probe: "transaction_edit", variant, metodo: "finance.updateTransactions", encoding: "json" });
      expect(r.wire_body, key).toBe(wire);
      expect(r.read_back, key).toMatch(/finance\.getTransactions/);
      expect(r.notices.join("\n"), key).toMatch(/nothing was sent/i);
    }
  });

  it("B16 refuses a missing or deleted row, a transfer, an amount above 100 kopecks and a comment without the marker, before any POST", async () => {
    const CASES: [string, Obj, RegExp][] = [
      ["missing row", { transaction_id: 9999 }, /not found/i],
      ["deleted row", { transaction_id: 9009 }, /not found/i],
      ["type 2", { transaction_id: 9004 }, /transfer/i],
      ["recipient_type 1", { transaction_id: 9005 }, /recipient_type "1"/],
      ["binding_type 1", { transaction_id: 9006 }, /binding_type "1"/],
      ["expense of 101", { transaction_id: 9003 }, /100/],
      ["income of 101", { transaction_id: 9008 }, /100/],
      ["no marker", { transaction_id: 9007 }, /probe/],
      ["bad dia", { transaction_id: 9001, dia: "2026-11-31" }, /dia/],
      ["no dia", { transaction_id: 9001, dia: undefined }, /dia/],
      ["no transaction_id", { transaction_id: undefined }, /transaction_id/],
    ];
    for (const [name, change, error] of CASES) {
      const { W, audit } = await load();
      const { post, api } = fakeApi();
      const r = await outcome(W.probarEscritura(ctx(api), { ...TX, ...change, variant: "amount_currency", confirm: true } as any));
      expect(r, name).toHaveProperty("thrown");
      expect(r.thrown, name).toMatch(error);
      expect(post, name).not.toHaveBeenCalled();
      expect(audit().map((l) => JSON.parse(l).modo), name).toEqual(["rechazado"]);
    }
  });

  it("B17 a confirmed call sends one JSON POST through the transport, then reads the same day's row back as read", async () => {
    const { P, W } = await load();
    const { posts } = fakeFetch(() => new Response(JSON.stringify({ response: 9001 })));
    const { get, api } = transportApi(P);
    const r = (await W.probarEscritura(ctx(api), { ...TX, transaction_id: 9001, variant: "amount_kopecks", confirm: true } as any)) as Obj;
    expect(posts()).toHaveLength(1);
    expect((posts()[0].headers as Obj)["Content-Type"]).toBe("application/json");
    expect(wireOf(posts()[0])).toBe(TX_WIRE["9001 amount_kopecks"]);
    expect(get.mock.calls.map((c) => [c[1], c[2]])).toEqual([
      ["finance.getTransactions", { dateFrom: "20261118", dateTo: "20261118" }],
      ["finance.getTransactions", { dateFrom: "20261118", dateTo: "20261118" }],
    ]);
    expect(r).toMatchObject({ modo: "aplicado", http_status: 200, reply: { response: 9001 } });
    expect(r.verificacion).toEqual({ ok: true, detalle: ROWS[0] });
  });

  it("B18 the read-back is not ok when the row no longer reads back", async () => {
    const { W } = await load();
    const get = fakeGet();
    get.mockImplementationOnce(async () => structuredClone(ROWS));
    get.mockImplementationOnce(async () => []);
    const post = vi.fn(async () => ({ response: 9001 }));
    const r = (await W.probarEscritura(ctx({ get, post } as unknown as PosterApi), { ...TX, transaction_id: 9001, variant: "amount_currency", confirm: true } as any)) as Obj;
    expect(r.modo).toBe("aplicado");
    expect(r.verificacion.ok).toBe(false);
  });

  it("B19 a variant or a field of the other probe is refused before any read", async () => {
    const CASES: Obj[] = [
      { ...SUPPLY, variant: "amount_currency" },
      { ...SUPPLY, variant: "documented", transaction_id: 9001 },
      { ...TX, transaction_id: 9001, variant: "documented" },
      { ...TX, transaction_id: 9001, variant: "amount_currency", storage_id: 7 },
      { ...TX, transaction_id: 9001, variant: "amount_currency", fecha: FECHA },
    ];
    for (const c of CASES) {
      const { W } = await load();
      const { get, post, api } = fakeApi();
      const r = await outcome(W.probarEscritura(ctx(api), { ...c, confirm: true } as any));
      expect(r, JSON.stringify(c)).toHaveProperty("thrown");
      expect(get, JSON.stringify(c)).not.toHaveBeenCalled();
      expect(post, JSON.stringify(c)).not.toHaveBeenCalled();
    }
  });
});

describe("B write gate", () => {
  it("B20 an account outside the write set is refused as for other writes, before any read or POST; permitir_otra_cuenta lets the dry-run through", async () => {
    for (const args of [{ ...SUPPLY, variant: "documented" }, { cuenta: "shop-b", probe: "transaction_edit", transaction_id: 9001, dia: DIA, variant: "amount_currency" }]) {
      const { W, audit } = await load();
      const { get, post, api } = fakeApi();
      const r = await outcome(W.probarEscritura(ctx(api), { ...args, cuenta: "shop-a", confirm: true } as any));
      expect(r).toHaveProperty("thrown");
      expect(r.thrown).toMatch(/shop-a/);
      expect(get).not.toHaveBeenCalled();
      expect(post).not.toHaveBeenCalled();
      expect(audit().map((l) => JSON.parse(l).modo)).toEqual(["rechazado"]);
      const ok = (await W.probarEscritura(ctx(api), { ...args, cuenta: "shop-a", permitir_otra_cuenta: true } as any)) as Obj;
      expect(ok.modo).toBe("dry-run");
    }
  });

  it("B21 through MCP with the switch on, the probe dry-runs and is audited under its name", async () => {
    const { M, audit } = await load({ EXPERIMENTAL_WRITE_PROBE: "1" });
    const { post, api } = fakeApi();
    const client = await connect(M, api);
    const r = await client.callTool({ name: PROBE, arguments: { ...SUPPLY, variant: "form_ingredient" } });
    expect(r.isError).not.toBe(true);
    const body = JSON.parse((r.content as Array<{ text: string }>)[0].text);
    expect(body).toMatchObject({ modo: "dry-run", probe: "supply", variant: "form_ingredient", encoding: "multipart" });
    expect(body.wire_body).toEqual(SUPPLY_WIRE.form_ingredient.wire);
    expect(post).not.toHaveBeenCalled();
    expect(audit().map((l) => JSON.parse(l))).toMatchObject([{ herramienta: PROBE, modo: "dry-run", metodo: "storage.createSupply" }]);
  });
});

describe("B transaction_edit target", () => {
  const TX = { cuenta: "shop-b", probe: "transaction_edit" as const, dia: DIA, variant: "amount_currency", confirm: true };
  /** A confirmed probe on row 9001 read with `o` over its defaults: the outcome and the POST mock. */
  const on = async (o: Obj) => {
    const { W } = await load();
    const { post, api } = fakeApi({ response: 9001 }, { ...READS, "finance.getTransactions": [row(9001, o)] });
    const r = await outcome(W.probarEscritura(ctx(api), { ...TX, transaction_id: 9001 } as any));
    return { r, post };
  };

  it("B22 the comment must read exactly 'write probe' once trimmed and case-folded; a comment that only contains the word is refused before any POST", async () => {
    for (const comment of ["Replacement temperature probe", "write probe test", "my write probe", "probe", "write  probe", "write-probe", "", undefined]) {
      const { r, post } = await on({ comment });
      expect(post, String(comment)).not.toHaveBeenCalled();
      expect(r.thrown, String(comment)).toMatch(/comment/);
    }
    for (const comment of ["write probe", "  Write Probe\n", "WRITE PROBE"]) {
      const { r, post } = await on({ comment });
      expect(r.thrown, comment).toBeUndefined();
      expect(post, comment).toHaveBeenCalledTimes(1);
    }
  });

  it("B23 a row whose binding_type or recipient_type is present and not 0 is refused before any POST; the error names the field and the value", async () => {
    const CASES: [string, unknown][] = [
      ["binding_type", "13"], ["binding_type", "12"], ["binding_type", "14"], ["binding_type", "1"], ["binding_type", "15"], ["binding_type", "11"],
      ["binding_type", 13], ["binding_type", "abc"], ["binding_type", ""],
      ["recipient_type", "12"], ["recipient_type", "1"], ["recipient_type", "15"], ["recipient_type", 12], ["recipient_type", "-1"],
    ];
    for (const [field, value] of CASES) {
      const name = `${field} ${JSON.stringify(value)}`;
      const { r, post } = await on({ [field]: value });
      expect(post, name).not.toHaveBeenCalled();
      expect(r.thrown, name).toContain(`${field} ${JSON.stringify(value)}`);
    }
  });

  it("B24 binding_type and recipient_type read as 0 or absent let the edit through", async () => {
    const CASES: Obj[] = [
      { binding_type: "0", recipient_type: "0" },
      { binding_type: 0, recipient_type: 0 },
      { binding_type: undefined, recipient_type: undefined },
      { binding_type: null, recipient_type: null },
    ];
    for (const o of CASES) {
      const { r, post } = await on(o);
      expect(r.thrown, JSON.stringify(o)).toBeUndefined();
      expect(post, JSON.stringify(o)).toHaveBeenCalledTimes(1);
    }
  });

  it("B25 refuses a type other than 0 or 1, a non-positive account, category or user id, and the same id read on another day, before any POST", async () => {
    const CASES: [string, Obj, RegExp][] = [
      ["type 3", { type: "3" }, /type other than 0/],
      ["type empty", { type: "" }, /type other than 0/],
      ["type -1", { type: "-1" }, /type other than 0/],
      ["account_id 0", { account_id: "0" }, /positive account_id/],
      ["account_id -3", { account_id: "-3" }, /positive account_id/],
      ["category_id 0", { category_id: "0" }, /positive account_id/],
      ["category_id empty", { category_id: "" }, /positive account_id/],
      ["user_id 0", { user_id: "0" }, /positive account_id/],
      ["user_id empty", { user_id: "" }, /positive account_id/],
      ["another day", { date: "2026-11-17 23:59:00" }, /date on 2026-11-18/],
      ["no date", { date: undefined }, /date on 2026-11-18/],
    ];
    for (const [name, o, error] of CASES) {
      const { r, post } = await on(o);
      expect(post, name).not.toHaveBeenCalled();
      expect(r.thrown, name).toMatch(error);
    }
  });

  it("B26 a row not found, before the edit or on the read-back, says it may be on another day and to check dia", async () => {
    const { W } = await load();
    const { post, api } = fakeApi();
    const r = await outcome(W.probarEscritura(ctx(api), { ...TX, transaction_id: 9999 } as any));
    expect(post).not.toHaveBeenCalled();
    expect(r.thrown).toMatch(/another day/);
    expect(r.thrown).toMatch(/\bdia\b/);
    const get = fakeGet();
    get.mockImplementationOnce(async () => structuredClone(ROWS));
    get.mockImplementationOnce(async () => []);
    const post2 = vi.fn(async () => ({ response: 9001 }));
    const done = await outcome(W.probarEscritura(ctx({ get, post: post2 } as unknown as PosterApi), { ...TX, transaction_id: 9001 } as any));
    expect(done.verificacion).toMatchObject({ ok: false, detalle: { transaction_id: 9001, found: false } });
    expect(done.verificacion?.detalle?.note).toMatch(/another day/);
    expect(done.verificacion?.detalle?.note).toMatch(/\bdia\b/);
  });
});

describe("B supply variant with the line inside supply", () => {
  it("B27 documented_nested puts the ingredient line inside supply, as the createSupply parameter table lists it, and is listed second", async () => {
    const { W, M } = await load({ EXPERIMENTAL_WRITE_PROBE: "1" });
    const ORDER = ["documented", "documented_nested", "documented_flat", "form_ingredient", "legacy_unscaled"];
    expect(W.PROBE_VARIANTS.slice(0, 5)).toEqual(ORDER);
    const { post, api } = fakeApi();
    const dry = await outcome(W.probarEscritura(ctx(api), { ...SUPPLY, variant: "documented_nested" } as any));
    expect(dry.thrown).toBeUndefined();
    expect(dry).toMatchObject({ modo: "dry-run", encoding: "json", wire_body: SUPPLY_WIRE.documented_nested.wire });
    expect(post).not.toHaveBeenCalled();
    const client = await connect(M, api);
    const tool = (await client.listTools()).tools.find((t) => t.name === PROBE);
    expect(tool?.description).toContain(ORDER.join(", "));
    expect(JSON.stringify(tool?.inputSchema)).toContain(`supply: ${ORDER.join(", ")}.`);
    await client.close();
  });
});

describe("B probe diagnostics", () => {
  const fragment = "QxR7Sample";
  const SECRET = "synthetic-upstream-value";
  /** A confirmed documented supply probe whose POST goes through the real transport to `respond`. */
  const run = async (respond: () => Response | Promise<Response>, reads: Obj = READS) => {
    const L = await load();
    const { posts } = fakeFetch(respond);
    const { api, get } = transportApi(L.P, reads);
    const r = await outcome(L.W.probarEscritura(ctx(api), { ...SUPPLY, variant: "documented", confirm: true } as any));
    return { r, posts, get, modos: () => L.audit().map((l) => JSON.parse(l).modo), ...L };
  };
  /** A group creation (not the probe) whose POST goes through the real transport. */
  const otherWrite = (L: { P: typeof import("../src/poster.js"); W: typeof import("../src/tools/escritura.js") }) => {
    const get = vi.fn(async () => [] as unknown);
    return outcome(L.W.crearGrupoCliente(ctx({ get, post: L.P.posterHttp.post } as unknown as PosterApi), {
      cuenta: "shop-b", nombre: "Sample regulars", tipo: "descuento", porcentaje: 10, confirm: true,
    }));
  };

  it("B28 the outcome does not depend on formatting the reply: a reply too deeply nested to format gives unknown, rejected or applied by its fields, after one POST", async () => {
    const deep = (head: string) => `{${head},"detail":${"[".repeat(16000)}0${"]".repeat(16000)}}`;
    const CASES: [string, string, string][] = [
      ["no result", deep('"response":false'), "desconocido"],
      ["error", deep('"error":32'), "rechazado"],
      ["result", deep('"response":4501'), "aplicado"],
    ];
    for (const [name, body, modo] of CASES) {
      const { r, posts, modos } = await run(() => new Response(body, { status: 200 }));
      expect(posts(), name).toHaveLength(1);
      expect(modos(), name).toEqual([modo]);
      if (modo === "desconocido") expect(r.thrown, name).toMatch(/HTTP status: 200\./);
      else expect(r, name).toMatchObject({ modo, http_status: 200, reply: "reply could not be formatted" });
    }
    // A reply that cannot even be classified after the POST is an unknown outcome, never a rejection.
    const { W, audit } = await load();
    const { api } = fakeApi(null as unknown as Obj);
    const r = await outcome(W.probarEscritura(ctx(api), { ...SUPPLY, variant: "documented", confirm: true } as any));
    expect(r.thrown).toMatch(/HTTP status: none\./);
    expect(audit().map((l) => JSON.parse(l).modo)).toEqual(["desconocido"]);
  });

  it("B29 the probe POST asks fetch not to follow redirects and other writes do not; a 3xx or status 0 reply is unknown with its status", async () => {
    {
      const { posts } = await run(() => new Response(JSON.stringify({ response: 4501 })));
      expect(posts()).toHaveLength(1);
      expect(posts()[0].redirect).toBe("manual");
    }
    {
      const L = await load();
      const { posts } = fakeFetch(() => new Response(JSON.stringify({ response: 9001 })));
      const { api } = transportApi(L.P);
      const r = await outcome(L.W.probarEscritura(ctx(api), {
        cuenta: "shop-b", probe: "transaction_edit", dia: DIA, transaction_id: 9001, variant: "amount_currency", confirm: true,
      } as any));
      expect(r.modo).toBe("aplicado");
      expect(posts()).toHaveLength(1);
      expect(posts()[0].redirect).toBe("manual");
    }
    {
      const L = await load();
      const { posts } = fakeFetch(() => new Response(JSON.stringify({ response: 31 })));
      expect((await otherWrite(L)).modo).toBe("aplicado");
      expect(posts()).toHaveLength(1);
      expect(posts()[0]).not.toHaveProperty("redirect");
    }
    const CASES: [number, string][] = [[302, '{"response":4501}'], [307, '{"response":4501}'], [308, ""], [0, '{"response":4501}'], [0, ""]];
    for (const [status, body] of CASES) {
      const name = `${status} ${body || "empty"}`;
      // Status 0 is what an opaque redirect reads as; a Response cannot be built with it, so a stand-in is used.
      const reply = status === 0 ? ({ status: 0, type: "opaqueredirect", headers: new Headers(), text: async () => body } as unknown as Response) : new Response(body, { status });
      const { r, modos, get } = await run(() => reply);
      expect(r.thrown, name).toContain(`HTTP status: ${status}.`);
      expect(modos(), name).toEqual(["desconocido"]);
      expect(get.mock.calls.filter((c) => c[1] === "storage.getSupply"), name).toHaveLength(0);
    }
  });

  it("B30 over a real 127.0.0.1 server, a 307 on the probe POST is not followed: its target is hit 0 times and the outcome is unknown with status 307; another write still follows it", async () => {
    const http = await import("node:http");
    let targetHits = 0;
    const server = http.createServer((req, res) => {
      req.resume();
      if (req.url?.startsWith("/target")) {
        targetHits++;
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"response":4501}');
        return;
      }
      res.writeHead(307, { location: "/target", "content-type": "application/json" });
      res.end('{"response":4501}');
    });
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    try {
      const port = (server.address() as { port: number }).port;
      const realFetch = globalThis.fetch;
      const L = await load();
      // Only the origin changes; the init built by the transport goes to fetch untouched.
      const swap = vi.fn((url: string | URL | Request, init?: RequestInit) => realFetch(String(url).replace(/^https:\/\/[^/]+/, `http://127.0.0.1:${port}`), init));
      vi.stubGlobal("fetch", swap);
      const { get, api } = transportApi(L.P);
      const r = await outcome(L.W.probarEscritura(ctx(api), { ...SUPPLY, variant: "documented", confirm: true } as any));
      expect(swap).toHaveBeenCalledTimes(1);
      expect(targetHits).toBe(0);
      expect(r.thrown).toContain("HTTP status: 307.");
      expect(L.audit().map((l) => JSON.parse(l).modo)).toEqual(["desconocido"]);
      expect(get.mock.calls.filter((c) => c[1] === "storage.getSupply")).toHaveLength(0);
      // Other writes keep following redirects, a known limitation: the same 307 sends a group creation to the target.
      await otherWrite(L);
      expect(targetHits).toBe(1);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });

  it("B31 an unknown probe outcome keeps the redacted reply up to 2000 characters in the status note, marked when clipped", async () => {
    const note = (thrown: string) => thrown.slice(thrown.indexOf(" HTTP status:"));
    {
      // The token crosses the 2000th character of the reply text: it is redacted before the reply is clipped.
      const { r } = await run(() => new Response(JSON.stringify({ response: false, note: `${"x".repeat(1960)} ${TOKEN_B} ${"y".repeat(3000)}` }), { status: 200 }));
      const n = note(r.thrown);
      expect(n).toMatch(/^ HTTP status: 200\. Reply: \{"response":false,"note":"x{1960} \*\*\* y+/);
      expect(n).toMatch(/clipped/);
      expect(r.thrown).not.toContain(fragment);
      expect(r.thrown).not.toContain("770055");
      const reply = n.slice(" HTTP status: 200. Reply: ".length);
      expect(reply.indexOf("y".repeat(5))).toBeGreaterThan(0);
      expect(reply.lastIndexOf("y") + 1).toBe(2000);
    }
    {
      const { r } = await run(() => new Response(JSON.stringify({ response: false, note: "short" }), { status: 200 }));
      expect(note(r.thrown)).toBe(' HTTP status: 200. Reply: {"response":false,"note":"short"}');
    }
  });

  it("B32 probe diagnostics mask values under credential-like keys in the reply, the error, the status note and the read-back rows; shared redaction is unchanged", async () => {
    const creds = { access_token: SECRET, client_secret: SECRET, Password: SECRET, passwd: SECRET, api_key: SECRET, ApiKey: SECRET, Authorization: SECRET, nested: { refresh_TOKEN: SECRET } };
    const supplyReads = { ...READS, "storage.getSupply": (p: Obj) => ({ supply_id: String(p.supply_id), date: FECHA, supply_sum: { api_key: SECRET, value: "1" }, ingredients: [] }) };
    const CASES: [string, Obj, string][] = [
      ["applied", { response: 4501, ...creds }, "aplicado"],
      ["rejected", { error: 32, ...creds }, "rechazado"],
      ["no result", { response: false, ...creds }, "desconocido"],
      ["no response", { ...creds }, "desconocido"],
    ];
    for (const [name, body, modo] of CASES) {
      const { r, modos } = await run(() => new Response(JSON.stringify(body), { status: 200 }), supplyReads);
      expect(modos(), name).toEqual([modo]);
      expect(JSON.stringify(r), name).not.toContain(SECRET);
      if (modo !== "desconocido") expect(r.reply, name).toMatchObject({ access_token: "***", Authorization: "***", nested: { refresh_TOKEN: "***" } });
      if (modo === "aplicado") expect(r.verificacion.detalle.supply_sum).toEqual({ api_key: "***", value: "1" });
    }
    const { W } = await load();
    const { api } = fakeApi({ response: 9001 }, { ...READS, "finance.getTransactions": [row(9001, { access_token: SECRET, secret_note: SECRET })] });
    const tx = (await W.probarEscritura(ctx(api), { cuenta: "shop-b", probe: "transaction_edit", dia: DIA, transaction_id: 9001, variant: "amount_currency", confirm: true } as any)) as Obj;
    expect(tx.verificacion.detalle).toMatchObject({ transaction_id: "9001", access_token: "***", secret_note: "***" });
    const T = await import("../src/tokens.js");
    expect(T.redactarEstructura({ access_token: SECRET })).toEqual({ access_token: SECRET });
  });

  it("B33 a write other than the probe, answered with no result, carries no HTTP status note", async () => {
    const L = await load();
    fakeFetch(() => new Response(JSON.stringify({ response: false })));
    const r = await otherWrite(L);
    expect(r.thrown).toContain("Poster returned no result");
    expect(r.thrown).not.toContain("HTTP status");
  });

  it("B34 a token in the supply read-back or in the transaction row read back is redacted", async () => {
    const reads = {
      ...READS,
      "storage.getSupply": (p: Obj) => ({ supply_id: String(p.supply_id), date: `${FECHA} ${TOKEN_B}`, supply_sum: TOKEN_A,
        ingredients: [{ ingredient_id: "4101", supply_ingredient_num: `token=${TOKEN_B}`, supply_ingredient_sum: "1.00" }] }),
      "finance.getTransactions": [row(9001, { extra: `echo ${TOKEN_B}`, [TOKEN_A]: "1" })],
    };
    const { W } = await load();
    const { api } = fakeApi({ response: 4501 }, reads);
    const sup = (await W.probarEscritura(ctx(api), { ...SUPPLY, variant: "documented", confirm: true } as any)) as Obj;
    const tx = (await W.probarEscritura(ctx(api), { cuenta: "shop-b", probe: "transaction_edit", dia: DIA, transaction_id: 9001, variant: "amount_currency", confirm: true } as any)) as Obj;
    expect(sup.verificacion.detalle.supply_id).toBe("4501");
    expect(tx.verificacion.detalle.transaction_id).toBe("9001");
    expect(JSON.stringify(sup)).not.toContain(fragment);
    expect(JSON.stringify(tx)).not.toContain(fragment);
  });
});
