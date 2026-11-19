// The local .env file fills only unset variables, and it is skipped under Vitest unless POSTER_LIVE=1,
// so a developer's settings cannot change the offline suite while the live suite still gets them.
// cargarDotenv is called with an explicit file and environment object: nothing here reads or writes
// the repository's own .env or process.env.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { cargarDotenv } from "../src/config.js";

const DIR = mkdtempSync(path.join(os.tmpdir(), "poster-mcp-dotenv-"));
const ARCHIVO = path.join(DIR, ".env");

beforeAll(() => {
  writeFileSync(ARCHIVO, `# comentario\nTOKEN_SOURCE=mysql\nOWNER_NAME="Ana"\nSERVICE_NAME=desde-archivo\n`);
});

afterAll(() => {
  rmSync(DIR, { recursive: true, force: true });
});

describe("cargarDotenv", () => {
  it("G1 under Vitest without POSTER_LIVE=1 the file is not loaded", () => {
    for (const entorno of [{ VITEST: "true" }, { VITEST: "true", POSTER_LIVE: "0" }, { VITEST: "true", POSTER_LIVE: "" }]) {
      const env: Record<string, string | undefined> = { ...entorno };
      cargarDotenv(ARCHIVO, env);
      expect(env, JSON.stringify(entorno)).toEqual(entorno);
    }
  });

  it("G2 under Vitest with POSTER_LIVE=1 the file is loaded and fills only unset variables", () => {
    const env: Record<string, string | undefined> = { VITEST: "true", POSTER_LIVE: "1", SERVICE_NAME: "del-entorno" };
    cargarDotenv(ARCHIVO, env);
    expect(env).toEqual({ VITEST: "true", POSTER_LIVE: "1", SERVICE_NAME: "del-entorno", TOKEN_SOURCE: "mysql", OWNER_NAME: "Ana" });
  });

  it("G3 outside Vitest the file is loaded and fills only unset variables", () => {
    const env: Record<string, string | undefined> = { SERVICE_NAME: "del-entorno" };
    cargarDotenv(ARCHIVO, env);
    expect(env).toEqual({ SERVICE_NAME: "del-entorno", TOKEN_SOURCE: "mysql", OWNER_NAME: "Ana" });
  });

  it("G5 an empty VITEST counts as outside Vitest: the file is loaded", () => {
    const env: Record<string, string | undefined> = { VITEST: "", SERVICE_NAME: "del-entorno" };
    cargarDotenv(ARCHIVO, env);
    expect(env).toEqual({ VITEST: "", SERVICE_NAME: "del-entorno", TOKEN_SOURCE: "mysql", OWNER_NAME: "Ana" });
  });

  it("G4 a missing file changes nothing", () => {
    const env: Record<string, string | undefined> = { POSTER_LIVE: "1" };
    cargarDotenv(path.join(DIR, "no-existe.env"), env);
    expect(env).toEqual({ POSTER_LIVE: "1" });
  });
});
