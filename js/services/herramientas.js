// === Inventario de herramienta y equipo ===
//
// Vive en /shared/herramientas (nodo suite-level, NO colgado de una obra) porque
// la herramienta es de SOGRUB, no de la obra: se compra una vez y va rotando.
// Cada obra ve "lo que está aquí" filtrando el mismo ledger — por eso el módulo
// global vive antes de Obras y dentro de cada obra hay una vista espejo.
//
// Dos modos de control (`tipoControl`):
//   'unitario' — un registro = UNA pieza física, con folio propio, número de
//                serie, foto e historial individual. Para lo que importa saber
//                CUÁL (rotomartillo, revolvedora, nivel láser, generador).
//   'cantidad' — un registro = un TIPO de herramienta con existencias repartidas
//                entre almacén y obras (20 palas, 15 cubetas, 8 carretillas).
//
// Ubicación: NO se guarda como campo mutable. Cada movimiento declara `origen` y
// `destino`, y dónde está cada pieza se DERIVA sumando el ledger
// (computeEstadoHerramientas). Así nunca hay drift entre el campo y el historial,
// y el "acta" de quién la tiene sale del mismo lugar que el inventario.

import { rread, rset, rpush, rupdate, rremove } from './db.js';

export const HERRAMIENTAS_PATH = '/shared/herramientas';
const CATALOGO_PATH = `${HERRAMIENTAS_PATH}/catalogo`;
const MOVIMIENTOS_PATH = `${HERRAMIENTAS_PATH}/movimientos`;

// === Ubicaciones ===
// Un string identifica cada ubicación del ledger. Obras usan el prefijo `obra:`.
export const UBIC_ALMACEN = '__almacen__';   // bodega central SOGRUB
export const UBIC_EXTERNO = '__externo__';   // fuera del inventario: alta, baja, pérdida, venta

export const ubicObra = (obraId) => `obra:${obraId}`;
export function parseUbic(u) {
  if (typeof u === 'string' && u.startsWith('obra:')) return { tipo: 'obra', obraId: u.slice(5) };
  if (u === UBIC_ALMACEN) return { tipo: 'almacen', obraId: null };
  return { tipo: 'externo', obraId: null };
}
export function labelUbic(u, obras) {
  const p = parseUbic(u);
  if (p.tipo === 'almacen') return '🏚 Almacén central';
  if (p.tipo === 'externo') return 'Fuera de inventario';
  const nombre = obras?.[p.obraId]?.meta?.nombre || obras?.[p.obraId]?.nombre;
  return '🏗 ' + (nombre || p.obraId.slice(0, 6));
}

// === Catálogos de apoyo ===
export const TIPOS_CONTROL = [
  { value: 'unitario', label: 'Por pieza (folio y serie propios)' },
  { value: 'cantidad', label: 'Por cantidad (existencias)' }
];

export const ESTADOS_FISICOS = [
  { value: 'nuevo',       label: 'Nuevo',           tag: 'ok' },
  { value: 'bueno',       label: 'Bueno',           tag: 'ok' },
  { value: 'regular',     label: 'Regular',         tag: '' },
  { value: 'malo',        label: 'Malo',            tag: 'warn' },
  { value: 'reparacion',  label: 'En reparación',   tag: 'warn' },
  { value: 'baja',        label: 'Baja',            tag: 'danger' }
];
export const estadoFisicoLabel = (v) => ESTADOS_FISICOS.find(e => e.value === v)?.label || v || '—';
export const estadoFisicoTag = (v) => ESTADOS_FISICOS.find(e => e.value === v)?.tag ?? 'muted';

export const CATEGORIAS_SUGERIDAS = [
  'Herramienta eléctrica', 'Herramienta manual', 'Medición y trazo',
  'Equipo de seguridad', 'Andamiaje y cimbra', 'Maquinaria menor',
  'Equipo de bombeo', 'Accesorios y consumible durable', 'Mobiliario de obra'
];

// Motivos del ledger. `afectaExistencia:false` = movimiento de bitácora
// (cambio de resguardo/estado): origen === destino, no mueve cantidades.
export const MOTIVOS = {
  alta:         { label: 'Alta',              icon: '➕', afectaExistencia: true },
  asignacion:   { label: 'Asignación a obra', icon: '🚚', afectaExistencia: true },
  devolucion:   { label: 'Devolución',        icon: '↩',  afectaExistencia: true },
  traspaso:     { label: 'Traspaso',          icon: '⇄',  afectaExistencia: true },
  baja:         { label: 'Baja',              icon: '🗑', afectaExistencia: true },
  perdida:      { label: 'Pérdida / robo',    icon: '⚠',  afectaExistencia: true },
  ajuste:       { label: 'Ajuste de existencia', icon: '⚖', afectaExistencia: true },
  resguardo:    { label: 'Cambio de resguardo', icon: '👤', afectaExistencia: false },
  estado:       { label: 'Cambio de estado',  icon: '🔧', afectaExistencia: false }
};
export const motivoLabel = (m) => MOTIVOS[m]?.label || m || '—';
export const motivoIcon = (m) => MOTIVOS[m]?.icon || '•';

