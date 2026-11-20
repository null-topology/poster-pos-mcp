// Cliente HTTP mínimo de la API Póster: https://<cuenta>.joinposter.com/api/<metodo>?token=
import { tokenDe, redactar } from "./tokens.js";

export type PosterRespuesta<T = unknown> = { response?: T; success?: number; error?: unknown; message?: string };

export interface PosterApi {
  get<T = unknown>(cuenta: string, metodo: string, params?: Record<string, string | number>): Promise<T>;
  /** `onStatus` gets the HTTP status of the reply as soon as its headers arrive; a request that fails before that has none. */
  post<T = unknown>(cuenta: string, metodo: string, cuerpo: unknown, opciones?: { form?: boolean; onStatus?: (status: number) => void }): Promise<PosterRespuesta<T>>;
}

/** The multipart fields of a form body, in order: a string value as it is, any other value as JSON text. */
export function formFields(cuerpo: Record<string, unknown>): Array<[string, string]> {
  return Object.entries(cuerpo).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)]);
}

/**
 * The outcome of a write is unknown: its HTTP attempt failed after fetch was called (network error,
 * timeout, a reply that is not JSON, or a reply with HTTP status 500 or higher whatever its body), or
 * the reply has no error and no result. The request may have reached Poster, so the write may have
 * been applied.
 */
export class EscrituraIncierta extends Error {
  constructor(mensaje: string) {
    super(mensaje);
    this.name = "EscrituraIncierta";
  }
}

const espera = (ms: number) => new Promise((r) => setTimeout(r, ms));
const METODO_OK = /^[a-zA-Z]+\.[a-zA-Z0-9]+$/;

/** A Poster reply that parsed as JSON, with its HTTP status. */
interface Respuesta {
  estado: number;
  cuerpo: PosterRespuesta;
}

async function pedir(url: string, init: RequestInit, intentos: number, alEstado?: (estado: number) => void): Promise<Respuesta> {
  let ultimo = "";
  for (let i = 0; i < intentos; i++) {
    // Status of this attempt once its headers arrived; a failure before that has none.
    let estado: number | undefined;
    try {
      const r = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
      estado = r.status;
      alEstado?.(r.status);
      const t = await r.text();
      // Redacted before clipping, so a token across the limit leaves no prefix.
      const extracto = () => redactar(t).slice(0, 120);
      if (t.trim().startsWith("{") || t.trim().startsWith("[")) {
        try {
          return { estado: r.status, cuerpo: JSON.parse(t) };
        } catch {
          // The parser's message quotes a clipped piece of the body, which may hold a token prefix.
          ultimo = `HTTP ${r.status}: JSON inválido: ${extracto()}`;
        }
      } else {
        // Póster a veces devuelve HTML de error/limitación: se reintenta
        ultimo = `HTTP ${r.status}: ${extracto()}`;
      }
    } catch (e) {
      const motivo = String((e as Error).message ?? e);
      // A body that fails to read after the headers keeps the status of this attempt in the diagnostic.
      ultimo = estado === undefined ? motivo : `HTTP ${estado}: ${motivo}`;
    }
    await espera(800 * (i + 1));
  }
  throw new Error(redactar(`Póster sin respuesta JSON: ${ultimo}`));
}

/** A Poster reply as JSON text, redacted before it is clipped so a token across the limit leaves no prefix. */
export function resumenPoster(r: unknown): string {
  return redactar(JSON.stringify(r) ?? String(r)).slice(0, 300);
}

export function errorPoster(r: PosterRespuesta): string | null {
  if (r.error !== undefined && r.error !== null && r.error !== 0) return resumenPoster(r);
  return null;
}

export const posterHttp: PosterApi = {
  async get(cuenta, metodo, params = {}) {
    if (!METODO_OK.test(metodo)) throw new Error(`Método inválido: ${metodo}`);
    const token = await tokenDe(cuenta);
    const qs = new URLSearchParams({ format: "json", ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])) });
    const { cuerpo: r } = await pedir(`https://${cuenta}.joinposter.com/api/${metodo}?token=${encodeURIComponent(token)}&${qs}`, {}, 5);
    const e = errorPoster(r);
    if (e) throw new Error(`${metodo}: ${e}`);
    return r.response as never;
  },
  async post(cuenta, metodo, cuerpo, opciones = {}) {
    if (!METODO_OK.test(metodo)) throw new Error(`Método inválido: ${metodo}`);
    const token = await tokenDe(cuenta);
    const url = `https://${cuenta}.joinposter.com/api/${metodo}?token=${encodeURIComponent(token)}`;
    let init: RequestInit;
    if (opciones.form) {
      const f = new FormData();
      for (const [k, v] of formFields(cuerpo as Record<string, unknown>)) f.append(k, v);
      init = { method: "POST", body: f };
    } else {
      init = { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(cuerpo) };
    }
    // Escrituras: un solo intento por si Póster sí aplicó y solo tardó en responder (evita duplicados).
    // pedir has called fetch by the time it fails, so the outcome of the write is unknown.
    let r: Respuesta;
    try {
      r = await pedir(url, init, 1, opciones.onStatus);
    } catch (e) {
      throw new EscrituraIncierta(String((e as Error)?.message ?? e));
    }
    // A server error does not prove the write was not applied, whatever its body says. The summary of the
    // body is best effort: a body it cannot format still gives EscrituraIncierta, without the summary.
    if (r.estado >= 500) {
      let resumen = "";
      try {
        resumen = `: ${resumenPoster(r.cuerpo)}`;
      } catch {
        // The body cannot be formatted; the message goes without it.
      }
      throw new EscrituraIncierta(`Póster respondió HTTP ${r.estado}${resumen}`);
    }
    return r.cuerpo as never;
  },
};
