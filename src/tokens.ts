// Origen de tokens Póster. Nunca se registran ni se devuelven: solo los usa el cliente HTTP.
//   gsm   → Google Secret Manager, secreto `<SECRET_PREFIX><cuenta en minúsculas>` (versión latest)
//   mysql → tabla poster_accounts de la DB local de erp-core (solo para dev en la Mac)
//   env   → variable POSTER_TOKEN_<CUENTA>, validada al arrancar; sin GCP ni MySQL, cambia solo al reiniciar
import { readFileSync } from "node:fs";
import { config, esCuenta, variableToken, type Cuenta } from "./config.js";

const cache = new Map<Cuenta, { token: string; hasta: number }>();
const TTL_MS = 10 * 60 * 1000;

/** Nombre del secreto en GSM. Los IDs de secreto no aceptan mayúsculas raras, se normaliza. */
export const nombreSecreto = (cuenta: Cuenta) => `${config.secretPrefix}${cuenta.toLowerCase()}`;

async function desdeGsm(cuenta: Cuenta): Promise<string> {
  if (!config.gcpProjectId) throw new Error("GCP_PROJECT_ID no configurado");
  const { SecretManagerServiceClient } = await import("@google-cloud/secret-manager");
  const cliente = new SecretManagerServiceClient();
  const [v] = await cliente.accessSecretVersion({
    name: `projects/${config.gcpProjectId}/secrets/${nombreSecreto(cuenta)}/versions/latest`,
  });
  const t = v.payload?.data?.toString().trim();
  if (!t) throw new Error(`Secreto vacío para ${cuenta}`);
  return t;
}