// === Lecturas ===
export async function listHerramientas() {
  return (await rread(CATALOGO_PATH)) || {};
}
export async function getHerramienta(hid) {
  return await rread(`${CATALOGO_PATH}/${hid}`);
}
export async function listMovimientosHerramientas() {
  return (await rread(MOVIMIENTOS_PATH)) || {};
}
export async function getHerramientasMeta() {
  return (await rread(`${HERRAMIENTAS_PATH}/meta`)) || null;
}

// Folio legible autoincremental global: HE-0001.
export function nextNumero(catalogo) {
  return Math.max(0, ...Object.values(catalogo || {}).map(x => Number(x?.numero) || 0)) + 1;
}
export const folioHerramienta = (h) => `HE-${String(h?.numero || 0).padStart(4, '0')}`;

// === Escrituras ===
//
// Crear siempre genera el movimiento de ALTA (externo → ubicación inicial), para
// que la existencia derivada del ledger cuadre desde el primer día.
export async function createHerramienta(data, autor, opts = {}) {
  const catalogo = await listHerramientas();
  const numero = nextNumero(catalogo);
  const tipoControl = data.tipoControl === 'cantidad' ? 'cantidad' : 'unitario';
  const cantidadInicial = tipoControl === 'unitario' ? 1 : Math.max(1, Number(data.cantidadInicial) || 1);
  const now = Date.now();

  const record = {
    numero,
    nombre: (data.nombre || '').trim(),
    descripcion: (data.descripcion || '').trim() || null,
    categoria: (data.categoria || '').trim() || null,
    marca: (data.marca || '').trim() || null,
    modelo: (data.modelo || '').trim() || null,
    tipoControl,
    unidad: tipoControl === 'cantidad' ? ((data.unidad || 'pza').trim() || 'pza') : 'pza',
    numeroSerie: tipoControl === 'unitario' ? ((data.numeroSerie || '').trim() || null) : null,
    estado: data.estado || 'bueno',
    fotoUrl: (data.fotoUrl || '').trim() || null,
    costo: Number(data.costo) || 0,
    fechaCompra: data.fechaCompra || null,
    proveedor: (data.proveedor || '').trim() || null,
    proveedorId: data.proveedorId || null,
    factura: (data.factura || '').trim() || null,
    ultimoMantenimiento: data.ultimoMantenimiento || null,
    notas: (data.notas || '').trim() || null,
    archivado: false,
    createdAt: now,
    createdBy: autor || null,
    updatedAt: now
  };

  const hid = await rpush(CATALOGO_PATH, record);

  const destino = opts.ubicacionInicial || UBIC_ALMACEN;
  await addMovimiento({
    herramientaKey: hid,
    motivo: 'alta',
    origen: UBIC_EXTERNO,
    destino,
    cantidad: cantidadInicial,
    fecha: data.fechaCompra || now,
    responsable: (opts.responsable || '').trim() || null,
    notas: opts.notasAlta || null,
    autor
  });

  return hid;
}

export async function updateHerramienta(hid, patch) {
  return rupdate(`${CATALOGO_PATH}/${hid}`, { ...patch, updatedAt: Date.now() });
}
export async function deleteHerramienta(hid) {
  // Borra el registro y todo su ledger. Solo admin, y solo para capturas erróneas:
  // para retirar herramienta real del inventario se usa el motivo 'baja'.
  const movs = await listMovimientosHerramientas();
  for (const [id, m] of Object.entries(movs)) {
    if (m.herramientaKey === hid) await rremove(`${MOVIMIENTOS_PATH}/${id}`);
  }
  return rremove(`${CATALOGO_PATH}/${hid}`);
}

export async function addMovimiento(mov) {
  const clean = {
    herramientaKey: mov.herramientaKey,
    motivo: mov.motivo || 'asignacion',
    origen: mov.origen || UBIC_ALMACEN,
    destino: mov.destino || UBIC_ALMACEN,
    cantidad: Math.max(0, Number(mov.cantidad) || 0),
    fecha: mov.fecha || Date.now(),
    responsable: (mov.responsable || '').trim() || null,
    notas: (mov.notas || '').trim() || null,
    autor: mov.autor || null,
    createdAt: Date.now()
  };
  return rpush(MOVIMIENTOS_PATH, clean);
}
export async function deleteMovimiento(movId) {
  return rremove(`${MOVIMIENTOS_PATH}/${movId}`);
}

