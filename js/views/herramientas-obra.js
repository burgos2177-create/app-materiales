// Vista espejo del inventario de herramienta, acotada a UNA obra: qué equipo
// está aquí, con quién, desde cuándo y en qué estado. Lee del mismo ledger que
// el módulo global (/shared/herramientas) — no duplica datos.

import { h } from '../util/dom.js';
import { renderShell } from './shell.js';
import { state, setState } from '../state/store.js';
import { navigate } from '../state/router.js';
import { getObraMetaLegacy } from '../services/db.js';
import {
  herramientasEnObra, resumenInventario, existenciaEn,
  UBIC_ALMACEN, ubicObra,
  estadoFisicoLabel, estadoFisicoTag, folioHerramienta,
  searchBlob, normalizeSearch
} from '../services/herramientas.js';
import {
  herramientaFormDialog, movimientoDialog, resguardoDialog, estadoDialog, pickHerramientaDialog
} from './_herramientas-dialogs.js';
import { cargarInventario, kpi, filaMovimiento } from './herramientas.js';
import { money, dateMx, num0 } from '../util/format.js';

const filtroObra = new Map();   // obraId → texto de búsqueda

export async function renderHerramientasObra({ params }) {
  const obraId = params.id;
  setState({ obraActual: obraId });
  renderShell(crumbs(obraId, '…'), h('div', { class: 'empty' }, 'Cargando herramienta de la obra…'));

  let meta, data;
  try {
    [meta, data] = await Promise.all([getObraMetaLegacy(obraId), cargarInventario()]);
  } catch (err) {
    renderShell(crumbs(obraId, '…'), h('div', { class: 'empty' }, 'Error: ' + err.message));
    return;
  }
  const { catalogo, movimientos, obras, obrasVisibles, estados } = data;
  const reload = () => renderHerramientasObra({ params: { id: obraId } });
  const ubic = ubicObra(obraId);
  const isAdmin = state.user?.role === 'admin';

  const enObra = herramientasEnObra(catalogo, estados, obraId);
  const resumen = resumenInventario(catalogo, estados, ubic);
  const disponiblesAlmacen = Object.entries(catalogo)
    .filter(([hid, hh]) => !hh.archivado && existenciaEn(estados.get(hid), UBIC_ALMACEN) > 0).length;

  // ============ Cabecera ============
  const head = h('div', { class: 'row' }, [
    h('h1', { style: { margin: 0 } }, '🔧 Herramienta en obra'),
    h('div', { style: { flex: 1 } }),
    h('button', { class: 'btn ghost', onClick: () => navigate('/herramientas') }, '🏚 Inventario global'),
    h('button', {
      class: 'btn',
      title: 'Da de alta herramienta que se compró y se quedó directamente en esta obra',
      onClick: () => herramientaFormDialog({
        obras, obrasVisibles, ubicacionInicial: ubic,
        onDone: () => reload()
      })
    }, '+ Alta directa aquí'),
    h('button', {
      class: 'btn primary',
      title: disponiblesAlmacen === 0 ? 'No hay herramienta libre en el almacén central' : 'Traer herramienta del almacén central',
      onClick: () => onAsignarDelAlmacen({ catalogo, estados, obras, obrasVisibles, obraId, ubic, reload })
    }, '🚚 Traer del almacén')
  ]);

  // ============ KPIs ============
  const kpis = h('div', { class: 'card' }, [
    h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '14px' } }, [
      kpi('Piezas en esta obra', num0(resumen.piezas), `${num0(resumen.registros)} registros distintos`, 'var(--accent)'),
      kpi('Valor resguardado', money(resumen.valor), 'a costo de adquisición'),
      resumen.enReparacion > 0
        ? kpi('🔧 En reparación', num0(resumen.enReparacion), 'fuera de servicio', 'var(--warn)')
        : null,
      kpi('🏚 Libre en almacén', num0(disponiblesAlmacen), 'registros disponibles para traer', 'var(--ok)')
    ])
  ]);

  // ============ Listado ============
  const qActual = filtroObra.get(obraId) || '';
  const qInput = h('input', { value: qActual, placeholder: 'Buscar por nombre, marca, folio o serie…' });
  qInput.addEventListener('change', () => { filtroObra.set(obraId, qInput.value); reload(); });
  const q = normalizeSearch(qActual);
  const filas = enObra.filter(r => !q || searchBlob(r.herramienta).includes(q));

  let tabla;
  if (enObra.length === 0) {
    tabla = h('div', { class: 'empty' }, [
      h('div', { class: 'ico' }, '🔧'),
      h('div', {}, 'No hay herramienta asignada a esta obra.'),
      h('div', { class: 'muted', style: { marginTop: '8px', fontSize: '12px' } },
        disponiblesAlmacen > 0
          ? `Hay ${disponiblesAlmacen} registros libres en el almacén central listos para traer.`
          : 'El almacén central tampoco tiene herramienta libre. Da de alta la que ya está aquí con "Alta directa aquí".'),
      h('div', { class: 'row', style: { justifyContent: 'center', marginTop: '12px' } }, [
        h('button', {
          class: 'btn primary',
          onClick: () => onAsignarDelAlmacen({ catalogo, estados, obras, obrasVisibles, obraId, ubic, reload })
        }, '🚚 Traer del almacén'),
        h('button', {
          class: 'btn',
          onClick: () => herramientaFormDialog({ obras, obrasVisibles, ubicacionInicial: ubic, onDone: () => reload() })
        }, '+ Alta directa aquí')
      ])
    ]);
  } else if (filas.length === 0) {
    tabla = h('div', { class: 'empty' }, 'Nada coincide con la búsqueda.');
  } else {
    tabla = h('div', { class: 'card', style: { padding: 0, overflow: 'auto' } }, [
      h('table', { class: 'tbl' }, [
        h('thead', {}, [h('tr', {}, [
          h('th', {}, 'Folio'),
          h('th', {}, 'Herramienta'),
          h('th', { class: 'num' }, 'Cant.'),
          h('th', {}, 'Resguardo'),
          h('th', {}, 'Aquí desde'),
          h('th', {}, 'Estado'),
          h('th', { class: 'num' }, 'Valor'),
          h('th', {}, '')
        ])]),
        h('tbody', {}, filas.map(r => filaEnObra(r, { obras, obrasVisibles, ubic, reload })))
      ])
    ]);
  }

  // ============ Historial de esta obra ============
  const movsObra = Object.entries(movimientos || {})
    .filter(([, m]) => m.origen === ubic || m.destino === ubic)
    .map(([id, m]) => ({ id, ...m }))
    .sort((a, b) => (b.fecha || b.createdAt || 0) - (a.fecha || a.createdAt || 0));

  const historial = h('div', { class: 'card', style: { padding: 0 } }, [
    h('h3', { style: { padding: '16px 16px 0' } }, 'Entradas y salidas de esta obra'),
    movsObra.length === 0
      ? h('div', { class: 'empty' }, 'Sin movimientos todavía.')
      : h('table', { class: 'tbl' }, [
        h('thead', {}, [h('tr', {}, [
          h('th', {}, 'Fecha'),
          h('th', {}, 'Herramienta'),
          h('th', {}, 'Movimiento'),
          h('th', {}, 'De'),
          h('th', {}, 'A'),
          h('th', { class: 'num' }, 'Cant.'),
          h('th', {}, 'Responsable'),
          h('th', {}, 'Notas'),
          h('th', {}, 'Registró')
        ])]),
        h('tbody', {}, movsObra.map(m => {
          const hh = catalogo[m.herramientaKey];
          const base = filaMovimiento(m, obras, hh, false, reload);
          // Inserta la columna "Herramienta" (clickable) después de la fecha.
          const celda = h('td', {}, hh
            ? h('a', { href: '#/herramientas/' + m.herramientaKey, style: { fontSize: '12px' } },
              `${folioHerramienta(hh)} · ${hh.nombre || ''}`)
            : h('span', { class: 'muted' }, '(borrada)'));
          base.insertBefore(celda, base.children[1]);
          return base;
        }))
      ])
  ]);

  renderShell(crumbs(obraId, meta?.nombre), h('div', {}, [head, kpis,
    enObra.length > 0 ? h('div', { class: 'card' }, [h('div', { class: 'field' }, [h('label', {}, 'Buscar'), qInput])]) : null,
    tabla, historial]));
}

