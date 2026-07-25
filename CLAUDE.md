# app-materiales

App web para el almacenista de obra. Sister app de **app-estimaciones** (ingeniero de campo) y **appsogrub/Bitácora** (contador). Aquí no hay generadores ni estimaciones de obra: solo catálogo de materiales por obra, requisiciones, recepciones y salidas con cargo a concepto OPUS.

## Stack
- Vanilla JS (módulos ES nativos), HTML, CSS — sin frameworks ni bundler
- Firebase Realtime Database + Auth (proyecto `sogrub-suite`, compartido con las hermanas)
- SheetJS (CDN) para parsear el XLS de materiales exportado de OPUS

## Decisiones de producto (2026-04-30)

1. **Firebase unificado** en `sogrub-suite`. La app de materiales escribe sus datos bajo `/shared/materiales/{obraId}/*`. Lee usuarios y obras desde `/legacy/estimaciones/*` (fuente única, NO se duplica).
2. **Roles**:
   - `admin` — global (mismo admin de la suite). Sube XLS, asigna almacenistas a obras.
   - `almacenista` — rol nuevo. Solo ve sus obras asignadas, captura requisiciones/recepciones/salidas.
   - `ingeniero` — opcional, solo lectura del almacén (TBD si se habilita).
3. **Catálogo de materiales** se importa desde el XLS de OPUS exportado con esta config exacta:
   - Filtro `Tipo: Materiales`, **Explotar hasta `Insumos básicos`**, **Incluir solo `Materiales`**.
   - Columnas en orden: `Clave, Descripción, Unidad, Familia, Subfamilia, Marca, Cantidad, Costo, Importe, Ultima actualización, Proveedor, Donde se usa`.
   - "Donde se usa" trae lista de claves de conceptos finales en formato `[clave1], [clave2], ...`.
4. **Sin auxiliares ni matrices**: el cross-reference probó que el 100% de las refs en "Donde se usa" son claves de conceptos del catálogo principal de la obra (los prefijos `G`, `C`, `Z`, `T`, `TR`, `SALHD`, etc. son claves arbitrarias del cliente, no taxonomía OPUS).
5. **Resolución material → conceptos**: cada material guarda `conceptosDirectos: [conceptoKey, ...]` resuelto contra `/shared/catalogos/{obraId}` al momento del import. Caso colisión Torre 1 / Torre 2 (clave repetida): se incluyen TODOS los conceptoKeys; el almacenista desambigua al capturar salida con un dropdown que muestra la jerarquía.
6. **Ledger simple, no kardex**: entradas (recepciones) y salidas (consumo a concepto) sin costeo PEPS/promedio ni lotes/ubicaciones. Si en el futuro se necesita sub-almacenes, se agrega `ubicacionId` a cada movimiento sin tocar la jerarquía principal — un almacén por obra es el default.
7. **Dos flujos de adquisición** (definidos por Fernando):
   - **A — Con OC**: almacenista requisita → compras cotiza/genera PO → buzón `tipo='oc_materiales'` → contador aprueba → CxP → al pagar, factura del proveedor cierra.
   - **B — Caja chica**: auxiliar compra directo en sitio con caja chica → almacenista registra recepción + foto del ticket + concepto OPUS al que se carga → buzón `tipo='gasto_caja_chica'` → contador pide factura al negocio → al recibirla se vuelve `gasto` con `categoria='Materiales'` y `desglose_presupuesto` ya armado.
