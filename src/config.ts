// Configuración central: lista blanca de cuentas, permisos de escritura y entorno.
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

type Entorno = Record<string, string | undefined>;

/**
 * Fills the variables of `env` that are not set yet from a local `.env` file (on Cloud Run the
 * variables come from the service and there is no file). Skipped under Vitest unless POSTER_LIVE=1:
 * a developer's local settings must not change the offline suite, while the live suite needs them.
 */
export function cargarDotenv(archivo: string, env: Entorno = process.env) {
  if (env.VITEST && env.POSTER_LIVE !== "1") return;
  if (!existsSync(archivo)) return;
  for (const linea of readFileSync(archivo, "utf8").split(/\r?\n/)) {
    if (!linea.includes("=") || linea.trimStart().startsWith("#")) continue;
    const k = linea.slice(0, linea.indexOf("=")).trim();
    const v = linea.slice(linea.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "");
    if (env[k] === undefined) env[k] = v;
  }
}

// Defaults of the runtime settings: with none of the variables set, the server behaves as before, except
// that two texts which said "RUSH" (a tool parameter description, the authorization page) now use the
// default NETWORK_NAME, "RUSH Café".
const DEFAULT_ACCOUNTS = Object.freeze(["cafe-01", "cafe-02", "cafe-03", "cafe-04", "cafe-05", "cafe-06", "cafe-07", "cafe-08", "cafe-09", "cafe-10"]);
const DEFAULT_WRITE_ACCOUNT = "cafe-04";
const DEFAULT_TIMEZONE = "America/Merida";
/** Place named in tool descriptions while the default zone is in use; any other zone is named as Intl resolves it. */
const DEFAULT_TIMEZONE_PLACE = "Carmen";
const DEFAULT_OWNER_NAME = "Roy";
const DEFAULT_NETWORK_NAME = "RUSH Café";
const DEFAULT_SERVICE_NAME = "poster-rush";
const DEFAULT_OAUTH_SUBJECT = "roy";

const ACCOUNT_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const SERVICE_NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;
const OAUTH_SUBJECT_RE = /^[A-Za-z0-9._@-]{1,64}$/;
const CONTROL_RE = /[\u0000-\u001F\u007F-\u009F]/;
/** Bidirectional formatting characters: they can make a name render differently from what it holds. */
const BIDI_RE = /[\u200E\u200F\u202A-\u202E\u2066-\u2069]/;
const NAME_MAX = 100;

// Error messages name the variable and the rule that failed and never quote a configured value: a
// value placed in the wrong variable may be a secret. Account-list entries are identified by their
// 1-based position. Nothing here logs.
const isBlank = (v: string) => v.trim() === "";
const splitList = (v: string) => v.split(",").map((s) => s.trim());

function parseAccounts(e: Entorno): readonly string[] {
  const v = e.POSTER_ACCOUNTS;
  if (v === undefined) return DEFAULT_ACCOUNTS;
  if (isBlank(v)) throw new Error("POSTER_ACCOUNTS está en blanco: define al menos una cuenta o quita la variable.");
  const cuentas: string[] = [];
  splitList(v).forEach((entrada, i) => {
    const pos = i + 1;
    if (!entrada) throw new Error(`POSTER_ACCOUNTS: la entrada ${pos} está vacía (revisa las comas).`);
    if (!ACCOUNT_RE.test(entrada)) {
      throw new Error(`POSTER_ACCOUNTS: la entrada ${pos} no es un subdominio válido (minúsculas, dígitos y guiones internos; de 1 a 63 caracteres).`);
    }
    const previa = cuentas.indexOf(entrada);
    if (previa >= 0) throw new Error(`POSTER_ACCOUNTS: la entrada ${pos} repite la entrada ${previa + 1}.`);
    cuentas.push(entrada);
  });
  return Object.freeze(cuentas);
}

