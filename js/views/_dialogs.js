// Diálogos compartidos para captura de items que tocan el catálogo de
// materiales. Usados por requisicion.js, salida.js y recepcion.js.
//
// Tres piezas:
//   - materialItemDialog: el modal grande de "Agregar/editar material a un
//     documento" parametrizable (concepto opcional, costo opcional, etc.).
//   - newMaterialDialog: sub-modal para crear material ad-hoc, sin concepto.
//   - conceptoPickerDialog: sub-modal con search del catálogo completo de
//     conceptos, gatillado por la opción "Otro…".

import { h, modal, toast } from '../util/dom.js';
import { state } from '../state/store.js';
import { createMaterialAdHoc } from '../services/db.js';
import { computeMaterialKey } from '../services/material-keys.js';

// Sentinel para consumo de material que no se carga a un concepto OPUS
// (gasto general / indirecto). Lo exportamos para que las vistas lo
// reconozcan y lo dibujen distinto en tablas.
export const CONCEPTO_INDIRECTO = '__indirecto__';

// === materialItemDialog ===
//
// opts:
//   obraId           — para crear ad-hoc en esa obra
//   title            — título del modal
//   materiales       — { materialKey: material }, mutable: si se crea ad-hoc se agrega aquí en memoria
//   conceptos        — { conceptoKey: concepto } del /shared/catalogos para resolver labels
//   initial          — { materialKey, cantidad, conceptoKey, costoUnitario, notas, requisicionItemRef, razonDiferencia }
//   lockedMaterial   — true bloquea la elección del material (modo edición)
//   showConcepto     — default true; false para salidas (cuyo conceptoKey vive en la salida)
//   showCosto        — default false; true para recepciones (costo unitario por item)
//   notasLabel       — label opcional del campo notas
//   stockMap         — Map<materialKey, { recibido, consumido, disponible }> opcional
//   requireStock     — default false. Si true: filtra results a materiales con stock > 0 y valida cantidad ≤ disponible
//   showRequisicionDelta — si true y initial.requisicionItemRef existe, muestra Δ y campo razonDiferencia
//   pedidoOtrosMap   — Map<materialKey, number> cantidad ya pedida en otras requisiciones (info panel)
//   showInfoPanel    — default false. Si true muestra panel de métricas bajo el material seleccionado
//                      (OPUS, pedido otros, falta por pedir, consumido, stock, sobrepedido warning)
//   multiAllocation  — default false. Si true, la cantidad+concepto se vuelven multi-row (split a varios conceptos).
//                      onSave(items[]) recibe array. Si false, onSave(item) recibe un objeto.
//   onSave           — function(data | array) según el modo
//
export function materialItemDialog(opts) {
  const {
    obraId, title, materiales, conceptos,
    initial = {}, lockedMaterial = false,
    showConcepto = true, showCosto = false,
    notasLabel = 'Notas',
    stockMap = null, requireStock = false,
    showRequisicionDelta = false,
    pedidoOtrosMap = null,
    showInfoPanel = false,
    multiAllocation = false,
    prorrataDefault = null,   // función (matKey) → number; para Prorratear cuando no hay total en filas
    onSave
  } = opts;
  const previaCantidad = Number(initial.cantidad) || 0;
  const reqRef = initial.requisicionItemRef || null;

  const search = h('input', { placeholder: 'Buscar por clave, descripción, marca…', autofocus: !lockedMaterial });
  const newBtn = h('button', { class: 'btn sm' }, '+ Nuevo material');
  const searchRow = h('div', { class: 'row', style: { gap: '6px' } }, [
    h('div', { style: { flex: 1 } }, search),
    !lockedMaterial && newBtn
  ]);
  const resultsBox = h('div', {
    style: {
      maxHeight: '200px', overflow: 'auto',
      border: '1px solid var(--border)', borderRadius: '6px',
      background: 'var(--bg-2)', padding: '4px'
    }
  });
  let selectedKey = initial.materialKey || null;
  let selectedConceptoKey = initial.conceptoKey || '';

  const materialPreview = h('div', {
    style: { padding: '8px 10px', background: 'var(--bg-2)', border: '1px solid var(--border)', borderRadius: '6px', minHeight: '36px' }
  });
  const cantidad = h('input', { type: 'number', step: '0.01', min: '0', value: initial.cantidad ?? '' });
  const costoUnitario = h('input', { type: 'number', step: '0.01', min: '0', value: initial.costoUnitario ?? '' });
  const conceptoSel = h('select', {});
  const conceptoNote = h('div', { class: 'muted', style: { fontSize: '11px', minHeight: '14px', marginTop: '2px' } }, '');
  const notas = h('input', { value: initial.notas || '', placeholder: 'Opcional' });
  const stockHint = h('div', { class: 'muted', style: { fontSize: '11px', minHeight: '14px' } }, '');
  const infoPanel = h('div', {
    style: {
      marginTop: '6px', padding: '8px 10px', background: 'var(--bg-2)',
      border: '1px solid var(--border)', borderRadius: '6px',
      fontSize: '11px', display: 'none'
    }
  });
  const razonInput = h('input', {
    value: initial.razonDiferencia || '',
    placeholder: 'p.ej. faltó tubo, sobró cemento, vino con defecto…'
  });
  const reqDeltaRow = h('div', { class: 'field', style: { display: 'none' } }, [
    h('label', {}, 'Razón de la diferencia con la requisición'),
    razonInput,
    h('div', { id: 'reqDeltaSummary', class: 'muted', style: { fontSize: '11px', marginTop: '2px' } }, '')
  ]);

  function effectiveStock(matKey) {
    if (!stockMap) return null;
    const e = stockMap.get(matKey);
    if (!e) return { recibido: 0, consumido: 0, disponible: 0 };
    // Cuando estás editando un item ya existente, la cantidad previa ya está
    // contada como consumido en stockMap; el "disponible para esta edición"
    // = disponible + previa.
    return { ...e, disponible: e.disponible + previaCantidad };
  }
  function refreshStockHint() {
    if (!stockMap || !selectedKey) { stockHint.textContent = ''; return; }
    const s = effectiveStock(selectedKey);
    if (!s) { stockHint.textContent = ''; return; }
    if (s.disponible > 0) {
      stockHint.innerHTML = `<span style="color: var(--ok)">🟢 Stock disponible: ${s.disponible.toFixed(2).replace(/\.00$/, '')}</span> · recibido ${s.recibido.toFixed(2).replace(/\.00$/, '')} − consumido ${s.consumido.toFixed(2).replace(/\.00$/, '')}`;
    } else {
      stockHint.innerHTML = `<span style="color: var(--danger)">🔴 Sin stock disponible</span> · recibido ${s.recibido.toFixed(2).replace(/\.00$/, '')} − consumido ${s.consumido.toFixed(2).replace(/\.00$/, '')}`;
    }
  }
  function fmt(n) { return Number(n).toFixed(2).replace(/\.00$/, ''); }
  function refreshInfoPanel() {
    if (!showInfoPanel || !selectedKey) { infoPanel.style.display = 'none'; return; }
    const m = materiales[selectedKey];
    if (!m) { infoPanel.style.display = 'none'; return; }
    const cantOpus = Number(m.cantidadOpus) || 0;
    const pedidoOtros = pedidoOtrosMap ? (pedidoOtrosMap.get(selectedKey) || 0) : 0;
    const stk = stockMap ? stockMap.get(selectedKey) : null;
    const consumido = stk ? stk.consumido : 0;
    const recibido = stk ? stk.recibido : 0;
    const disponible = stk ? stk.disponible : 0;
    const falta = cantOpus - pedidoOtros;
    const sobrepedido = pedidoOtros > cantOpus;
    const unidad = m.unidad || '';

    infoPanel.style.display = '';
    infoPanel.innerHTML = '';
    const grid = h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '8px' } });
    const cell = (label, value, color) => h('div', {}, [
      h('div', { class: 'muted', style: { fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.3px' } }, label),
      h('div', { style: { fontWeight: 600, fontSize: '13px', marginTop: '2px', color: color || 'var(--text-0)' } }, value)
    ]);
    grid.appendChild(cell('Total OPUS', cantOpus > 0 ? `${fmt(cantOpus)} ${unidad}` : '—'));
    if (pedidoOtrosMap) {
      grid.appendChild(cell('Pedido (otras reqs)', `${fmt(pedidoOtros)} ${unidad}`));
      if (cantOpus > 0) {
        grid.appendChild(cell(
          sobrepedido ? '⚠ Sobrepedido' : 'Falta por pedir',
          `${fmt(Math.abs(falta))} ${unidad}`,
          sobrepedido ? 'var(--warn)' : (falta > 0 ? 'var(--ok)' : 'var(--text-2)')
        ));
      }
    }
    if (stockMap) {
      grid.appendChild(cell('Recibido', `${fmt(recibido)} ${unidad}`));
      grid.appendChild(cell('Consumido (salidas)', `${fmt(consumido)} ${unidad}`));
      grid.appendChild(cell(
        'Stock disponible',
        `${fmt(disponible)} ${unidad}`,
        disponible > 0 ? 'var(--ok)' : 'var(--text-2)'
      ));
    }
    infoPanel.appendChild(grid);
  }
  function refreshDeltaRow() {
    if (!showRequisicionDelta || !reqRef) { reqDeltaRow.style.display = 'none'; return; }
    const cur = Number(cantidad.value) || 0;
    const orig = Number(reqRef.cantidadOriginal) || 0;
    const delta = cur - orig;
    if (Math.abs(delta) < 0.0001) {
      reqDeltaRow.style.display = 'none';
    } else {
      reqDeltaRow.style.display = '';
      const sum = reqDeltaRow.querySelector('#reqDeltaSummary');
      const sign = delta > 0 ? '+' : '';
      sum.textContent = `Requisitada: ${orig} · Recibida: ${cur} · Δ ${sign}${delta.toFixed(2).replace(/\.00$/, '')}`;
    }
  }
  cantidad.addEventListener('input', refreshDeltaRow);

  newBtn.addEventListener('click', () => {
    newMaterialDialog({
      obraId,
      onCreated: (newKey, newMat) => {
        materiales[newKey] = newMat;
        selectedKey = newKey;
        selectedConceptoKey = '';
        if (showCosto && (!costoUnitario.value || Number(costoUnitario.value) === 0)) {
          costoUnitario.value = '';   // ad-hoc tiene costo 0; el almacenista lo escribe ahora
        }
        refreshPreview();
        refreshResults();
      }
    });
  });

  function refreshPreview() {
    materialPreview.innerHTML = '';
    if (!selectedKey) {
      materialPreview.appendChild(h('span', { class: 'muted', style: { fontSize: '12px' } }, 'Selecciona o crea un material…'));
      conceptoSel.innerHTML = '';
      conceptoSel.appendChild(h('option', { value: '' }, 'Sin concepto'));
      return;
    }
    const m = materiales[selectedKey];
    if (!m) { materialPreview.textContent = '⚠ Material no encontrado'; return; }
    materialPreview.appendChild(h('div', {}, [
      h('span', { class: 'mono', style: { fontSize: '11px', color: 'var(--text-2)', marginRight: '8px' } }, m.clave),
      h('strong', {}, m.descripcion),
      h('span', { class: 'muted', style: { marginLeft: '8px', fontSize: '12px' } }, `${m.unidad}${m.marca ? ' · ' + m.marca : ''}`),
      m.origen === 'ad_hoc' ? h('span', { class: 'tag', style: { marginLeft: '6px', fontSize: '10px' }, title: 'Material creado en obra, no proviene del XLS de OPUS.' }, 'ad-hoc') : null
    ]));

    // Pre-cargar costo unitario desde el catálogo si no se especificó initial
    if (showCosto && !initial.costoUnitario && (!costoUnitario.value || costoUnitario.value === '0')) {
      if (m.costoUnitario) costoUnitario.value = m.costoUnitario;
    }

    if (showConcepto) refreshConceptoSel();
    refreshStockHint();
    refreshInfoPanel();
    if (multiAllocation) rebuildAllocRows();
  }

  function refreshConceptoSel() {
    conceptoSel.innerHTML = '';
    conceptoSel.appendChild(h('option', { value: '' }, 'Sin concepto (cargo libre)'));
    const m = materiales[selectedKey];
    const directos = (m?.conceptosDirectos || []).filter(ck => conceptos[ck]);
    const directosSet = new Set(directos);

    if (directos.length > 0) {
      for (const ck of directos) {
        const c = conceptos[ck];
        const path = (c.agrupadores || []).map(a => a.descripcion).join(' > ');
        const label = `${c.clave} — ${(c.descripcion || '').slice(0, 50)}${path ? ' [' + path + ']' : ''}`;
        conceptoSel.appendChild(h('option', { value: ck }, label));
      }
    }

    if (selectedConceptoKey && !directosSet.has(selectedConceptoKey) && conceptos[selectedConceptoKey]) {
      const c = conceptos[selectedConceptoKey];
      const path = (c.agrupadores || []).map(a => a.descripcion).join(' > ');
      const label = `★ ${c.clave} — ${(c.descripcion || '').slice(0, 50)}${path ? ' [' + path + ']' : ''}`;
      conceptoSel.appendChild(h('option', { value: selectedConceptoKey }, label));
    }

    conceptoSel.appendChild(h('option', { value: '__otro__' }, 'Otro… (elegir de toda la lista)'));
    conceptoSel.value = selectedConceptoKey || '';
    updateConceptoNote();
  }

  function updateConceptoNote() {
    const v = selectedConceptoKey;
    const m = materiales[selectedKey];
    const directos = new Set(m?.conceptosDirectos || []);
    if (v && !directos.has(v)) {
      conceptoNote.textContent = '★ Concepto fuera de las sugerencias del catálogo OPUS para este material.';
    } else if (m && (m.conceptosDirectos || []).length === 0) {
      conceptoNote.textContent = 'Este material no tiene conceptos sugeridos en el catálogo OPUS. Usa "Otro…" para elegir uno.';
    } else {
      conceptoNote.textContent = '';
    }
  }

  if (showConcepto) {
    conceptoSel.addEventListener('change', () => {
      if (conceptoSel.value === '__otro__') {
        conceptoSel.value = selectedConceptoKey || '';
        conceptoPickerDialog({
          conceptos,
          excludeKeys: new Set(materiales[selectedKey]?.conceptosDirectos || []),
          onPick: (ck) => { selectedConceptoKey = ck; refreshConceptoSel(); }
        });
      } else {
        selectedConceptoKey = conceptoSel.value;
        updateConceptoNote();
      }
    });
  }

  function refreshResults() {
    resultsBox.innerHTML = '';
    if (lockedMaterial) return;
    const q = search.value.trim().toLowerCase();
    if (!q) {
      resultsBox.appendChild(h('div', { class: 'muted', style: { padding: '12px', fontSize: '12px', textAlign: 'center' } },
        'Empieza a escribir para buscar (clave, descripción o marca).'));
      return;
    }
    let allEntries = Object.entries(materiales).filter(([, m]) => !m.archivado);
    if (requireStock && stockMap) {
      // Permitir el material actualmente seleccionado aunque su stock global
      // sea 0 (typically en edición — la cantidad previa libera espacio).
      allEntries = allEntries.filter(([k]) => {
        if (k === selectedKey) return true;
        const e = stockMap.get(k);
        return !!e && e.disponible > 0;
      });
    }
    const matches = [];
    for (const [k, m] of allEntries) {
      const blob = `${m.clave} ${m.descripcion} ${m.marca || ''}`.toLowerCase();
      if (blob.includes(q)) {
        matches.push([k, m]);
        if (matches.length >= 30) break;
      }
    }
    if (matches.length === 0) {
      const msg = requireStock && stockMap
        ? 'Sin coincidencias con stock disponible. Registra una recepción primero o ajusta la búsqueda.'
        : 'Sin coincidencias.';
      resultsBox.appendChild(h('div', { class: 'muted', style: { padding: '12px', fontSize: '12px', textAlign: 'center' } }, msg));
      return;
    }
    for (const [k, m] of matches) {
      const stk = stockMap ? stockMap.get(k) : null;
      const row = h('div', {
        style: {
          padding: '6px 10px', cursor: 'pointer', borderRadius: '4px',
          background: k === selectedKey ? 'var(--bg-3)' : 'transparent'
        },
        onClick: () => { selectedKey = k; refreshPreview(); refreshResults(); refreshDeltaRow(); }
      }, [
        h('span', { class: 'mono', style: { fontSize: '11px', color: 'var(--text-2)', marginRight: '8px' } }, m.clave),
        h('span', {}, m.descripcion.slice(0, 70)),
        m.marca && h('span', { class: 'muted', style: { marginLeft: '6px', fontSize: '11px' } }, ' · ' + m.marca),
        stk
          ? h('span', { class: 'muted', style: { marginLeft: '8px', fontSize: '10px', color: stk.disponible > 0 ? 'var(--ok)' : 'var(--text-2)' } },
              ` · stock ${stk.disponible.toFixed(2).replace(/\.00$/, '')}`)
          : null
      ]);
      resultsBox.appendChild(row);
    }
  }
  search.addEventListener('input', refreshResults);

  // ============ Multi-allocation rows (si multiAllocation=true) ============
  // Cuando true, en lugar de cantidad + 1 concepto, mostramos varias filas
  // (cantidad → concepto). Cada fila se guarda como item independiente.
  const allocRows = multiAllocation
    ? [{ cantidad: initial.cantidad ?? '', conceptoKey: initial.conceptoKey || '' }]
    : null;
  const allocContainer = h('div', {});
  const allocTotalLine = h('div', { class: 'muted', style: { fontSize: '11px', marginTop: '6px' } }, '');

  function rebuildAllocRows() {
    if (!multiAllocation) return;
    allocContainer.innerHTML = '';
    allocRows.forEach((row, idx) => {
      allocContainer.appendChild(renderAllocRow(row, idx));
    });
    refreshAllocTotal();
  }
  function refreshAllocTotal() {
    if (!multiAllocation) return;
    const total = allocRows.reduce((s, r) => s + (Number(r.cantidad) || 0), 0);
    allocTotalLine.textContent = `Total: ${total} ${materiales[selectedKey]?.unidad || ''}`;
  }
  function renderAllocRow(row, idx) {
    const cantInput = h('input', {
      type: 'number', step: '0.01', min: '0',
      value: row.cantidad ?? '',
      style: { width: '90px' }
    });
    cantInput.addEventListener('input', () => { row.cantidad = cantInput.value; refreshAllocTotal(); });

    const m = materiales[selectedKey];
    const directos = (m?.conceptosDirectos || []).filter(ck => conceptos[ck]);
    const directosSet = new Set(directos);
    const sel = h('select', { style: { flex: 1 } });
    sel.appendChild(h('option', { value: '' }, 'Sin concepto (cargo libre)'));
    if (directos.length > 0) {
      const og = h('optgroup', { label: 'Sugeridos del material' });
      for (const ck of directos) {
        const c = conceptos[ck];
        og.appendChild(h('option', { value: ck }, `${c.clave} — ${(c.descripcion || '').slice(0, 50)}`));
      }
      sel.appendChild(og);
    }
    if (row.conceptoKey && !directosSet.has(row.conceptoKey) && conceptos[row.conceptoKey]) {
      const c = conceptos[row.conceptoKey];
      sel.appendChild(h('option', { value: row.conceptoKey }, `★ ${c.clave} — ${(c.descripcion || '').slice(0, 50)}`));
    }
    sel.appendChild(h('option', { value: '__otro__' }, 'Otro… (elegir de toda la lista)'));
    sel.value = row.conceptoKey || '';

    sel.addEventListener('change', () => {
      if (sel.value === '__otro__') {
        sel.value = row.conceptoKey || '';
        conceptoPickerDialog({
          conceptos, excludeKeys: directosSet,
          onPick: (ck) => { row.conceptoKey = ck; rebuildAllocRows(); }
        });
      } else {
        row.conceptoKey = sel.value;
      }
    });

    const removeBtn = h('button', {
      class: 'btn sm ghost', title: 'Quitar asignación',
      disabled: allocRows.length <= 1,
      onClick: () => { allocRows.splice(idx, 1); rebuildAllocRows(); }
    }, '🗑');

    return h('div', {
      class: 'row',
      style: { gap: '6px', alignItems: 'center', marginBottom: '6px' }
    }, [
      cantInput,
      h('span', { class: 'muted', style: { fontSize: '12px' } }, m?.unidad || '→'),
      h('span', { class: 'muted', style: { fontSize: '12px' } }, '→'),
      sel,
      removeBtn
    ]);
  }
  const addAllocBtn = h('button', {
    class: 'btn sm',
    onClick: () => {
      allocRows.push({ cantidad: 0, conceptoKey: '' });
      rebuildAllocRows();
    }
  }, '+ Agregar otra asignación (split)');

  // Prorratear entre filas existentes (el usuario decide cuántos conceptos y
  // cuáles agregando filas). El total puede escribirse a mano; si no, se usa
  // la suma actual o el prorrataDefault (típicamente "falta por pedir").
  const totalAllocInput = h('input', {
    type: 'number', step: '0.01', min: '0',
    placeholder: 'vacío = falta por pedir',
    style: { width: '120px' }
  });
  const prorratearAllocBtn = h('button', {
    class: 'btn sm',
    title: 'Reparte el total entre las asignaciones que tengas, equitativamente',
    onClick: () => {
      if (!multiAllocation) return;
      if (!selectedKey) { toast('Selecciona un material primero', 'warn'); return; }
      if (allocRows.length === 0) { toast('Agrega al menos una asignación primero', 'warn'); return; }
      let total = Number(totalAllocInput.value);
      if (!total || total <= 0) {
        const sum = allocRows.reduce((s, r) => s + (Number(r.cantidad) || 0), 0);
        total = sum > 0 ? sum : (typeof prorrataDefault === 'function' ? Number(prorrataDefault(selectedKey)) || 0 : 0);
      }
      if (total <= 0) { toast('Escribe un total a repartir', 'warn'); return; }
      const N = allocRows.length;
      const each = Math.floor((total / N) * 100) / 100;
      const remainder = +(total - each * N).toFixed(2);
      allocRows.forEach((row, i) => {
        row.cantidad = i === N - 1 ? +(each + remainder).toFixed(2) : each;
      });
      rebuildAllocRows();
    }
  }, '⚖ Prorratear entre filas');

  // Layout dinámico de la fila de campos numéricos: cantidad + (costo) + (concepto)
  const numFields = [];
  if (!multiAllocation) {
    numFields.push(h('div', { class: 'field' }, [h('label', {}, 'Cantidad'), cantidad]));
  }
  if (showCosto) numFields.push(h('div', { class: 'field' }, [h('label', {}, 'Costo unitario'), costoUnitario]));
  if (showConcepto && !multiAllocation) numFields.push(h('div', { class: 'field' }, [h('label', {}, 'Concepto OPUS'), conceptoSel, conceptoNote]));
  const colsClass = numFields.length <= 2 ? 'grid-2' : 'grid-3';

  const helpText = multiAllocation
    ? 'Puedes partir la requisición en varios conceptos: agrega filas si lo necesitas. "+ Nuevo material" para crear ad-hoc; "Otro…" para elegir un concepto fuera de las sugerencias.'
    : showConcepto
      ? 'Las sugerencias del dropdown vienen del campo "Donde se usa" de OPUS. Usa "Otro…" para elegir un concepto fuera de las sugerencias, o "+ Nuevo material" si el insumo no está dado de alta.'
      : 'El concepto destino se establece a nivel del documento, no por item. Usa "+ Nuevo material" si el insumo no está dado de alta.';

  const body = h('div', {}, [
    !lockedMaterial && h('div', { class: 'field' }, [h('label', {}, 'Material'), searchRow, resultsBox]),
    h('div', { class: 'field' }, [h('label', {}, 'Material seleccionado'), materialPreview, stockHint, infoPanel]),
    multiAllocation
      ? h('div', { class: 'field' }, [
          h('label', {}, 'Asignar cantidad a concepto(s)'),
          allocContainer,
          h('div', { class: 'row', style: { gap: '6px', marginTop: '4px', flexWrap: 'wrap' } }, [
            addAllocBtn,
            h('span', { class: 'muted', style: { fontSize: '11px', marginLeft: '8px' } }, 'Total a repartir:'),
            totalAllocInput,
            prorratearAllocBtn
          ]),
          allocTotalLine
        ])
      : null,
    numFields.length > 0 ? h('div', { class: colsClass }, numFields) : null,
    showRequisicionDelta && reqRef ? reqDeltaRow : null,
    h('div', { class: 'field' }, [h('label', {}, notasLabel), notas]),
    h('div', { class: 'muted', style: { fontSize: '11px', marginTop: '4px' } }, helpText)
  ]);

  refreshPreview();
  refreshResults();
  refreshDeltaRow();
  refreshInfoPanel();
  if (multiAllocation) rebuildAllocRows();

  modal({
    title, body, confirmLabel: 'Guardar', size: 'lg',
    onConfirm: async () => {
      if (!selectedKey) { toast('Selecciona un material', 'danger'); return false; }

      if (multiAllocation) {
        const totalAlloc = allocRows.reduce((s, r) => s + (Number(r.cantidad) || 0), 0);
        if (totalAlloc <= 0) { toast('Agrega al menos una cantidad mayor que 0', 'danger'); return false; }
        if (requireStock && stockMap) {
          const s = effectiveStock(selectedKey);
          if (!s || totalAlloc > s.disponible) {
            toast(`Total excede stock disponible (${s ? s.disponible : 0})`, 'danger');
            return false;
          }
        }
        const items = [];
        for (const r of allocRows) {
          const c = Number(r.cantidad) || 0;
          if (c <= 0) continue;
          items.push({
            materialKey: selectedKey,
            cantidad: c,
            conceptoKey: r.conceptoKey || null,
            notas: notas.value.trim() || null
          });
        }
        if (items.length === 0) { toast('Agrega al menos una asignación', 'danger'); return false; }
        try { await onSave(items); return true; }
        catch (err) { toast('Error: ' + err.message, 'danger'); return false; }
      }

      // Modo single
      const cant = Number(cantidad.value);
      if (!cant || cant <= 0) { toast('Cantidad debe ser mayor que 0', 'danger'); return false; }
      if (requireStock && stockMap) {
        const s = effectiveStock(selectedKey);
        if (!s || cant > s.disponible) {
          toast(`Cantidad excede stock disponible (${s ? s.disponible : 0})`, 'danger');
          return false;
        }
      }
      const out = {
        materialKey: selectedKey,
        cantidad: cant,
        notas: notas.value.trim() || null
      };
      if (showConcepto) out.conceptoKey = selectedConceptoKey || null;
      if (showCosto) {
        const c = Number(costoUnitario.value);
        if (c < 0 || isNaN(c)) { toast('Costo unitario inválido', 'danger'); return false; }
        out.costoUnitario = c || 0;
      }
      if (showRequisicionDelta && reqRef) {
        out.requisicionItemRef = reqRef;
        const orig = Number(reqRef.cantidadOriginal) || 0;
        const delta = cant - orig;
        out.razonDiferencia = Math.abs(delta) > 0.0001 ? (razonInput.value.trim() || null) : null;
      }
      try {
        await onSave(out);
        return true;
      } catch (err) {
        toast('Error: ' + err.message, 'danger');
        return false;
      }
    }
  });
}

// === newMaterialDialog ===
export function newMaterialDialog({ obraId, onCreated }) {
  const clave = h('input', { placeholder: 'p.ej. ZZ-001 o el código que uses', autofocus: true });
  const descripcion = h('input', { placeholder: 'Descripción del material' });
  const unidad = h('input', { placeholder: 'PZA, m, M3, KG…' });
  const marca = h('input', { placeholder: 'Marca (opcional)' });
  const familia = h('input', { placeholder: 'Familia (opcional)' });
  const proveedor = h('input', { placeholder: 'Proveedor (opcional)' });

  const body = h('div', {}, [
    h('div', { class: 'grid-2' }, [
      h('div', { class: 'field' }, [h('label', {}, 'Clave *'), clave]),
      h('div', { class: 'field' }, [h('label', {}, 'Unidad *'), unidad])
    ]),
    h('div', { class: 'field' }, [h('label', {}, 'Descripción *'), descripcion]),
    h('div', { class: 'grid-2' }, [
      h('div', { class: 'field' }, [h('label', {}, 'Marca'), marca]),
      h('div', { class: 'field' }, [h('label', {}, 'Familia'), familia])
    ]),
    h('div', { class: 'field' }, [h('label', {}, 'Proveedor'), proveedor]),
    h('div', { class: 'muted', style: { fontSize: '11px', marginTop: '6px' } },
      'Este material queda marcado como ad-hoc. Si después aparece en el XLS de OPUS con la misma clave, descripción y unidad, OPUS lo "absorbe" en el siguiente import; si no, se preserva como ad-hoc.')
  ]);

  modal({
    title: 'Nuevo material', body, confirmLabel: 'Crear', size: 'lg',
    onConfirm: async () => {
      const cl = clave.value.trim();
      const desc = descripcion.value.trim();
      const u = unidad.value.trim();
      if (!cl || !desc || !u) { toast('Clave, descripción y unidad son obligatorios', 'danger'); return false; }
      try {
        const data = {
          clave: cl, descripcion: desc, unidad: u,
          marca: marca.value.trim(), familia: familia.value.trim(), subfamilia: '',
          proveedor: proveedor.value.trim(),
          cantidadOpus: 0, costoUnitario: 0, importe: 0,
          ultimaActualizacion: null,
          conceptosDirectos: [],
          refsRaw: [],
          origen: 'ad_hoc',
          creadoPor: state.user?.uid || null,
          creadoAt: Date.now(),
          archivado: false
        };
        const key = computeMaterialKey(data);
        await createMaterialAdHoc(obraId, key, data);
        toast('Material creado', 'ok');
        onCreated(key, data);
        return true;
      } catch (err) {
        toast('Error: ' + err.message, 'danger');
        return false;
      }
    }
  });
}

// === consumeMaterialDialog ===
//
// Modal para consumir un material desde el "stock browser" de una salida.
// El material ya está fijado (clicaste su card). El usuario decide cantidades
// y a qué concepto(s) cargar. Permite split: una cantidad total se divide en
// 1+ asignaciones, cada una con su propio conceptoKey.
//
// Sentinel `__indirecto__` para consumo que no se carga a un concepto OPUS
// (gasto general / indirecto). Se trata como cualquier otra asignación pero
// no aparece en el "Donde se usa" del export.
//
// opts:
//   material        — { clave, descripcion, unidad, conceptosDirectos, ... }
//   conceptos       — { conceptoKey: concepto } del catálogo
//   stockDisponible — número (effective, ya considerando el contexto de edición)
//   onSave(items)   — items: array de { materialKey, cantidad, conceptoKey, notas }
export function consumeMaterialDialog({ material, conceptos, stockDisponible, materialKey, onSave }) {
  const directos = (material.conceptosDirectos || []).filter(ck => conceptos[ck]);
  const directosSet = new Set(directos);

  // Cada fila tiene su propio estado en este array.
  const rows = [];

  const rowsContainer = h('div', {});
  const totalLine = h('div', { class: 'muted', style: { fontSize: '12px', marginTop: '6px' } }, '');
  const notas = h('input', { placeholder: 'Notas opcionales para todo el consumo' });

  function rebuildRows() {
    rowsContainer.innerHTML = '';
    rows.forEach((row, idx) => {
      rowsContainer.appendChild(renderRow(row, idx));
    });
    refreshTotalLine();
  }

  function refreshTotalLine() {
    const total = rows.reduce((s, r) => s + (Number(r.cantidad) || 0), 0);
    const ok = total > 0 && total <= stockDisponible;
    const overflow = total > stockDisponible;
    totalLine.innerHTML = '';
    totalLine.appendChild(h('span', {
      style: { color: overflow ? 'var(--danger)' : (ok ? 'var(--ok)' : 'var(--text-2)'), fontWeight: 600 }
    }, `Total: ${total} / ${stockDisponible} disponible${overflow ? ' ⚠ excede' : ok ? ' ✓' : ''}`));
  }

  function renderRow(row, idx) {
    const cantInput = h('input', {
      type: 'number', step: '0.01', min: '0',
      value: row.cantidad ?? '',
      style: { width: '90px' }
    });
    cantInput.addEventListener('input', () => {
      row.cantidad = cantInput.value;
      refreshTotalLine();
    });

    const conceptoSel = h('select', { style: { flex: 1 } });
    conceptoSel.appendChild(h('option', { value: CONCEPTO_INDIRECTO }, '🏷  Indirecto / gasto general'));
    if (directos.length > 0) {
      const og = h('optgroup', { label: 'Sugeridos del material' });
      for (const ck of directos) {
        const c = conceptos[ck];
        const path = (c.agrupadores || []).map(a => a.descripcion).join(' > ');
        og.appendChild(h('option', { value: ck }, `${c.clave} — ${(c.descripcion || '').slice(0, 50)}${path ? ' [' + path + ']' : ''}`));
      }
      conceptoSel.appendChild(og);
    }
    if (row.conceptoKey && !directosSet.has(row.conceptoKey) && row.conceptoKey !== CONCEPTO_INDIRECTO && conceptos[row.conceptoKey]) {
      const c = conceptos[row.conceptoKey];
      const path = (c.agrupadores || []).map(a => a.descripcion).join(' > ');
      conceptoSel.appendChild(h('option', {
        value: row.conceptoKey
      }, `★ ${c.clave} — ${(c.descripcion || '').slice(0, 50)}${path ? ' [' + path + ']' : ''}`));
    }
    conceptoSel.appendChild(h('option', { value: '__otro__' }, 'Otro… (elegir de toda la lista)'));
    conceptoSel.value = row.conceptoKey || (directos[0] || CONCEPTO_INDIRECTO);
    row.conceptoKey = conceptoSel.value;

    conceptoSel.addEventListener('change', () => {
      if (conceptoSel.value === '__otro__') {
        conceptoSel.value = row.conceptoKey || CONCEPTO_INDIRECTO;
        conceptoPickerDialog({
          conceptos,
          excludeKeys: directosSet,
          onPick: (ck) => {
            row.conceptoKey = ck;
            rebuildRows();
          }
        });
      } else {
        row.conceptoKey = conceptoSel.value;
      }
    });

    const removeBtn = h('button', {
      class: 'btn sm ghost', title: 'Quitar asignación',
      disabled: rows.length <= 1,
      onClick: () => {
        rows.splice(idx, 1);
        rebuildRows();
      }
    }, '🗑');

    return h('div', {
      class: 'row',
      style: { gap: '6px', alignItems: 'center', marginBottom: '6px' }
    }, [
      cantInput,
      h('span', { class: 'muted', style: { fontSize: '12px' } }, material.unidad || '→'),
      h('span', { class: 'muted', style: { fontSize: '12px' } }, '→'),
      conceptoSel,
      removeBtn
    ]);
  }

  // Quick-apply chips: aplicar TODO al concepto X
  function quickChip(label, ck, suggested = false) {
    return h('button', {
      class: 'btn sm',
      style: suggested ? { borderColor: 'var(--accent-2)' } : {},
      onClick: () => {
        rows.length = 0;
        rows.push({ cantidad: stockDisponible, conceptoKey: ck });
        rebuildRows();
      }
    }, label);
  }

  // Inicializar con 1 fila, cantidad = stock total y concepto sugerido (si solo
  // hay 1 directo, lo selecciona; si no, default a Indirecto).
  rows.push({
    cantidad: stockDisponible,
    conceptoKey: directos.length === 1 ? directos[0] : (directos[0] || CONCEPTO_INDIRECTO)
  });

  const quickRow = h('div', { class: 'row', style: { gap: '6px', flexWrap: 'wrap', marginBottom: '8px' } }, [
    h('span', { class: 'muted', style: { fontSize: '11px', alignSelf: 'center' } }, 'Aplicar todo a:'),
    ...directos.slice(0, 4).map(ck => quickChip(conceptos[ck]?.clave || ck.slice(0, 10), ck, true)),
    quickChip('🏷 Indirecto', CONCEPTO_INDIRECTO)
  ]);

  const addRowBtn = h('button', {
    class: 'btn sm',
    onClick: () => {
      rows.push({ cantidad: 0, conceptoKey: directos[0] || CONCEPTO_INDIRECTO });
      rebuildRows();
    }
  }, '+ Agregar otra asignación (split)');

  // Prorratear: el usuario elige las filas (cada una con su concepto),
  // define un total a repartir, y el botón divide ese total equitativamente
  // entre las filas existentes. Si no se escribe total, usa la suma actual
  // de filas o stockDisponible como fallback.
  const totalInput = h('input', {
    type: 'number', step: '0.01', min: '0',
    placeholder: `vacío = ${stockDisponible}`,
    style: { width: '110px' }
  });
  const prorratearBtn = h('button', {
    class: 'btn sm',
    title: 'Reparte el total entre las asignaciones que tengas, equitativamente',
    onClick: () => {
      if (rows.length === 0) { toast('Agrega al menos una asignación primero', 'warn'); return; }
      let total = Number(totalInput.value);
      if (!total || total <= 0) {
        const sum = rows.reduce((s, r) => s + (Number(r.cantidad) || 0), 0);
        total = sum > 0 ? sum : stockDisponible;
      }
      if (total <= 0) { toast('Escribe un total a repartir', 'warn'); return; }
      const N = rows.length;
      const each = Math.floor((total / N) * 100) / 100;
      const remainder = +(total - each * N).toFixed(2);
      rows.forEach((row, i) => {
        row.cantidad = i === N - 1 ? +(each + remainder).toFixed(2) : each;
      });
      rebuildRows();
    }
  }, '⚖ Prorratear entre filas');

  const stockBadge = h('div', {
    style: { fontSize: '12px', color: 'var(--ok)', marginBottom: '10px' }
  }, `🟢 Stock disponible: ${stockDisponible} ${material.unidad || ''}`);

  const matInfo = h('div', { style: { padding: '8px 10px', background: 'var(--bg-2)', border: '1px solid var(--border)', borderRadius: '6px', marginBottom: '10px' } }, [
    h('span', { class: 'mono', style: { fontSize: '11px', color: 'var(--text-2)', marginRight: '8px' } }, material.clave),
    h('strong', {}, material.descripcion),
    h('span', { class: 'muted', style: { marginLeft: '8px', fontSize: '12px' } }, `${material.unidad || ''}${material.marca ? ' · ' + material.marca : ''}`)
  ]);

  const body = h('div', {}, [
    matInfo,
    stockBadge,
    quickRow,
    h('div', { class: 'field' }, [
      h('label', {}, 'Asignar a'),
      rowsContainer,
      h('div', { class: 'row', style: { gap: '6px', marginTop: '4px', flexWrap: 'wrap' } }, [
        addRowBtn,
        h('span', { class: 'muted', style: { fontSize: '11px', marginLeft: '8px' } }, 'Total a repartir:'),
        totalInput,
        prorratearBtn
      ])
    ]),
    totalLine,
    h('div', { class: 'field', style: { marginTop: '8px' } }, [h('label', {}, 'Notas (aplica a todas)'), notas])
  ]);

  rebuildRows();

  modal({
    title: 'Consumir material', body, confirmLabel: 'Guardar', size: 'lg',
    onConfirm: async () => {
      const total = rows.reduce((s, r) => s + (Number(r.cantidad) || 0), 0);
      if (total <= 0) { toast('La cantidad debe ser mayor que 0', 'danger'); return false; }
      if (total > stockDisponible) { toast(`Total excede stock disponible (${stockDisponible})`, 'danger'); return false; }
      const items = [];
      for (const r of rows) {
        const cant = Number(r.cantidad) || 0;
        if (cant <= 0) continue;
        if (!r.conceptoKey) { toast('Cada asignación necesita un concepto', 'danger'); return false; }
        items.push({
          materialKey,
          cantidad: cant,
          conceptoKey: r.conceptoKey,
          notas: notas.value.trim() || null
        });
      }
      if (items.length === 0) { toast('Agrega al menos una asignación', 'danger'); return false; }
      try {
        await onSave(items);
        return true;
      } catch (err) {
        toast('Error: ' + err.message, 'danger');
        return false;
      }
    }
  });
}

// === conceptoPickerDialog ===
// Sub-modal para elegir cualquier concepto del catálogo. No usa modal() porque
// queremos cerrar al hacer click en una fila.
export function conceptoPickerDialog({ conceptos, excludeKeys = new Set(), onPick }) {
  const search = h('input', { placeholder: 'Buscar por clave, descripción, agrupador…', autofocus: true });
  const list = h('div', {
    style: {
      maxHeight: '380px', overflow: 'auto',
      border: '1px solid var(--border)', borderRadius: '6px',
      background: 'var(--bg-2)', padding: '4px'
    }
  });

  const indexed = Object.entries(conceptos)
    .filter(([k, c]) => c?.tipo === 'precio_unitario' && !c.archivado && !excludeKeys.has(k))
    .map(([k, c]) => {
      const path = (c.agrupadores || []).map(a => a.descripcion).join(' > ');
      return { key: k, c, path, blob: `${c.clave} ${c.descripcion} ${path}`.toLowerCase() };
    });

  let backdrop;
  const close = () => { if (backdrop) backdrop.remove(); };

  function refresh() {
    list.innerHTML = '';
    const q = search.value.trim().toLowerCase();
    let matches = indexed;
    if (q) matches = indexed.filter(it => it.blob.includes(q));
    if (matches.length === 0) {
      list.appendChild(h('div', { class: 'muted', style: { padding: '12px', fontSize: '12px', textAlign: 'center' } },
        q ? 'Sin coincidencias.' : 'Sin conceptos disponibles.'));
      return;
    }
    const limited = matches.slice(0, 100);
    for (const it of limited) {
      const row = h('div', {
        style: { padding: '6px 10px', cursor: 'pointer', borderRadius: '4px' },
        onmouseover: (e) => e.currentTarget.style.background = 'var(--bg-3)',
        onmouseout: (e) => e.currentTarget.style.background = 'transparent',
        onClick: () => { onPick(it.key); close(); }
      }, [
        h('div', {}, [
          h('span', { class: 'mono', style: { fontSize: '11px', color: 'var(--text-2)', marginRight: '8px' } }, it.c.clave),
          h('span', {}, (it.c.descripcion || '').slice(0, 80))
        ]),
        it.path && h('div', { class: 'muted', style: { fontSize: '11px', marginTop: '2px' } }, it.path)
      ]);
      list.appendChild(row);
    }
    if (matches.length > limited.length) {
      list.appendChild(h('div', { class: 'muted', style: { padding: '6px 10px', fontSize: '11px' } },
        `+ ${matches.length - limited.length} resultados más — refina la búsqueda.`));
    }
  }
  search.addEventListener('input', refresh);

  const card = h('div', { class: 'modal lg' }, [
    h('h2', {}, 'Elegir concepto OPUS'),
    h('div', { class: 'field' }, [h('label', {}, `Buscar (${indexed.length} disponibles)`), search]),
    list,
    h('div', { class: 'actions' }, [
      h('button', { class: 'btn ghost', onClick: () => close() }, 'Cancelar')
    ])
  ]);
  backdrop = h('div', {
    class: 'modal-backdrop',
    onClick: (e) => { if (e.target === e.currentTarget) close(); }
  }, card);
  document.getElementById('modal-root').appendChild(backdrop);
  refresh();
}