8. **`materialKey`**: `{clave}_{hash6(stableKey)}` con stableKey = `tipo|clave|descripcion|unidad`. FNV-1a 32-bit, mismo patrón que conceptoKey en estimaciones — determinístico, idempotente, desambigua si dos obras importan claves repetidas con marca/unidad distinta.
9. **Materiales ad-hoc**: el almacenista puede crear materiales que no estén en el catálogo OPUS desde el modal de agregar item (botón "+ Nuevo material"). Quedan con `origen: 'ad_hoc'` y `creadoPor: uid`. El re-import del XLS los **preserva** (en `saveCatalogoMateriales`), salvo que OPUS produzca el mismo `materialKey` (misma clave + descripción + unidad) — en ese caso lo absorbe. Es el release valve para la realidad de obra que diverge del catálogo.
10. **Concepto fuera de sugerencias**: en cualquier item, además de los conceptos sugeridos por `conceptosDirectos` (de "Donde se usa" de OPUS), el dropdown ofrece "Otro… (elegir de toda la lista)" que abre un picker con todos los conceptos del catálogo. Permite ajustes en obra cuando el concepto destino no está en la lista pareada por OPUS.
11. **Edición de familia/marca/proveedor desde la app (catálogo)**: el almacenista o admin puede editar `familia`, `subfamilia`, `marca` y `proveedor` de cualquier material clickeando la celda "Familia / Marca" en `/obras/{id}/catalogo`. Se escribe en `/shared/materiales/{obraId}/catalogo/items/{materialKey}` directo — como `app-compras` lee del mismo path, ve el cambio sin sync extra. Cada campo editado deja un flag en `manualOverrides: { familia: true, ... }`. En el re-import del XLS de OPUS, `saveCatalogoMateriales` respeta esos overrides aunque OPUS traiga otro valor, hasta que el round-trip cierre (exportar XLS desde aquí → cargarlo en OPUS → siguiente export de OPUS ya trae el valor correcto, y el override coincide con el valor → no se nota). El exporter ya escribe Familia/Subfamilia/Marca/Proveedor en las 12 columnas estándar, así que OPUS lo absorbe al re-importar el XLS exportado.
12b. **Dos fondos por obra (2026-07-25)**: cada movimiento de `/shared/cajaChica` pertenece a un fondo — `fondo` ausente = **transferencia** (histórico) o `fondo:'efectivo'` = **fondo de efectivo** (billete físico). `computeSaldoCajaChica(movimientos, fondo)` calcula el saldo del fondo pedido; la vista tiene pills 🏦/💵. En el fondo efectivo TODO depósito aprobado cuenta al saldo (el contador lo saca de la caja física de SOGRUB al aprobar, no de Mifel) y el depósito SÍ pasa por el buzón (`deposito_caja_chica` con `fondo:'efectivo'`). Al reportar una recepción de caja chica se elige de qué fondo salió (`gasto_caja_chica` con `fondo:'efectivo'` si aplica). El depósito "efectivo" sin `fondo` sigue siendo informativo (legacy). Contrato completo: `appsogrub/docs/spec-caja-chica-fondo-efectivo.md`.

12. **Caja chica por obra**: módulo en `/shared/cajaChica/{obraId}/` (compartido con `appsogrub`). Movimientos: `tipo: 'deposito' | 'gasto'`. Ambos tienen `estado: 'solicitado' | 'reportado' | 'aprobado' | 'rechazado'` (depósitos usan `solicitado`/`aprobado`/`rechazado`; gastos usan `reportado`/`aprobado`/`rechazado`). Depósitos llevan también `metodoDeposito: 'transferencia' | 'efectivo'`. Esta app **solo solicita y reporta**: la autoridad de aprobación vive solo en bitácora — desde aquí no hay botones Aprobar/Rechazar/Reabrir. Saldo conciliado = sum(depósitos transferencia con estado=aprobado) − sum(gastos con estado=aprobado). Efectivo nunca afecta saldo; los pendientes (solicitado/reportado) tampoco — solo se ven en KPI "Pendiente de aprobación". Flujo: almacenista/admin **solicita depósito** (transferencia o efectivo) → publica al buzón con tipo `deposito_caja_chica` → contador aprueba o rechaza en bitácora → cross-app sync actualiza el estado y el saldo se recalcula en ambas apps. Almacenista crea recepción tipo `caja_chica` y la "reporta" → publica al buzón con tipo `gasto_caja_chica` → mismo flujo de aprobación. Si saldo cae bajo el `umbralAlerta` (default $1,000, configurable), aparece alerta visual con leyenda "solicita depósito al contador". Backward compat: depósitos viejos sin `estado` se asumen aprobados.

## Routing cross-app

