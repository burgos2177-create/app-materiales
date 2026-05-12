import { h, toast } from '../util/dom.js';
import { renderShell } from './shell.js';
import { state, setState } from '../state/store.js';
import {
  loadCatalogoConceptos, loadCatalogoMateriales, getObraMetaLegacy,
  listRequisiciones, listRecepciones, listSalidas
} from '../services/db.js';
import { buildConceptosResueltos } from '../services/opus-materiales-exporter.js';
import { isAdHoc, isAdHocCompras, origenLabel } from '../services/origen.js';
import { money, num, num0 } from '../util/format.js';
import { editMaterialMetaDialog, manageFamiliasDialog } from './_dialogs.js';

export async function renderCatalogo({ params }) {
  const obraId = params.id;
  setState({ obraActual: obraId });
  renderShell(crumbs(obraId, '...'), h('div', { class: 'empty' }, 'Cargando catálogo…'));

  const [meta, catMat, catCon, requisiciones, recepciones, salidas] = await Promise.all([
    getObraMetaLegacy(obraId),
    loadCatalogoMateriales(obraId),
    loadCatalogoConceptos(obraId),
    listRequisiciones(obraId),
    listRecepciones(obraId),
    listSalidas(obraId)
  ]);
  setState({ catalogo: catMat, conceptos: catCon?.conceptos || null });

  const items = catMat?.items || {};
  const ids = Object.keys(items);
  if (ids.length === 0) {
    renderShell(crumbs(obraId, meta?.nombre), h('div', { class: 'empty' },
      'No hay catálogo cargado. Vuelve a la obra para subir el XLS.'));
    return;
  }

  const conceptos = catCon?.conceptos || {};
  // Mismo merge que usa el export y el dashboard.
  const resueltosMap = buildConceptosResueltos(items, { requisiciones, recepciones, salidas });

  const canEdit = state.user?.role !== 'ingeniero';
  const openEdit = (id) => {
    const m = items[id];
    if (!m) return;
    editMaterialMetaDialog({
      obraId, materialKey: id, material: m, items,
      onSaved: (patch, changedFields) => {
        // Mutamos el item en memoria para reflejar en la lista de filtros y la fila.
        // Solo marcamos overrides en los campos que cambiaron (espejo de la lógica del DB).
        const overrides = { ...(m.manualOverrides || {}) };
        for (const f of Object.keys(changedFields || {})) overrides[f] = true;
        items[id] = { ...m, ...patch, manualOverrides: overrides };
        refreshFamiliasDropdown();
        refresh();
      }
    });
  };

  // Filtros
  const search = h('input', { placeholder: 'Buscar por clave, descripción, marca…', style: { flex: '1', minWidth: '260px' } });
  const familiaSel = h('select', {}, [h('option', { value: '' }, 'Todas las familias')]);
  function refreshFamiliasDropdown() {
    const prev = familiaSel.value;
    const familias = [...new Set(Object.values(items).map(m => m.familia).filter(Boolean))].sort();
    familiaSel.innerHTML = '';
    familiaSel.appendChild(h('option', { value: '' }, 'Todas las familias'));
    for (const f of familias) familiaSel.appendChild(h('option', { value: f }, f));
    if (familias.includes(prev)) familiaSel.value = prev;
  }
  refreshFamiliasDropdown();
  const soloSinResolver = h('input', { type: 'checkbox' });
  const soloAgregados = h('input', { type: 'checkbox' });
  const soloAdHoc = h('input', { type: 'checkbox' });
  const soloSinFamilia = h('input', { type: 'checkbox' });
  const soloSinMarca = h('input', { type: 'checkbox' });

  const tbody = h('tbody', {});
  const counter = h('div', { class: 'muted', style: { fontSize: '12px' } }, '');

  function refresh() {
    const q = search.value.toLowerCase().trim();
    const fam = familiaSel.value;
    const sinResolver = soloSinResolver.checked;
    const conAgregados = soloAgregados.checked;
    const adHoc = soloAdHoc.checked;
    const sinFam = soloSinFamilia.checked;
    const sinMar = soloSinMarca.checked;
    let visible = 0;
    let totalAgregados = 0;
    tbody.innerHTML = '';
    for (const id of ids) {
      const m = items[id];
      const r = resueltosMap.get(id) || { directos: new Set(), agregados: new Set(), all: new Set() };
      if (r.agregados.size > 0) totalAgregados++;
      if (q && !(`${m.clave} ${m.descripcion} ${m.marca || ''}`.toLowerCase().includes(q))) continue;
      if (fam && m.familia !== fam) continue;
      if (sinResolver && r.all.size > 0) continue;
      if (conAgregados && r.agregados.size === 0) continue;
      if (adHoc && !isAdHoc(m.origen)) continue;
      if (sinFam && (m.familia || '').trim() !== '') continue;
      if (sinMar && (m.marca || '').trim() !== '') continue;
      tbody.appendChild(materialRow(id, m, conceptos, r, { canEdit, onEditMeta: openEdit }));
      visible++;
    }
    const sumario = `${num0(visible)} / ${num0(ids.length)} materiales`;
    const extra = totalAgregados > 0 ? ` · ★ ${num0(totalAgregados)} con conceptos agregados en obra` : '';
    counter.textContent = sumario + extra;
  }
  search.addEventListener('input', refresh);
  familiaSel.addEventListener('change', refresh);
  soloSinResolver.addEventListener('change', refresh);
  soloAgregados.addEventListener('change', refresh);
  soloAdHoc.addEventListener('change', refresh);
  soloSinFamilia.addEventListener('change', refresh);
  soloSinMarca.addEventListener('change', refresh);

  const filtersBar = h('div', { class: 'card' }, [
    h('div', { class: 'row', style: { flexWrap: 'wrap', rowGap: '6px' } }, [
      search, familiaSel,
      h('label', { class: 'row', style: { gap: '6px', cursor: 'pointer' } }, [
        soloSinResolver, h('span', { class: 'muted', style: { fontSize: '12px' } }, 'Sin concepto')
      ]),
      h('label', { class: 'row', style: { gap: '6px', cursor: 'pointer' } }, [
        soloAgregados, h('span', { class: 'muted', style: { fontSize: '12px' } }, '★ Con agregados')
      ]),
      h('label', { class: 'row', style: { gap: '6px', cursor: 'pointer' } }, [
        soloAdHoc, h('span', { class: 'muted', style: { fontSize: '12px' } }, 'Ad-hoc')
      ]),
      h('label', { class: 'row', style: { gap: '6px', cursor: 'pointer' } }, [
        soloSinFamilia, h('span', { class: 'muted', style: { fontSize: '12px' } }, 'Sin familia')
      ]),
      h('label', { class: 'row', style: { gap: '6px', cursor: 'pointer' } }, [
        soloSinMarca, h('span', { class: 'muted', style: { fontSize: '12px' } }, 'Sin marca')
      ]),
      h('div', { style: { flex: 1 } }),
      counter
    ])
  ]);

  const table = h('table', { class: 'tbl' }, [
    h('thead', {}, [h('tr', {}, [
      h('th', {}, 'Clave'),
      h('th', {}, 'Descripción'),
      h('th', {}, 'Unidad'),
      h('th', { class: 'num' }, 'Cantidad OPUS'),
      h('th', { class: 'num' }, 'Costo'),
      h('th', { class: 'num' }, 'Importe'),
      h('th', {}, 'Conceptos'),
      h('th', {}, 'Familia / Marca')
    ])]),
    tbody
  ]);

  const manageBtn = canEdit
    ? h('button', {
        class: 'btn sm',
        title: 'Administrar familias y subfamilias',
        onClick: () => manageFamiliasDialog({
          obraId, items,
          onChange: () => { refreshFamiliasDropdown(); refresh(); }
        })
      }, '🏷 Administrar familias')
    : null;

  renderShell(crumbs(obraId, meta?.nombre), h('div', {}, [
    h('div', { class: 'row', style: { alignItems: 'center', gap: '12px', marginBottom: '8px' } }, [
      h('h1', { style: { margin: 0 } }, 'Catálogo de materiales'),
      h('div', { style: { flex: 1 } }),
      manageBtn
    ]),
    filtersBar,
    h('div', { class: 'card', style: { padding: '0', overflow: 'auto', maxHeight: '70vh' } }, [table])
  ]));
  refresh();
}

