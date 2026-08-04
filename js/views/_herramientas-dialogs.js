// Diálogos compartidos del módulo de herramienta y equipo.
// Los usan tanto la vista global (/herramientas) como la vista por obra
// (/obras/:id/herramientas), por eso viven aparte.

import { h, toast, modal } from '../util/dom.js';
import { state } from '../state/store.js';
import { listProveedores, createProveedor, normalizeProveedor } from '../services/db.js';
import {
  UBIC_ALMACEN, UBIC_EXTERNO, ubicObra, parseUbic, labelUbic,
  ESTADOS_FISICOS, CATEGORIAS_SUGERIDAS, TIPOS_CONTROL,
  estadoFisicoLabel, folioHerramienta, existenciaEn, searchBlob, normalizeSearch,
  createHerramienta, updateHerramienta, addMovimiento
} from '../services/herramientas.js';
import { money, dateMx } from '../util/format.js';

const autorActual = () => {
  const u = state.user || {};
  return { uid: u.uid, displayName: u.displayName || '', email: u.email || '' };
};

function toDateInputVal(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  if (isNaN(d)) return '';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const fromDateInput = (v) => (v ? new Date(v + 'T12:00').getTime() : Date.now());

// ============================================================
//  Alta / edición de herramienta
// ============================================================
//
// `ubicacionesDisponibles` son las obras a las que el usuario puede mandar la
// herramienta al darla de alta (además del almacén central).
export async function herramientaFormDialog({ hid = null, herramienta = null, obras = {}, obrasVisibles = null, ubicacionInicial = UBIC_ALMACEN, onDone }) {
  const editing = !!hid;
  const h0 = herramienta || {};

  const proveedores = await listProveedores().catch(() => ({}));
  let proveedorSel = { proveedor: h0.proveedor || '', proveedorId: h0.proveedorId || null };

  const nombre = h('input', { value: h0.nombre || '', placeholder: 'p.ej. Rotomartillo SDS-Plus', autofocus: true });
  const categoria = h('input', { value: h0.categoria || '', placeholder: 'Herramienta eléctrica', list: 'cat-herr-list' });
  const catList = h('datalist', { id: 'cat-herr-list' }, CATEGORIAS_SUGERIDAS.map(c => h('option', { value: c })));
  const marca = h('input', { value: h0.marca || '', placeholder: 'Bosch, Truper, DeWalt…' });
  const modelo = h('input', { value: h0.modelo || '', placeholder: 'GBH 2-26' });

  const tipoControl = h('select', { disabled: editing },
    TIPOS_CONTROL.map(t => h('option', { value: t.value, selected: (h0.tipoControl || 'unitario') === t.value }, t.label)));
  const numeroSerie = h('input', { value: h0.numeroSerie || '', placeholder: 'Serie / número económico' });
  const unidad = h('input', { value: h0.unidad || 'pza', placeholder: 'pza' });
  const cantidadInicial = h('input', { type: 'number', min: '1', step: '1', value: '1' });

  const estado = h('select', {}, ESTADOS_FISICOS.map(e =>
    h('option', { value: e.value, selected: (h0.estado || 'bueno') === e.value }, e.label)));
  const ultimoMantenimiento = h('input', { type: 'date', value: toDateInputVal(h0.ultimoMantenimiento) });

  const costo = h('input', { type: 'number', step: '0.01', min: '0', value: h0.costo || '', placeholder: '0.00' });
  const fechaCompra = h('input', { type: 'date', value: toDateInputVal(h0.fechaCompra) });
  const factura = h('input', { value: h0.factura || '', placeholder: 'Folio de factura / ticket' });
  const fotoUrl = h('input', { value: h0.fotoUrl || '', placeholder: 'https://drive.google.com/… (liga a la foto)' });
  const notas = h('textarea', { rows: 2, placeholder: 'Accesorios que incluye, detalles, restricciones de uso…' }, h0.notas || '');

  const provSel = proveedorSelect({
    proveedores,
    currentId: h0.proveedorId,
    currentNombre: h0.proveedor,
    onPick: (p) => { proveedorSel = p; }
  });

  // Ubicación inicial (solo al dar de alta)
  const ubicSel = h('select', {});
  if (!editing) {
    ubicSel.appendChild(h('option', { value: UBIC_ALMACEN }, '🏚 Almacén central'));
    for (const [oid, o] of obrasEntries(obras, obrasVisibles)) {
      ubicSel.appendChild(h('option', { value: ubicObra(oid) }, '🏗 ' + (o.meta?.nombre || oid.slice(0, 6))));
    }
    ubicSel.value = ubicacionInicial;
  }
  const responsableAlta = h('input', { placeholder: 'Quién la resguarda (opcional)' });

  const unitarioBox = h('div', { class: 'field' }, [h('label', {}, 'Número de serie'), numeroSerie]);
  const cantidadBox = h('div', { class: 'grid-2' }, [
    h('div', { class: 'field' }, [h('label', {}, 'Unidad'), unidad]),
    h('div', { class: 'field' }, [h('label', {}, 'Cantidad inicial'), cantidadInicial])
  ]);
  const syncTipo = () => {
    const esUnit = tipoControl.value === 'unitario';
    unitarioBox.classList.toggle('hidden', !esUnit);
    cantidadBox.classList.toggle('hidden', esUnit || editing);
  };
  tipoControl.addEventListener('change', syncTipo);
  syncTipo();

  const body = h('div', {}, [
    catList,
    h('div', { class: 'grid-2' }, [
      h('div', { class: 'field' }, [h('label', {}, 'Nombre *'), nombre]),
      h('div', { class: 'field' }, [h('label', {}, 'Categoría'), categoria])
    ]),
    h('div', { class: 'grid-2' }, [
      h('div', { class: 'field' }, [h('label', {}, 'Marca'), marca]),
      h('div', { class: 'field' }, [h('label', {}, 'Modelo'), modelo])
    ]),
    h('div', { class: 'field' }, [
      h('label', {}, 'Tipo de control'), tipoControl,
      h('div', { class: 'muted', style: { fontSize: '11px' } }, editing
        ? 'El tipo de control no se cambia después del alta (el historial dejaría de cuadrar).'
        : 'Por pieza = folio y serie propios, sabes cuál está en cuál obra. Por cantidad = existencias (20 palas).')
    ]),
    unitarioBox,
    cantidadBox,
    h('div', { class: 'grid-2' }, [
      h('div', { class: 'field' }, [h('label', {}, 'Estado físico'), estado]),
      h('div', { class: 'field' }, [h('label', {}, 'Último mantenimiento'), ultimoMantenimiento])
    ]),
    h('h3', { style: { fontSize: '12px', textTransform: 'uppercase', color: 'var(--text-1)', margin: '14px 0 6px' } }, 'Compra'),
    h('div', { class: 'grid-2' }, [
      h('div', { class: 'field' }, [h('label', {}, 'Valor de adquisición'), costo]),
      h('div', { class: 'field' }, [h('label', {}, 'Fecha de compra'), fechaCompra])
    ]),
    h('div', { class: 'grid-2' }, [
      h('div', { class: 'field' }, [h('label', {}, 'Proveedor'), provSel]),
      h('div', { class: 'field' }, [h('label', {}, 'Factura / ticket'), factura])
    ]),
    !editing ? h('div', { class: 'grid-2' }, [
      h('div', { class: 'field' }, [h('label', {}, 'Ubicación inicial'), ubicSel]),
      h('div', { class: 'field' }, [h('label', {}, 'Resguardo inicial'), responsableAlta])
    ]) : null,
    h('div', { class: 'field' }, [h('label', {}, 'Foto (liga)'), fotoUrl]),
    h('div', { class: 'field' }, [h('label', {}, 'Notas'), notas])
  ]);

  return modal({
    title: editing ? `Editar ${folioHerramienta(h0)}` : 'Nueva herramienta',
    body, size: 'lg', confirmLabel: editing ? 'Guardar' : 'Dar de alta',
    onConfirm: async () => {
      const n = nombre.value.trim();
      if (!n) { toast('Ponle nombre a la herramienta', 'danger'); return false; }
      const data = {
        nombre: n,
        categoria: categoria.value,
        marca: marca.value,
        modelo: modelo.value,
        tipoControl: tipoControl.value,
        numeroSerie: numeroSerie.value,
        unidad: unidad.value,
        cantidadInicial: Number(cantidadInicial.value) || 1,
        estado: estado.value,
        ultimoMantenimiento: ultimoMantenimiento.value ? fromDateInput(ultimoMantenimiento.value) : null,
        costo: Number(costo.value) || 0,
        fechaCompra: fechaCompra.value ? fromDateInput(fechaCompra.value) : null,
        proveedor: proveedorSel.proveedor,
        proveedorId: proveedorSel.proveedorId,
        factura: factura.value,
        fotoUrl: fotoUrl.value,
        notas: notas.value
      };
      try {
        if (editing) {
          const patch = { ...data };
          delete patch.cantidadInicial;
          if (patch.tipoControl !== 'cantidad') { patch.unidad = 'pza'; }
          else { patch.numeroSerie = null; }
          await updateHerramienta(hid, patch);
          toast('Herramienta actualizada', 'ok');
          onDone && await onDone(hid);
        } else {
          const nuevoId = await createHerramienta(data, autorActual(), {
            ubicacionInicial: ubicSel.value || UBIC_ALMACEN,
            responsable: responsableAlta.value
          });
          toast('Herramienta dada de alta', 'ok');
          onDone && await onDone(nuevoId);
        }
        return true;
      } catch (err) {
        console.error(err);
        toast('Error: ' + err.message, 'danger');
        return false;
      }
    }
  });
}

// ============================================================
//  Movimiento: asignar, devolver, traspasar, dar de baja
// ============================================================
//
// Un solo diálogo cubre todos los movimientos que mueven existencia. El motivo
// se DERIVA de origen→destino (almacén→obra = asignación, obra→almacén =
// devolución, obra→obra = traspaso, cualquiera→fuera = baja/pérdida), así el
// almacenista solo piensa en "de dónde a dónde", no en taxonomías.
export function movimientoDialog({
  hid, herramienta, estado, obras = {}, obrasVisibles = null,
  origenSugerido = UBIC_ALMACEN, destinoSugerido = null, titulo = 'Mover herramienta', onDone
}) {
  const esUnitario = (herramienta.tipoControl || 'unitario') === 'unitario';

  // Origen: solo ubicaciones donde hay existencia.
  const origenes = [...(estado?.porUbicacion || new Map())].filter(([, c]) => c > 0);
  if (origenes.length === 0) {
    toast('Esta herramienta no tiene existencia en ninguna ubicación', 'warn');
    return Promise.resolve(false);
  }
  const origenSel = h('select', {}, origenes.map(([u, c]) =>
    h('option', { value: u, selected: u === origenSugerido }, `${labelUbic(u, obras)} · ${c}`)));
  if (!origenes.some(([u]) => u === origenSugerido)) origenSel.value = origenes[0][0];

  const destinoSel = h('select', {}, [
    h('option', { value: UBIC_ALMACEN }, '🏚 Almacén central'),
    ...obrasEntries(obras, obrasVisibles).map(([oid, o]) =>
      h('option', { value: ubicObra(oid) }, '🏗 ' + (o.meta?.nombre || oid.slice(0, 6)))),
    h('option', { value: UBIC_EXTERNO }, '🗑 Fuera de inventario (baja / pérdida)')
  ]);
  if (destinoSugerido) destinoSel.value = destinoSugerido;

  const motivoBaja = h('select', {}, [
    h('option', { value: 'baja' }, 'Baja — se retira por desgaste, venta o fin de vida'),
    h('option', { value: 'perdida' }, 'Pérdida o robo — se extravió en obra')
  ]);
  const motivoBajaBox = h('div', { class: 'field' }, [h('label', {}, 'Motivo de la salida'), motivoBaja]);

  const cantidad = h('input', { type: 'number', min: '1', step: '1', value: '1' });
  const cantidadBox = h('div', { class: 'field' }, [
    h('label', {}, 'Cantidad'), cantidad,
    h('div', { class: 'muted', style: { fontSize: '11px' } }, '')
  ]);
  const responsable = h('input', { placeholder: 'Nombre de quien la recibe / resguarda' });
  const fecha = h('input', { type: 'date', value: toDateInputVal(Date.now()) });
  const notas = h('textarea', { rows: 2, placeholder: 'Detalle del movimiento (opcional)' });

  const resumen = h('div', { class: 'muted', style: { fontSize: '12px', marginTop: '4px' } }, '');

  const motivoDe = (origen, destino) => {
    if (destino === UBIC_EXTERNO) return motivoBaja.value;
    if (origen === UBIC_EXTERNO) return 'ajuste';
    const po = parseUbic(origen), pd = parseUbic(destino);
    if (po.tipo === 'almacen' && pd.tipo === 'obra') return 'asignacion';
    if (po.tipo === 'obra' && pd.tipo === 'almacen') return 'devolucion';
    if (po.tipo === 'obra' && pd.tipo === 'obra') return 'traspaso';
    return 'ajuste';
  };

  const sync = () => {
    const origen = origenSel.value, destino = destinoSel.value;
    const disp = existenciaEn(estado, origen);
    cantidad.max = String(disp);
    if (esUnitario) { cantidad.value = '1'; }
    cantidadBox.classList.toggle('hidden', esUnitario);
    cantidadBox.lastChild.textContent = `Disponibles en ${labelUbic(origen, obras)}: ${disp} ${herramienta.unidad || 'pza'}`;
    motivoBajaBox.classList.toggle('hidden', destino !== UBIC_EXTERNO);
    const m = motivoDe(origen, destino);
    const nombres = { asignacion: 'Asignación a obra', devolucion: 'Devolución al almacén', traspaso: 'Traspaso entre obras', baja: 'Baja de inventario', perdida: 'Pérdida / robo', ajuste: 'Ajuste de existencia' };
    resumen.textContent = origen === destino
      ? '⚠ Origen y destino son la misma ubicación.'
      : `Se registrará como: ${nombres[m]}.`;
  };
  origenSel.addEventListener('change', sync);
  destinoSel.addEventListener('change', sync);
  motivoBaja.addEventListener('change', sync);
  sync();

  const body = h('div', {}, [
    h('div', { class: 'row', style: { gap: '6px', marginBottom: '10px' } }, [
      h('span', { class: 'mono muted', style: { fontSize: '12px' } }, folioHerramienta(herramienta)),
      h('b', {}, herramienta.nombre || '—'),
      herramienta.numeroSerie ? h('span', { class: 'tag muted' }, 'S/N ' + herramienta.numeroSerie) : null
    ]),
    h('div', { class: 'grid-2' }, [
      h('div', { class: 'field' }, [h('label', {}, 'Sale de'), origenSel]),
      h('div', { class: 'field' }, [h('label', {}, 'Va a'), destinoSel])
    ]),
    motivoBajaBox,
    cantidadBox,
    h('div', { class: 'grid-2' }, [
      h('div', { class: 'field' }, [h('label', {}, 'Recibe / resguarda'), responsable]),
      h('div', { class: 'field' }, [h('label', {}, 'Fecha'), fecha])
    ]),
    h('div', { class: 'field' }, [h('label', {}, 'Notas'), notas]),
    resumen
  ]);

  return modal({
    title: titulo, body, confirmLabel: 'Registrar movimiento',
    onConfirm: async () => {
      const origen = origenSel.value, destino = destinoSel.value;
      if (origen === destino) { toast('Origen y destino no pueden ser el mismo', 'danger'); return false; }
      const disp = existenciaEn(estado, origen);
      const cant = esUnitario ? 1 : Number(cantidad.value) || 0;
      if (cant <= 0) { toast('Cantidad inválida', 'danger'); return false; }
      if (cant > disp) { toast(`Solo hay ${disp} en ${labelUbic(origen, obras)}`, 'danger'); return false; }
      try {
        await addMovimiento({
          herramientaKey: hid,
          motivo: motivoDe(origen, destino),
          origen, destino, cantidad: cant,
          fecha: fromDateInput(fecha.value),
          responsable: responsable.value,
          notas: notas.value,
          autor: autorActual()
        });
        // Una baja total marca también el estado físico del registro.
        if (destino === UBIC_EXTERNO && cant >= (estado?.total || 0)) {
          await updateHerramienta(hid, { estado: 'baja' });
        }
        toast('Movimiento registrado', 'ok');
        onDone && await onDone();
        return true;
      } catch (err) {
        console.error(err);
        toast('Error: ' + err.message, 'danger');
        return false;
      }
    }
  });
}

// ============================================================
//  Cambio de resguardo (quién responde por ella, sin moverla)
// ============================================================
export function resguardoDialog({ hid, herramienta, ubicacion, obras, responsableActual, onDone }) {
  const nombre = h('input', { value: responsableActual || '', placeholder: 'Nombre de quien la resguarda', autofocus: true });
  const fecha = h('input', { type: 'date', value: toDateInputVal(Date.now()) });
  const notas = h('textarea', { rows: 2, placeholder: 'Motivo del cambio (cambio de turno, salida del maestro…)' });

  const body = h('div', {}, [
    h('div', { class: 'muted', style: { fontSize: '12px', marginBottom: '10px' } },
      `${folioHerramienta(herramienta)} · ${herramienta.nombre} — en ${labelUbic(ubicacion, obras)}`),
    h('div', { class: 'field' }, [h('label', {}, 'Responsable del resguardo'), nombre]),
    h('div', { class: 'field' }, [h('label', {}, 'Desde'), fecha]),
    h('div', { class: 'field' }, [h('label', {}, 'Notas'), notas]),
    h('div', { class: 'muted', style: { fontSize: '11px', marginTop: '6px' } },
      'No mueve la herramienta de lugar: solo cambia a quién se le reclama si falta.')
  ]);

  return modal({
    title: 'Cambiar resguardo', body, confirmLabel: 'Guardar',
    onConfirm: async () => {
      const n = nombre.value.trim();
      if (!n) { toast('Escribe el nombre del responsable', 'danger'); return false; }
      try {
        await addMovimiento({
          herramientaKey: hid, motivo: 'resguardo',
          origen: ubicacion, destino: ubicacion, cantidad: 0,
          fecha: fromDateInput(fecha.value),
          responsable: n, notas: notas.value, autor: autorActual()
        });
        toast('Resguardo actualizado', 'ok');
        onDone && await onDone();
        return true;
      } catch (err) { toast('Error: ' + err.message, 'danger'); return false; }
    }
  });
}

// ============================================================
//  Cambio de estado físico / mantenimiento
// ============================================================
export function estadoDialog({ hid, herramienta, ubicacion = UBIC_ALMACEN, onDone }) {
  const estado = h('select', {}, ESTADOS_FISICOS.map(e =>
    h('option', { value: e.value, selected: (herramienta.estado || 'bueno') === e.value }, e.label)));
  const mantenimiento = h('input', { type: 'date', value: toDateInputVal(herramienta.ultimoMantenimiento) });
  const notas = h('textarea', { rows: 2, placeholder: 'Qué se le hizo / qué falla tiene' });

  const body = h('div', {}, [
    h('div', { class: 'muted', style: { fontSize: '12px', marginBottom: '10px' } },
      `${folioHerramienta(herramienta)} · ${herramienta.nombre} — hoy: ${estadoFisicoLabel(herramienta.estado)}`),
    h('div', { class: 'field' }, [h('label', {}, 'Estado físico'), estado]),
    h('div', { class: 'field' }, [h('label', {}, 'Último mantenimiento'), mantenimiento]),
    h('div', { class: 'field' }, [h('label', {}, 'Notas'), notas])
  ]);

  return modal({
    title: 'Estado y mantenimiento', body, confirmLabel: 'Guardar',
    onConfirm: async () => {
      try {
        await updateHerramienta(hid, {
          estado: estado.value,
          ultimoMantenimiento: mantenimiento.value ? fromDateInput(mantenimiento.value) : null
        });
        await addMovimiento({
          herramientaKey: hid, motivo: 'estado',
          origen: ubicacion, destino: ubicacion, cantidad: 0,
          fecha: Date.now(),
          notas: `${estadoFisicoLabel(herramienta.estado)} → ${estadoFisicoLabel(estado.value)}` +
                 (notas.value.trim() ? ` · ${notas.value.trim()}` : ''),
          autor: autorActual()
        });
        toast('Estado actualizado', 'ok');
        onDone && await onDone();
        return true;
      } catch (err) { toast('Error: ' + err.message, 'danger'); return false; }
    }
  });
}

// ============================================================
//  Picker: elegir herramienta con existencia en una ubicación
// ============================================================
//
// Lo usa la vista de obra para "asignar herramienta del almacén". Devuelve el
// hid elegido vía onPick; el llamador abre después el diálogo de movimiento.
export function pickHerramientaDialog({ catalogo, estados, ubicacionOrigen = UBIC_ALMACEN, obras, titulo = 'Elegir herramienta', onPick }) {
  const search = h('input', { placeholder: 'Buscar por nombre, marca, folio o serie…', autofocus: true });
  const lista = h('div', { style: { maxHeight: '380px', overflowY: 'auto', marginTop: '10px' } });
  let elegido = null;

  const disponibles = Object.entries(catalogo || {})
    .filter(([hid, hh]) => !hh.archivado && existenciaEn(estados.get(hid), ubicacionOrigen) > 0)
    .sort((a, b) => (a[1].nombre || '').localeCompare(b[1].nombre || '', 'es'));

  const paint = () => {
    const q = normalizeSearch(search.value);
    lista.innerHTML = '';
    const rows = disponibles.filter(([, hh]) => !q || searchBlob(hh).includes(q));
    if (rows.length === 0) {
      lista.appendChild(h('div', { class: 'empty' }, disponibles.length === 0
        ? `No hay herramienta disponible en ${labelUbic(ubicacionOrigen, obras)}.`
        : 'Nada coincide con la búsqueda.'));
      return;
    }
    for (const [hid, hh] of rows) {
      const disp = existenciaEn(estados.get(hid), ubicacionOrigen);
      const row = h('div', {
        class: 'row',
        style: {
          padding: '8px 10px', borderBottom: '1px solid var(--border)', cursor: 'pointer',
          background: elegido === hid ? 'var(--bg-3)' : 'transparent', borderRadius: '4px'
        },
        onClick: () => { elegido = hid; paint(); }
      }, [
        h('span', { class: 'mono muted', style: { fontSize: '11px', minWidth: '62px' } }, folioHerramienta(hh)),
        h('div', { style: { flex: 1, minWidth: 0 } }, [
          h('div', {}, hh.nombre || '—'),
          h('div', { class: 'muted', style: { fontSize: '11px' } },
            [hh.marca, hh.modelo, hh.numeroSerie && ('S/N ' + hh.numeroSerie), hh.categoria].filter(Boolean).join(' · ') || '—')
        ]),
        h('span', { class: 'tag' + (hh.estado === 'reparacion' || hh.estado === 'malo' ? ' warn' : '') }, estadoFisicoLabel(hh.estado)),
        h('span', { class: 'mono', style: { fontSize: '12px' } }, `${disp} ${hh.unidad || 'pza'}`)
      ]);
      lista.appendChild(row);
    }
  };
  search.addEventListener('input', paint);
  paint();

  return modal({
    title: titulo, size: 'lg',
    body: h('div', {}, [
      h('div', { class: 'field' }, [h('label', {}, `Disponible en ${labelUbic(ubicacionOrigen, obras)}`), search]),
      lista
    ]),
    confirmLabel: 'Continuar',
    onConfirm: async () => {
      if (!elegido) { toast('Selecciona una herramienta', 'warn'); return false; }
      await onPick(elegido);
      return true;
    }
  });
}

// ============================================================
//  Helpers
// ============================================================

// Obras que el usuario puede ver (admin: todas). `obrasVisibles` es un Set de ids.
function obrasEntries(obras, obrasVisibles) {
  return Object.entries(obras || {})
    .filter(([oid]) => !obrasVisibles || obrasVisibles.has(oid))
    .sort((a, b) => (a[1].meta?.nombre || '').localeCompare(b[1].meta?.nombre || '', 'es'));
}

// Selector de proveedor homologado (misma lista que bitácora). Mismo patrón que
// el de recepciones: elegir de la lista evita variantes del mismo nombre.
function proveedorSelect({ proveedores, currentId = null, currentNombre = '', onPick }) {
  const sel = h('select', {});
  let curId = currentId, curNombre = currentNombre || '';
  function build() {
    sel.innerHTML = '';
    sel.appendChild(h('option', { value: '' }, '— Sin proveedor —'));
    const entries = Object.entries(proveedores)
      .sort((a, b) => (a[1].nombre || '').localeCompare(b[1].nombre || '', 'es'));
    for (const [id, p] of entries) sel.appendChild(h('option', { value: id }, p.nombre));
    let selId = curId && proveedores[curId] ? curId : '';
    if (!selId && curNombre) {
      const norm = normalizeProveedor(curNombre);
      const match = entries.find(([, p]) => normalizeProveedor(p.nombre) === norm);
      if (match) selId = match[0];
      else { sel.appendChild(h('option', { value: '__legacy__' }, `${curNombre} (sin registrar)`)); selId = '__legacy__'; }
    }
    sel.appendChild(h('option', { value: '__nuevo__' }, '➕ Agregar nuevo…'));
    sel.value = selId;
  }
  build();
  sel.addEventListener('change', async () => {
    const v = sel.value;
    if (v === '__nuevo__') {
      const nombre = await promptNombreProveedor();
      if (!nombre) { build(); return; }
      try {
        const { id, nombre: n, existed } = await createProveedor(nombre, state.user);
        proveedores[id] = { id, nombre: n };
        curId = id; curNombre = n; build();
        onPick({ proveedor: n, proveedorId: id });
        toast(existed ? 'Ese proveedor ya existía — se seleccionó' : 'Proveedor agregado', 'ok');
      } catch (e) { toast('Error: ' + e.message, 'danger'); build(); }
    } else if (v === '__legacy__') {
      onPick({ proveedor: curNombre, proveedorId: null });
    } else if (v === '') {
      curId = null; curNombre = '';
      onPick({ proveedor: '', proveedorId: null });
    } else {
      curId = v; curNombre = proveedores[v]?.nombre || '';
      onPick({ proveedor: curNombre, proveedorId: v });
    }
  });
  return sel;
}

function promptNombreProveedor() {
  return new Promise(resolve => {
    const input = h('input', { placeholder: 'Nombre del proveedor' });
    let done = false;
    modal({
      title: 'Agregar proveedor',
      body: h('div', { class: 'field' }, [
        h('label', {}, 'Nombre'), input,
        h('div', { class: 'muted', style: { fontSize: '12px', marginTop: '6px' } },
          'Se agrega a la lista compartida (homologada con bitácora).')
      ]),
      confirmLabel: 'Agregar',
      onConfirm: () => {
        const v = input.value.trim();
        if (!v) { toast('Escribe un nombre', 'warn'); return false; }
        done = true; resolve(v); return true;
      }
    }).then(() => { if (!done) resolve(null); });
    setTimeout(() => input.focus(), 30);
  });
}