| Origen (app-materiales)            | Destino contador (`appsogrub`)              | Destino compras (futura)        |
|------------------------------------|---------------------------------------------|---------------------------------|
| Requisición                        | ❌                                          | ✅ (cotiza, genera OC)          |
| Recepción tipo OC                  | ✅ vía `gasto_oc` (contador aprueba y registra el gasto) | ✅ (futuro: compras concilia la OC) |
| Recepción tipo caja_chica          | ✅ vía `gasto_caja_chica`                   | ❌                              |
| Salida (consumo de almacén)        | ❌ (info interna del almacén)               | ❌                              |
| Caja chica · depósito transferencia| ✅ vía `deposito_caja_chica`                | ❌                              |
| Caja chica · depósito efectivo     | ❌ (efectivo ya estaba contabilizado)       | ❌                              |
| Caja chica · gasto aprobado/rechazado | ✅ se sincroniza el item ya publicado     | ❌                              |

## Contratos del buzón (`/shared/buzon/{itemId}`) que esta app publica

### `gasto_caja_chica`
Reportado al crear/actualizar el gasto desde una recepción de caja chica.
```js
{
  tipo: 'gasto_caja_chica',
  origenApp: 'materiales',
  obraId,
  movimientoId,         // id en /shared/cajaChica/{obraId}/movimientos
  refRecepcionId,       // id en obras/{obraId}/recepciones
  ivaMode,              // 'sin_iva' | 'mas_iva' | 'iva_incluido'
  monto,                // total CON IVA (== total). El movimiento de caja chica usa este.
  subtotal,             // SIN IVA (== sum(desglose.monto))
  iva,                  // según ivaMode
  total,                // alias de monto
  fecha, comentario,
  proveedor, factura,
  desglose: [{ conceptoKey, conceptoClave, conceptoDescripcion, monto }, ...],   // SIN IVA, sum === subtotal
  autor: { uid, displayName, email },
  estado: 'recibido' | 'en_revision' | 'aprobado' | 'rechazado' | 'huerfano'
}
```
**Lo que debe hacer bitácora al aprobar**: crear gasto contable bajo `categoria='Caja chica'` (o similar) con `desglose_presupuesto` mapeado por `conceptoKey`, asociado al proyecto resuelto vía `/shared/obraLinks/{obraId}`. Al cambiar el estado en bitácora, sincronizar al item del buzón y vía hook al `/shared/cajaChica/{obraId}/movimientos/{movimientoId}` para que el saldo conciliado refleje el cambio en ambas apps.

### `gasto_oc`
Publicado al enviar una recepción **de OC** al contador (botón "↗ Enviar al contador").
La recepción pasa a `estado='enviada_buzon'` + `buzonId`. El payload es self-contained
(bitácora no necesita leer la recepción ni el catálogo).
```js
{
  tipo: 'gasto_oc',
  origenApp: 'materiales',
  obraId,
  refRecepcionId,       // id en obras/{obraId}/recepciones
  folio,                // 'E-0006'
  numero,
  origenTipo: 'oc',
  reqId,                // requisición vinculada, si la hay (o null)
  formaPago,            // 'credito' | 'efectivo' | 'transferencia' | 'caja_chica'
  ivaMode,              // 'sin_iva' | 'mas_iva' | 'iva_incluido' (cómo se derivó el IVA)
  monto,                // total del gasto CON IVA (== total). Compat: úsalo como total.
  subtotal,             // suma de items SIN IVA (== sum(desglose.monto))
  iva,                  // IVA calculado según ivaMode
  total,                // total con IVA (alias de monto)
  fecha, comentario,
  proveedor, factura,
  items: [{ materialKey, clave, descripcion, unidad, cantidad, costoUnitario, importe, conceptoKey }, ...],
  desglose: [{ conceptoKey, conceptoClave, conceptoDescripcion, monto }, ...],   // SIN IVA, sum(monto) === subtotal
  autor: { uid, displayName, email },
  estado: 'recibido' | 'en_revision' | 'aprobado' | 'rechazado' | 'huerfano'
}
```
**Garantía del emisor**: solo se envía si TODOS los items tienen `conceptoKey` y el subtotal > 0,
así que `sum(desglose.monto) === subtotal` y `subtotal + iva === total === monto`.
**Es un GASTO (por pagar/pagado), NO un ingreso** — el stepper correcto es *Devengado → Por pagar → Pagado*, no *por cobrar*.
**Lo que debe hacer bitácora al aprobar**: crear el gasto contable con `categoria='Materiales'`,
importe = `total` (subtotal + iva), y `desglose_presupuesto` mapeado por `conceptoKey` (montos SIN
IVA, suman `subtotal`; el IVA es acreditable, línea aparte), asociado al proyecto vía
`/shared/obraLinks/{obraId}`. El **`formaPago`** define la liquidación:
- `credito` → gasto + cuenta por pagar (CxP); queda *por pagar* hasta que se liquide.
- `efectivo` → gasto YA pagado (salida de efectivo), sin CxP.
- `transferencia` → gasto YA pagado (salida de banco), sin CxP; concilia contra el banco.
- `caja_chica` → gasto pagado desde el fondo formal de caja chica (afecta su saldo).

