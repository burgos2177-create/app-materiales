// Salidas — registro de consumo de almacén.
// UX nueva (multi-allocation):
//   1. Click "+ Nueva salida" → se crea un borrador vacío y se entra al detalle.
//   2. En el detalle hay un STOCK BROWSER (grid de cards de materiales con
//      stock > 0). Click "+ Consumir" en una card abre un modal donde se
//      decide la cantidad total y se asigna a UNO O VARIOS conceptos.
//   3. Cada asignación se guarda como un item independiente (mismo material,
//      distinto concepto, distinta cantidad). Permite el caso típico
//      "saqué 10 cables, 6 al concepto A y 4 al concepto B".
//   4. Sentinel `__indirecto__` para consumo que no carga a un concepto OPUS.

import { h, toast, modal } from '../util/dom.js';
import { renderShell } from './shell.js';
import { state, setState } from '../state/store.js';
import {
  getObraMetaLegacy,
  loadCatalogoMateriales, loadCatalogoConceptos,
  listSalidas, getSalida, createSalida, updateSalida, deleteSalida,
  addSalidaItemsBatch, updateSalidaItem, removeSalidaItem,
  setSalidaEstado,
  listRecepciones,
  CONCEPTO_INDIRECTO
} from '../services/db.js';
import { computeStockByMaterial } from '../services/stock.js';
import { navigate } from '../state/router.js';
import { num, num0, dateMx, money } from '../util/format.js';
import { consumeMaterialDialog, conceptoPickerDialog } from './_dialogs.js';

// =================== Lista ===================

export async function renderSalidasList({ params }) {
  const obraId = params.id;
  setState({ obraActual: obraId });
  renderShell(crumbs(obraId, '...'), h('div', { class: 'empty' }, 'Cargando…'));

  const [meta, salidas] = await Promise.all([
    getObraMetaLegacy(obraId),
    listSalidas(obraId)
  ]);

  const ids = Object.keys(salidas);
  ids.sort((a, b) => (salidas[b].numero || 0) - (salidas[a].numero || 0));

  const head = h('div', { class: 'row' }, [
    h('h1', {}, 'Salidas de almacén'),
    h('div', { style: { flex: 1 } }),
    h('button', { class: 'btn primary', onClick: () => onCreate(obraId) }, '+ Nueva salida')
  ]);

  let body;
  if (ids.length === 0) {
    body = h('div', { class: 'empty' }, [
      h('div', { class: 'ico' }, '📤'),
      h('div', {}, 'Sin salidas todavía.'),
      h('div', { class: 'muted', style: { marginTop: '8px', fontSize: '12px' } },
        'Crea una para registrar consumo del almacén. Luego eliges los materiales del stock disponible.')
    ]);
  } else {
    body = h('div', { class: 'card', style: { padding: 0, overflow: 'auto' } }, [
      h('table', { class: 'tbl' }, [
        h('thead', {}, [h('tr', {}, [
          h('th', {}, '#'),
          h('th', {}, 'Fecha'),
          h('th', {}, 'Estado'),
          h('th', { class: 'num' }, 'Items'),
          h('th', {}, 'Conceptos cargados'),
          h('th', {}, 'Autoriza'),
          h('th', {}, 'Notas'),
          h('th', {}, '')
        ])]),
        h('tbody', {}, ids.map(id => salidaRow(obraId, id, salidas[id])))
      ])
    ]);
  }

  renderShell(crumbs(obraId, meta?.nombre), h('div', {}, [head, body]));
}

