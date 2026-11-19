// Registro de herramientas en el servidor MCP.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { config, CUENTAS } from "./config.js";
import { posterHttp, type PosterApi } from "./poster.js";
import { auditoriaReciente } from "./audit.js";
import { redactar, redactarEstructura } from "./tokens.js";
import * as L from "./tools/lectura.js";
import * as W from "./tools/escritura.js";

// Names, accounts and the timezone in these texts come from the configuration (src/config.ts).
const { ownerName, networkName, defaultWriteAccount } = config;
/** Accounts writable without permitir_otra_cuenta, in account-list order. */
const escribibles = [...config.writeDefault].join(", ");
const horaLocal = config.timezonePlace ?? config.timezone;
const horaLocalConZona = config.timezonePlace ? `${config.timezonePlace} (${config.timezone})` : config.timezone;

const cuenta = z.enum(CUENTAS).describe(`Cuenta Póster de la red ${networkName}`);
// Without DEFAULT_WRITE_ACCOUNT, every write tool requires `cuenta`. A target outside
// WRITE_DEFAULT_ACCOUNTS is allowed, but writes to it still need permitir_otra_cuenta: true.
const cuentaEscritura =
  defaultWriteAccount === undefined
    ? z.enum(CUENTAS).describe("Cuenta destino (obligatoria: no hay cuenta por defecto)")
    : z
        .enum(CUENTAS)
        .default(defaultWriteAccount)
        .describe(
          config.writeDefault.has(defaultWriteAccount)
            ? `Cuenta destino (por defecto ${defaultWriteAccount})`
            : `Cuenta destino (por defecto ${defaultWriteAccount}; escribir en ella requiere permitir_otra_cuenta: true)`,
        );
const escritura = {
  confirm: z.boolean().default(false).describe("false = dry-run (solo muestra el diff). true = aplica el cambio."),
  permitir_otra_cuenta: z
    .boolean()
    .default(false)
    .describe(
      escribibles
        ? `Requerido en true para escribir en una cuenta distinta de ${escribibles}. Solo con autorización explícita de ${ownerName}.`
        : `Requerido en true para escribir en cualquier cuenta. Solo con autorización explícita de ${ownerName}.`,
    ),
};
const LECTURA = { readOnlyHint: true, openWorldHint: true } as const;
const ESCRITURA = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } as const;

// Known tokens are masked before a result reaches the client. Results are redacted structurally (every
// string and key; a number only when its text equals a known digit-only token; never booleans or null)
// and serialized once, so the text is always valid JSON. Errors are redacted as text.
const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(redactarEstructura(data), null, 1) }] });
const fallo = (e: unknown) => ({ isError: true, content: [{ type: "text" as const, text: redactar(String((e as Error)?.message ?? e)) }] });
const envolver = <A>(fn: (a: A, extra: any) => Promise<unknown>) => async (a: A, extra: any) => {
  try {
    return ok(await fn(a, extra));
  } catch (e) {
    return fallo(e);
  }
};

