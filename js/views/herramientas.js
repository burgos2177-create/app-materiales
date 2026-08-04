// Módulo global de herramienta y equipo. Vive ANTES de las obras porque la
// herramienta es de SOGRUB y rota entre obras: aquí está el inventario completo
// (almacén central + lo que está repartido), y dentro de cada obra hay una vista
// espejo de "lo que está aquí" (views/herramientas-obra.js).

import { h, toast, modal } from '../util/dom.js';
import { renderShell } from './shell.js';
import { state, setState } from '../state/store.js';
import { navigate } from '../state/router.js';
import { listObrasLegacy, listObrasForUser } from '../services/db.js';
import {
  listHerramientas, listMovimientosHerramientas, computeEstadoHerramientas,
  resumenInventario, existenciaEn,
  UBIC_ALMACEN, ubicObra, parseUbic, labelUbic,
  ESTADOS_FISICOS, estadoFisicoLabel, estadoFisicoTag, folioHerramienta,
  motivoLabel, motivoIcon, searchBlob, normalizeSearch,
  updateHerramienta, deleteHerramienta, deleteMovimiento
} from '../services/herramientas.js';
import {
  herramientaFormDialog, movimientoDialog, resguardoDialog, estadoDialog
} from './_herramientas-dialogs.js';
import { money, dateMx, num0 } from '../util/format.js';

// Filtros de la vista global (se conservan entre renders de la misma sesión).
const filtros = { q: '', categoria: '', estado: '', ubicacion: '', incluirArchivadas: false };

// Carga común a las dos vistas: catálogo + ledger + obras (todas para etiquetar,
// las del usuario para restringir a dónde puede mandar herramienta).
export async function cargarInventario() {
  const [catalogo, movimientos, obrasUser] = await Promise.all([
    listHerramientas(),
    listMovimientosHerramientas(),
    listObrasForUser(state.user)
  ]);
  let obras = obrasUser;
  if (state.user?.role === 'admin') obras = await listObrasLegacy().catch(() => obrasUser);
  else {
    // Etiquetas de obras ajenas (herramienta que está en otra obra): mejor
    // esfuerzo, si las reglas lo impiden se muestra el id corto.
    const todas = await listObrasLegacy().catch(() => null);
    if (todas) obras = { ...todas, ...obrasUser };
  }
  const estados = computeEstadoHerramientas(catalogo, movimientos);
  const obrasVisibles = state.user?.role === 'admin' ? null : new Set(Object.keys(obrasUser));
  return { catalogo, movimientos, obras, obrasVisibles, estados };
}