function parseDefaultWriteAccount(e: Entorno, cuentas: readonly string[]): string | undefined {
  const v = e.DEFAULT_WRITE_ACCOUNT;
  if (v === undefined) return e.POSTER_ACCOUNTS === undefined ? DEFAULT_WRITE_ACCOUNT : undefined;
  const cuenta = v.trim();
  if (!cuenta) return undefined;
  if (!cuentas.includes(cuenta)) throw new Error("DEFAULT_WRITE_ACCOUNT: la cuenta no está en la lista de cuentas (POSTER_ACCOUNTS).");
  return cuenta;
}

function parseWriteDefault(e: Entorno, cuentas: readonly string[]): Set<string> {
  const v = e.WRITE_DEFAULT_ACCOUNTS ?? (e.POSTER_ACCOUNTS === undefined ? DEFAULT_WRITE_ACCOUNT : "");
  // Empty entries are ignored; positions count every comma-separated entry, empty ones included.
  const entradas = splitList(v);
  entradas.forEach((cuenta, i) => {
    if (cuenta && !cuentas.includes(cuenta)) {
      throw new Error(`WRITE_DEFAULT_ACCOUNTS: la entrada ${i + 1} no está en la lista de cuentas (POSTER_ACCOUNTS).`);
    }
  });
  // Kept in account-list order, so the order of the variable has no effect anywhere.
  return new Set(cuentas.filter((c) => entradas.includes(c)));
}

/** Validates TIMEZONE and returns the zone as Intl resolves it, so letter case does not matter. */
function parseTimezone(e: Entorno): string {
  const zona = e.TIMEZONE?.trim();
  if (!zona) return DEFAULT_TIMEZONE;
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: zona }).resolvedOptions().timeZone;
  } catch {
    throw new Error(`TIMEZONE: no es una zona horaria que Intl.DateTimeFormat acepte (por ejemplo ${DEFAULT_TIMEZONE}).`);
  }
}

function parseName(e: Entorno, variable: "OWNER_NAME" | "NETWORK_NAME", def: string): string {
  const v = e[variable];
  if (v === undefined || isBlank(v)) return def;
  if (CONTROL_RE.test(v)) throw new Error(`${variable}: no puede contener caracteres de control.`);
  if (BIDI_RE.test(v)) throw new Error(`${variable}: no puede contener caracteres de formato bidireccional.`);
  const nombre = v.trim();
  if ([...nombre].length > NAME_MAX) throw new Error(`${variable}: admite como máximo ${NAME_MAX} caracteres.`);
  return nombre;
}

/** The raw value must match: it is not trimmed, so a blank or padded value fails. */
function parseIdentifier(e: Entorno, variable: "SERVICE_NAME" | "OAUTH_SUBJECT", def: string, re: RegExp, regla: string): string {
  const v = e[variable];
  if (v === undefined) return def;
  if (!re.test(v)) throw new Error(`${variable}: valor no válido (${regla}; sin espacios alrededor).`);
  return v;
}

type FuenteTokens = "gsm" | "mysql" | "env";

/** Blank means gsm; otherwise exactly "gsm", "mysql" or "env", not trimmed. */
function parseTokenSource(e: Entorno): FuenteTokens {
  const v = e.TOKEN_SOURCE;
  if (v === undefined || isBlank(v)) return "gsm";
  if (v === "gsm" || v === "mysql" || v === "env") return v;
  throw new Error('TOKEN_SOURCE: valor no válido; usa exactamente "gsm", "mysql" o "env" (sin espacios).');
}

type Transporte = "http" | "stdio";

/** Blank means http; otherwise exactly "http" or "stdio", not trimmed. */
function parseTransport(e: Entorno): Transporte {
  const v = e.MCP_TRANSPORT;
  if (v === undefined || isBlank(v)) return "http";
  if (v === "http" || v === "stdio") return v;
  throw new Error('MCP_TRANSPORT: valor no válido; usa exactamente "http" o "stdio" (sin espacios).');
}

/** Unset or blank means off; exactly "1" means on. Any other value stops startup; the error does not repeat it. */
function parseWriteProbe(e: Entorno): boolean {
  const v = e.EXPERIMENTAL_WRITE_PROBE;
  if (v === undefined || isBlank(v)) return false;
  if (v === "1") return true;
  throw new Error('EXPERIMENTAL_WRITE_PROBE: invalid value; set it to exactly "1" to turn the experimental write probe on, or leave it unset.');
}