function salidaRow(obraId, salId, s) {
  const items = s.items || {};
  const itemsCount = Object.keys(items).length;
  // Conceptos únicos cargados en esta salida (incluye Indirecto si aplica)
  const conceptosUsados = new Set();
  for (const it of Object.values(items)) if (it.conceptoKey) conceptosUsados.add(it.conceptoKey);
  const conceptosLabel = [...conceptosUsados].length === 0
    ? '—'
    : [...conceptosUsados].length === 1
      ? (conceptosUsados.has(CONCEPTO_INDIRECTO) ? 'Indirecto' : '1 concepto')
      : `${conceptosUsados.size} conceptos`;

  const cerrada = s.estado === 'cerrada';
  return h('tr', {
    style: { cursor: 'pointer' },
    onClick: () => navigate(`/obras/${obraId}/salidas/${salId}`)
  }, [
    h('td', { class: 'mono' }, `S-${String(s.numero || 0).padStart(4, '0')}`),
    h('td', {}, dateMx(s.fecha) || '—'),
    h('td', {}, estadoBadge(s.estado)),
    h('td', { class: 'num' }, num0(itemsCount)),
    h('td', { class: 'muted', style: { fontSize: '12px' } }, conceptosLabel),
    h('td', { class: 'muted', style: { fontSize: '12px' } }, s.autorizadoPor?.displayName || s.autorizadoPor?.email || '—'),
    h('td', { class: 'muted', style: { fontSize: '12px' } }, (s.notas || '').slice(0, 40)),
    h('td', {}, !cerrada && h('button', {
      class: 'btn sm danger',
      onClick: (e) => { e.stopPropagation(); confirmDelete(obraId, salId, s); }
    }, 'Borrar'))
  ]);
}

function estadoBadge(estado) {
  if (estado === 'cerrada') return h('span', { class: 'tag', style: { background: 'rgba(93,211,158,.15)', color: 'var(--ok)' } }, '🔒 Cerrada');
  return h('span', { class: 'tag warn' }, '✎ Borrador');
}

async function onCreate(obraId) {
  try {
    const u = state.user;
    const id = await createSalida(obraId, {
      uid: u.uid, displayName: u.displayName || '', email: u.email || ''
    });
    toast('Salida creada', 'ok');
    navigate(`/obras/${obraId}/salidas/${id}`);
  } catch (err) {
    toast('Error: ' + err.message, 'danger');
  }
}

async function confirmDelete(obraId, salId, s) {
  await modal({
    title: 'Borrar salida',
    body: h('div', {}, `Se borrará la salida S-${String(s.numero).padStart(4, '0')} y todos sus items. Esta acción no se puede deshacer.`),
    confirmLabel: 'Borrar', danger: true,
    onConfirm: async () => {
      await deleteSalida(obraId, salId);
      toast('Salida borrada', 'ok');
      renderSalidasList({ params: { id: obraId } });
      return true;
    }
  });
}

// =================== Detalle ===================