// ============================================================
//  Listado global
// ============================================================
export async function renderHerramientas() {
  setState({ obraActual: null });
  renderShell(crumbs(), h('div', { class: 'empty' }, 'Cargando inventario…'));

  let data;
  try { data = await cargarInventario(); }
  catch (err) {
    renderShell(crumbs(), h('div', { class: 'empty' }, 'Error: ' + err.message));
    return;
  }
  const { catalogo, obras, obrasVisibles, estados } = data;
  const reload = () => renderHerramientas();

  const resumen = resumenInventario(catalogo, estados);

  const head = h('div', { class: 'row' }, [
    h('h1', { style: { margin: 0 } }, '🔧 Herramienta y equipo'),
    h('div', { style: { flex: 1 } }),
    h('button', { class: 'btn ghost', onClick: () => navigate('/') }, '📦 Obras'),
    h('button', {
      class: 'btn primary',
      onClick: () => herramientaFormDialog({ obras, obrasVisibles, onDone: reload })
    }, '+ Nueva herramienta')
  ]);

  const kpis = h('div', { class: 'card' }, [
    h('div', {
      style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '14px' }
    }, [
      kpi('Registros', num0(resumen.registros), 'tipos / piezas dadas de alta'),
      kpi('Piezas vivas', num0(resumen.piezas), 'en almacén + en obras'),
      kpi('🏚 En almacén', num0(resumen.enAlmacen), 'disponibles para asignar', 'var(--ok)'),
      kpi('🏗 En obra', num0(resumen.enObra), 'repartidas en obras', 'var(--accent)'),
      resumen.enReparacion > 0 ? kpi('🔧 En reparación', num0(resumen.enReparacion), 'fuera de servicio', 'var(--warn)') : null,
      kpi('Valor inventario', money(resumen.valor), 'a costo de adquisición'),
      resumen.dadasBaja > 0 ? kpi('Bajas / pérdidas', num0(resumen.dadasBaja), 'salieron del inventario', 'var(--text-2)') : null
    ])
  ]);

  // ============ Filtros ============
  const categorias = [...new Set(Object.values(catalogo).map(x => x.categoria).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, 'es'));

  const qInput = h('input', { value: filtros.q, placeholder: 'Buscar nombre, marca, folio, serie…' });
  const catSel = h('select', {}, [
    h('option', { value: '' }, 'Todas las categorías'),
    ...categorias.map(c => h('option', { value: c, selected: filtros.categoria === c }, c))
  ]);
  const estSel = h('select', {}, [
    h('option', { value: '' }, 'Todos los estados'),
    ...ESTADOS_FISICOS.map(e => h('option', { value: e.value, selected: filtros.estado === e.value }, e.label))
  ]);
  const ubicSel = h('select', {}, [
    h('option', { value: '' }, 'Todas las ubicaciones'),
    h('option', { value: UBIC_ALMACEN, selected: filtros.ubicacion === UBIC_ALMACEN }, '🏚 Almacén central'),
    ...Object.entries(obras)
      .sort((a, b) => (a[1].meta?.nombre || '').localeCompare(b[1].meta?.nombre || '', 'es'))
      .map(([oid, o]) => h('option', {
        value: ubicObra(oid), selected: filtros.ubicacion === ubicObra(oid)
      }, '🏗 ' + (o.meta?.nombre || oid.slice(0, 6))))
  ]);
  const apply = () => {
    filtros.q = qInput.value;
    filtros.categoria = catSel.value;
    filtros.estado = estSel.value;
    filtros.ubicacion = ubicSel.value;
    reload();
  };
  qInput.addEventListener('change', apply);
  [catSel, estSel, ubicSel].forEach(el => el.addEventListener('change', apply));

  const filtrosRow = h('div', { class: 'card' }, [
    h('div', { class: 'row' }, [
      h('div', { class: 'field', style: { flex: '2 1 240px' } }, [h('label', {}, 'Buscar'), qInput]),
      h('div', { class: 'field', style: { flex: '1 1 160px' } }, [h('label', {}, 'Categoría'), catSel]),
      h('div', { class: 'field', style: { flex: '1 1 150px' } }, [h('label', {}, 'Estado'), estSel]),
      h('div', { class: 'field', style: { flex: '1 1 180px' } }, [h('label', {}, 'Ubicación'), ubicSel]),
      (filtros.q || filtros.categoria || filtros.estado || filtros.ubicacion)
        ? h('button', {
          class: 'btn sm', style: { alignSelf: 'flex-end' },
          onClick: () => { filtros.q = ''; filtros.categoria = ''; filtros.estado = ''; filtros.ubicacion = ''; reload(); }
        }, '✕ Limpiar')
        : null
    ])
  ]);

  // ============ Tabla ============
  const q = normalizeSearch(filtros.q);
  const rows = Object.entries(catalogo)
    .filter(([hid, hh]) => {
      if (hh.archivado && !filtros.incluirArchivadas) return false;
      if (q && !searchBlob(hh).includes(q)) return false;
      if (filtros.categoria && hh.categoria !== filtros.categoria) return false;
      if (filtros.estado && (hh.estado || 'bueno') !== filtros.estado) return false;
      if (filtros.ubicacion && existenciaEn(estados.get(hid), filtros.ubicacion) <= 0) return false;
      return true;
    })
    .sort((a, b) => (b[1].numero || 0) - (a[1].numero || 0));

  let tabla;
  if (Object.keys(catalogo).length === 0) {
    tabla = h('div', { class: 'empty' }, [
      h('div', { class: 'ico' }, '🔧'),
      h('div', {}, 'Todavía no hay herramienta inventariada.'),
      h('div', { class: 'muted', style: { marginTop: '8px', fontSize: '12px' } },
        'Da de alta el rotomartillo, la revolvedora, las palas… y desde aquí las asignas a cada obra.'),
      h('div', { style: { marginTop: '12px' } },
        h('button', {
          class: 'btn primary',
          onClick: () => herramientaFormDialog({ obras, obrasVisibles, onDone: reload })
        }, '+ Nueva herramienta'))
    ]);
  } else if (rows.length === 0) {
    tabla = h('div', { class: 'empty' }, 'Ninguna herramienta coincide con los filtros.');
  } else {
    tabla = h('div', { class: 'card', style: { padding: 0, overflow: 'auto' } }, [
      h('table', { class: 'tbl' }, [
        h('thead', {}, [h('tr', {}, [
          h('th', {}, 'Folio'),
          h('th', {}, 'Herramienta'),
          h('th', {}, 'Categoría'),
          h('th', {}, 'Dónde está'),
          h('th', {}, 'Resguardo'),
          h('th', {}, 'Estado'),
          h('th', { class: 'num' }, 'Valor'),
          h('th', {}, '')
        ])]),
        h('tbody', {}, rows.map(([hid, hh]) => filaHerramienta(hid, hh, estados.get(hid), obras, obrasVisibles, reload)))
      ])
    ]);
  }

  renderShell(crumbs(), h('div', {}, [head, kpis, filtrosRow, tabla]));
}