function conceptoLabel(ck, conceptos) {
  const c = conceptos[ck];
  if (!c) return null;
  return c.clave || ck.slice(0, 12);
}

function materialRow(id, m, conceptos, resueltos, opts = {}) {
  const { canEdit = false, onEditMeta = null } = opts;
  const directos = [...resueltos.directos];
  const agregados = [...resueltos.agregados];
  const total = directos.length + agregados.length;

  let conceptosCell;
  if (total === 0) {
    conceptosCell = h('span', { class: 'tag warn', title: 'No se resolvieron refs en /shared/catalogos y no se ha usado en obra todavía' }, '⚠ sin resolver');
  } else {
    const titleParts = [];
    if (directos.length) titleParts.push('De OPUS: ' + directos.map(k => conceptoLabel(k, conceptos) || k).join(', '));
    if (agregados.length) titleParts.push('Agregados en obra: ' + agregados.map(k => conceptoLabel(k, conceptos) || k).join(', '));
    const title = titleParts.join('\n');

    if (total === 1) {
      const ck = directos[0] || agregados[0];
      const isAgregado = agregados.length === 1;
      conceptosCell = h('span', { class: 'mono', style: { fontSize: '11px' }, title: title + (conceptos[ck]?.descripcion ? '\n' + conceptos[ck].descripcion : '') }, [
        conceptoLabel(ck, conceptos) || ck.slice(0, 12),
        isAgregado ? h('span', { class: 'tag', style: { marginLeft: '4px', fontSize: '10px' }, title: 'Concepto agregado en obra (no estaba en OPUS)' }, '★') : null
      ]);
    } else {
      conceptosCell = h('span', { class: 'tag', title }, [
        `${total} conceptos`,
        agregados.length > 0
          ? h('span', { style: { marginLeft: '4px', color: 'var(--accent)' }, title: `${agregados.length} agregado${agregados.length > 1 ? 's' : ''} en obra` }, ` · ★${agregados.length}`)
          : null
      ]);
    }
  }

  const famMarca = [m.familia, m.marca].filter(Boolean).join(' · ');
  const adHocFlag = isAdHoc(m.origen);
  const edited = m.manualOverrides && Object.values(m.manualOverrides).some(Boolean);

  // Celda Familia / Marca: botón explícito para editar cuando hay permiso.
  let famMarcaCell;
  if (canEdit && onEditMeta) {
    const editBtn = h('button', {
      class: 'btn ghost sm',
      style: { fontSize: '11px', padding: '2px 8px', whiteSpace: 'nowrap' },
      title: 'Editar familia, subfamilia, marca y proveedor',
      onClick: (e) => { e.stopPropagation(); onEditMeta(id); }
    }, famMarca ? '✎ Editar' : '+ Asignar');

    famMarcaCell = h('td', { class: 'muted', style: { fontSize: '11px' } }, [
      h('div', { class: 'row', style: { gap: '6px', alignItems: 'center', justifyContent: 'space-between' } }, [
        famMarca
          ? h('span', {}, [
              famMarca,
              edited ? h('span', {
                class: 'tag',
                style: { marginLeft: '4px', fontSize: '10px' },
                title: 'Editado en la app. Se preserva contra re-imports de OPUS hasta que el XLS exportado se cargue en OPUS.'
              }, '✎') : null
            ])
          : h('span', { class: 'muted', style: { fontStyle: 'italic' } }, '—'),
        editBtn
      ])
    ]);
  } else {
    famMarcaCell = h('td', { class: 'muted', style: { fontSize: '11px' } }, famMarca);
  }

  return h('tr', {}, [
    h('td', { class: 'mono', style: { fontSize: '11px' } }, [
      m.clave,
      adHocFlag ? h('span', {
        class: 'tag',
        style: { marginLeft: '4px', fontSize: '10px' },
        title: isAdHocCompras(m.origen)
          ? 'Material creado por compras'
          : 'Material creado por el almacenista en obra'
      }, origenLabel(m.origen)) : null
    ]),
    h('td', { style: { maxWidth: '380px', overflow: 'hidden', textOverflow: 'ellipsis' }, title: m.descripcion }, m.descripcion),
    h('td', {}, m.unidad),
    h('td', { class: 'num' }, num(m.cantidadOpus, 4)),
    h('td', { class: 'num' }, money(m.costoUnitario)),
    h('td', { class: 'num' }, money(m.importe)),
    h('td', {}, conceptosCell),
    famMarcaCell
  ]);
}

function crumbs(obraId, nombre) {
  return [
    { label: 'Obras', to: '/' },
    { label: nombre || obraId.slice(0, 6), to: '/obras/' + obraId },
    { label: 'Catálogo' }
  ];
}
