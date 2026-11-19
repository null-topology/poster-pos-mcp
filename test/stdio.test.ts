// MCP_TRANSPORT=stdio: the setting, the audit line on stderr, and a real stdio client talking to a spawned server.
import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { cargarConfig } from "../src/config.js";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TOKEN_A = "9001:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TOKEN_B = "9002:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("MCP_TRANSPORT setting", () => {
  it("S1 unset or blank means http", () => {
    expect(cargarConfig({}).transport).toBe("http");
    expect(cargarConfig({ MCP_TRANSPORT: "" }).transport).toBe("http");
    expect(cargarConfig({ MCP_TRANSPORT: "  " }).transport).toBe("http");
  });

  it("S2 accepts exactly http or stdio", () => {
    expect(cargarConfig({ MCP_TRANSPORT: "http" }).transport).toBe("http");
    expect(cargarConfig({ MCP_TRANSPORT: "stdio" }).transport).toBe("stdio");
  });

  it("S3 any other value stops startup and names the variable", () => {
    for (const v of ["STDIO", " stdio", "stdio ", "sse", "pipe"]) {
      expect(() => cargarConfig({ MCP_TRANSPORT: v }), JSON.stringify(v)).toThrow(/^MCP_TRANSPORT: /);
    }
  });
});

describe("audit line with MCP_TRANSPORT=stdio", () => {
  async function auditarCon(transporte: string | undefined) {
    vi.stubEnv("MCP_TRANSPORT", transporte);
    vi.stubEnv("AUDIT_DIR", mkdtempSync(path.join(tmpdir(), "poster-mcp-stdio-audit-")));
    vi.resetModules();
    const salida = vi.spyOn(console, "log").mockImplementation(() => {});
    const errores = vi.spyOn(console, "error").mockImplementation(() => {});
    const { auditar } = await import("../src/audit.js");
    auditar({
      actor: "t",
      cuenta: "cafe-04",
      metodo: "clients.addGroup",
      herramienta: "create_client_group",
      modo: "dry-run",
      payload: { nombre: "x" },
    });
    const lineas = (spy: typeof salida) => spy.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('"audit":true'));
    return { stdout: lineas(salida), stderr: lineas(errores) };
  }

  it("S4 goes to stderr, never stdout, under stdio", async () => {
    const r = await auditarCon("stdio");
    expect(r.stdout).toEqual([]);
    expect(r.stderr).toHaveLength(1);
    expect(JSON.parse(r.stderr[0])).toMatchObject({ audit: true, herramienta: "create_client_group", modo: "dry-run" });
  });

  it("S5 stays on stdout under http", async () => {
    const r = await auditarCon(undefined);
    expect(r.stdout).toHaveLength(1);
    expect(r.stderr).toEqual([]);
  });
});

describe("stdio server process", () => {
  it("S6 a stdio client lists the tools and calls one, with no auth configured and nothing but MCP on stdout", async () => {
    const transporte = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", path.join(RAIZ, "src/server.ts")],
      cwd: RAIZ,
      stderr: "pipe",
      env: {
        PATH: process.env.PATH ?? "",
        MCP_TRANSPORT: "stdio",
        TOKEN_SOURCE: "env",
        POSTER_ACCOUNTS: "shop-a,shop-b",
        POSTER_TOKEN_SHOP_A: TOKEN_A,
        POSTER_TOKEN_SHOP_B: TOKEN_B,
        AUDIT_DIR: mkdtempSync(path.join(tmpdir(), "poster-mcp-stdio-proc-")),
      },
    });
    let stderr = "";
    transporte.stderr?.on("data", (d) => (stderr += String(d)));
    const errores: unknown[] = [];
    const cliente = new Client({ name: "stdio-test", version: "0.0.0" });
    cliente.onerror = (e) => errores.push(e);
    try {
      await cliente.connect(transporte);
      const { tools } = await cliente.listTools();
      expect(tools).toHaveLength(35);
      expect(tools.map((t) => t.name)).toContain("list_accounts");
      const r = await cliente.callTool({ name: "list_accounts", arguments: {} });
      const texto = (r.content as { type: string; text: string }[]).map((c) => c.text).join("");
      expect(texto).toContain("shop-a");
      expect(texto).toContain("shop-b");
      expect(texto).not.toContain(TOKEN_A);
    } finally {
      await cliente.close();
    }
    expect(errores).toEqual([]);
    expect(stderr).toContain("MCP por stdio · tokens=env");
    expect(stderr).not.toContain(TOKEN_A);
    expect(stderr).not.toContain(TOKEN_B);
  }, 30_000);
});