export function crearServidorMcp(api: PosterApi = posterHttp) {
  const s = new McpServer({ name: config.serviceName, version: "0.4.0" }, {
    instructions:
      `Herramientas para leer y configurar las cuentas Póster POS de la red ${networkName}. ` +
      `Lecturas en cualquier cuenta de la lista blanca. Escrituras: siempre primero en dry-run (confirm:false), mostrar el diff a ${ownerName}, ` +
      "y solo aplicar con confirm:true tras su OK. " +
      (escribibles
        ? `Por defecto solo ${escribibles}; otra cuenta requiere permitir_otra_cuenta:true y autorización explícita. `
        : "Ninguna cuenta se escribe por defecto; toda escritura requiere permitir_otra_cuenta:true y autorización explícita. ") +
      `Productos fuera de carta se OCULTAN (hide_dish); solo se borran con delete_old_dish si ${ownerName} lo pide para liberar lugar del plan. Platillos nuevos con receta: create_dish. update_dish no toca platillos con receta; permisos de puestos solo en panel web.`,
  });
  const ctx = (extra: any): W.Contexto => ({
    api,
    actor: (extra?.authInfo?.extra?.sub as string) ?? extra?.authInfo?.clientId ?? "desconocido",
    cliente: extra?.authInfo?.clientId,
  });

  // ── Lectura ──
  s.registerTool("list_accounts", { title: "Cuentas Póster", description: "Lista blanca de cuentas y cuáles permiten escritura por defecto.", annotations: LECTURA }, async () => ok(L.listarCuentas()));

  s.registerTool("menu_snapshot", {
    title: "Menú (resumen)",
    description: "Categorías y productos compactos (precio en pesos por spot, visible, #grupos, #líneas de receta). Filtra por texto/categoría.",
    inputSchema: { cuenta, buscar: z.string().optional(), categoria_id: z.number().int().optional(), solo_visibles: z.boolean().optional(), limite: z.number().int().min(1).max(500).optional() },
    annotations: LECTURA,
  }, envolver((a) => L.menuSnapshot(api, a)));

  s.registerTool("product_details", {
    title: "Detalle de producto",
    description: "Un producto completo: spots, grupos de modificadores con opciones (precio en pesos) y receta.",
    inputSchema: { cuenta, product_id: z.number().int() },
    annotations: LECTURA,
  }, envolver((a) => L.productoDetalle(api, a)));

  s.registerTool("ingredients", {
    title: "Insumos",
    description: "Insumos con categoría, unidad, existencia total y costo en pesos.",
    inputSchema: { cuenta, buscar: z.string().optional(), categoria_id: z.number().int().optional(), limite: z.number().int().min(1).max(1000).optional() },
    annotations: LECTURA,
  }, envolver((a) => L.insumos(api, a)));

  s.registerTool("prepacks", {
    title: "Precocinados",
    description: "Precocinados (prepacks) con rendimiento y receta línea por línea.",
    inputSchema: { cuenta, buscar: z.string().optional() },
    annotations: LECTURA,
  }, envolver((a) => L.precocinados(api, a)));

  s.registerTool("client_groups", {
    title: "Grupos de clientes",
    description: "Grupos de clientes (puntos/descuento, porcentaje, # clientes).",
    inputSchema: { cuenta, incluir_borrados: z.boolean().optional() },
    annotations: LECTURA,
  }, envolver((a) => L.gruposClientes(api, a)));

  s.registerTool("promotions", {
    title: "Promociones",
    description: "Promociones. Por defecto solo vigentes (date_end ≥ hoy, 0000-00-00, vacío o ausente).",
    inputSchema: { cuenta, solo_vigentes: z.boolean().default(true) },
    annotations: LECTURA,
  }, envolver((a) => L.promociones(api, a)));

  s.registerTool("employees", {
    title: "Empleados y puestos",
    description: "Empleados con puesto, rol y secciones a las que tienen acceso; resumen de puestos.",
    inputSchema: { cuenta },
    annotations: LECTURA,
  }, envolver((a) => L.empleados(api, a)));

  s.registerTool("payment_methods", { title: "Métodos de pago", description: "Métodos de pago configurados (settings.getPaymentMethods).", inputSchema: { cuenta }, annotations: LECTURA }, envolver((a) => L.metodosPago(api, a)));

  s.registerTool("settings", { title: "Ajustes de la cuenta", description: "settings.getAllSettings completo.", inputSchema: { cuenta }, annotations: LECTURA }, envolver((a) => L.ajustes(api, a)));

  s.registerTool("supplies", {
    title: "Compras",
    description: "Compras (storage.getSupplies) más recientes primero; total en pesos. Fechas YYYY-MM-DD.",
    inputSchema: { cuenta, desde: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), hasta: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), limite: z.number().int().min(1).max(500).optional() },
    annotations: LECTURA,
  }, envolver((a) => L.compras(api, a)));

  s.registerTool("supply_details", { title: "Detalle de compra", description: "Renglones de una compra (storage.getSupply) con importe y unitario en pesos.", inputSchema: { cuenta, supply_id: z.number().int() }, annotations: LECTURA }, envolver((a) => L.compraDetalle(api, a)));

  s.registerTool("stock_levels", {
    title: "Saldos de inventario",
    description: "Existencias por almacén (storage.getStorageLeftovers). Puede filtrar negativos.",
    inputSchema: { cuenta, storage_id: z.number().int().optional(), buscar: z.string().optional(), solo_negativos: z.boolean().optional(), limite: z.number().int().min(1).max(1000).optional() },
    annotations: LECTURA,
  }, envolver((a) => L.saldos(api, a)));

  s.registerTool("list_stocktakes", {
    title: "Inventarios (conteos)",
    description:
      "Inventarios de un almacén o de todos (storage.getStorageInventories): inicio, fin, fecha del inventario, si es retroactivo, si se realizó y costo total. " +
      "desde/hasta filtran por el día de fin (o de inicio si no hay fin); un inventario sin ninguna de las dos fechas solo aparece sin desde/hasta. " +
      "Del más reciente al más antiguo. Póster no permite crear ni realizar inventarios por API: se hacen en Póster y aquí solo se leen.",
    inputSchema: {
      cuenta,
      storage_id: z.number().int().optional().describe("Almacén (reference_catalogs). Sin él, todos los almacenes."),
      desde: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("YYYY-MM-DD, incluido (día de fin, o de inicio si no hay fin)"),
      hasta: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("YYYY-MM-DD, incluido (día de fin, o de inicio si no hay fin)"),
    },
    annotations: LECTURA,
  }, envolver((a) => L.inventarios(api, a)));

  s.registerTool("stocktake_result", {
    title: "Resultado de un inventario",
    description:
      "Diferencias de un inventario (storage.getInventoryIngredients): insumos, producciones y platillos/precocinados con lo calculado, lo contado y la diferencia. " +
      "Ordena por el costo de la diferencia y suma faltantes y sobrantes. Un valor no contado se lee como null.",
    inputSchema: {
      cuenta,
      inventario_id: z.number().int().describe("Inventario (list_stocktakes)"),
      solo_diferencias: z.boolean().optional().describe("Por defecto true: solo renglones con diferencia (o, en platillos/precocinados, con conteo) distinta de 0"),
      limite: z.number().int().min(1).max(1000).optional().describe("Renglones por grupo (por defecto 200)"),
    },
    annotations: LECTURA,
  }, envolver((a) => L.inventarioResultado(api, a)));

  s.registerTool("count_sheet", {
    title: "Hoja de conteo",
    description:
      "Hoja para contar a ciegas un almacén (storage.getStorageLeftovers con existencias en cero): id, nombre, unidad y tipo, ordenados por nombre, sin existencias ni costos. " +
      "Los ocultos quedan fuera salvo incluir_ocultos.",
    inputSchema: { cuenta, storage_id: z.number().int().describe("Almacén (reference_catalogs)"), incluir_ocultos: z.boolean().optional() },
    annotations: LECTURA,
  }, envolver((a) => L.hojaConteo(api, a)));

  s.registerTool("reference_catalogs", { title: "Almacenes, proveedores y categorías", description: "IDs necesarios para escribir: almacenes, proveedores, categorías de insumos y de menú.", inputSchema: { cuenta }, annotations: LECTURA }, envolver((a) => L.catalogosBase(api, a)));

  s.registerTool("poster_get", {
    title: "Lectura genérica",
    description: "Llama cualquier método de LECTURA de Póster (<modulo>.get*) con parámetros simples. Respuesta cruda (JSON truncado a 60 000 caracteres).",
    inputSchema: { cuenta, metodo: z.string().regex(L.METODO_LECTURA), params: z.record(z.string(), z.union([z.string(), z.number()])).optional() },
    annotations: LECTURA,
  }, envolver((a) => L.posterGet(api, a)));

  s.registerTool("recent_audit", { title: "Auditoría", description: "Últimas escrituras/dry-runs registrados en esta instancia.", inputSchema: { limite: z.number().int().min(1).max(200).default(20) }, annotations: LECTURA }, envolver(async (a: { limite: number }) => auditoriaReciente(a.limite)));

  // ── Escritura ──
  s.registerTool("create_client_group", {
    title: "Crear grupo de clientes",
    description: "clients.createGroup. Dry-run por defecto.",
    inputSchema: { cuenta: cuentaEscritura, nombre: z.string().min(1), tipo: z.enum(["puntos", "descuento"]), porcentaje: z.number().min(0).max(100), bono_cumple: z.number().min(0).optional(), usar_monedero: z.boolean().optional(), ...escritura },
    annotations: ESCRITURA,
  }, envolver((a, extra) => W.crearGrupoCliente(ctx(extra), a)));

  s.registerTool("update_client_group", {
    title: "Actualizar grupo de clientes",
    description: "clients.updateGroup (envía el grupo completo; conserva lo no indicado). Dry-run por defecto.",
    inputSchema: { cuenta: cuentaEscritura, client_groups_id: z.number().int(), nombre: z.string().min(1).optional(), tipo: z.enum(["puntos", "descuento"]).optional(), porcentaje: z.number().min(0).max(100).optional(), bono_cumple: z.number().min(0).optional(), usar_monedero: z.boolean().optional(), ...escritura },
    annotations: ESCRITURA,
  }, envolver((a, extra) => W.actualizarGrupoCliente(ctx(extra), a)));

  s.registerTool("create_ingredient", {
    title: "Crear insumo",
    description: "menu.createIngredient (rechaza nombres duplicados). Unidad: kg, l o p (pieza). Dry-run por defecto.",
    inputSchema: { cuenta: cuentaEscritura, nombre: z.string().min(1), categoria_id: z.number().int(), unidad: z.enum(["kg", "l", "p"]), peso_pieza_g: z.number().min(0).optional(), ...escritura },
    annotations: ESCRITURA,
  }, envolver((a, extra) => W.crearInsumo(ctx(extra), a)));

  s.registerTool("create_supply", {
    title: "Crear compra",
    description: "storage.createSupply. costo_unitario en PESOS por unidad del insumo (se envía en centavos). account_id opcional = cuenta de Finanzas que paga al momento; sin él la compra queda a crédito (sin pagar) y se paga después con assign_supply_payment. Tras aplicar verifica el total leyendo la compra. Dry-run por defecto.",
    inputSchema: {
      cuenta: cuentaEscritura,
      storage_id: z.number().int(),
      supplier_id: z.number().int(),
      fecha: z.string().regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/).optional().describe(`YYYY-MM-DD HH:MM:SS (hora de ${horaLocal}). Por defecto ahora.`),
      comentario: z.string().optional().describe("Ej. 'Ticket 51946'. Se usa para detectar duplicados."),
      account_id: z.number().int().optional().describe("Cuenta de Finanzas que paga la compra al momento (finance.getAccounts). Si se omite, la compra queda a crédito."),
      renglones: z.array(z.object({ id: z.number().int(), tipo: z.enum(["insumo", "producto", "modificador"]).optional(), cantidad: z.number().positive(), costo_unitario: z.number().min(0) })).min(1),
      ...escritura,
    },
    annotations: ESCRITURA,
  }, envolver((a, extra) => W.crearCompra(ctx(extra), a)));

  s.registerTool("create_write_off", {
    title: "Registrar merma",
    description:
      "storage.createWriteOff: da de baja existencias de un almacén (merma). Póster calcula el costo; no se envía costo por unidad. " +
      "Valida almacén, razón (storage.getWasteReasons), cada artículo y que la fecha sea real y no futura; avisa si ya hay mermas en ese almacén ese día. " +
      "Los renglones de tipo modificador se rechazan: el servidor no puede verificar que existan. Un mismo artículo va en un solo renglón; un platillo va como tipo platillo, no producto. " +
      "El contrato sigue la documentación de Póster y no está confirmado en una cuenta real: tras aplicar relee la merma (storage.getWaste) y compara almacén, día, razón y cantidades. " +
      "Póster la muestra como merma, no como inventario. Dry-run por defecto.",
    inputSchema: {
      cuenta: cuentaEscritura,
      storage_id: z.number().int().positive(),
      fecha: z.string().regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/).optional().describe(`YYYY-MM-DD HH:MM:SS (hora de ${horaLocal}). Por defecto ahora; no puede ser futura.`),
      razon_id: z.number().int().positive().optional().describe("Razón de merma (storage.getWasteReasons)"),
      renglones: z
        .array(
          z.object({
            id: z.number().int().positive(),
            tipo: z.enum(["insumo", "producto", "platillo", "precocinado", "modificador"]).optional().describe("Por defecto insumo"),
            cantidad: z.number().positive().describe("En la unidad del artículo"),
            comentario: z.string().optional(),
          }),
        )
        .min(1),
      ...escritura,
    },
    annotations: ESCRITURA,
  }, envolver((a, extra) => W.crearMerma(ctx(extra), a)));

  s.registerTool("assign_supply_payment", {
    title: "Pagar / asignar cuenta a una compra",
    description:
      "storage.updateSupply: asigna (o reasigna) la cuenta de Finanzas que paga una compra existente — el equivalente del botón \"pagar\" de Póster para compras a crédito. " +
      "Tras aplicar relee la compra y verifica que quedó la cuenta, que el total no cambió (tolerancia 0.5) y que el número de renglones es el mismo; no verifica el efecto en Finanzas. Dry-run por defecto.",
    inputSchema: { cuenta: cuentaEscritura, supply_id: z.number().int().describe("Número de compra (supply_id del almacén)"), account_id: z.number().int().describe("Cuenta de Finanzas que paga (finance.getAccounts)"), ...escritura },
    annotations: ESCRITURA,
  }, envolver((a, extra) => W.asignarPagoCompra(ctx(extra), a)));

  s.registerTool("update_dish", {
    title: "Actualizar platillo",
    description:
      "menu.updateDish (update COMPLETO). Cambia nombre, categoría, precio (pesos), visibilidad, color o precio de opciones (pesos). " +
      "Rechaza platillos con receta (updateDish la borraría). Para sacar de carta usa visible:false (no borrar). Dry-run por defecto.",
    inputSchema: {
      cuenta: cuentaEscritura,
      product_id: z.number().int(),
      nombre: z.string().min(1).optional(),
      categoria_id: z.number().int().optional(),
      precio: z.number().min(0).optional().describe("Precio del platillo en pesos, igual en todos los spots"),
      visible: z.boolean().optional(),
      color: z.string().optional(),
      precios_opciones: z.array(z.object({ dish_modification_id: z.number().int(), precio: z.number().min(0) })).optional().describe("Precio en pesos de opciones existentes"),
      ...escritura,
    },
    annotations: ESCRITURA,
  }, envolver((a, extra) => W.actualizarPlatillo(ctx(extra), a)));

  s.registerTool("update_category", {
    title: "Actualizar categoría del menú",
    description: "menu.updateCategory: renombrar o mover bajo otra categoría (padre_id 0 = raíz). Dry-run por defecto.",
    inputSchema: { cuenta: cuentaEscritura, category_id: z.number().int(), nombre: z.string().min(1).optional(), padre_id: z.number().int().min(0).optional(), ...escritura },
    annotations: ESCRITURA,
  }, envolver((a, extra) => W.actualizarCategoria(ctx(extra), a)));

  s.registerTool("update_prepack", {
    title: "Actualizar precocinado",
    description: "menu.updatePrepack: nombre, rendimiento (out) y/o receta COMPLETA (reemplaza todas las líneas; unidades g/ml/p). Dry-run por defecto.",
    inputSchema: {
      cuenta: cuentaEscritura,
      product_id: z.number().int(),
      nombre: z.string().min(1).optional(),
      rendimiento: z.number().positive().optional(),
      receta: z.array(z.object({ ingredient_id: z.number().int(), tipo: z.number().int().min(1).max(2).optional(), brutto: z.number().positive(), netto: z.number().positive().optional(), unidad: z.enum(["g", "ml", "p"]).optional(), lock: z.number().int().min(0).max(1).optional() })).min(1).optional(),
      ...escritura,
    },
    annotations: ESCRITURA,
  }, envolver((a, extra) => W.actualizarPrecocinado(ctx(extra), a)));

  // ── Altas de menú ──
  const lineaReceta = z.object({
    ingredient_id: z.number().int(),
    tipo: z.number().int().min(1).max(2).optional().describe("1 = insumo (default), 2 = precocinado. Los IDs se repiten entre ambos: indica siempre el tipo."),
    brutto: z.number().positive().describe("Cantidad en g / ml / piezas (aunque el insumo esté en kg o l)"),
    netto: z.number().positive().optional(),
    lock: z.number().int().min(0).max(1).optional(),
  });

  const grupoSchema = z.array(z.object({
        nombre: z.string().min(1),
        tipo: z.union([z.literal(1), z.literal(2)]).optional().describe("1 = uno de varios (default), 2 = varios"),
        min: z.number().int().min(0),
        max: z.number().int().min(1),
        opciones: z.array(z.object({
          ingredient_id: z.number().int(),
          tipo: z.enum(["insumo", "precocinado", "platillo"]).optional().describe("insumo (type 10, default), precocinado (type 3) o platillo auxiliar sin grupos (type 2, ej. \"Para llevar 12 oz\")"),
          nombre: z.string().min(1),
          brutto: z.number().positive().describe("g / ml / piezas que descuenta la opción"),
          precio: z.number().min(0).optional().describe("Cargo extra en pesos"),
        })).min(1),
      }));

  s.registerTool("create_category", {
    title: "Crear categoría del menú",
    description: "menu.createCategory (rechaza nombre duplicado). padre_id 0 = raíz. Dry-run por defecto.",
    inputSchema: { cuenta: cuentaEscritura, nombre: z.string().min(1), padre_id: z.number().int().min(0).optional(), color: z.string().optional().describe("white, red, orange, yellow, green, blue, navy blue, purple, black, mint blue, lime green, pink"), oculta: z.boolean().optional(), ...escritura },
    annotations: ESCRITURA,
  }, envolver((a, extra) => W.crearCategoria(ctx(extra), a)));

  s.registerTool("create_prepack", {
    title: "Crear precocinado",
    description: "menu.createPrepack con receta (valida que cada insumo/precocinado exista; rechaza nombre duplicado). Dry-run por defecto.",
    inputSchema: { cuenta: cuentaEscritura, nombre: z.string().min(1), receta: z.array(lineaReceta).min(1), descripcion: z.string().optional(), ...escritura },
    annotations: ESCRITURA,
  }, envolver((a, extra) => W.crearPrecocinado(ctx(extra), a)));

  s.registerTool("create_dish", {
    title: "Crear platillo con receta",
    description:
      "menu.createDish con receta y grupos de modificadores. Precios en PESOS (se envían en centavos). Valida IDs por tipo, categoría y nombre duplicado; " +
      "tras aplicar relee el producto y compara receta, grupos y precio. La leche va en un grupo obligatorio (min 1). Dry-run por defecto.",
    inputSchema: {
      cuenta: cuentaEscritura,
      nombre: z.string().min(1),
      categoria_id: z.number().int(),
      workshop: z.number().int().min(0).describe("Taller/estación de la cuenta (cada cuenta usa el suyo)"),
      precio: z.number().min(0).describe("Pesos"),
      receta: z.array(lineaReceta).min(1),
      grupos: grupoSchema.optional(),
      color: z.string().optional(),
      sin_descuento: z.boolean().optional().describe("true = nodiscount 1 (no participa en descuentos). Default false."),
      ...escritura,
    },
    annotations: ESCRITURA,
  }, envolver((a, extra) => W.crearPlatillo(ctx(extra), a)));

  s.registerTool("hide_dish", {
    title: "Ocultar platillo (sacar de carta)",
    description:
      "menu.getProduct + menu.updateDish con el payload COMPLETO (receta, grupos y opciones con sus IDs): visible 0 en los spots del payload que reconstruye y el sufijo del parámetro sufijo (default \" (old)\"). " +
      "Nunca borra. Tras aplicar verifica que receta y grupos quedaron intactos. Dry-run por defecto.",
    inputSchema: { cuenta: cuentaEscritura, product_id: z.number().int(), sufijo: z.string().optional().describe('Default " (old)"'), ...escritura },
    annotations: ESCRITURA,
  }, envolver((a, extra) => W.ocultarPlatillo(ctx(extra), a)));

  s.registerTool("delete_old_dish", {
    title: "Borrar platillo (old) para liberar lugar",
    description:
      "menu.removeDish SOLO para platillos cuyo nombre termina en \"(old)\" y que están ocultos explícitamente en todos sus spots (visible 0); no comprueba si pasaron por hide_dish. " +
      `Úsalo únicamente cuando ${ownerName} pida borrar para liberar lugar del plan de Póster. Dry-run por defecto.`,
    inputSchema: { cuenta: cuentaEscritura, product_id: z.number().int(), ...escritura },
    annotations: ESCRITURA,
  }, envolver((a, extra) => W.borrarPlatilloOld(ctx(extra), a)));

  s.registerTool("update_dish_recipe", {
    title: "Actualizar receta y grupos de un platillo",
    description:
      "menu.updateDish COMPLETO para un platillo con receta: reemplaza receta y grupos de modificadores (ej. sacar el empaque de la receta y agregar el grupo \"Servicio\" con En local / Para llevar). " +
      "Conserva nombre, categoría, precio y visibilidad. Muestra antes/después legible; tras aplicar relee y verifica. Dry-run por defecto.",
    inputSchema: { cuenta: cuentaEscritura, product_id: z.number().int(), receta: z.array(lineaReceta).min(1), grupos: grupoSchema, ...escritura },
    annotations: ESCRITURA,
  }, envolver((a, extra) => W.actualizarRecetaPlatillo(ctx(extra), a)));

  // ── Finanzas ──
  s.registerTool("create_transaction", {
    title: "Registrar transacción en Finanzas",
    description:
      "finance.createTransactions: registra un gasto (type 0), ingreso (type 1) o transferencia (type 2). " +
      "Monto en PESOS (se envía en pesos, no en centavos). El account_id es la cuenta financiera (ver finance.getAccounts con poster_get); " +
      "category_id es obligatorio en gasto e ingreso (finance.getCategories) y no aplica a transferencias, que usan account_destino_id. " +
      "Valida cuenta y categoría; tras aplicar relee finance.getTransactions entre la fecha de la transacción y hoy, busca el transaction_id de la respuesta y verifica monto (tolerancia 0.5 pesos), cuenta y categoría; " +
      "en transferencias solo revisa la cuenta origen y no la categoría. Si la diferencia de monto supera la tolerancia y es de unas 100×, avisa de un posible error de unidad. " +
      "Una respuesta de Póster sin transaction_id o sin cuenta se lee como 0 y puede coincidir: ese caso no se detecta. Dry-run por defecto.",
    inputSchema: {
      cuenta: cuentaEscritura,
      tipo: z.enum(["gasto", "ingreso", "transferencia"]).describe("gasto = salida, ingreso = entrada, transferencia = entre cuentas"),
      monto: z.number().positive().describe("Monto en PESOS (se envía en pesos, no en centavos)"),
      account_id: z.number().int().describe("Cuenta financiera: origen del gasto/transferencia o destino del ingreso (finance.getAccounts)"),
      account_destino_id: z.number().int().optional().describe("Solo transferencias: cuenta financiera destino"),
      category_id: z.number().int().optional().describe("Categoría financiera (finance.getCategories). Obligatoria en gasto e ingreso; se ignora en transferencias"),
      comentario: z.string().optional(),
      fecha: z.string().regex(/^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}:\d{2})?$/).optional().describe(`YYYY-MM-DD [HH:MM:SS], hora de ${horaLocalConZona}. Por defecto ahora.`),
      user_id: z.number().int().optional().describe("Empleado que registra la operación (opcional)"),
      ...escritura,
    },
    annotations: ESCRITURA,
  }, envolver((a, extra) => W.crearTransaccion(ctx(extra), a)));

  return s;
}