// === Derivación del estado (ledger → dónde está y con quién) ===
//
// Puro y testeable. Devuelve un Map herramientaKey → {
//   porUbicacion: Map(ubic → cantidad>0),
//   almacen, enObras: Map(obraId → cantidad), fueraInventario,
//   total,                       // piezas vivas (sin las dadas de baja/perdidas)
//   responsables: Map(ubic → { nombre, desde }),
//   movs: [{ id, ...mov }]       // historial ordenado por fecha ASC
// }
export function computeEstadoHerramientas(catalogo, movimientos) {
  const out = new Map();
  const ensure = (hid) => {
    if (!out.has(hid)) {
      out.set(hid, {
        porUbicacion: new Map(),
        enObras: new Map(),
        almacen: 0,
        fueraInventario: 0,
        total: 0,
        responsables: new Map(),
        movs: []
      });
    }
    return out.get(hid);
  };
  for (const hid of Object.keys(catalogo || {})) ensure(hid);

  const sorted = Object.entries(movimientos || {})
    .filter(([, m]) => m && m.herramientaKey)
    .sort((a, b) => (a[1].fecha || a[1].createdAt || 0) - (b[1].fecha || b[1].createdAt || 0));

  for (const [id, m] of sorted) {
    const st = ensure(m.herramientaKey);
    st.movs.push({ id, ...m });

    const cant = Number(m.cantidad) || 0;
    if (cant > 0 && m.origen !== m.destino) {
      if (m.origen && m.origen !== UBIC_EXTERNO) {
        st.porUbicacion.set(m.origen, (st.porUbicacion.get(m.origen) || 0) - cant);
      }
      if (m.destino && m.destino !== UBIC_EXTERNO) {
        st.porUbicacion.set(m.destino, (st.porUbicacion.get(m.destino) || 0) + cant);
      }
      if (m.destino === UBIC_EXTERNO) st.fueraInventario += cant;
      if (m.origen === UBIC_EXTERNO) st.fueraInventario = Math.max(0, st.fueraInventario - cant);
    }

    // El responsable viaja con el destino: quien recibe, resguarda.
    if (m.responsable) {
      const dest = m.destino || UBIC_ALMACEN;
      if (dest !== UBIC_EXTERNO) {
        st.responsables.set(dest, { nombre: m.responsable, desde: m.fecha || m.createdAt || null });
      }
    }
  }

  // Limpieza: ubicaciones en cero (o negativas por captura inconsistente) fuera.
  for (const st of out.values()) {
    for (const [u, c] of [...st.porUbicacion]) {
      if (c <= 0) { st.porUbicacion.delete(u); st.responsables.delete(u); }
    }
    st.almacen = st.porUbicacion.get(UBIC_ALMACEN) || 0;
    let total = 0;
    for (const [u, c] of st.porUbicacion) {
      total += c;
      const p = parseUbic(u);
      if (p.tipo === 'obra') st.enObras.set(p.obraId, c);
    }
    st.total = total;
    st.movs.reverse();   // historial más reciente primero para la UI
  }
  return out;
}

// Cuántas piezas hay de `hid` en una ubicación concreta.
export function existenciaEn(estado, ubic) {
  return estado?.porUbicacion?.get(ubic) || 0;
}

// Herramientas presentes en una obra: [{ hid, herramienta, cantidad, responsable, desde, estadoDerivado }]
export function herramientasEnObra(catalogo, estados, obraId) {
  const ubic = ubicObra(obraId);
  const out = [];
  for (const [hid, h] of Object.entries(catalogo || {})) {
    const st = estados.get(hid);
    const cant = existenciaEn(st, ubic);
    if (cant <= 0) continue;
    const resp = st.responsables.get(ubic) || null;
    out.push({
      hid, herramienta: h, cantidad: cant,
      responsable: resp?.nombre || null, desde: resp?.desde || null,
      estadoDerivado: st
    });
  }
  out.sort((a, b) => (a.herramienta.nombre || '').localeCompare(b.herramienta.nombre || '', 'es'));
  return out;
}

// KPIs del inventario (global o acotado a una obra si se pasa `soloUbic`).
export function resumenInventario(catalogo, estados, soloUbic = null) {
  let piezas = 0, enAlmacen = 0, enObra = 0, enReparacion = 0, valor = 0, registros = 0, dadasBaja = 0;
  for (const [hid, h] of Object.entries(catalogo || {})) {
    if (h?.archivado) continue;
    const st = estados.get(hid);
    if (!st) continue;
    const cant = soloUbic ? existenciaEn(st, soloUbic) : st.total;
    if (soloUbic && cant <= 0) continue;
    registros++;
    piezas += cant;
    enAlmacen += soloUbic ? 0 : st.almacen;
    if (!soloUbic) for (const c of st.enObras.values()) enObra += c;
    valor += cant * (Number(h.costo) || 0);
    if (h.estado === 'reparacion') enReparacion += cant;
    if (h.estado === 'baja') dadasBaja += cant;
    if (!soloUbic) dadasBaja += st.fueraInventario;
  }
  return { registros, piezas, enAlmacen, enObra, enReparacion, valor, dadasBaja };
}

// Texto de búsqueda de una herramienta (para el filtro libre).
export function searchBlob(h) {
  return [h.nombre, h.descripcion, h.categoria, h.marca, h.modelo, h.numeroSerie, h.notas, folioHerramienta(h)]
    .filter(Boolean).join(' ').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}
export function normalizeSearch(s) {
  return (s || '').toString().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
}