function filaHerramienta(hid, hh, st, obras, obrasVisibles, reload) {
  const ubicaciones = [...(st?.porUbicacion || new Map())];
  const esUnitario = (hh.tipoControl || 'unitario') === 'unitario';

  const dondeCell = ubicaciones.length === 0
    ? h('span', { class: 'tag danger' }, st?.fueraInventario ? '🗑 Fuera de inventario' : '— sin existencia')
    : h('div', { class: 'row', style: { gap: '4px' } }, ubicaciones.map(([u, c]) => {
      const p = parseUbic(u);
      return h('span', {
        class: 'tag' + (p.tipo === 'almacen' ? '' : ' ok'),
        style: { cursor: p.tipo === 'obra' ? 'pointer' : 'default' },
        title: p.tipo === 'obra' ? 'Ver el módulo de herramienta de esta obra' : '',
        onClick: p.tipo === 'obra' ? (e) => { e.stopPropagation(); navigate(`/obras/${p.obraId}/herramientas`); } : null
      }, labelUbic(u, obras) + (esUnitario ? '' : ` · ${c}`));
    }));

  const resp = ubicaciones.map(([u]) => st.responsables.get(u)?.nombre).filter(Boolean);

  return h('tr', {
    style: { cursor: 'pointer' },
    onClick: () => navigate('/herramientas/' + hid)
  }, [
    h('td', { class: 'mono' }, folioHerramienta(hh)),
    h('td', {}, [
      h('div', {}, hh.nombre || '—'),
      h('div', { class: 'muted', style: { fontSize: '11px' } },
        [hh.marca, hh.modelo, hh.numeroSerie && ('S/N ' + hh.numeroSerie)].filter(Boolean).join(' · ') ||
        (esUnitario ? '' : `${st?.total || 0} ${hh.unidad || 'pza'} en total`))
    ]),
    h('td', { class: 'muted', style: { fontSize: '12px' } }, hh.categoria || '—'),
    h('td', {}, dondeCell),
    h('td', { class: 'muted', style: { fontSize: '12px' } }, resp.length ? resp.join(', ') : '—'),
    h('td', {}, h('span', { class: 'tag ' + estadoFisicoTag(hh.estado) }, estadoFisicoLabel(hh.estado))),
    // Valor del inventario vivo de este registro: en las de cantidad son todas
    // las piezas, no el costo unitario (que se muestra abajo como referencia).
    h('td', { class: 'num' }, hh.costo
      ? h('div', {}, [
        h('div', {}, money((st?.total || 0) * Number(hh.costo))),
        !esUnitario ? h('div', { class: 'muted', style: { fontSize: '10px' } }, money(hh.costo) + ' c/u') : null
      ])
      : '—'),
    h('td', {}, h('div', { class: 'row', style: { gap: '4px' } }, [
      (st?.total || 0) > 0 && h('button', {
        class: 'btn sm',
        title: 'Asignar, devolver, traspasar o dar de baja',
        onClick: (e) => {
          e.stopPropagation();
          movimientoDialog({
            hid, herramienta: hh, estado: st, obras, obrasVisibles,
            origenSugerido: st.almacen > 0 ? UBIC_ALMACEN : (ubicaciones[0]?.[0] || UBIC_ALMACEN),
            titulo: 'Mover ' + folioHerramienta(hh), onDone: reload
          });
        }
      }, '🚚 Mover')
    ]))
  ]);
}