/** Variable holding an account's Poster token with TOKEN_SOURCE=env: cafe-04 → POSTER_TOKEN_CAFE_04. */
export const variableToken = (cuenta: string) => `POSTER_TOKEN_${cuenta.toUpperCase().replace(/-/g, "_")}`;

/**
 * Format of a trimmed env token (Poster tokens look like `<account id>:<hex>`). Whitespace, control
 * characters, quotes, backslashes, `%`, `&` and `=` are outside it, which keeps every token
 * recognizable for redaction in every representation the server produces.
 */
const TOKEN_FORMATO_RE = /^[A-Za-z0-9:._~-]{16,}$/;

/**
 * With TOKEN_SOURCE=env, every listed account needs POSTER_TOKEN_<ACCOUNT>. Each value is trimmed; a
 * missing or blank one, or one outside TOKEN_FORMATO_RE, fails. The error names every failing
 * variable and never a value. Other sources ignore these variables (empty map).
 */
function parseEnvTokens(e: Entorno, fuente: FuenteTokens, accounts: readonly string[]): ReadonlyMap<string, string> {
  const tokens = new Map<string, string>();
  if (fuente !== "env") return tokens;
  const faltan: string[] = [];
  const invalidas: string[] = [];
  for (const cuenta of accounts) {
    const variable = variableToken(cuenta);
    const valor = e[variable]?.trim();
    if (!valor) faltan.push(variable);
    else if (!TOKEN_FORMATO_RE.test(valor)) invalidas.push(variable);
    else tokens.set(cuenta, valor);
  }
  if (faltan.length > 0 || invalidas.length > 0) {
    const partes: string[] = [];
    if (faltan.length > 0) partes.push(`faltan o están en blanco: ${faltan.join(", ")}`);
    if (invalidas.length > 0) {
      partes.push(
        `no tienen el formato de un token (al menos 16 caracteres, solo letras ASCII, dígitos y los signos : . _ ~ -): ${invalidas.join(", ")}`,
      );
    }
    throw new Error(`POSTER_TOKEN_*: con TOKEN_SOURCE=env cada cuenta de la lista necesita su token; ${partes.join("; ")}.`);
  }
  return tokens;
}

/**
 * POSTER_MYSQL_URL: blank means unset. With TOKEN_SOURCE=mysql a value that `new URL()` cannot
 * parse fails startup; the parse error carries the raw value, so it is replaced, never chained.
 */
function parseMysqlUrl(e: Entorno, fuente: FuenteTokens): string | undefined {
  const url = e.POSTER_MYSQL_URL?.trim() || undefined;
  if (url === undefined || fuente !== "mysql") return url;
  let valida = true;
  try {
    new URL(url);
  } catch {
    valida = false;
  }
  if (!valida) throw new Error("POSTER_MYSQL_URL: no es una URL válida (mysql://usuario:clave@host:puerto/base).");
  return url;
}

/**
 * Builds and validates the whole configuration from an environment object. Pure: reads no files and
 * logs nothing; throws on invalid input so startup fails fast.
 */