export async function renderSalidaDetalle({ params }) {
  const obraId = params.id;
  const salId = params.salid;
  setState({ obraActual: obraId });
  renderShell(crumbs(obraId, '...', null), h('div', { class: 'empty' }, 'Cargando…'));

  const [meta, sal, catMat, catCon, recepciones, todasSalidas] = await Promise.all([
    getObraMetaLegacy(obraId),
    getSalida(obraId, salId),
    loadCatalogoMateriales(obraId),
    loadCatalogoConceptos(obraId),
    listRecepciones(obraId),
    listSalidas(obraId)
  ]);
  if (!sal) {
    renderShell(crumbs(obraId, meta?.nombre, null), h('div', { class: 'empty' }, 'Salida no encontrada.'));
    return;
  }
  setState({ catalogo: catMat, conceptos: catCon?.conceptos || null });

  const folio = `S-${String(sal.numero || 0).padStart(4, '0')}`;
  const conceptos = catCon?.conceptos || {};
  const materiales = catMat?.items || {};
  const editable = sal.estado !== 'cerrada';
  const isAdmin = state.user?.role === 'admin';
  // Stock global excluyendo la salida actual.
  const stockMap = computeStockByMaterial(recepciones, todasSalidas, { excludeSalidaId: salId });

  const yaConsumidoEnEsta = new Map();
  for (const it of Object.values(sal.items || {})) {
    if (!it.materialKey) continue;
    yaConsumidoEnEsta.set(it.materialKey, (yaConsumidoEnEsta.get(it.materialKey) || 0) + (Number(it.cantidad) || 0));
  }

  const head = h('div', { class: 'row' }, [
    h('h1', {}, [folio, ' ', estadoBadge(sal.estado)]),
    h('div', { style: { flex: 1 } }),
    editable && Object.keys(sal.items || {}).length > 0 && h('button', {
      class: 'btn primary',
      onClick: () => confirmCerrar(obraId, salId, sal)
    }, '🔒 Cerrar salida'),
    !editable && isAdmin && h('button', {
      class: 'btn ghost',
      onClick: () => confirmReabrir(obraId, salId, sal)
    }, '↺ Reabrir (admin)'),
    editable && h('button', {
      class: 'btn sm danger',
      onClick: () => confirmDelete(obraId, salId, sal)
    }, 'Borrar salida')
  ]);

  const fechaInput = h('input', { type: 'date', value: toDateInputVal(sal.fecha), disabled: !editable });
  fechaInput.addEventListener('change', async () => {
    const ms = fechaInput.value ? new Date(fechaInput.value + 'T12:00').getTime() : Date.now();
    await updateSalida(obraId, salId, { fecha: ms });
    toast('Fecha actualizada', 'ok');
  });
  const notasInput = h('input', { value: sal.notas || '', placeholder: 'Notas (opcional)', disabled: !editable });
  notasInput.addEventListener('change', async () => {
    await updateSalida(obraId, salId, { notas: notasInput.value.trim() || null });
  });

  const metaFields = [
    kv('Folio', folio),
    h('div', { class: 'field' }, [h('label', {}, 'Fecha'), fechaInput]),
    kv('Autoriza', sal.autorizadoPor?.displayName || sal.autorizadoPor?.email || '—')
  ];
  if (sal.estado === 'cerrada') {
    metaFields.push(kv('Cerrada el', sal.cerradaAt ? new Date(sal.cerradaAt).toLocaleString('es-MX') : '—'));
    metaFields.push(kv('Cerrada por', sal.cerradaPor?.displayName || sal.cerradaPor?.email || '—'));
  }
  metaFields.push(h('div', { class: 'field', style: { gridColumn: 'span 3' } }, [h('label', {}, 'Notas'), notasInput]));

  const metaCard = h('div', { class: 'card' }, [
    h('h3', {}, 'Datos'),
    h('div', { class: 'grid-3' }, metaFields)
  ]);

  const itemsCard = renderItemsCard(obraId, salId, sal, materiales, conceptos, stockMap, editable);
  const browserCard = editable
    ? renderStockBrowser(obraId, salId, materiales, conceptos, stockMap, yaConsumidoEnEsta)
    : h('div', { class: 'card' }, [
        h('h3', {}, 'Stock disponible'),
        h('div', { class: 'muted', style: { fontSize: '12px' } },
          'Salida cerrada — el browser de stock se oculta para evitar ediciones.')
      ]);

  renderShell(crumbs(obraId, meta?.nombre, folio), h('div', {}, [head, metaCard, itemsCard, browserCard]));
}

async function confirmCerrar(obraId, salId, sal) {
  const itemsCount = Object.keys(sal.items || {}).length;
  if (itemsCount === 0) { toast('No hay items que cerrar', 'warn'); return; }
  await modal({
    title: 'Cerrar salida',
    body: h('div', {}, [
      h('p', {}, [
        'Se cerrará la salida ',
        h('b', {}, `S-${String(sal.numero).padStart(4, '0')}`),
        ' con ', h('b', {}, itemsCount), ' items.'
      ]),
      h('p', { class: 'muted', style: { fontSize: '12px' } },
        'Una vez cerrada, no se podrá editar ni borrar items, y el stock browser quedará oculto. ' +
        'Esto previene ajustes posteriores indebidos. La reapertura requiere rol admin.')
    ]),
    confirmLabel: '🔒 Cerrar', danger: false,
    onConfirm: async () => {
      const u = state.user;
      await setSalidaEstado(obraId, salId, 'cerrada', {
        cerradaPor: { uid: u.uid, displayName: u.displayName || '', email: u.email || '' }
      });
      toast('Salida cerrada', 'ok');
      renderSalidaDetalle({ params: { id: obraId, salid: salId } });
      return true;
    }
  });
}

async function confirmReabrir(obraId, salId, sal) {
  await modal({
    title: 'Reabrir salida',
    body: h('div', {}, [
      h('p', {}, [`¿Reabrir la salida S-${String(sal.numero).padStart(4, '0')}? Volverá a borrador y se podrá editar.`]),
      h('p', { class: 'muted', style: { fontSize: '12px' } },
        'Solo el admin puede reabrir. Esta acción es auditable: queda registrada en updatedAt.')
    ]),
    confirmLabel: '↺ Reabrir', danger: true,
    onConfirm: async () => {
      await setSalidaEstado(obraId, salId, 'borrador');
      toast('Salida reabierta', 'ok');
      renderSalidaDetalle({ params: { id: obraId, salid: salId } });
      return true;
    }
  });
}

