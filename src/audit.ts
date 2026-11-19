// Auditoría de escrituras: quién, cuándo, cuenta, método, payload (sin token) y resultado.
// Cada evento va (1) a stdout como JSON (stderr with MCP_TRANSPORT=stdio) → Cloud Logging lo conserva en producción y
// (2) a un JSONL local por día en AUDIT_DIR (en Cloud Run es efímero; la fuente de verdad es Logging).
import { appendFileSync, mkdirSync, readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { redactar, redactarEstructura } from "./tokens.js";

export interface EventoAuditoria {
  ts: string;
  actor: string;
  cliente?: string;
  cuenta: string;
  metodo: string;
  herramienta: string;
  /** desconocido: the write may have been applied: its HTTP attempt failed after it started, Poster answered 5xx, or the reply had no error and no result. */
  modo: "dry-run" | "aplicado" | "rechazado" | "desconocido";
  payload: unknown;
  resultado?: unknown;
  error?: string;
}

/** Reads one field of the event as redacted text; a getter that throws gives "?". */
function campo(leer: () => unknown): string {
  try {
    return redactar(String(leer()));
  } catch {
    return "?";
  }
}

/** Line for an event that cannot be serialized: only the fields needed to find it, marked incomplete. */
function lineaMinima(ts: string, e: Omit<EventoAuditoria, "ts">): string {
  return JSON.stringify({
    ts,
    herramienta: campo(() => e.herramienta),
    cuenta: campo(() => e.cuenta),
    modo: campo(() => e.modo),
    error: "Entrada de auditoría incompleta: el evento no se pudo serializar.",
  });
}

const severidad = (modo: unknown) => (modo === "aplicado" ? "NOTICE" : modo === "desconocido" ? "WARNING" : "INFO");

/**
 * Logs the event to stdout and to the day's JSONL. Every string and every key is redacted by the shared
 * structural walk before the single serialization, so both lines are always valid JSON. An event that
 * does not serialize to a JSON object gets the minimal line. Never throws and returns nothing.
 */
export function auditar(e: Omit<EventoAuditoria, "ts">): void {
  const ts = new Date().toISOString();
  let linea: string | undefined;
  try {
    const texto = JSON.stringify(redactarEstructura({ ts, ...e }));
    // The stdout line splices this text after its own fields, so it must be a non-empty object.
    if (texto.startsWith('{"')) linea = texto;
  } catch {
    /* not serializable: the minimal line below */
  }
  linea ??= lineaMinima(ts, e);
  let modo: unknown;
  try {
    modo = e.modo;
  } catch {
    /* a throwing getter leaves the severity at INFO */
  }
  try {
    // With MCP_TRANSPORT=stdio stdout carries the MCP protocol, so the log line goes to stderr.
    (config.transport === "stdio" ? console.error : console.log)(`{"severity":"${severidad(modo)}","audit":true,${linea.slice(1)}`);
  } catch {
    /* stdout no disponible: queda el JSONL */
  }
  try {
    mkdirSync(config.auditDir, { recursive: true });
    appendFileSync(path.join(config.auditDir, `${ts.slice(0, 10)}.jsonl`), linea + "\n");
  } catch {
    /* disco de solo lectura: queda el log en stdout */
  }
}

/** Latest audit entries, newest first. A line that does not parse is skipped. */
export function auditoriaReciente(limite = 20): EventoAuditoria[] {
  if (!existsSync(config.auditDir)) return [];
  const archivos = readdirSync(config.auditDir).filter((f) => f.endsWith(".jsonl")).sort().reverse();
  const out: EventoAuditoria[] = [];
  for (const f of archivos) {
    const lineas = readFileSync(path.join(config.auditDir, f), "utf8").trim().split("\n").filter(Boolean).reverse();
    for (const l of lineas) {
      try {
        out.push(JSON.parse(l));
      } catch {
        continue;
      }
      if (out.length >= limite) return out;
    }
  }
  return out;
}