Al cambiar el estado (aprobado/rechazado, con `motivoRechazo`), sincronizarlo de regreso al item
del buzón — esta app lo lee por `buzonId` para mostrar el estado y, si se rechaza, permitir
"↺ Reabrir" y reenviar.

### `deposito_caja_chica`
Publicado al **solicitar** un depósito (cualquier método). El depósito nace en `/shared/cajaChica` con `estado='solicitado'` y NO afecta saldo hasta que el contador apruebe en bitácora.
```js
{
  tipo: 'deposito_caja_chica',
  origenApp: 'materiales',
  obraId,
  movimientoId,
  monto, fecha, comentario,
  metodoDeposito: 'transferencia' | 'efectivo',  // ambos casos llegan al buzón
  autor,
  estado: 'recibido' | 'aprobado' | 'rechazado' | ...
}
```
**Lo que debe hacer bitácora al aprobar**:
- Si `metodoDeposito === 'transferencia'`: registrar movimiento bancario (egreso del banco origen + ingreso a la cuenta "Caja Chica Obra X"). Al sincronizar de regreso, el `/shared/cajaChica/{obraId}/movimientos/{movimientoId}` queda con `estado='aprobado'` y entonces SÍ suma al saldo conciliado del lado materiales.
- Si `metodoDeposito === 'efectivo'`: NO hay movimiento bancario nuevo (el efectivo ya estaba contabilizado al retirarlo del banco previamente). Solo confirmar la solicitud cambiando `estado='aprobado'` en el buzón y en el movimiento; el saldo conciliado **no** cambia.

## Heads-up: lado contador de la bitácora (pendiente en `appsogrub`)

`appsogrub` debe agregar:
1. Vista de caja chica por obra leyendo `/shared/cajaChica/{obraId}/{meta,movimientos}`. Mismo patrón que aquí pero con la perspectiva contable (botones para asentar el movimiento bancario).
2. Manejo de los nuevos `tipo` del buzón: `gasto_caja_chica`, `deposito_caja_chica` y `gasto_oc`. Las máquinas de estado existentes (`recibido → en_revision → aprobado → cerrado`) ya cubren el flujo. Folios atómicos según el tipo (CC para depósito, CP para gasto de caja chica, y el gasto de OC va a `categoria='Materiales'` con su `desglose_presupuesto` por `conceptoKey`). Para `gasto_oc` el hook bidireccional escribe de regreso a `/shared/materiales/{obraId}/recepciones/{refRecepcionId}` (o al item del buzón, que la app lee por `buzonId`) el `estado` y el `motivoRechazo`.
3. Hook bidireccional: cuando el contador cambia el estado en bitácora, también escribir en `/shared/cajaChica/{obraId}/movimientos/{movimientoId}` para que esta app refleje el cambio. Patrón análogo al ya existente entre estimaciones y bitácora vía `origen_buzon_id`.

## Modelo de datos (Firebase RTDB)

### Bajo `/shared/materiales/{obraId}/*` (escribe esta app)