// =================== Tabla de items consumidos ===================

function renderItemsCard(obraId, salId, sal, materiales, conceptos, stockMap, editable = true) {
  const itemEntries = Object.entries(sal.items || {});

  // Sumarios
  let totalCantidad = 0, importeTotal = 0;
  const conceptosUsados = new Set();
  for (const [, it] of itemEntries) {
    totalCantidad += Number(it.cantidad) || 0;
    const m = materiales[it.materialKey];
    importeTotal += (Number(it.cantidad) || 0) * (m?.costoUnitario || 0);
    if (it.conceptoKey) conceptosUsados.add(it.conceptoKey);
  }

  const header = h('div', { style: { padding: '14px 18px 0' } }, h('h3', {}, [
    'Items consumidos ',
    h('span', { class: 'muted', style: { fontWeight: 'normal', textTransform: 'none' } },
      itemEntries.length === 0
        ? '— ninguno todavía'
        : `(${num0(itemEntries.length)} items · ${num0(totalCantidad)} unidades · ${money(importeTotal)} · ${conceptosUsados.size} conceptos)`
    )
  ]));

  if (itemEntries.length === 0) {
    return h('div', { class: 'card' }, [
      header,
      h('div', { class: 'empty', style: { margin: '14px' } }, [
        h('div', {}, 'Sin items todavía.'),
        h('div', { class: 'muted', style: { marginTop: '8px', fontSize: '12px' } },
          'Click "+ Consumir" en una card del stock browser de abajo para empezar.')
      ])
    ]);
  }

  // Ordenamos por material clave (para ver agrupados los splits del mismo)
  itemEntries.sort((a, b) => {
    const ma = materiales[a[1].materialKey]?.clave || '';
    const mb = materiales[b[1].materialKey]?.clave || '';
    return String(ma).localeCompare(String(mb), 'es');
  });

  const rows = itemEntries.map(([itemId, it]) =>
    itemRow(obraId, salId, itemId, it, materiales, conceptos, stockMap, editable)
  );

  return h('div', { class: 'card', style: { padding: 0 } }, [
    header,
    h('table', { class: 'tbl' }, [
      h('thead', {}, [h('tr', {}, [
        h('th', {}, 'Material'),
        h('th', {}, 'Unid'),
        h('th', { class: 'num' }, 'Cantidad'),
        h('th', { class: 'num' }, 'Importe'),
        h('th', {}, 'Concepto destino'),
        editable && h('th', {}, '')
      ])]),
      h('tbody', {}, rows)
    ])
  ]);
}

function itemRow(obraId, salId, itemId, it, materiales, conceptos, stockMap, editable = true) {
  const m = materiales[it.materialKey];
  const matLabel = m
    ? h('div', {}, [
      h('span', { class: 'mono', style: { fontSize: '11px', color: 'var(--text-2)', marginRight: '8px' } }, m.clave),
      h('span', {}, m.descripcion)
    ])
    : h('span', { class: 'tag danger' }, '⚠ Material eliminado del catálogo');

  const importe = (Number(it.cantidad) || 0) * (m?.costoUnitario || 0);

  return h('tr', {}, [
    h('td', { style: { maxWidth: '420px' } }, matLabel),
    h('td', {}, m?.unidad || ''),
    h('td', { class: 'num' }, num(it.cantidad, 2)),
    h('td', { class: 'num' }, money(importe)),
    h('td', {}, conceptoCell(it.conceptoKey, conceptos)),
    editable && h('td', {}, h('div', { class: 'row', style: { gap: '4px' } }, [
      h('button', {
        class: 'btn sm ghost',
        onClick: () => editItemDialog(obraId, salId, itemId, it, materiales, conceptos, stockMap)
      }, '✎'),
      h('button', {
        class: 'btn sm danger',
        onClick: () => onRemoveItem(obraId, salId, itemId)
      }, '🗑')
    ]))
  ]);
}