// ============================================================
//  Detalle de una herramienta
// ============================================================
export async function renderHerramientaDetalle({ params }) {
  const hid = params.hid;
  renderShell(crumbs('…'), h('div', { class: 'empty' }, 'Cargando…'));

  let data;
  try { data = await cargarInventario(); }
  catch (err) {
    renderShell(crumbs('…'), h('div', { class: 'empty' }, 'Error: ' + err.message));
    return;
  }
  const { catalogo, obras, obrasVisibles, estados } = data;
  const hh = catalogo[hid];
  if (!hh) {
    renderShell(crumbs('…'), h('div', { class: 'empty' }, 'Herramienta no encontrada.'));
    return;
  }
  const st = estados.get(hid) || { porUbicacion: new Map(), responsables: new Map(), movs: [], total: 0, almacen: 0 };
  const isAdmin = state.user?.role === 'admin';
  const reload = () => renderHerramientaDetalle({ params: { hid } });
  const esUnitario = (hh.tipoControl || 'unitario') === 'unitario';
  const ubicaciones = [...st.porUbicacion];
  const ubicPrincipal = ubicaciones[0]?.[0] || UBIC_ALMACEN;

  const acciones = h('div', { class: 'row' }, [
    st.total > 0 && h('button', {
      class: 'btn primary',
      onClick: () => movimientoDialog({
        hid, herramienta: hh, estado: st, obras, obrasVisibles,
        origenSugerido: st.almacen > 0 ? UBIC_ALMACEN : ubicPrincipal,
        titulo: 'Mover ' + folioHerramienta(hh), onDone: reload
      })
    }, '🚚 Mover / asignar'),
    st.total > 0 && h('button', {
      class: 'btn',
      onClick: () => resguardoDialog({
        hid, herramienta: hh, ubicacion: ubicPrincipal, obras,
        responsableActual: st.responsables.get(ubicPrincipal)?.nombre, onDone: reload
      })
    }, '👤 Resguardo'),
    h('button', {
      class: 'btn',
      onClick: () => estadoDialog({ hid, herramienta: hh, ubicacion: ubicPrincipal, onDone: reload })
    }, '🔧 Estado / mantenimiento'),
    h('button', {
      class: 'btn',
      onClick: () => herramientaFormDialog({ hid, herramienta: hh, obras, obrasVisibles, onDone: reload })
    }, '✎ Editar'),
    isAdmin && h('button', {
      class: 'btn sm',
      title: hh.archivado ? 'Volver a mostrarla en el inventario' : 'Ocultarla del listado sin borrar su historial',
      onClick: async () => {
        await updateHerramienta(hid, { archivado: !hh.archivado });
        toast(hh.archivado ? 'Herramienta restaurada' : 'Herramienta archivada', 'ok');
        reload();
      }
    }, hh.archivado ? '↺ Desarchivar' : '📁 Archivar'),
    isAdmin && h('button', {
      class: 'btn sm danger',
      title: 'Borra el registro y todo su historial. Para retirar herramienta real usa Mover → Fuera de inventario.',
      onClick: () => onBorrar(hid, hh)
    }, '🗑 Borrar')
  ]);

  const foto = hh.fotoUrl
    ? h('a', { href: hh.fotoUrl, target: '_blank', rel: 'noopener' },
      h('img', {
        src: hh.fotoUrl, alt: hh.nombre || '',
        style: { width: '100%', maxWidth: '220px', borderRadius: '8px', border: '1px solid var(--border)' },
        onError: (e) => { e.target.replaceWith(h('span', { class: 'muted', style: { fontSize: '12px' } }, '(no se pudo cargar la foto)')); }
      }))
    : null;

  const datosCard = h('div', { class: 'card' }, [
    h('div', { class: 'row', style: { alignItems: 'flex-start', gap: '20px' } }, [
      h('div', { style: { flex: 1, minWidth: 0 } }, [
        h('div', { class: 'row', style: { gap: '8px' } }, [
          h('span', { class: 'mono muted' }, folioHerramienta(hh)),
          h('h2', { style: { margin: 0 } }, hh.nombre || '—'),
          h('span', { class: 'tag ' + estadoFisicoTag(hh.estado) }, estadoFisicoLabel(hh.estado)),
          hh.archivado && h('span', { class: 'tag muted' }, '📁 Archivada')
        ]),
        h('div', { class: 'grid-3', style: { marginTop: '14px' } }, [
          kv('Categoría', hh.categoria),
          kv('Marca', hh.marca),
          kv('Modelo', hh.modelo),
          esUnitario ? kv('Número de serie', hh.numeroSerie) : kv('Unidad', hh.unidad || 'pza'),
          kv('Control', esUnitario ? 'Por pieza' : 'Por cantidad'),
          kv('Piezas vivas', `${st.total} ${hh.unidad || 'pza'}`),
          kv('Valor de adquisición', hh.costo ? money(hh.costo) : null),
          kv('Fecha de compra', hh.fechaCompra ? dateMx(hh.fechaCompra) : null),
          kv('Proveedor', hh.proveedor),
          kv('Factura / ticket', hh.factura),
          kv('Último mantenimiento', hh.ultimoMantenimiento ? dateMx(hh.ultimoMantenimiento) : null),
          kv('Alta', hh.createdAt ? dateMx(hh.createdAt) : null)
        ]),
        hh.descripcion ? h('div', { class: 'muted', style: { marginTop: '10px', fontSize: '13px' } }, hh.descripcion) : null,
        hh.notas ? h('div', { style: { marginTop: '10px', fontSize: '13px' } }, [h('b', {}, 'Notas: '), hh.notas]) : null
      ]),
      foto
    ])
  ]);

  const ubicCard = h('div', { class: 'card' }, [
    h('h3', {}, 'Dónde está'),
    ubicaciones.length === 0
      ? h('div', { class: 'empty' }, st.fueraInventario
        ? 'Salió del inventario (baja o pérdida). El historial de abajo lo documenta.'
        : 'Sin existencia registrada.')
      : h('div', {
        style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: '10px' }
      }, ubicaciones.map(([u, c]) => {
        const p = parseUbic(u);
        const resp = st.responsables.get(u);
        return h('div', {
          style: {
            border: '1px solid var(--border)', borderRadius: '8px', padding: '12px',
            background: p.tipo === 'almacen' ? 'var(--bg-2)' : 'rgba(93,211,158,.06)'
          }
        }, [
          h('div', { class: 'row', style: { gap: '6px' } }, [
            h('b', {}, labelUbic(u, obras)),
            h('span', { class: 'tag' }, `${c} ${hh.unidad || 'pza'}`)
          ]),
          h('div', { class: 'muted', style: { fontSize: '12px', marginTop: '6px' } },
            resp ? `👤 ${resp.nombre}${resp.desde ? ' · desde ' + dateMx(resp.desde) : ''}` : 'Sin resguardo asignado'),
          h('div', { class: 'row', style: { gap: '6px', marginTop: '10px' } }, [
            h('button', {
              class: 'btn sm',
              onClick: () => movimientoDialog({
                hid, herramienta: hh, estado: st, obras, obrasVisibles,
                origenSugerido: u,
                destinoSugerido: p.tipo === 'obra' ? UBIC_ALMACEN : null,
                titulo: p.tipo === 'obra' ? 'Devolver o traspasar' : 'Asignar a obra',
                onDone: reload
              })
            }, p.tipo === 'obra' ? '↩ Devolver / traspasar' : '🚚 Asignar a obra'),
            h('button', {
              class: 'btn sm',
              onClick: () => resguardoDialog({
                hid, herramienta: hh, ubicacion: u, obras,
                responsableActual: resp?.nombre, onDone: reload
              })
            }, '👤 Resguardo'),
            p.tipo === 'obra' ? h('button', {
              class: 'btn sm ghost',
              onClick: () => navigate(`/obras/${p.obraId}/herramientas`)
            }, '→ Ver obra') : null
          ])
        ]);
      }))
  ]);

  const historialCard = h('div', { class: 'card', style: { padding: 0 } }, [
    h('h3', { style: { padding: '16px 16px 0' } }, 'Historial'),
    st.movs.length === 0
      ? h('div', { class: 'empty' }, 'Sin movimientos.')
      : h('table', { class: 'tbl' }, [
        h('thead', {}, [h('tr', {}, [
          h('th', {}, 'Fecha'),
          h('th', {}, 'Movimiento'),
          h('th', {}, 'De'),
          h('th', {}, 'A'),
          h('th', { class: 'num' }, 'Cant.'),
          h('th', {}, 'Responsable'),
          h('th', {}, 'Notas'),
          h('th', {}, 'Registró'),
          isAdmin ? h('th', {}, '') : null
        ])]),
        h('tbody', {}, st.movs.map(m => filaMovimiento(m, obras, hh, isAdmin, reload)))
      ])
  ]);

  renderShell(crumbs(folioHerramienta(hh)), h('div', {}, [
    h('div', { class: 'row' }, [
      h('h1', { style: { margin: 0 } }, hh.nombre || folioHerramienta(hh)),
      h('div', { style: { flex: 1 } })
    ]),
    acciones, datosCard, ubicCard, historialCard
  ]));
}