function filaEnObra(r, { obras, obrasVisibles, ubic, reload }) {
  const { hid, herramienta: hh, cantidad, responsable, desde, estadoDerivado } = r;
  const esUnitario = (hh.tipoControl || 'unitario') === 'unitario';
  return h('tr', {}, [
    h('td', { class: 'mono' },
      h('a', { href: '#/herramientas/' + hid, title: 'Ver ficha completa' }, folioHerramienta(hh))),
    h('td', {}, [
      h('div', {}, hh.nombre || '—'),
      h('div', { class: 'muted', style: { fontSize: '11px' } },
        [hh.marca, hh.modelo, hh.numeroSerie && ('S/N ' + hh.numeroSerie), hh.categoria].filter(Boolean).join(' · ') || '—')
    ]),
    h('td', { class: 'num' }, esUnitario ? '1' : `${cantidad} ${hh.unidad || 'pza'}`),
    h('td', { style: { fontSize: '12px' } }, responsable || h('span', { class: 'tag warn' }, 'sin asignar')),
    h('td', { class: 'muted', style: { fontSize: '12px' } }, desde ? dateMx(desde) : '—'),
    h('td', {}, h('span', { class: 'tag ' + estadoFisicoTag(hh.estado) }, estadoFisicoLabel(hh.estado))),
    h('td', { class: 'num' }, hh.costo ? money(cantidad * Number(hh.costo)) : '—'),
    h('td', {}, h('div', { class: 'row', style: { gap: '4px' } }, [
      h('button', {
        class: 'btn sm',
        title: 'Devolver al almacén central o traspasar a otra obra',
        onClick: () => movimientoDialog({
          hid, herramienta: hh, estado: estadoDerivado, obras, obrasVisibles,
          origenSugerido: ubic, destinoSugerido: UBIC_ALMACEN,
          titulo: 'Devolver o traspasar ' + folioHerramienta(hh), onDone: reload
        })
      }, '↩ Devolver'),
      h('button', {
        class: 'btn sm',
        title: 'Cambiar a quién se le reclama esta herramienta',
        onClick: () => resguardoDialog({
          hid, herramienta: hh, ubicacion: ubic, obras,
          responsableActual: responsable, onDone: reload
        })
      }, '👤'),
      h('button', {
        class: 'btn sm',
        title: 'Reportar daño, mandar a reparación o registrar mantenimiento',
        onClick: () => estadoDialog({ hid, herramienta: hh, ubicacion: ubic, onDone: reload })
      }, '🔧')
    ]))
  ]);
}

// "Traer del almacén": primero se elige la herramienta con existencia libre en
// el almacén central, luego se captura cantidad/responsable en el diálogo de
// movimiento con el destino ya fijado en esta obra.
function onAsignarDelAlmacen({ catalogo, estados, obras, obrasVisibles, obraId, ubic, reload }) {
  return pickHerramientaDialog({
    catalogo, estados, obras, ubicacionOrigen: UBIC_ALMACEN,
    titulo: 'Traer herramienta del almacén central',
    onPick: (hid) => {
      movimientoDialog({
        hid, herramienta: catalogo[hid], estado: estados.get(hid), obras, obrasVisibles,
        origenSugerido: UBIC_ALMACEN, destinoSugerido: ubic,
        titulo: 'Asignar a esta obra', onDone: reload
      });
    }
  });
}

function crumbs(obraId, nombre) {
  return [
    { label: 'Obras', to: '/' },
    { label: nombre || obraId.slice(0, 6), to: '/obras/' + obraId },
    { label: 'Herramienta' }
  ];
}
