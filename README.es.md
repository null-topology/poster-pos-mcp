# poster-rush · MCP remoto para Póster POS (red RUSH Café)

Servidor MCP (TypeScript + Hono, transporte **Streamable HTTP** sin estado) para que Roy lea y configure
las 10 cuentas Póster de la red RUSH Café desde claude.ai (también en el celular), sin la Mac encendida.
Esos son los valores por defecto: el nombre (`OWNER_NAME`), la red (`NETWORK_NAME`), la lista de cuentas
(`POSTER_ACCOUNTS`) y el resto de ajustes se configuran por entorno; ver [Configuración](#configuración).

- Local: `dev start poster-mcp` → `http://localhost:3210` (bloque de puertos **3210–3219**; el 3200 ya lo usa academy)
- Producción (despliegue por defecto): Cloud Run, tokens en Google Secret Manager (`TOKEN_SOURCE` también admite MySQL o variables de entorno) → ver [DEPLOY_CLOUD_RUN.md](DEPLOY_CLOUD_RUN.md)

## Reglas que el servidor hace cumplir

Aplicar una escritura (`confirm: true`) y escribir fuera de las cuentas por defecto (`permitir_otra_cuenta: true`) son argumentos de la herramienta que pone el modelo; el control humano antes de escribir es la aprobación de la llamada en el cliente.

| Regla | Cómo |
|---|---|
| Solo las cuentas de la lista blanca | `POSTER_ACCOUNTS` (cargada en `CUENTAS`, `src/config.ts`; por defecto `cafe-01` a `cafe-10`); cualquier otra se rechaza, también en lectura. Una excepción: `recent_audit` devuelve el log de auditoría local de esta instancia sin filtrar por cuenta (su salida se redacta como todo resultado), así que puede mostrar entradas de cuentas que ya se quitaron de la lista |
| Escritura limitada a un conjunto de cuentas | Solo las cuentas de `WRITE_DEFAULT_ACCOUNTS` (por defecto `cafe-04` mientras `POSTER_ACCOUNTS` no esté definida, si no vacía; puede dejarse vacía) se escriben por defecto. Otra cuenta exige `permitir_otra_cuenta: true` **en esa llamada** |
| Dry-run por defecto | una llamada de escritura con `confirm: false` que tiene éxito devuelve `cambios` (diff), `avisos` y una vista previa del `payload`, redactada como todo resultado, y no envía ninguna escritura a Póster (puede leer de Póster para armar el diff) |
| Aplicar = `confirm: true` | escribe una sola vez (sin reintentos, para no duplicar) y **lee de vuelta** para verificar |
| Auditoría | el manejador de escrituras registra cada dry-run, aplicación, rechazo y resultado desconocido, con mejor esfuerzo (si un destino falla, la llamada no falla); los argumentos que rechaza la validación de entrada nunca llegan al manejador y no se registran (stdout → Cloud Logging + JSONL en `AUDIT_DIR`). Cada entrada lleva hora, actor, cliente, cuenta, herramienta, método y payload sin token; un dry-run no lleva nada más; un rechazo de Póster agrega la respuesta completa de Póster y el error; una escritura aplicada agrega el `response` de Póster y el resultado de la relectura; un resultado desconocido, o una falla antes de enviar la escritura, agrega el error (si la falla ocurrió antes de armar el plan, la herramienta es `?`, el método es `-` y el payload son los argumentos de la llamada). Una escritura cuyo intento HTTP falló una vez iniciado (error de red, timeout, respuesta que no es JSON) o que recibió un estado HTTP 5xx, diga lo que diga el cuerpo, queda como `desconocido`, igual que una respuesta sin `error` ni resultado (ni `response` ni `success: 1`) y una respuesta sin `error` cuyo `response` es false o null, diga lo que diga `success` (no se relee, y el error incluye la respuesta sin tokens): puede haberse aplicado, así que se verifica con una lectura antes de reintentar. Fuera de esos casos, una respuesta cuyo `error` está presente y no es 0 ni null queda como rechazo. Una escritura aplicada queda como `aplicado`: si la relectura misma falla, `verificacion.ok` es false y un aviso pide no repetirla; una relectura que termina pero no coincide devuelve `verificacion.ok: false` con su propio detalle |
| Redacción de tokens | se leen de GSM (prod), `poster_accounts` (dev) o variables de entorno `POSTER_TOKEN_<CUENTA>`, según `TOKEN_SOURCE`, y viajan en la query string de cada petición a Póster. Los tokens conocidos (los de entorno desde el arranque, los de GSM o MySQL una vez cargados) se enmascaran en resultados, errores y auditoría en sus formas literal, codificada en URL (con los dígitos hexadecimales de los escapes `%XX` en mayúscula o en minúscula) y escapada en JSON, y cualquier valor `token=` se enmascara. `poster_get` recorta una respuesta cuyo texto JSON pasa de 60 000 caracteres: la vista previa se redacta como texto antes de recortarla, así que puede redactar de más pero nunca deja un prefijo de token, y `bytes` es la longitud en caracteres del texto JSON sin redactar |
| Fuera de carta = ocultar | `update_dish` con `visible: false` o `hide_dish`. El único borrado, `delete_old_dish` (`menu.removeDish`), revisa el platillo que lee: el nombre debe terminar en "(old)" y todos sus spots deben estar marcados como ocultos (`visible` "0" o 0; `hide_dish` envía 0). Un platillo sin spots, o con un spot de visibilidad ausente o de otro valor o tipo, se rechaza. La revisión no sabe si se usó `hide_dish` |

## Herramientas

**Lectura** (cualquier cuenta de la lista): `list_accounts`, `menu_snapshot`, `product_details`, `ingredients`,
`prepacks`, `client_groups`, `promotions` (vigentes = `date_end ≥ hoy`, `0000-00-00`, vacío o ausente), `employees`
(con puestos y secciones de acceso), `payment_methods`, `settings` (`settings.getAllSettings`), `supplies`,
`supply_details`, `stock_levels`, `list_stocktakes` (inventarios por almacén con fechas, estado y costo total),
`stocktake_result` (diferencias de un inventario, ordenadas por costo, con faltante y sobrante),
`count_sheet` (hoja de conteo a ciegas, sin existencias ni costos; por defecto solo los artículos cuya existencia en ese almacén no es cero, `include_zero` los lista todos),
`reference_catalogs` (IDs de almacenes/proveedores/categorías para escribir),
`poster_get` (cualquier `<modulo>.get*` crudo), `recent_audit`.

**Escritura** (dry-run por defecto): `create_client_group`, `update_client_group`, `create_ingredient`,
`create_supply`, `update_dish` (updateDish), `update_category` (updateCategory),
`update_prepack` (updatePrepack), `create_category` (createCategory), `create_prepack` (createPrepack),
`create_dish` (createDish con receta y grupos; relee y verifica), `hide_dish` (getProduct + updateDish COMPLETO con receta, visible 0 en los spots del payload que reconstruye y el sufijo del parámetro `sufijo`, por defecto " (old)"),
`update_dish_recipe` (getProduct + updateDish COMPLETO que reemplaza la receta; sin `grupos` conserva los grupos y opciones de modificadores actuales con sus ids, y con `grupos` reemplaza el conjunto: un grupo con el mismo nombre y, dentro de él, una opción con el mismo insumo y tipo conservan su id, los demás se crean y los actuales que no se pasan se borran, según lista el dry-run; reenvía los demás campos a partir de lo leído, entre ellos nombre, categoría, workshop, color, precio y visibilidad; relee y compara receta, grupos, precio y visibilidad),
`delete_old_dish` (menu.removeDish solo para un platillo cuyo nombre termina en "(old)" y cuyos spots están todos marcados como ocultos; relee y verifica),
`create_transaction` (finance.createTransactions: `type` 0 gasto / 1 ingreso / 2 transferencia es OBLIGATORIO; la categoría va como `category` (id, no `category_id`); **el monto se envía en PESOS** —finance.createTransactions NO usa centavos, mientras que `create_supply` y `create_dish` envían centavos—; valida `account_id` y `category` contra `finance.getAccounts`/`getCategories`; tras aplicar relee `finance.getTransactions`, busca el `transaction_id` de la respuesta y compara monto (tolerancia 0.5 pesos), cuenta y categoría —en transferencias solo la cuenta origen y sin categoría—, y marca una posible desviación de unidad de 100× cuando la diferencia supera la tolerancia y el monto leído es unas 100 veces mayor o menor; una respuesta de Póster sin `transaction_id` o sin cuenta se lee como 0 y puede coincidir, y eso no se detecta),
`create_supply` ahora acepta `account_id` opcional (paga al momento; sin él la compra queda a crédito),
`assign_supply_payment` (storage.updateSupply: el botón "pagar" por API — asigna/reasigna la cuenta de Finanzas de una compra a crédito; relee y verifica que quedó la cuenta, que el total no cambió (tolerancia 0.5) y que el número de renglones es el mismo; el efecto en Finanzas no se verifica),
`create_write_off` (storage.createWriteOff en JSON, sin costo: Póster lo calcula; valida almacén, razón, artículos y que la fecha no sea futura; rechaza renglones de tipo modificador; avisa si ya hay mermas en ese almacén ese día; relee `storage.getWaste` y compara almacén, día, razón y cantidades; el contrato sigue la documentación de Póster y no está confirmado en una cuenta real).

**Inventarios**: la API de Póster no permite crear, llenar ni realizar un inventario; el personal lo realiza en Póster. Este servidor lista los inventarios, muestra las diferencias de uno con su costo e imprime una hoja de conteo a ciegas. Por defecto la hoja lista solo los artículos cuya existencia en ese almacén no es cero; `include_zero` los lista todos y `omitted_zero_balance` dice cuántos quedaron fuera. Un faltante encontrado fuera de un inventario se puede registrar con `create_write_off`; Póster lo muestra como merma, no como inventario.

**Solo panel web**: permisos de puestos. La receta de un platillo existente se cambia con `update_dish_recipe` (update_dish rechaza platillos con receta).

## Contratos de Póster (aprendidos en la migración de la 47)

API: `https://<cuenta>.joinposter.com/api/<metodo>?token=…`. Escrituras con cuerpo JSON salvo `createSupply` (multipart).

**Menú / platillos**
- `menu.updateDish` es update **COMPLETO**: hay que reenviar nombre, categoría, workshop, color, `price`, `visible`,
  `modificationgroup` y `"ingredient[]": []`. Omitir `price`/`"ingredient[]"` da `Bad price value` / `Bad ingredient value`.
- **updateDish BORRA la receta** del platillo (la API descarta recetas de platillos en silencio). Guarda:
  *si el platillo tiene `ingredients` → no se toca* (`update_dish` lo rechaza; la receta se cambia con `update_dish_recipe`).
- `price` y `visible` son mapas por spot: `{"1": 2500}`, `{"1": 1}`. El precio del **platillo** se lee y escribe en **centavos**.
- Precio de **opción** de modificador: se **escribe en centavos** (2000) y se **lee en pesos** (20).
- Visibilidad en terminal = `spots[].visible`. El `hidden` de `getProducts` es otro flag: no derivar `visible` de `hidden`.
- Opciones: `{name, ingredientId, ingredient_id, type, brutto, price, sort_order}`; `type` 2 = platillo, 1/10 = insumo.
- Según la documentación, updateDish conserva un grupo solo si lleva `dish_modification_group_id` y una opción solo si lleva `dish_modification_id`; lo que va sin id se crea y lo actual que no va por id se borra.
- **Póster no anida**: un platillo con grupos propios no puede ser opción tipo 2 de otro (`Bad <id> value`).
- `menu.getProduct {product_id}` sí responde (probado 23 oct 2026) con receta y grupos; las altas lo usan y caen a `menu.getProducts` si falla.
- `createDish`/`updateDish` aceptan `ingredient:[{id,type,brutto,netto,lock}]`: con eso la receta se conserva al ocultar.
- `menu.updateCategory {category_id, category_name, parent_category}` funciona.

**Precocinados**
- `menu.updatePrepack` acepta receta por API y la **reemplaza completa**:
  `{prepack_id, product_id, product_name, prepack_unit, out, ingredient:[{id:number, type, brutto, netto, lock, unit}]}`.
  `prepack_unit` (no `unit`), `out` = rendimiento. Las líneas se leen en kg/l pero se escriben en g/ml.
  (También se vio aceptado `id: "1_97"` = `<tipo>_<id>`; aquí se usa `id` numérico + `type`.)
- Métodos de proceso (`clear`, `cook`, `fry`, `stew`, `bake`; se leen como `pr_in_*`): las reescrituras de receta (`update_prepack`, `hide_dish`, `update_dish_recipe`) reenvían los métodos de cada línea tal como se leyeron. La verificación avisa si un método enviado o un neto manual (lock 0) vuelve distinto; un método enviado que no se puede releer se lista como no verificado, y un método que falta en la receta leída se lista como no conservado (Póster puede reiniciarlo). Una línea existente con neto manual (lock 0) se envía con los valores por defecto cuando no se pasan: neto igual al bruto sin `netto` y, en `update_dish_recipe`, también lock 1 sin `lock`. Su neto manual puede perderse entonces; el dry-run lo avisa. `create_prepack` y `create_dish` todavía no pueden fijar métodos.

**Compras e inventario**
- `storage.getSupplies` (lista): `supply_sum` en **centavos**.
- `storage.getSupply` (detalle): `supply_sum` y `supply_ingredient_sum` en **pesos**; el importe del renglón es el **total** del renglón.
- `storage.createSupply`: multipart con `date, storage_id, supplier_id, supply_comment` e `ingredients` = JSON string
  `[{id, type, num, sum}]` (`type` 4 insumo · 1 producto · 5 modificador).
  ⚠ **Sin verificar con compra real**: si `sum` va en centavos o pesos. El servidor envía **centavos por unidad** (lo que
  asumían los probes) y tras aplicar compara el total leído con el esperado; si no cuadra, lo marca con `alerta`.
- `storage.getStorageLeftovers.prime_cost` en centavos; **`menu.getIngredients.prime_cost` viene ×10 000** (1040000 = $104),
  por eso `ingredients` toma el costo de los saldos.
- `storage.getStorageLeftovers`: `ingredient_left` es el total de todos los almacenes; con `storage_id`, `storage_ingredient_left`
  es la existencia de ese almacén (según la documentación, sin verificar en una cuenta real). Con `zero_leftovers=true` vienen
  también los artículos sin existencia en ese almacén. `stock_levels` con `storage_id` y `count_sheet` usan `storage_ingredient_left`.
- `storage.getStorageInventories`: la documentación da `sum` y `sum_netto` en centavos, pero en una cuenta real `sum` llegó en
  **pesos con decimales** (un inventario que Póster muestra como 1 660,17 salía 16.6 al dividirlo entre 100). `list_stocktakes`
  los lee tal cual, redondeados a 2 decimales; que `sum_netto` use la misma unidad no está verificado.

**Finanzas** (`create_transaction`)
- `finance.createTransactions`: `type` 0 gasto · 1 ingreso · 2 transferencia. Gasto usa `account_from`/`amount_from`;
  ingreso `account_to`/`amount_to`; transferencia ambos pares (`account_from`→`account_to`). La categoría va como `category` (el `category_id` de la herramienta), solo en gasto/ingreso.
- ⚠ **Unidad del monto**: el servidor **envía pesos** (a diferencia de `create_supply`, que envía centavos); al LEER (`finance.getTransactions`)
  trata los montos como **centavos**. Tras aplicar relee las transacciones entre la fecha de la transacción y hoy y busca la del `transaction_id`
  de la respuesta. Si la diferencia de monto supera la tolerancia de 0.5 pesos y es de unas **100×**, lo marca con `alerta_100x` y pide no
  reintentar. En transferencias solo se revisa la cuenta origen. Una respuesta sin `transaction_id` o sin cuenta se lee como 0 y puede coincidir: no se detecta.
- `account_id`/`account_destino_id` = cuentas de `finance.getAccounts`; `category_id` = `finance.getCategories`. `date` = `YYYY-MM-DD HH:MM:SS` (hora de la zona `TIMEZONE`).

**Compras y su pago**
- El **número de compra = `supply_id`** del almacén. `storage.getSupply`/`getSupplies` traen `account_id` = la cuenta que pagó; **`account_id` vacío `""` = a crédito (sin pagar)**. El detalle (`getSupply`) viene en **pesos**; la lista (`getSupplies`) en **centavos**.
- Al fijar `account_id` a una compra, Póster **autogenera** la transacción de Finanzas (type 0, categoría Compras) **ligada por `binding_type 12` + `binding_id = supply_id`**, con `recipient_type 12`/`recipient_id = supplier_id`.
- `assign_supply_payment` = `storage.updateSupply` (update COMPLETO: relee y reenvía la compra cambiando solo `account_id`). ⚠ **Contrato de updateSupply sin verificar en vivo**: tras aplicar se relee y se compara total y # de renglones; si algo cambió, se marca para corregir en el panel.

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
| `MCP_TRANSPORT` | `http` | `http`: un servidor HTTP en `PORT` con el endpoint `/mcp`; necesita `MCP_BEARER_TOKEN` u OAuth. `stdio`: el cliente MCP lanza el proceso y habla con él por stdin/stdout; no se abre ningún puerto, no hace falta autenticación y todo el log (arranque y auditoría) va a stderr. Exactamente uno de los dos, sin recortar. En blanco = por defecto |
| `POSTER_TOKEN_<CUENTA>` | sin definir | Solo con `env`; con `gsm` y `mysql` se ignora. Una por cuenta de `POSTER_ACCOUNTS`, con el nombre de la cuenta en mayúsculas y cada guion cambiado por guion bajo (`cafe-04` → `POSTER_TOKEN_CAFE_04`); las variables de cuentas fuera de la lista no se leen. Con la lista por defecto son diez variables, de `POSTER_TOKEN_CAFE_01` a `POSTER_TOKEN_CAFE_10`. Cada valor se recorta y luego debe cumplir `^[A-Za-z0-9:._~-]{16,}$`: al menos 16 caracteres, solo letras ASCII, dígitos y `:` `.` `_` `~` `-` (un token `<id de cuenta>:<hex>` cumple; esa forma es un ejemplo, no un formato de token de Póster verificado). Falla un token que falta o está en blanco, o que no tiene ese formato, y un solo error nombra todas las variables que fallan y nunca cita un valor. Se lee una vez al arrancar, así que un token cambiado vale tras reiniciar; con `gsm` o `mysql` el token se guarda en caché 10 minutos y se vuelve a leer en la primera búsqueda después de ese plazo. Estos tokens se quitan de los mensajes de error y de las entradas de auditoría, también los de cuentas nunca consultadas |
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
| `MCP_BEARER_TOKEN` | un secreto aleatorio, por ejemplo la salida de `openssl rand -hex 32` (solo HTTP; con `MCP_TRANSPORT=stdio` se omite) |

Son valores para la plataforma, no un script para ejecutar; cada token se captura tal cual, sin comillas. No hacen
falta `GCP_PROJECT_ID`, `SECRET_PREFIX`, `POSTER_MYSQL_URL` ni `FINANZAS_ENV_PATH`; `PORT` y `PUBLIC_BASE_URL` se
definen según lo pida la plataforma. Escribir en `tienda-sur` sigue exigiendo `permitir_otra_cuenta: true`. Si una
variable de token falta o está en blanco, o su token no cumple la regla de formato de la tabla de arriba, el servidor
se detiene al arrancar con un error que nombra la variable y nunca cita su valor.

### Ejecutar con npx

El servidor corre sin clonar el repositorio: `npx` descarga el repositorio en una etiqueta, instala las dependencias,
compila TypeScript con el script `prepare` y arranca el servidor. Con las variables de arriba en el entorno:

```bash
npx -y github:null-topology/poster-pos-mcp#v0.5.1
```

- Requiere Node.js 20 o superior, `git` en el `PATH` y scripts de instalación habilitados (sin `--ignore-scripts`).
  La primera ejecución compila el paquete; las siguientes usan la caché de npx.
- Fija una etiqueta: sin `#<etiqueta>` se ejecuta la rama principal tal como esté en ese momento.
- No se lee un `.env` del directorio actual. El `AUDIT_DIR` por defecto (`./audit`) queda dentro de la caché de npx;
  define `AUDIT_DIR` con un directorio con permiso de escritura.
- Por HTTP el endpoint MCP es `http://<host>:<PORT>/mcp` (puerto por defecto 3210). El servidor escucha en todas las
  interfaces.

Para que un cliente MCP lance el servidor él mismo por stdio, define `MCP_TRANSPORT=stdio`; entonces no hacen falta
`MCP_BEARER_TOKEN`, OAuth, `PORT` ni `PUBLIC_BASE_URL`. Una configuración de cliente en el formato habitual
`mcpServers`:

```json
{
  "mcpServers": {
    "poster": {
      "command": "npx",
      "args": ["-y", "github:null-topology/poster-pos-mcp#v0.5.1"],
      "env": {
        "MCP_TRANSPORT": "stdio",
        "TOKEN_SOURCE": "env",
        "POSTER_ACCOUNTS": "tienda-norte,tienda-sur",
        "POSTER_TOKEN_TIENDA_NORTE": "<token de tienda-norte>",
        "POSTER_TOKEN_TIENDA_SUR": "<token de tienda-sur>",
        "DEFAULT_WRITE_ACCOUNT": "tienda-norte",
        "WRITE_DEFAULT_ACCOUNTS": "tienda-norte",
        "AUDIT_DIR": "/ruta/a/auditoria"
      }
    }
  }
}
```

El primer arranque compila el paquete antes de que el servidor responda, unos 10-15 segundos; los siguientes arrancan
desde la caché de npx.

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
Cubre `menu_snapshot`, `product_details`, `ingredients`, `prepacks`, `client_groups`, `promotions`, `employees`,
`payment_methods`, `settings`, `supplies`, `supply_details`, `stock_levels`, `reference_catalogs` y `poster_get`, y el dry-run de
`update_dish`, `update_category`, `update_prepack`, `create_ingredient`, `create_supply`,
`create_client_group` y, si la cuenta tiene algún grupo, `update_client_group`.

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
src/tokens.ts       env / GSM / MySQL (GSM y MySQL con caché 10 min), redacción
src/poster.ts       cliente HTTP (reintenta lecturas, 1 intento en escrituras)
src/audit.ts        auditoría
src/tools/lectura.ts, src/tools/escritura.ts
src/mcp.ts          registro de herramientas (zod)
src/auth.ts         OAuth + bearer
src/server.ts       Hono: /health, OAuth, /mcp
scripts/subir-tokens-gsm.mts   DB local → Secret Manager (sin imprimir tokens)
```