export function filaMovimiento(m, obras, hh, isAdmin, reload) {
  const mueve = (Number(m.cantidad) || 0) > 0 && m.origen !== m.destino;
  return h('tr', {}, [
    h('td', {}, dateMx(m.fecha || m.createdAt) || '—'),
    h('td', {}, h('span', { class: 'tag' + (m.motivo === 'baja' || m.motivo === 'perdida' ? ' danger' : m.motivo === 'asignacion' ? ' ok' : '') },
      `${motivoIcon(m.motivo)} ${motivoLabel(m.motivo)}`)),
    h('td', { class: 'muted', style: { fontSize: '12px' } }, mueve ? labelUbic(m.origen, obras) : '—'),
    h('td', { class: 'muted', style: { fontSize: '12px' } }, mueve ? labelUbic(m.destino, obras) : '—'),
    h('td', { class: 'num' }, mueve ? `${m.cantidad}` : '—'),
    h('td', { style: { fontSize: '12px' } }, m.responsable || '—'),
    h('td', { class: 'muted', style: { fontSize: '12px', maxWidth: '260px' } }, m.notas || '—'),
    h('td', { class: 'muted', style: { fontSize: '11px' } }, m.autor?.displayName || m.autor?.email || '—'),
    isAdmin ? h('td', {}, h('button', {
      class: 'btn sm danger',
      title: 'Borrar este movimiento del historial (recalcula existencias)',
      onClick: async () => {
        const ok = await modal({
          title: 'Borrar movimiento',
          body: h('div', {}, 'Se borrará este movimiento y las existencias se recalcularán. Úsalo solo para corregir capturas erróneas.'),
          confirmLabel: 'Borrar', danger: true, onConfirm: async () => true
        });
        if (!ok) return;
        await deleteMovimiento(m.id);
        toast('Movimiento borrado', 'ok');
        reload();
      }
    }, '🗑')) : null
  ]);
}

