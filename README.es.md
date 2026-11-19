# poster-rush · MCP remoto para Póster POS (red RUSH Café)

Servidor MCP (TypeScript + Hono, transporte **Streamable HTTP** sin estado) para que Roy lea y configure
las 10 cuentas Póster de la red RUSH Café desde claude.ai (también en el celular), sin la Mac encendida.
Esos son los valores por defecto: el nombre (`OWNER_NAME`), la red (`NETWORK_NAME`), la lista de cuentas
(`POSTER_ACCOUNTS`) y el resto de ajustes se configuran por entorno; ver [Configuración](#configuración).

- Local: `dev start poster-mcp` → `http://localhost:3210` (bloque de puertos **3210–3219**; el 3200 ya lo usa academy)
- Producción: Cloud Run, tokens en Google Secret Manager → ver [DEPLOY_CLOUD_RUN.md](DEPLOY_CLOUD_RUN.md)

## Reglas que el servidor hace cumplir

| Regla | Cómo |
|---|---|
| Solo las cuentas de la lista blanca | `POSTER_ACCOUNTS` (cargada en `CUENTAS`, `src/config.ts`; por defecto `cafe-01` a `cafe-10`); cualquier otra se rechaza, también en lectura. Una excepción: `auditoria_reciente` devuelve el log de auditoría local de esta instancia tal como se escribió, así que puede mostrar entradas de cuentas que ya se quitaron de la lista |
| Escritura limitada a un conjunto de cuentas | Solo las cuentas de `WRITE_DEFAULT_ACCOUNTS` (por defecto `cafe-04` mientras `POSTER_ACCOUNTS` no esté definida, si no vacía; puede dejarse vacía) se escriben por defecto. Otra cuenta exige `permitir_otra_cuenta: true` **en esa llamada** (y la autorización de `OWNER_NAME`) |
| Dry-run por defecto | toda escritura con `confirm: false` devuelve `cambios` (diff), `avisos` y el `payload` exacto, sin tocar Póster |
| Aplicar = `confirm: true` | escribe una sola vez (sin reintentos, para no duplicar) y **lee de vuelta** para verificar |
| Auditoría | cada dry-run/aplicación/rechazo: quién, cuándo, cuenta, método, payload sin token, resultado (stdout → Cloud Logging + JSONL en `AUDIT_DIR`). Una escritura cuyo intento HTTP falló una vez iniciado (error de red, timeout, respuesta que no es JSON o estado HTTP 5xx) queda como `desconocido`: puede haberse aplicado, así que se verifica con una lectura antes de reintentar. Una escritura aplicada que no se pudo releer queda como `aplicado`, con `verificacion.ok: false` y un aviso de no repetirla |
| Tokens nunca visibles | se leen de GSM (prod), `poster_accounts` (dev) o variables de entorno `POSTER_TOKEN_<CUENTA>`, según `TOKEN_SOURCE`; se redactan de errores y auditoría; no hay herramienta que los devuelva |
| Fuera de carta = ocultar | `actualizar_platillo` con `visible: false`; no existe herramienta de borrado |

## Herramientas

**Lectura** (cualquier cuenta de la lista): `listar_cuentas`, `menu_snapshot`, `producto_detalle`, `insumos`,
`precocinados`, `grupos_clientes`, `promociones` (vigentes = `date_end ≥ hoy` o `0000-00-00`), `empleados`
(con puestos y secciones de acceso), `metodos_pago`, `ajustes` (`settings.getAllSettings`), `compras`,
`compra_detalle`, `saldos`, `catalogos_base` (IDs de almacenes/proveedores/categorías para escribir),
`poster_get` (cualquier `<modulo>.get*` crudo), `auditoria_reciente`.

**Escritura** (dry-run por defecto): `crear_grupo_cliente`, `actualizar_grupo_cliente`, `crear_insumo`,
`crear_compra`, `actualizar_platillo` (updateDish), `actualizar_categoria` (updateCategory),
`actualizar_precocinado` (updatePrepack), `crear_categoria` (createCategory), `crear_precocinado` (createPrepack),
`crear_platillo` (createDish con receta y grupos; relee y verifica), `ocultar_platillo` (getProduct + updateDish COMPLETO con receta, visible 0 y sufijo " (old)"),
`crear_transaccion` (finance.createTransactions: `type` 0 gasto / 1 ingreso / 2 transferencia es OBLIGATORIO; la categoría va como `category` (id, no `category_id`); **el monto se envía en PESOS** —finance.createTransactions NO usa centavos, al revés que el resto de la API—; valida `account_id` y `category` contra `finance.getAccounts`/`getCategories` y tras aplicar relee `finance.getTransactions` avisando si el monto quedó 100× desviado),
`crear_compra` ahora acepta `account_id` opcional (paga al momento; sin él la compra queda a crédito),
`asignar_pago_compra` (storage.updateSupply: el botón "pagar" por API — asigna/reasigna la cuenta de Finanzas de una compra a crédito; relee y verifica que el total y los renglones no cambiaron).

**Solo panel web**: editar la receta de un platillo existente (actualizar_platillo rechaza platillos con receta) y permisos de puestos.

## Contratos de Póster (aprendidos en la migración de la 47)

API: `https://<cuenta>.joinposter.com/api/<metodo>?token=…`. Escrituras con cuerpo JSON salvo `createSupply` (multipart).

**Menú / platillos**
- `menu.updateDish` es update **COMPLETO**: hay que reenviar nombre, categoría, workshop, color, `price`, `visible`,
  `modificationgroup` y `"ingredient[]": []`. Omitir `price`/`"ingredient[]"` da `Bad price value` / `Bad ingredient value`.
- **updateDish BORRA la receta** del platillo (la API descarta recetas de platillos en silencio). Guarda:
  *si el platillo tiene `ingredients` → no se toca* (`actualizar_platillo` lo rechaza y manda al panel).
- `price` y `visible` son mapas por spot: `{"1": 2500}`, `{"1": 1}`. El precio del **platillo** se lee y escribe en **centavos**.
- Precio de **opción** de modificador: se **escribe en centavos** (2000) y se **lee en pesos** (20).
- Visibilidad en terminal = `spots[].visible`. El `hidden` de `getProducts` es otro flag: no derivar `visible` de `hidden`.
- Opciones: `{name, ingredientId, ingredient_id, type, brutto, price, sort_order}`; `type` 2 = platillo, 1/10 = insumo.
- **Póster no anida**: un platillo con grupos propios no puede ser opción tipo 2 de otro (`Bad <id> value`).
- `menu.getProduct {product_id}` sí responde (probado 23 oct 2026) con receta y grupos; las altas lo usan y caen a `menu.getProducts` si falla.
- `createDish`/`updateDish` aceptan `ingredient:[{id,type,brutto,netto,lock}]`: con eso la receta se conserva al ocultar.
- `menu.updateCategory {category_id, category_name, parent_category}` funciona.

**Precocinados**
- `menu.updatePrepack` acepta receta por API y la **reemplaza completa**:
  `{prepack_id, product_id, product_name, prepack_unit, out, ingredient:[{id:number, type, brutto, netto, lock, unit}]}`.
  `prepack_unit` (no `unit`), `out` = rendimiento. Las líneas se leen en kg/l pero se escriben en g/ml.
  (También se vio aceptado `id: "1_97"` = `<tipo>_<id>`; aquí se usa `id` numérico + `type`.)

**Compras e inventario**
- `storage.getSupplies` (lista): `supply_sum` en **centavos**.
- `storage.getSupply` (detalle): `supply_sum` y `supply_ingredient_sum` en **pesos**; el importe del renglón es el **total** del renglón.
- `storage.createSupply`: multipart con `date, storage_id, supplier_id, supply_comment` e `ingredients` = JSON string
  `[{id, type, num, sum}]` (`type` 4 insumo · 1 producto · 5 modificador).
  ⚠ **Sin verificar con compra real**: si `sum` va en centavos o pesos. El servidor envía **centavos por unidad** (lo que
  asumían los probes) y tras aplicar compara el total leído con el esperado; si no cuadra, lo marca con `alerta`.
- `storage.getStorageLeftovers.prime_cost` en centavos; **`menu.getIngredients.prime_cost` viene ×10 000** (1040000 = $104),
  por eso `insumos` toma el costo de los saldos.

**Finanzas** (`crear_transaccion`)
- `finance.createTransactions`: `type` 0 gasto · 1 ingreso · 2 transferencia. Gasto usa `account_from`/`amount_from`;
  ingreso `account_to`/`amount_to`; transferencia ambos pares (`account_from`→`account_to`). `category_id` solo en gasto/ingreso.
- ⚠ **Unidad sin confirmar al escribir**: al LEER (`finance.getTransactions`) los montos vienen en **centavos**; no está
  verificado si al escribir Póster espera pesos o centavos. El servidor **envía centavos** (como el resto de la API) y tras
  aplicar relee la transacción del día; si el monto quedó **100× desviado**, lo marca con `alerta_100x` y pide no reintentar.
- `account_id`/`account_destino_id` = cuentas de `finance.getAccounts`; `category_id` = `finance.getCategories`. `date` = `YYYY-MM-DD HH:MM:SS` (hora de la zona `TIMEZONE`).

**Compras y su pago**
- El **número de compra = `supply_id`** del almacén. `storage.getSupply`/`getSupplies` traen `account_id` = la cuenta que pagó; **`account_id` vacío `""` = a crédito (sin pagar)**. El detalle (`getSupply`) viene en **pesos**; la lista (`getSupplies`) en **centavos**.
- Al fijar `account_id` a una compra, Póster **autogenera** la transacción de Finanzas (type 0, categoría Compras) **ligada por `binding_type 12` + `binding_id = supply_id`**, con `recipient_type 12`/`recipient_id = supplier_id`.
- `asignar_pago_compra` = `storage.updateSupply` (update COMPLETO: relee y reenvía la compra cambiando solo `account_id`). ⚠ **Contrato de updateSupply sin verificar en vivo**: tras aplicar se relee y se compara total y # de renglones; si algo cambió, se marca para corregir en el panel.

**Otros**: grupos de clientes `loyalty_type` 1 = puntos, 2 = descuento; métodos de pago = `settings.getPaymentMethods`
(no `finance.*`); promociones = `clients.getPromotions`.

## Desarrollo local

```bash
cp .env.example .env      # ya existe en la Mac con llaves locales generadas
npm install
dev start poster-mcp      # pm2, PORT=3210; arranca erp-core-db si hace falta (tokens desde poster_accounts)
curl localhost:3210/health
```

Para Claude Code local: `claude mcp add --transport http poster-rush http://localhost:3210/mcp --header "Authorization: Bearer $MCP_BEARER_TOKEN"`.

## Configuración

La configuración se lee del entorno; un `.env` local solo completa las variables que no estén ya definidas, y
`.env.example` las lista todas. Sin ninguna de las variables de abajo, el servidor se comporta como antes, salvo que
los textos que llamaban "RUSH" a la red (la descripción de un parámetro y la página de autorización) ahora usan el
`NETWORK_NAME` por defecto, "RUSH Café". Un valor inválido de una variable de la tabla detiene el arranque con un error
que nombra la variable y la regla que incumple, y señala una entrada mala de una lista de cuentas por su posición
(1 = la primera); el error nunca cita el valor. Los valores de la tabla se recortan (espacios) antes de validarlos, con
dos excepciones: `SERVICE_NAME`, `OAUTH_SUBJECT` y `TOKEN_SOURCE` se validan tal como están escritos, y en
`OWNER_NAME` y `NETWORK_NAME` los caracteres de control y de formato bidireccional se buscan antes de recortar, así que
un salto de línea o un tabulador al final detiene el arranque. Un `.env` local quita los espacios alrededor de los
valores sin comillas antes de cualquier validación; lo exportado en el shell llega tal cual. Con Vitest no se carga el
`.env` local, así que las pruebas sin red no dependen de él; `npm run test:live` (`POSTER_LIVE=1`) sí lo carga, salvo
`WRITE_DEFAULT_ACCOUNTS`, que fija el runner de pruebas (ver [Tests](#tests)).

| Variable | Por defecto | Reglas |
|---|---|---|
| `POSTER_ACCOUNTS` | `cafe-01,…,cafe-10` | Lista blanca separada por comas. Cada entrada cumple `^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$`; fallan las entradas vacías, los duplicados y el valor en blanco |
| `DEFAULT_WRITE_ACCOUNT` | `cafe-04` si `POSTER_ACCOUNTS` no está definida; si no, ninguna | Cuenta que usa una escritura cuando se omite `cuenta`; debe estar en la lista. En blanco = ninguna, y entonces toda escritura exige `cuenta`. Puede quedar fuera de `WRITE_DEFAULT_ACCOUNTS`: entonces escribir en ella sigue exigiendo `permitir_otra_cuenta: true`, y la descripción de `cuenta` en las escrituras lo dice |
| `WRITE_DEFAULT_ACCOUNTS` | `cafe-04` si `POSTER_ACCOUNTS` no está definida; si no, vacía | Cuentas que se escriben sin `permitir_otra_cuenta: true`; cada una debe estar en la lista. En blanco = vacía; el orden no importa |
| `TIMEZONE` | `America/Merida` | Zona horaria para "hoy" y las fechas por defecto: cualquier valor que admita `Intl.DateTimeFormat`. Se recomienda un nombre IANA; en las versiones actuales de Node también cargan desfases UTC como `+05:00` y alias como `EST` (cuáles cargan depende de la versión de Node). Se guarda tal como lo resuelve `Intl`, así que no importan mayúsculas y minúsculas (`america/merida` funciona) y un alias pasa a la zona a la que apunta, que puede variar entre versiones de Node. En blanco = por defecto |
| `OWNER_NAME` | `Roy` | En las instrucciones, descripciones de herramientas y el error de la guarda de escritura. De 1 a 100 caracteres, sin caracteres de control ni de formato bidireccional (U+200E, U+200F, U+202A-U+202E, U+2066-U+2069). En blanco = por defecto |
| `NETWORK_NAME` | `RUSH Café` | En las instrucciones, descripciones de herramientas y la página de autorización (escapado en HTML). Mismas reglas que `OWNER_NAME` |
| `SERVICE_NAME` | `poster-rush` | Nombre del servidor MCP, `/health`, `/`, título y encabezado de la página de autorización y log de arranque. `^[A-Za-z0-9._-]{1,64}$`, tal como está escrito: no se recorta, así que un valor en blanco o con espacios alrededor falla |
| `OAUTH_SUBJECT` | `roy` | Claim `sub` de los tokens de acceso y refresh. `^[A-Za-z0-9._@-]{1,64}$`, sin recortar, como `SERVICE_NAME`. Los tokens emitidos con un valor anterior siguen valiendo hasta que expiran |
| `TOKEN_SOURCE` | `gsm` | De dónde salen los tokens de la API de Póster: `gsm` (Google Secret Manager), `mysql` (tabla local `poster_accounts`) o `env` (variables `POSTER_TOKEN_<CUENTA>`). Exactamente uno de los tres, sin recortar: cualquier otro valor, también uno con espacios alrededor, falla. En blanco = por defecto. `/health` y el log de arranque lo muestran |
| `POSTER_TOKEN_<CUENTA>` | sin definir | Solo con `env`; con `gsm` y `mysql` se ignora. Una por cuenta de `POSTER_ACCOUNTS`, con el nombre de la cuenta en mayúsculas y cada guion cambiado por guion bajo (`cafe-04` → `POSTER_TOKEN_CAFE_04`); las variables de cuentas fuera de la lista no se leen. Con la lista por defecto son diez variables, de `POSTER_TOKEN_CAFE_01` a `POSTER_TOKEN_CAFE_10`. Cada valor se recorta y luego debe cumplir `^[A-Za-z0-9:._~-]{16,}$`: al menos 16 caracteres, solo letras ASCII, dígitos y `:` `.` `_` `~` `-` (los tokens de Póster tienen la forma `<id de cuenta>:<hex>`). Falla un token que falta o está en blanco, o que no tiene ese formato, y un solo error nombra todas las variables que fallan y nunca cita un valor. Se lee una vez al arrancar, así que un token cambiado vale tras reiniciar; con `gsm` o `mysql` el token se guarda en caché 10 minutos y se vuelve a leer en la primera búsqueda después de ese plazo. Estos tokens se quitan de los mensajes de error y de las entradas de auditoría, también los de cuentas nunca consultadas |
| `POSTER_MYSQL_URL` | sin definir | Solo con `mysql`; con `gsm` y `env` se ignora. Reemplaza la línea `DATABASE_URL` del archivo en `FINANZAS_ENV_PATH`; si no está definida o está en blanco, ese archivo se lee en la primera búsqueda de token. Con `mysql`, un valor que no es una URL válida detiene el arranque. Un `DATABASE_URL` genérico del entorno no se usa. Los errores de conexión y consulta MySQL nombran el origen de la URL (`POSTER_MYSQL_URL` o la línea `DATABASE_URL` del archivo) y como mucho el código de error del driver, nunca la URL |

`PORT`, `PUBLIC_BASE_URL`, `FINANZAS_ENV_PATH`, `GCP_PROJECT_ID`, `SECRET_PREFIX`, `MCP_BEARER_TOKEN`,
`OAUTH_SIGNING_KEY`, `OWNER_PASSPHRASE`, `OAUTH_ALLOWED_REDIRECTS` y `AUDIT_DIR` funcionan como antes, sin validación nueva.

En Cloud Run, cada `POSTER_TOKEN_<CUENTA>` se mapea desde Secret Manager con `--set-secrets` (por ejemplo
`--set-secrets POSTER_TOKEN_CAFE_04=poster-token-cafe-04:latest`) en vez de pasar el token como variable de entorno
normal con `--set-env-vars`, donde quedaría visible en la configuración del servicio. Las instancias en marcha conservan
el token con el que arrancaron; un token rotado llega al servicio con instancias nuevas o una revisión nueva.

### Configuración solo con variables de entorno

Donde la configuración solo puede pasarse como variables de entorno (sin archivo `.env`, sin acceso a Google Cloud ni a
MySQL), se usa `TOKEN_SOURCE=env` y cada cuenta de la lista recibe su token. Sin `POSTER_ACCOUNTS` vale la lista por
defecto, y las diez cuentas necesitan el suyo (de `POSTER_TOKEN_CAFE_01` a `POSTER_TOKEN_CAFE_10`). Una configuración
mínima para dos cuentas que escribe por defecto en `tienda-norte`, como nombre y valor de cada variable que se captura
en la configuración de entorno de la plataforma:

| Variable | Valor |
|---|---|
| `TOKEN_SOURCE` | `env` |
| `POSTER_ACCOUNTS` | `tienda-norte,tienda-sur` |
| `POSTER_TOKEN_TIENDA_NORTE` | el token de la API de Póster de `tienda-norte` |
| `POSTER_TOKEN_TIENDA_SUR` | el token de la API de Póster de `tienda-sur` |
| `DEFAULT_WRITE_ACCOUNT` | `tienda-norte` |
| `WRITE_DEFAULT_ACCOUNTS` | `tienda-norte` |
| `MCP_BEARER_TOKEN` | un secreto aleatorio, por ejemplo la salida de `openssl rand -hex 32` |

Son valores para la plataforma, no un script para ejecutar; cada token se captura tal cual, sin comillas. No hacen
falta `GCP_PROJECT_ID`, `SECRET_PREFIX`, `POSTER_MYSQL_URL` ni `FINANZAS_ENV_PATH`; `PORT` y `PUBLIC_BASE_URL` se
definen según lo pida la plataforma. Escribir en `tienda-sur` sigue exigiendo `permitir_otra_cuenta: true`. Si una
variable de token falta o está en blanco, o su token no cumple la regla de formato de la tabla de arriba, el servidor
se detiene al arrancar con un error que nombra la variable y nunca cita su valor.

## Tests

```bash
npm test             # unitarios (contratos, guardas, dry-run con API falsa) + flujo HTTP/OAuth completo
npm run test:live    # EN VIVO contra cafe-04: una parte de las lecturas + dry-run de algunas escrituras.
                     # El cliente de prueba revienta si algo intenta escribir.
```

La suite en vivo requiere `cafe-04` y `cafe-01` en la lista de cuentas (`POSTER_ACCOUNTS`; la lista por defecto
incluye ambas); las demás cuentas no se usan. Lee y hace dry-run contra `cafe-04`, que debe tener datos reales, por
ejemplo más de 50 productos en más de 3 categorías (entre ellos un
americano), más de 50 insumos, precocinados con receta, empleados y puestos, métodos de pago, compras, almacenes y
proveedores. `vitest.config.ts` fija `WRITE_DEFAULT_ACCOUNTS=cafe-04` por encima del shell y del `.env`, así que
`cafe-04` es la única cuenta que se escribe por defecto, y con un `POSTER_ACCOUNTS` que no incluya `cafe-04` la
configuración no carga y la suite falla. `cafe-01` debe estar en la lista, y la prueba espera que se bloquee sin
`permitir_otra_cuenta`.
Cubre `menu_snapshot`, `producto_detalle`, `insumos`, `precocinados`, `grupos_clientes`, `promociones`, `empleados`,
`metodos_pago`, `ajustes`, `compras`, `compra_detalle`, `saldos`, `catalogos_base` y `poster_get`, y el dry-run de
`actualizar_platillo`, `actualizar_categoria`, `actualizar_precocinado`, `crear_insumo`, `crear_compra`,
`crear_grupo_cliente` y, si la cuenta tiene algún grupo, `actualizar_grupo_cliente`.

## Autenticación

- **OAuth 2.1** (para el conector de claude.ai): descubrimiento `/.well-known/oauth-protected-resource` y
  `/.well-known/oauth-authorization-server`, registro dinámico `/register`, `/authorize` (pide `OWNER_PASSPHRASE`,
  5 intentos/15 min), `/token` (authorization_code + PKCE S256, refresh). Tokens JWT HS256 firmados con
  `OAUTH_SIGNING_KEY`: access 1 h, refresh 30 días. Los 30 días son la vigencia de un token de refresh:
  cada refresh emite uno nuevo, así que una autorización no tiene fin absoluto. **Rotar la llave revoca
  solo lo emitido por OAuth** (tokens de acceso y refresh, códigos, `client_id`); el bearer estático
  `MCP_BEARER_TOKEN` sigue valiendo y se rota aparte. Redirects permitidos: `claude.ai`/`claude.com`
  callback + loopback para pruebas.
- **Bearer estático** `MCP_BEARER_TOKEN` para Claude Code / curl.
- **Límite de la frase de acceso:** un solo contador por instancia, compartido por todos los clientes;
  la ventana de 15 minutos empieza con la primera frase incorrecta y una autorización correcta pone el
  contador a cero; `X-Forwarded-For` no interviene en la decisión. Limitaciones conocidas de este diseño
  (riesgos residuales):
  - Quien llegue a `/authorize` y obtenga un `client_id` del `/register` abierto puede mantener bloqueadas
    las autorizaciones nuevas enviando cinco frases incorrectas cada vez que termina una ventana. Mientras
    dura el bloqueo, todo `POST /authorize` bien formado recibe 429 sea cual sea la frase, también la
    correcta (una solicitud que no pasa la validación de los parámetros OAuth sigue recibiendo 400 y la página
    por GET se sigue mostrando). El bearer
    estático, los tokens de acceso y refresh ya emitidos y la renovación en `/token` siguen funcionando;
    reiniciar la instancia borra el bloqueo.
  - Las ventanas son locales a cada instancia y empiezan con el primer fallo en esa instancia. Con N
    instancias, un atacante que llegue a todas obtiene hasta cinco intentos por instancia y por ventana;
    no hay un límite para todo el servicio.

## Estructura

```
src/config.ts       lista blanca, reglas de escritura, env
src/tokens.ts       GSM / MySQL, caché 10 min, redacción
src/poster.ts       cliente HTTP (reintenta lecturas, 1 intento en escrituras)
src/audit.ts        auditoría
src/tools/lectura.ts, src/tools/escritura.ts
src/mcp.ts          registro de herramientas (zod)
src/auth.ts         OAuth + bearer
src/server.ts       Hono: /health, OAuth, /mcp
scripts/subir-tokens-gsm.mts   DB local → Secret Manager (sin imprimir tokens)
```