```
/shared/materiales/{obraId}/meta:
  sourceFileName, importedAt, version, conceptosResueltos, conceptosNoResueltos,
  totalMaterials, totalImporteOpus

/shared/materiales/{obraId}/catalogo/{materialKey}:
  clave, descripcion, unidad,
  familia, subfamilia, marca, proveedor,
  cantidadOpus, costoUnitario, importe, ultimaActualizacion,
  conceptosDirectos: [conceptoKey, ...],   # 1 o más; resuelto al importar
  refsRaw: [string, ...],                  # claves originales del XLS para audit
  archivado: bool

/shared/materiales/{obraId}/requisiciones/{reqId}:
  numero, fechaSolicitud, solicitadoPor,
  items: [{ materialKey, cantidad, conceptoKey?, notas }],
  estado: 'borrador' | 'enviada' | 'cotizada' | 'aprobada' | 'cancelada',
  ocBuzonId   # cuando compras genera la OC

/shared/materiales/{obraId}/recepciones/{recId}:
  fecha, recibidoPor,
  origenTipo: 'oc' | 'caja_chica',
  origenRef,                  # reqId si oc, ticketUrl si caja_chica
  proveedor, factura?,
  totalRecepcion,             # BASE = suma de items (cantidad×costo)
  ivaMode: 'sin_iva' | 'mas_iva' | 'iva_incluido',   # default 'sin_iva'
  ivaRate,                    # default 0.16. subtotal/iva/total se derivan (ver computeRecepcionMontos)
  formaPago?,                 # al enviar OC: credito|efectivo|transferencia|caja_chica
  items: [{ materialKey, cantidad, costoUnitario, conceptoKey? }],
  fotos: [driveFileId, ...],
  buzonId     # set al enviar a bitácora

/shared/materiales/{obraId}/salidas/{salId}:
  fecha, autorizadoPor,
  conceptoKey,                # principal — un salida = un concepto destino
  items: [{ materialKey, cantidad }],
  notas
```

### Bajo `/legacy/estimaciones/*` (lee esta app, NO escribe)

```
/legacy/estimaciones/users/{uid}:
  email, displayName, role, obrasAsignadas/{obraId}: true

/legacy/estimaciones/obras/{obraId}/meta:
  nombre, ubicacion, contratoNo, cliente, ...
```

### Bajo `/shared/*` (cross-app)

```
/shared/catalogos/{obraId}/conceptos/{conceptoKey}: ...   # solo lectura
/shared/buzon/{itemId}: { tipo, origenApp: 'materiales', ... }

/shared/cajaChica/{obraId}/
  meta: { umbralAlerta, createdAt, updatedAt }
  movimientos/{movId}:
    tipo: 'deposito' | 'gasto'
    estado: 'reportado' | 'aprobado' | 'rechazado'   # solo gastos
    monto, fecha, comentario,
    autor: { uid, displayName, email },
    refRecepcionId?,                                  # si es gasto vinculado
    aprobadoAt?, aprobadoPor?, rechazadoAt?, rechazadoPor?, motivoRechazo?
```

## Estructura de archivos

```
index.html
css/main.css
js/
  main.js
  config/firebase-config.js
  services/
    firebase.js
    auth.js
    db.js                        # paths absolutos /shared/* y /legacy/*
    opus-materiales-parser.js    # XLS → catálogo + resolución conceptosDirectos
    material-keys.js             # computeMaterialKey
  state/store.js, router.js
  util/dom.js, format.js
  views/
    login.js, shell.js,
    obras.js, obra.js, admin.js,
    catalogo.js,                 # listado del catálogo de materiales
    salidas.js,                  # capturar salida + cargo a concepto
    requisiciones.js, recepciones.js   # stubs v1
```

## Cómo arrancar

1. `python serve.py 8081`
2. Abrir http://localhost:8081/
3. Iniciar sesión con cuenta de admin de `sogrub-suite`. Si no hay almacenistas creados, el admin los crea desde `/admin` y les asigna obras.
4. Subir XLS de materiales desde la vista de la obra (admin only).

## Reglas de Firebase RTDB (pendiente, post-MVP)

Mismo patrón que estimaciones/bitácora: lectura/escritura libre para admin; `almacenista` solo lee/escribe en `/shared/materiales/{obraId}/*` si su `obrasAsignadas/{obraId}` es `true`. Lectura de `/shared/catalogos/{obraId}` y `/legacy/estimaciones/obras/{obraId}` requerida también para esa misma obra.