/** MySQL connection URL and the name of where it came from; errors name the source, never the URL. */
let origenMysql: { url: string; fuente: string } | null = null;
function urlMysql(): { url: string; fuente: string } {
  if (origenMysql) return origenMysql;
  // POSTER_MYSQL_URL replaces the file; without it the file is read at the first lookup.
  // A generic DATABASE_URL in the environment is deliberately not used.
  if (config.posterMysqlUrl) return (origenMysql = { url: config.posterMysqlUrl, fuente: "POSTER_MYSQL_URL" });
  const linea = readFileSync(config.finanzasEnvPath, "utf8").split(/\r?\n/).find((l) => l.startsWith("DATABASE_URL="));
  if (!linea) throw new Error("DATABASE_URL no encontrado en FINANZAS_ENV_PATH");
  const url = linea.slice("DATABASE_URL=".length).trim().replace(/^["']|["']$/g, "");
  const origen = { url, fuente: "la línea DATABASE_URL de FINANZAS_ENV_PATH" };
  // An empty value is not cached, so the next lookup reads the file again and a corrected line is
  // picked up without a restart. A non-empty value is cached, right or wrong.
  if (url) origenMysql = origen;
  return origen;
}

/**
 * Replaces a MySQL driver error (URL parsing, connection, query) with a fresh one that names only the
 * source and, when it is an uppercase identifier, the original code. The original carries the URL in
 * its message, `input` or `cause`, so it is neither chained nor copied.
 */
function errorMysql(fuente: string, e: unknown): Error {
  const code = (e as { code?: unknown } | null)?.code;
  const conCodigo = typeof code === "string" && /^[A-Z][A-Z0-9_]*$/.test(code) ? ` (${code})` : "";
  return new Error(`MySQL: falló la conexión o la consulta con ${fuente}${conCodigo}.`);
}

async function desdeMysql(cuenta: Cuenta): Promise<string> {
  const { url, fuente } = urlMysql();
  const mysql = await import("mysql2/promise");
  let filas: unknown;
  try {
    const c = await mysql.createConnection(url);
    try {
      [filas] = await c.execute("SELECT apiToken FROM poster_accounts WHERE accountId = ? AND status = 'active'", [cuenta]);
    } finally {
      await c.end();
    }
  } catch (e) {
    throw errorMysql(fuente, e);
  }
  // Domain error, outside the sanitized region: it keeps its message.
  const t = (filas as Array<{ apiToken: string }>)[0]?.apiToken?.trim();
  if (!t) throw new Error(`Sin token activo para ${cuenta} en poster_accounts`);
  return t;
}

export async function tokenDe(cuenta: string): Promise<string> {
  if (!esCuenta(cuenta)) throw new Error(`Cuenta "${cuenta}" fuera de la lista blanca.`);
  if (config.tokenSource === "env") {
    // Validados al arrancar para cada cuenta de la lista: no hay cache ni importación de GSM o MySQL.
    const t = config.envTokens.get(cuenta);
    if (!t) throw new Error(`Sin token para ${cuenta} en ${variableToken(cuenta)}`);
    return t;
  }
  const hit = cache.get(cuenta);
  if (hit && hit.hasta > Date.now()) return hit.token;
  const token = config.tokenSource === "mysql" ? await desdeMysql(cuenta) : await desdeGsm(cuenta);
  cache.set(cuenta, { token, hasta: Date.now() + TTL_MS });
  return token;
}

/**
 * Forms a known token can take in a text: literal, URL-encoded (with uppercase and with lowercase hex
 * digits in its %XX escapes; the token's own characters keep their case) and escaped inside a JSON string.
 */
const formas = (token: string) => {
  const codificado = encodeURIComponent(token);
  return [token, codificado, codificado.replace(/%[0-9A-F]{2}/g, (e) => e.toLowerCase()), JSON.stringify(token).slice(1, -1)];
};

/**
 * Redactor for the tokens known now. Every form of every known token is matched in one pass over the
 * original text, longest first, so a token that contains or is a prefix of another leaves no fragment.
 * Two tokens that cross (one starts inside the other and ends beyond it) are not guaranteed to be fully
 * removed. The `token=` pattern runs after. The pattern is compiled once here and reused for every text.
 */
function redactor(): (texto: string) => string {
  const conocidas = new Set<string>();
  // Con TOKEN_SOURCE=env, todos los tokens desde el arranque, aunque su cuenta no se haya consultado.
  for (const token of config.envTokens.values()) for (const f of formas(token)) conocidas.add(f);
  for (const { token } of cache.values()) if (token) for (const f of formas(token)) conocidas.add(f);
  const patron = conocidas.size
    ? new RegExp(
        [...conocidas]
          .sort((a, b) => b.length - a.length)
          .map((f) => f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
          .join("|"),
        "g",
      )
    : null;
  return (texto) => {
    const s = patron ? texto.replace(patron, "***") : texto;
    // Stops at a backslash too: in serialized JSON it starts an escape, and eating it breaks the JSON.
    return s.replace(/token=[^&\s"'\\]+/gi, "token=***");
  };
}

/** Quita cualquier token conocido de un texto (mensajes de error, extractos de respuestas de Póster). */
export function redactar(texto: string): string {
  return redactor()(texto);
}

/**
 * Copy of `v` with every string and every object key redacted, for a single serialization afterwards.
 * The value is first normalized with one JSON round trip (applies `toJSON`, drops `undefined`; a
 * top-level `undefined` becomes `null`). A number whose text is exactly a known token made only of
 * digits, at least 16 of them, becomes the string "***"; every other number, booleans and `null` are
 * never changed. Keys of one object that redact to the same text are all kept: the later ones get
 * " (2)", " (3)", ... A circular value or a BigInt throws the TypeError of `JSON.stringify`.
 */
export function redactarEstructura(v: unknown): unknown {
  const r = redactor();
  // Same sources as the redactor: every env token and every cached token.
  const numericos = new Set<string>();
  for (const token of [...config.envTokens.values(), ...[...cache.values()].map((c) => c.token)]) {
    if (/^[0-9]{16,}$/.test(token)) numericos.add(token);
  }
  const recorrer = (x: unknown): unknown => {
    if (typeof x === "string") return r(x);
    if (typeof x === "number") return numericos.has(String(x)) ? "***" : x;
    if (x === null || typeof x !== "object") return x;
    if (Array.isArray(x)) return x.map(recorrer);
    const usadas = new Set<string>();
    const pares: [string, unknown][] = [];
    for (const [k, valor] of Object.entries(x)) {
      const base = r(k);
      let clave = base;
      for (let n = 2; usadas.has(clave); n++) clave = `${base} (${n})`;
      usadas.add(clave);
      pares.push([clave, recorrer(valor)]);
    }
    return Object.fromEntries(pares);
  };
  return recorrer(JSON.parse(JSON.stringify(v) ?? "null"));
}