async function onBorrar(hid, hh) {
  await modal({
    title: 'Borrar herramienta',
    body: h('div', {}, [
      h('p', {}, [`Se borrará `, h('b', {}, `${folioHerramienta(hh)} · ${hh.nombre}`), ' y TODO su historial de movimientos.']),
      h('p', { class: 'muted', style: { fontSize: '12px' } },
        'Si la herramienta existió de verdad y se perdió o se dio de baja, mejor usa Mover → Fuera de inventario: conserva el rastro de qué pasó con ella.')
    ]),
    confirmLabel: 'Borrar', danger: true,
    onConfirm: async () => {
      try {
        await deleteHerramienta(hid);
        toast('Herramienta borrada', 'ok');
        navigate('/herramientas');
        return true;
      } catch (err) { toast('Error: ' + err.message, 'danger'); return false; }
    }
  });
}

// ============================================================
//  Helpers
// ============================================================
export function kpi(label, value, sub, color) {
  return h('div', {}, [
    h('div', { class: 'muted', style: { fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.4px' } }, label),
    h('div', { style: { fontSize: '20px', fontWeight: 600, marginTop: '2px', color: color || 'var(--text-0)' } }, value),
    sub ? h('div', { class: 'muted', style: { fontSize: '11px', marginTop: '2px' } }, sub) : null
  ]);
}

function kv(label, val) {
  return h('div', { class: 'field' }, [h('label', {}, label), h('div', {}, val || '—')]);
}

function crumbs(sub) {
  const out = [{ label: 'Obras', to: '/' }, { label: 'Herramienta', to: sub ? '/herramientas' : null }];
  if (sub) out.push({ label: sub });
  return out;
}