export function cargarConfig(e: Entorno) {
  const env = (k: string, def = "") => e[k] ?? def;
  const accounts = parseAccounts(e);
  const timezone = parseTimezone(e);
  const tokenSource = parseTokenSource(e);
  return {
    raiz: RAIZ,
    /** MCP transport (MCP_TRANSPORT): http serves /mcp on PORT; stdio speaks MCP on stdin/stdout and needs no auth. */
    transport: parseTransport(e),
    /** Registers the experimental_write_probe tool (EXPERIMENTAL_WRITE_PROBE=1); off by default. */
    experimentalWriteProbe: parseWriteProbe(e),
    port: Number(env("PORT", "3210")),
    publicBaseUrl: env("PUBLIC_BASE_URL", `http://localhost:${env("PORT", "3210")}`).replace(/\/$/, ""),
    tokenSource,
    /** Used only with TOKEN_SOURCE=mysql; when unset, the DATABASE_URL line of FINANZAS_ENV_PATH is read at the first lookup. */
    posterMysqlUrl: parseMysqlUrl(e, tokenSource),
    /** Poster token per listed account with TOKEN_SOURCE=env (POSTER_TOKEN_<ACCOUNT>); empty with gsm and mysql. */
    envTokens: parseEnvTokens(e, tokenSource, accounts),
    finanzasEnvPath: path.resolve(RAIZ, env("FINANZAS_ENV_PATH", "../erp-core/services/finanzas-pro/.env")),
    gcpProjectId: env("GCP_PROJECT_ID"),
    secretPrefix: env("SECRET_PREFIX", "poster-token-"),
    /** Account allow-list (POSTER_ACCOUNTS). */
    accounts,
    /** Account a write tool targets when the call omits `cuenta`; undefined = `cuenta` is required. */
    defaultWriteAccount: parseDefaultWriteAccount(e, accounts),
    /** Accounts writable without `permitir_otra_cuenta: true` (WRITE_DEFAULT_ACCOUNTS). */
    writeDefault: parseWriteDefault(e, accounts),
    timezone,
    timezonePlace: timezone === DEFAULT_TIMEZONE ? DEFAULT_TIMEZONE_PLACE : undefined,
    ownerName: parseName(e, "OWNER_NAME", DEFAULT_OWNER_NAME),
    networkName: parseName(e, "NETWORK_NAME", DEFAULT_NETWORK_NAME),
    serviceName: parseIdentifier(e, "SERVICE_NAME", DEFAULT_SERVICE_NAME, SERVICE_NAME_RE, "letras, dígitos, punto, guion y guion bajo; de 1 a 64 caracteres"),
    oauthSubject: parseIdentifier(e, "OAUTH_SUBJECT", DEFAULT_OAUTH_SUBJECT, OAUTH_SUBJECT_RE, "letras, dígitos, punto, guion, guion bajo y @; de 1 a 64 caracteres"),
    bearerToken: env("MCP_BEARER_TOKEN"),
    oauthSigningKey: env("OAUTH_SIGNING_KEY"),
    ownerPassphrase: env("OWNER_PASSPHRASE"),
    oauthAllowedRedirects: env("OAUTH_ALLOWED_REDIRECTS", "https://claude.ai/api/mcp/auth_callback,https://claude.com/api/mcp/auth_callback")
      .split(",").map((s) => s.trim()).filter(Boolean),
    auditDir: path.resolve(RAIZ, env("AUDIT_DIR", "./audit")),
  };
}
export type Config = ReturnType<typeof cargarConfig>;

cargarDotenv(path.join(RAIZ, ".env"));
export const config: Config = cargarConfig(process.env);

/** Cuentas Póster de la lista blanca (POSTER_ACCOUNTS). Nada fuera de esta lista se toca, ni en lectura. */
export const CUENTAS: readonly string[] = config.accounts;
export type Cuenta = string;

export function esCuenta(c: string): c is Cuenta {
  return CUENTAS.includes(c);
}

/**
 * Regla de escritura: la cuenta debe estar en la lista blanca; si no está en WRITE_DEFAULT_ACCOUNTS
 * la llamada tiene que traer `permitir_otra_cuenta: true`.
 */
export function verificarEscritura(cuenta: string, permitirOtra: boolean | undefined): void {
  if (!esCuenta(cuenta)) throw new Error(`Cuenta "${cuenta}" fuera de la lista blanca.`);
  if (config.writeDefault.has(cuenta)) return;
  if (permitirOtra === true) return;
  const permitidas = [...config.writeDefault];
  const regla = permitidas.length ? `solo ${permitidas.join(", ")} se escribe por defecto. Para otra cuenta` : "ninguna cuenta se escribe por defecto. Para escribir en ella";
  throw new Error(
    `Escritura en "${cuenta}" bloqueada: ${regla}, ` +
      `${config.ownerName} debe autorizarla explícitamente y la llamada debe incluir permitir_otra_cuenta: true.`,
  );
}