function conceptoCell(conceptoKey, conceptos) {
  if (!conceptoKey) return h('span', { class: 'muted', style: { fontSize: '12px' } }, '—');
  if (conceptoKey === CONCEPTO_INDIRECTO) {
    return h('span', { class: 'tag', style: { background: 'rgba(160,107,217,.18)', color: '#a06bd9' } }, '🏷 Indirecto');
  }
  const c = conceptos[conceptoKey];
  if (!c) return h('span', { class: 'tag warn' }, '⚠ Concepto eliminado');
  const path = (c.agrupadores || []).map(a => a.descripcion).join(' > ');
  return h('span', { title: c.descripcion + (path ? '\n' + path : '') }, [
    h('span', { class: 'mono', style: { fontSize: '11px', marginRight: '6px' } }, c.clave),
    h('span', { class: 'muted', style: { fontSize: '11px' } }, (c.descripcion || '').slice(0, 35))
  ]);
}

// =================== Stock browser ===================

function renderStockBrowser(obraId, salId, materiales, conceptos, stockMap, yaConsumidoEnEsta) {
  // Materiales con stock > 0 (incluyendo lo que ya se consumió en esta salida —
  // el stockMap excluyó la salida actual entera, así que recibido−otrosConsumos)
  const candidates = [];
  for (const [matKey, m] of Object.entries(materiales)) {
    if (m.archivado) continue;
    const s = stockMap.get(matKey);
    if (!s) continue;
    const usadoAqui = yaConsumidoEnEsta.get(matKey) || 0;
    const dispNeto = s.disponible - usadoAqui;
    if (dispNeto <= 0 && usadoAqui === 0) continue;
    candidates.push({ matKey, m, stock: s, usadoAqui, dispNeto });
  }

  const search = h('input', { placeholder: 'Buscar clave, descripción, marca…', style: { flex: 1, minWidth: '240px' } });
  const familias = [...new Set(candidates.map(c => c.m.familia).filter(Boolean))].sort();
  const familiaSel = h('select', {}, [
    h('option', { value: '' }, 'Todas las familias'),
    ...familias.map(f => h('option', { value: f }, f))
  ]);
  const soloUsado = h('input', { type: 'checkbox' });
  const counter = h('div', { class: 'muted', style: { fontSize: '12px' } }, '');
  const grid = h('div', {
    style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: '10px', marginTop: '12px' }
  });

  function refresh() {
    const q = search.value.trim().toLowerCase();
    const fam = familiaSel.value;
    const onlyUsado = soloUsado.checked;
    const visible = candidates.filter(c => {
      if (q && !`${c.m.clave} ${c.m.descripcion} ${c.m.marca || ''}`.toLowerCase().includes(q)) return false;
      if (fam && c.m.familia !== fam) return false;
      if (onlyUsado && c.usadoAqui === 0) return false;
      return true;
    });
    visible.sort((a, b) => (b.dispNeto - a.dispNeto));
    grid.innerHTML = '';
    if (visible.length === 0) {
      grid.appendChild(h('div', { class: 'empty', style: { gridColumn: '1 / -1' } },
        candidates.length === 0
          ? 'No hay material en stock. Registra una recepción primero.'
          : 'Sin coincidencias. Ajusta filtros.'));
    } else {
      for (const c of visible) grid.appendChild(stockCard(obraId, salId, c, conceptos));
    }
    counter.textContent = `${num0(visible.length)} / ${num0(candidates.length)} con stock`;
  }
  search.addEventListener('input', refresh);
  familiaSel.addEventListener('change', refresh);
  soloUsado.addEventListener('change', refresh);
  refresh();

  return h('div', { class: 'card' }, [
    h('h3', {}, 'Stock disponible'),
    h('div', { class: 'row' }, [
      search, familiaSel,
      h('label', { class: 'row', style: { gap: '6px', cursor: 'pointer' } }, [
        soloUsado, h('span', { class: 'muted', style: { fontSize: '12px' } }, 'Solo ya usado en esta salida')
      ]),
      h('div', { style: { flex: 1 } }), counter
    ]),
    grid
  ]);
}

