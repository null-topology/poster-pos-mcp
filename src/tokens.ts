// Origen de tokens Póster. Nunca se registran ni se devuelven: solo los usa el cliente HTTP.
//   gsm   → Google Secret Manager, secreto `<SECRET_PREFIX><cuenta en minúsculas>` (versión latest)
//   mysql → tabla poster_accounts de la DB local de erp-core (solo para dev en la Mac)
import { readFileSync } from "node:fs";
import { config, esCuenta, type Cuenta } from "./config.js";

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
  const hit = cache.get(cuenta);
  if (hit && hit.hasta > Date.now()) return hit.token;
  const token = config.tokenSource === "mysql" ? await desdeMysql(cuenta) : await desdeGsm(cuenta);
  cache.set(cuenta, { token, hasta: Date.now() + TTL_MS });
  return token;
}

/** Quita cualquier token conocido de un texto (mensajes de error, payloads de auditoría). */
export function redactar(texto: string): string {
  let s = texto.replace(/token=[^&\s"']+/gi, "token=***");
  for (const { token } of cache.values()) if (token) s = s.split(token).join("***");
  return s;
}