function stockCard(obraId, salId, c, conceptos) {
  const { matKey, m, stock, usadoAqui, dispNeto } = c;
  const directos = (m.conceptosDirectos || []).filter(ck => conceptos[ck]);
  const directosPreview = directos.slice(0, 2).map(ck => conceptos[ck]?.clave).filter(Boolean).join(' · ');
  const moreDirectos = directos.length > 2 ? ` +${directos.length - 2}` : '';

  const clickable = dispNeto > 0;

  return h('div', {
    class: 'obra-card',
    style: {
      padding: '12px',
      cursor: clickable ? 'pointer' : 'not-allowed',
      opacity: clickable ? 1 : 0.55,
      borderColor: usadoAqui > 0 ? 'var(--accent-2)' : ''
    },
    onClick: () => {
      if (!clickable) { toast('Sin stock disponible para este material', 'warn'); return; }
      onConsume(obraId, salId, matKey, m, conceptos, dispNeto);
    }
  }, [
    h('div', { style: { display: 'flex', alignItems: 'flex-start', gap: '6px' } }, [
      h('div', { style: { flex: 1, minWidth: 0 } }, [
        h('div', { class: 'mono', style: { fontSize: '11px', color: 'var(--text-2)' } }, m.clave),
        h('div', { style: { fontWeight: 600, fontSize: '13px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: m.descripcion }, m.descripcion),
        m.marca && h('div', { class: 'muted', style: { fontSize: '11px' } }, m.marca)
      ])
    ]),
    h('div', { style: { marginTop: '10px', display: 'flex', alignItems: 'baseline', gap: '6px' } }, [
      h('span', { style: { fontSize: '20px', fontWeight: 600, color: dispNeto > 0 ? 'var(--ok)' : 'var(--text-2)' } }, num(dispNeto, 2)),
      h('span', { class: 'muted', style: { fontSize: '12px' } }, m.unidad || '')
    ]),
    h('div', { class: 'muted', style: { fontSize: '11px', marginTop: '2px' } },
      `recibido ${num(stock.recibido, 2)} − consumido ${num(stock.consumido + usadoAqui, 2)}`
    ),
    usadoAqui > 0 && h('div', { class: 'tag', style: { marginTop: '6px', fontSize: '10px', background: 'rgba(245,160,76,.15)', color: 'var(--accent)' } }, `↘ Ya consumido aquí: ${num(usadoAqui, 2)}`),
    directosPreview && h('div', { class: 'muted', style: { fontSize: '11px', marginTop: '6px' } },
      `Sugeridos: ${directosPreview}${moreDirectos}`
    ),
    h('button', {
      class: 'btn primary sm', style: { marginTop: '10px', width: '100%' },
      disabled: !clickable
    }, '+ Consumir')
  ]);
}

function onConsume(obraId, salId, matKey, material, conceptos, stockDisponible) {
  consumeMaterialDialog({
    material, materialKey: matKey, conceptos, stockDisponible,
    onSave: async (items) => {
      await addSalidaItemsBatch(obraId, salId, items);
      toast(`${items.length} asignación${items.length > 1 ? 'es' : ''} guardada${items.length > 1 ? 's' : ''}`, 'ok');
      renderSalidaDetalle({ params: { id: obraId, salid: salId } });
    }
  });
}

// =================== Edición de un item existente ===================

function editItemDialog(obraId, salId, itemId, it, materiales, conceptos, stockMap) {
  const m = materiales[it.materialKey];
  if (!m) { toast('Material no encontrado en el catálogo', 'danger'); return; }

  const stockGlobal = stockMap.get(it.materialKey) || { disponible: 0 };
  const previa = Number(it.cantidad) || 0;
  const stockDisp = stockGlobal.disponible + previa;

  const cantidad = h('input', { type: 'number', step: '0.01', min: '0', value: it.cantidad });
  const directos = (m.conceptosDirectos || []).filter(ck => conceptos[ck]);
  const directosSet = new Set(directos);

  const conceptoSel = h('select', {});
  conceptoSel.appendChild(h('option', { value: CONCEPTO_INDIRECTO }, '🏷 Indirecto / gasto general'));
  if (directos.length > 0) {
    const og = h('optgroup', { label: 'Sugeridos del material' });
    for (const ck of directos) {
      const c = conceptos[ck];
      og.appendChild(h('option', { value: ck }, `${c.clave} — ${(c.descripcion || '').slice(0, 50)}`));
    }
    conceptoSel.appendChild(og);
  }
  if (it.conceptoKey && it.conceptoKey !== CONCEPTO_INDIRECTO && !directosSet.has(it.conceptoKey) && conceptos[it.conceptoKey]) {
    const c = conceptos[it.conceptoKey];
    conceptoSel.appendChild(h('option', { value: it.conceptoKey }, `★ ${c.clave} — ${(c.descripcion || '').slice(0, 50)}`));
  }
  conceptoSel.appendChild(h('option', { value: '__otro__' }, 'Otro… (elegir de toda la lista)'));
  conceptoSel.value = it.conceptoKey || directos[0] || CONCEPTO_INDIRECTO;

  let selectedConcepto = conceptoSel.value;
  conceptoSel.addEventListener('change', () => {
    if (conceptoSel.value === '__otro__') {
      conceptoSel.value = selectedConcepto;
      conceptoPickerDialog({
        conceptos, excludeKeys: directosSet,
        onPick: (ck) => {
          selectedConcepto = ck;
          // Reabrimos para refrescar — más simple
          editItemDialog(obraId, salId, itemId, { ...it, conceptoKey: ck }, materiales, conceptos, stockMap);
        }
      });
    } else {
      selectedConcepto = conceptoSel.value;
    }
  });

  const notas = h('input', { value: it.notas || '', placeholder: 'Notas (opcional)' });

  const matInfo = h('div', { style: { padding: '8px 10px', background: 'var(--bg-2)', border: '1px solid var(--border)', borderRadius: '6px', marginBottom: '10px' } }, [
    h('span', { class: 'mono', style: { fontSize: '11px', color: 'var(--text-2)', marginRight: '8px' } }, m.clave),
    h('strong', {}, m.descripcion),
    h('span', { class: 'muted', style: { marginLeft: '8px', fontSize: '12px' } }, `${m.unidad || ''}${m.marca ? ' · ' + m.marca : ''}`)
  ]);

  const body = h('div', {}, [
    matInfo,
    h('div', { class: 'muted', style: { fontSize: '12px', color: 'var(--ok)', marginBottom: '8px' } },
      `🟢 Stock disponible para este item: ${stockDisp}`),
    h('div', { class: 'grid-2' }, [
      h('div', { class: 'field' }, [h('label', {}, 'Cantidad'), cantidad]),
      h('div', { class: 'field' }, [h('label', {}, 'Concepto destino'), conceptoSel])
    ]),
    h('div', { class: 'field' }, [h('label', {}, 'Notas'), notas])
  ]);

  modal({
    title: 'Editar asignación', body, confirmLabel: 'Guardar', size: 'lg',
    onConfirm: async () => {
      const cant = Number(cantidad.value);
      if (!cant || cant <= 0) { toast('Cantidad inválida', 'danger'); return false; }
      if (cant > stockDisp) { toast(`Cantidad excede stock disponible (${stockDisp})`, 'danger'); return false; }
      try {
        await updateSalidaItem(obraId, salId, itemId, {
          cantidad: cant,
          conceptoKey: selectedConcepto,
          notas: notas.value.trim() || null
        });
        toast('Asignación actualizada', 'ok');
        renderSalidaDetalle({ params: { id: obraId, salid: salId } });
        return true;
      } catch (err) { toast('Error: ' + err.message, 'danger'); return false; }
    }
  });
}

async function onRemoveItem(obraId, salId, itemId) {
  await modal({
    title: 'Quitar asignación',
    body: h('div', {}, '¿Quitar esta asignación de la salida?'),
    confirmLabel: 'Quitar', danger: true,
    onConfirm: async () => {
      await removeSalidaItem(obraId, salId, itemId);
      toast('Asignación eliminada', 'ok');
      renderSalidaDetalle({ params: { id: obraId, salid: salId } });
      return true;
    }
  });
}

// === Helpers ===

function kv(label, val) {
  return h('div', { class: 'field' }, [h('label', {}, label), h('div', {}, val || '—')]);
}
function toDateInputVal(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

function crumbs(obraId, nombre, folio) {
  const c = [
    { label: 'Obras', to: '/' },
    { label: nombre || obraId.slice(0, 6), to: '/obras/' + obraId },
    { label: 'Salidas', to: `/obras/${obraId}/salidas` }
  ];
  if (folio !== undefined) c.push({ label: folio || '...' });
  return c;
}
