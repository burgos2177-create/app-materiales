import { h, toast } from '../util/dom.js';
import { renderShell } from './shell.js';
import { state, setState } from '../state/store.js';
import {
  getObraMetaLegacy, loadCatalogoMateriales, loadCatalogoConceptos,
  listRequisiciones, listRecepciones, listSalidas
} from '../services/db.js';
import { buildConceptosResueltos } from '../services/opus-materiales-exporter.js';
import { isAdHoc, origenLabel } from '../services/origen.js';
import { money, num, num0, pct } from '../util/format.js';

export async function renderDashboard({ params }) {
  const obraId = params.id;
  setState({ obraActual: obraId });
  renderShell(crumbs(obraId, '...'), h('div', { class: 'empty' }, 'Cargando dashboard…'));

  const [meta, catMat, catCon, requisiciones, recepciones, salidas] = await Promise.all([
    getObraMetaLegacy(obraId),
    loadCatalogoMateriales(obraId),
    loadCatalogoConceptos(obraId),
    listRequisiciones(obraId),
    listRecepciones(obraId),
    listSalidas(obraId)
  ]);

  if (!catMat?.items || Object.keys(catMat.items).length === 0) {
    renderShell(crumbs(obraId, meta?.nombre), h('div', { class: 'empty' },
      'No hay catálogo de materiales todavía. Cárgalo primero desde la obra.'));
    return;
  }

  const items = catMat.items;
  const conceptos = catCon?.conceptos || {};
  const resueltosMap = buildConceptosResueltos(items, { requisiciones, recepciones, salidas });
  const metrics = computeMetrics(items, conceptos, requisiciones, resueltosMap, { recepciones, salidas });

  renderShell(crumbs(obraId, meta?.nombre), h('div', {}, [
    h('h1', {}, 'Dashboard de materiales'),
    kpiBar(metrics),
    h('div', { class: 'muted', style: { fontSize: '11px', marginBottom: '12px' } },
      'Los movimientos reales (recepciones/salidas) se irán habilitando y sumándose a las métricas. "Pedido" es el proxy de consumo basado en requisiciones activas.'),
    tabsView({ metrics, items, conceptos, resueltosMap })
  ]));
}

// =================== Métricas ===================

export function computeMetrics(items, conceptos, requisiciones, resueltosMap, extras = {}) {
  const recepciones = extras.recepciones || {};
  const salidas = extras.salidas || {};
  const porMaterial = new Map();
  const porConcepto = new Map();
  const porFamilia = new Map();

  // Inicializa entry por material con datos del catálogo
  for (const [matKey, m] of Object.entries(items)) {
    if (m.archivado) continue;
    porMaterial.set(matKey, {
      matKey, m,
      cantPedida: 0, importePedido: 0, itemsPedidos: 0,
      cantRecibida: 0, importeRecibido: 0, itemsRecibidos: 0,
      cantConsumida: 0, importeConsumido: 0, itemsConsumidos: 0,
      conceptosUsados: new Set()
    });

    const fam = m.familia || '(sin familia)';
    if (!porFamilia.has(fam)) {
      porFamilia.set(fam, {
        familia: fam,
        materialesCount: 0, adHocCount: 0,
        importeOpus: 0, importePedido: 0, importeRecibido: 0, importeConsumido: 0,
        materialesPedidos: 0, materialesRecibidos: 0, materialesConsumidos: 0
      });
    }
    const f = porFamilia.get(fam);
    f.materialesCount++;
    if (isAdHoc(m.origen)) f.adHocCount++;
    f.importeOpus += m.importe || 0;
  }

  // Inicializa porConcepto desde resueltosMap
  for (const [matKey, r] of resueltosMap.entries()) {
    const m = items[matKey];
    if (!m || m.archivado) continue;
    for (const ck of r.directos) {
      if (!porConcepto.has(ck)) porConcepto.set(ck, mkConceptoEntry(ck, conceptos));
      porConcepto.get(ck).matDirectos.add(matKey);
      porConcepto.get(ck).importeOpusMateriales += m.importe || 0;
    }
    for (const ck of r.agregados) {
      if (!porConcepto.has(ck)) porConcepto.set(ck, mkConceptoEntry(ck, conceptos));
      porConcepto.get(ck).matAgregados.add(matKey);
    }
  }

  // Requisiciones (no canceladas) → métricas de "pedido"
  let requisicionesActivas = 0, itemsActivos = 0, importePedidoTotal = 0;
  for (const req of Object.values(requisiciones || {})) {
    if (req.estado === 'cancelada') continue;
    requisicionesActivas++;
    for (const it of Object.values(req.items || {})) {
      if (!it.materialKey) continue;
      itemsActivos++;
      const cant = Number(it.cantidad) || 0;
      const m = items[it.materialKey];
      const costo = m?.costoUnitario || 0;
      const importe = cant * costo;
      importePedidoTotal += importe;

      const pm = porMaterial.get(it.materialKey);
      if (pm) {
        pm.cantPedida += cant; pm.importePedido += importe; pm.itemsPedidos++;
        if (it.conceptoKey) pm.conceptosUsados.add(it.conceptoKey);
      }
      if (it.conceptoKey) {
        if (!porConcepto.has(it.conceptoKey)) porConcepto.set(it.conceptoKey, mkConceptoEntry(it.conceptoKey, conceptos));
        const pc = porConcepto.get(it.conceptoKey);
        pc.itemsCount++; pc.importePedido += importe; pc.materialesUsados.add(it.materialKey);
      }
      if (m) {
        const f = porFamilia.get(m.familia || '(sin familia)');
        if (f) f.importePedido += importe;
      }
    }
  }

  // Recepciones (no canceladas) → métricas de "recibido". El costo viene del item
  // (lo que realmente se pagó), no del catálogo.
  let recepcionesActivas = 0, importeRecibidoTotal = 0;
  for (const rec of Object.values(recepciones || {})) {
    if (rec.estado === 'cancelada') continue;
    recepcionesActivas++;
    for (const it of Object.values(rec.items || {})) {
      if (!it.materialKey) continue;
      const cant = Number(it.cantidad) || 0;
      const costo = Number(it.costoUnitario) || 0;
      const importe = cant * costo;
      importeRecibidoTotal += importe;

      const pm = porMaterial.get(it.materialKey);
      if (pm) {
        pm.cantRecibida += cant; pm.importeRecibido += importe; pm.itemsRecibidos++;
        if (it.conceptoKey) pm.conceptosUsados.add(it.conceptoKey);
      }
      if (it.conceptoKey) {
        if (!porConcepto.has(it.conceptoKey)) porConcepto.set(it.conceptoKey, mkConceptoEntry(it.conceptoKey, conceptos));
        const pc = porConcepto.get(it.conceptoKey);
        pc.importeRecibido += importe; pc.materialesUsados.add(it.materialKey);
      }
      const m = items[it.materialKey];
      if (m) {
        const f = porFamilia.get(m.familia || '(sin familia)');
        if (f) f.importeRecibido += importe;
      }
    }
  }

  // Salidas → métricas de "consumido". Cada item tiene su propio conceptoKey
  // (multi-allocation). Backward compat: fallback al conceptoKey de la salida
  // si el item no lo trae. Asignaciones a 'Indirecto' suman al consumo total
  // pero no aparecen en porConcepto (no son conceptos OPUS).
  let salidasCount = 0, importeConsumidoTotal = 0, importeIndirectoTotal = 0;
  for (const sal of Object.values(salidas || {})) {
    salidasCount++;
    for (const it of Object.values(sal.items || {})) {
      if (!it.materialKey) continue;
      const ck = it.conceptoKey || sal.conceptoKey;
      const cant = Number(it.cantidad) || 0;
      const m = items[it.materialKey];
      const costo = m?.costoUnitario || 0;
      const importe = cant * costo;
      importeConsumidoTotal += importe;
      if (ck === '__indirecto__') importeIndirectoTotal += importe;

      const pm = porMaterial.get(it.materialKey);
      if (pm) {
        pm.cantConsumida += cant; pm.importeConsumido += importe; pm.itemsConsumidos++;
        if (ck && ck !== '__indirecto__') pm.conceptosUsados.add(ck);
      }
      if (ck && ck !== '__indirecto__') {
        if (!porConcepto.has(ck)) porConcepto.set(ck, mkConceptoEntry(ck, conceptos));
        const pc = porConcepto.get(ck);
        pc.importeConsumido += importe; pc.materialesUsados.add(it.materialKey);
      }
      if (m) {
        const f = porFamilia.get(m.familia || '(sin familia)');
        if (f) f.importeConsumido += importe;
      }
    }
  }

  // Postproceso: contar por familia
  for (const pm of porMaterial.values()) {
    const fam = pm.m.familia || '(sin familia)';
    const f = porFamilia.get(fam);
    if (!f) continue;
    if (pm.cantPedida > 0) f.materialesPedidos++;
    if (pm.cantRecibida > 0) f.materialesRecibidos++;
    if (pm.cantConsumida > 0) f.materialesConsumidos++;
  }

  // Totales globales
  let importeOpusTotal = 0;
  let materialesPedidos = 0, materialesRecibidos = 0, materialesConsumidos = 0;
  let materialesAdHoc = 0, materialesConConcepto = 0, materialesConAgregados = 0;
  for (const pm of porMaterial.values()) {
    importeOpusTotal += pm.m.importe || 0;
    if (pm.cantPedida > 0) materialesPedidos++;
    if (pm.cantRecibida > 0) materialesRecibidos++;
    if (pm.cantConsumida > 0) materialesConsumidos++;
    if (isAdHoc(pm.m.origen)) materialesAdHoc++;
    const r = resueltosMap.get(pm.matKey);
    if (r && r.all.size > 0) materialesConConcepto++;
    if (r && r.agregados.size > 0) materialesConAgregados++;
  }

  return {
    porMaterial, porConcepto, porFamilia,
    totals: {
      catalogoCount: porMaterial.size,
      materialesAdHoc, materialesConConcepto, materialesConAgregados,
      materialesPedidos, materialesRecibidos, materialesConsumidos,
      conceptosCubiertos: porConcepto.size,
      conceptosTotales: Object.values(conceptos).filter(c => c?.tipo === 'precio_unitario' && !c.archivado).length,
      importeOpusTotal,
      importePedidoTotal, importeRecibidoTotal, importeConsumidoTotal,
      importeIndirectoTotal,
      requisicionesActivas, itemsActivos,
      recepcionesActivas, salidasCount
    }
  };
}

function mkConceptoEntry(ck, conceptos) {
  const c = conceptos[ck];
  return {
    conceptoKey: ck,
    c,
    matDirectos: new Set(),
    matAgregados: new Set(),
    materialesUsados: new Set(),
    importeOpusMateriales: 0,
    importePedido: 0,
    importeRecibido: 0,
    importeConsumido: 0,
    itemsCount: 0
  };
}

// =================== KPIs ===================

function kpiBar(metrics) {
  const t = metrics.totals;
  const avanceConsumo = t.importeOpusTotal > 0 ? t.importeConsumidoTotal / t.importeOpusTotal : 0;

  return h('div', {
    style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '12px', marginBottom: '14px' }
  }, [
    kpiCard('Catálogo', num0(t.catalogoCount), [
      `${num0(t.materialesConConcepto)} con concepto`,
      t.materialesAdHoc > 0 ? `${num0(t.materialesAdHoc)} ad-hoc` : null,
      t.materialesConAgregados > 0 ? `★ ${num0(t.materialesConAgregados)} con agregados` : null
    ].filter(Boolean).join(' · ')),

    kpiCard('Importe presupuestado', money(t.importeOpusTotal),
      'Suma de "Importe" del XLS de OPUS'),

    kpiCard('Pedido', money(t.importePedidoTotal),
      `${num0(t.requisicionesActivas)} req · ${num0(t.itemsActivos)} items · ${num0(t.materialesPedidos)} materiales`),

    kpiCard('Recibido', money(t.importeRecibidoTotal),
      `${num0(t.recepcionesActivas)} recepciones · ${num0(t.materialesRecibidos)} materiales · costo real`),

    kpiCard('Consumido', money(t.importeConsumidoTotal),
      `${num0(t.salidasCount)} salidas · ${num0(t.materialesConsumidos)} materiales`),

    t.importeIndirectoTotal > 0
      ? kpiCard('🏷 Indirectos', money(t.importeIndirectoTotal),
          'Consumo asignado a "Indirecto" (no carga a concepto OPUS)')
      : null,

    kpiCard('% consumo vs presupuesto', pct(avanceConsumo),
      'Importe consumido (cantidad × costo del catálogo) sobre presupuesto total'),

    kpiCard('Conceptos cubiertos', `${num0(t.conceptosCubiertos)} / ${num0(t.conceptosTotales)}`,
      'Conceptos con al menos 1 material asociado (directo o agregado)')
  ]);
}

function kpiCard(label, value, sub) {
  return h('div', { class: 'card', style: { padding: '14px' } }, [
    h('div', { class: 'muted', style: { fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.4px' } }, label),
    h('div', { style: { fontSize: '22px', fontWeight: 600, marginTop: '4px' } }, value),
    sub && h('div', { class: 'muted', style: { fontSize: '11px', marginTop: '2px' } }, sub)
  ]);
}

// =================== Tabs ===================

function tabsView({ metrics, items, conceptos, resueltosMap }) {
  let active = 'materiales';
  const root = h('div', {});

  function render() {
    root.innerHTML = '';
    const tabBtn = (id, label) => h('button', {
      class: 'btn ' + (id === active ? 'primary' : 'ghost') + ' sm',
      onClick: () => { active = id; render(); }
    }, label);
    root.appendChild(h('div', { class: 'card', style: { marginBottom: '12px' } }, [
      h('div', { class: 'row' }, [
        tabBtn('materiales', 'Por material'),
        tabBtn('conceptos', 'Por concepto'),
        tabBtn('familias', 'Por familia')
      ])
    ]));
    if (active === 'materiales') root.appendChild(materialesTab(metrics));
    else if (active === 'conceptos') root.appendChild(conceptosTab(metrics));
    else root.appendChild(familiasTab(metrics));
  }
  render();
  return root;
}

// =================== Tab: Por material ===================

function materialesTab(metrics) {
  const allRows = [...metrics.porMaterial.values()];
  const familias = [...new Set(allRows.map(r => r.m.familia).filter(Boolean))].sort();

  const search = h('input', { placeholder: 'Buscar clave, descripción, marca…', style: { flex: 1, minWidth: '240px' } });
  const familiaSel = h('select', {}, [
    h('option', { value: '' }, 'Todas las familias'),
    ...familias.map(f => h('option', { value: f }, f))
  ]);
  const statusSel = h('select', {}, [
    h('option', { value: '' }, 'Cualquier status'),
    h('option', { value: 'sin_movimiento' }, 'Sin movimiento'),
    h('option', { value: 'parcial' }, 'Parcial'),
    h('option', { value: 'completo' }, 'Completo (≥ OPUS)'),
    h('option', { value: 'sobre' }, 'Sobreejecutado (> OPUS)')
  ]);

  const cols = [
    { key: 'clave', label: 'Clave', sortable: true,
      get: r => r.m.clave, render: r => h('span', { class: 'mono', style: { fontSize: '11px' } }, [
        r.m.clave,
        isAdHoc(r.m.origen) ? h('span', { class: 'tag', style: { marginLeft: '4px', fontSize: '10px' } }, origenLabel(r.m.origen)) : null
      ]) },
    { key: 'desc', label: 'Descripción', sortable: true, get: r => r.m.descripcion,
      render: r => h('span', { title: r.m.descripcion, style: { display: 'block', maxWidth: '260px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, r.m.descripcion) },
    { key: 'unidad', label: 'Unid', sortable: true, get: r => r.m.unidad },
    { key: 'cantOpus', label: 'Cant OPUS', sortable: true, num: true,
      get: r => r.m.cantidadOpus || 0, render: r => num(r.m.cantidadOpus, 4) },
    { key: 'cantPedida', label: 'Pedida', sortable: true, num: true,
      get: r => r.cantPedida, render: r => r.cantPedida > 0 ? num(r.cantPedida, 4) : h('span', { class: 'muted' }, '—') },
    { key: 'cantRecibida', label: 'Recibida', sortable: true, num: true,
      get: r => r.cantRecibida, render: r => r.cantRecibida > 0 ? num(r.cantRecibida, 4) : h('span', { class: 'muted' }, '—') },
    { key: 'cantConsumida', label: 'Consumida', sortable: true, num: true,
      get: r => r.cantConsumida, render: r => r.cantConsumida > 0 ? num(r.cantConsumida, 4) : h('span', { class: 'muted' }, '—') },
    { key: 'pctConsumo', label: '% Cons.', sortable: true, num: true,
      get: r => pctConsumoOf(r),
      render: r => {
        const p = pctConsumoOf(r);
        if (p === null) return h('span', { class: 'muted' }, '—');
        return h('span', { class: p > 1 ? 'warn' : '' }, pct(p));
      } },
    { key: 'costo', label: 'Costo cat.', sortable: true, num: true,
      get: r => r.m.costoUnitario || 0, render: r => money(r.m.costoUnitario) },
    { key: 'importeOpus', label: 'Importe OPUS', sortable: true, num: true,
      get: r => r.m.importe || 0, render: r => money(r.m.importe) },
    { key: 'importeRecibido', label: 'Imp. Recibido', sortable: true, num: true,
      get: r => r.importeRecibido,
      render: r => r.importeRecibido > 0 ? money(r.importeRecibido) : h('span', { class: 'muted' }, '—') },
    { key: 'importeConsumido', label: 'Imp. Consumido', sortable: true, num: true,
      get: r => r.importeConsumido,
      render: r => r.importeConsumido > 0 ? money(r.importeConsumido) : h('span', { class: 'muted' }, '—') },
    { key: 'status', label: 'Status', sortable: true,
      get: r => statusOf(r), render: r => statusBadge(statusOf(r)) }
  ];

  let sortKey = 'importeOpus', sortDir = 'desc';
  const counter = h('div', { class: 'muted', style: { fontSize: '12px' } }, '');

  // Status semáforo: usa "consumido" como métrica principal; si no hay consumo,
  // cae a "pedido" (proxy mientras no se carguen salidas).
  function statusOf(r) {
    if (r.cantConsumida === 0 && r.cantPedida === 0 && r.cantRecibida === 0) return 'sin_movimiento';
    const opus = r.m.cantidadOpus || 0;
    if (opus === 0) return 'parcial';
    const ratio = (r.cantConsumida || r.cantPedida) / opus;
    if (ratio > 1) return 'sobre';
    if (ratio >= 1) return 'completo';
    return 'parcial';
  }
  function pctConsumoOf(r) {
    const opus = r.m.cantidadOpus || 0;
    if (opus === 0) return null;
    return r.cantConsumida / opus;
  }

  const tbody = h('tbody', {});

  function refresh() {
    const q = search.value.trim().toLowerCase();
    const fam = familiaSel.value;
    const status = statusSel.value;

    let rows = allRows.filter(r => {
      if (q && !`${r.m.clave} ${r.m.descripcion} ${r.m.marca || ''}`.toLowerCase().includes(q)) return false;
      if (fam && r.m.familia !== fam) return false;
      if (status && statusOf(r) !== status) return false;
      return true;
    });

    rows.sort((a, b) => {
      const col = cols.find(c => c.key === sortKey);
      if (!col) return 0;
      const va = col.get(a), vb = col.get(b);
      const cmp = (typeof va === 'number' && typeof vb === 'number')
        ? va - vb
        : String(va || '').localeCompare(String(vb || ''), 'es');
      return sortDir === 'asc' ? cmp : -cmp;
    });

    tbody.innerHTML = '';
    let sumOpus = 0, sumPed = 0, sumRec = 0, sumCons = 0;
    for (const r of rows) {
      sumOpus += r.m.importe || 0;
      sumPed += r.importePedido;
      sumRec += r.importeRecibido;
      sumCons += r.importeConsumido;
      tbody.appendChild(h('tr', {}, cols.map(c =>
        h('td', { class: c.num ? 'num' : '' }, c.render ? c.render(r) : c.get(r))
      )));
    }
    counter.textContent = `${num0(rows.length)} / ${num0(allRows.length)} · OPUS ${money(sumOpus)} · Ped ${money(sumPed)} · Rec ${money(sumRec)} · Cons ${money(sumCons)}`;
  }

  search.addEventListener('input', refresh);
  familiaSel.addEventListener('change', refresh);
  statusSel.addEventListener('change', refresh);

  function headerCell(c) {
    if (!c.sortable) return h('th', { class: c.num ? 'num' : '' }, c.label);
    const isActive = sortKey === c.key;
    const arrow = isActive ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '';
    return h('th', {
      class: c.num ? 'num' : '',
      style: { cursor: 'pointer', userSelect: 'none' },
      onClick: () => {
        if (sortKey === c.key) sortDir = sortDir === 'asc' ? 'desc' : 'asc';
        else { sortKey = c.key; sortDir = c.num ? 'desc' : 'asc'; }
        rerenderHeader();
        refresh();
      }
    }, c.label + arrow);
  }
  const thead = h('thead', {});
  function rerenderHeader() {
    thead.innerHTML = '';
    thead.appendChild(h('tr', {}, cols.map(headerCell)));
  }
  rerenderHeader();

  refresh();

  return h('div', {}, [
    h('div', { class: 'card' }, [
      h('div', { class: 'row' }, [search, familiaSel, statusSel, h('div', { style: { flex: 1 } }), counter])
    ]),
    h('div', { class: 'card', style: { padding: 0, overflow: 'auto', maxHeight: '65vh' } }, [
      h('table', { class: 'tbl' }, [thead, tbody])
    ])
  ]);
}

function statusBadge(s) {
  if (s === 'sin_movimiento') return h('span', { class: 'tag muted' }, 'sin mov.');
  if (s === 'parcial')   return h('span', { class: 'tag', style: { background: 'rgba(76,194,255,.15)', color: '#4cc2ff' } }, 'parcial');
  if (s === 'completo')  return h('span', { class: 'tag ok' }, 'completo');
  if (s === 'sobre')     return h('span', { class: 'tag warn' }, '⚠ sobreejec.');
  return h('span', { class: 'tag muted' }, s);
}

// =================== Tab: Por concepto ===================

function conceptosTab(metrics) {
  const allRows = [...metrics.porConcepto.values()].filter(r => r.c);

  const search = h('input', { placeholder: 'Buscar clave, descripción, agrupador…', style: { flex: 1, minWidth: '240px' } });
  const soloPedido = h('input', { type: 'checkbox' });

  const cols = [
    { key: 'clave', label: 'Clave', sortable: true, get: r => r.c.clave,
      render: r => h('span', { class: 'mono', style: { fontSize: '11px' } }, r.c.clave) },
    { key: 'desc', label: 'Descripción', sortable: true, get: r => r.c.descripcion,
      render: r => h('span', { title: r.c.descripcion, style: { display: 'block', maxWidth: '300px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, r.c.descripcion) },
    { key: 'agrupador', label: 'Agrupador', sortable: true,
      get: r => (r.c.agrupadores || []).map(a => a.descripcion).join(' > '),
      render: r => h('span', { class: 'muted', style: { fontSize: '11px' } }, (r.c.agrupadores || []).map(a => a.descripcion).join(' > ')) },
    { key: 'matCount', label: '# materiales', sortable: true, num: true,
      get: r => r.matDirectos.size + r.matAgregados.size,
      render: r => {
        const tot = r.matDirectos.size + r.matAgregados.size;
        const ag = r.matAgregados.size;
        return h('span', {}, [
          num0(tot),
          ag > 0 ? h('span', { style: { marginLeft: '4px', color: 'var(--accent)', fontSize: '11px' } }, `★${ag}`) : null
        ]);
      } },
    { key: 'cantContrat', label: 'Cant. contrat.', sortable: true, num: true,
      get: r => r.c.cantidad || 0, render: r => num(r.c.cantidad, 2) },
    { key: 'puContrat', label: 'PU contrat.', sortable: true, num: true,
      get: r => r.c.precio_unitario || 0, render: r => money(r.c.precio_unitario) },
    { key: 'importeContrat', label: 'Importe contrat.', sortable: true, num: true,
      get: r => r.c.total || 0, render: r => money(r.c.total) },
    { key: 'importeOpusMat', label: 'Importe OPUS mat.', sortable: true, num: true,
      get: r => r.importeOpusMateriales,
      render: r => r.importeOpusMateriales > 0 ? money(r.importeOpusMateriales) : h('span', { class: 'muted' }, '—') },
    { key: 'importePedido', label: 'Pedido', sortable: true, num: true,
      get: r => r.importePedido,
      render: r => r.importePedido > 0 ? money(r.importePedido) : h('span', { class: 'muted' }, '—') },
    { key: 'importeRecibido', label: 'Recibido', sortable: true, num: true,
      get: r => r.importeRecibido,
      render: r => r.importeRecibido > 0 ? money(r.importeRecibido) : h('span', { class: 'muted' }, '—') },
    { key: 'importeConsumido', label: 'Consumido', sortable: true, num: true,
      get: r => r.importeConsumido,
      render: r => r.importeConsumido > 0 ? money(r.importeConsumido) : h('span', { class: 'muted' }, '—') }
  ];

  let sortKey = 'importeContrat', sortDir = 'desc';
  const counter = h('div', { class: 'muted', style: { fontSize: '12px' } }, '');
  const tbody = h('tbody', {});

  function refresh() {
    const q = search.value.trim().toLowerCase();
    const onlyPedido = soloPedido.checked;
    let rows = allRows.filter(r => {
      const blob = `${r.c.clave} ${r.c.descripcion} ${(r.c.agrupadores || []).map(a => a.descripcion).join(' ')}`.toLowerCase();
      if (q && !blob.includes(q)) return false;
      if (onlyPedido && r.importePedido <= 0) return false;
      return true;
    });
    rows.sort((a, b) => {
      const col = cols.find(c => c.key === sortKey);
      if (!col) return 0;
      const va = col.get(a), vb = col.get(b);
      const cmp = (typeof va === 'number' && typeof vb === 'number')
        ? va - vb : String(va || '').localeCompare(String(vb || ''), 'es');
      return sortDir === 'asc' ? cmp : -cmp;
    });
    tbody.innerHTML = '';
    let sumPed = 0, sumOpusMat = 0, sumContrat = 0;
    for (const r of rows) {
      sumPed += r.importePedido;
      sumOpusMat += r.importeOpusMateriales;
      sumContrat += r.c.total || 0;
      tbody.appendChild(h('tr', {}, cols.map(c =>
        h('td', { class: c.num ? 'num' : '' }, c.render ? c.render(r) : c.get(r))
      )));
    }
    counter.textContent = `${num0(rows.length)} / ${num0(allRows.length)} conceptos · contratado ${money(sumContrat)} · OPUS mat ${money(sumOpusMat)} · pedido ${money(sumPed)}`;
  }

  search.addEventListener('input', refresh);
  soloPedido.addEventListener('change', refresh);

  function headerCell(c) {
    if (!c.sortable) return h('th', { class: c.num ? 'num' : '' }, c.label);
    const arrow = sortKey === c.key ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '';
    return h('th', {
      class: c.num ? 'num' : '',
      style: { cursor: 'pointer', userSelect: 'none' },
      onClick: () => {
        if (sortKey === c.key) sortDir = sortDir === 'asc' ? 'desc' : 'asc';
        else { sortKey = c.key; sortDir = c.num ? 'desc' : 'asc'; }
        rerenderHeader();
        refresh();
      }
    }, c.label + arrow);
  }
  const thead = h('thead', {});
  function rerenderHeader() { thead.innerHTML = ''; thead.appendChild(h('tr', {}, cols.map(headerCell))); }
  rerenderHeader();
  refresh();

  return h('div', {}, [
    h('div', { class: 'card' }, [
      h('div', { class: 'row' }, [
        search,
        h('label', { class: 'row', style: { gap: '6px', cursor: 'pointer' } }, [
          soloPedido, h('span', { class: 'muted', style: { fontSize: '12px' } }, 'Solo con pedido > 0')
        ]),
        h('div', { style: { flex: 1 } }), counter
      ])
    ]),
    h('div', { class: 'card', style: { padding: 0, overflow: 'auto', maxHeight: '65vh' } }, [
      h('table', { class: 'tbl' }, [thead, tbody])
    ])
  ]);
}

// =================== Tab: Por familia ===================

function familiasTab(metrics) {
  const allRows = [...metrics.porFamilia.values()];

  const cols = [
    { key: 'familia', label: 'Familia', sortable: true, get: r => r.familia },
    { key: 'count', label: '# materiales', sortable: true, num: true,
      get: r => r.materialesCount, render: r => num0(r.materialesCount) },
    { key: 'adHoc', label: '# ad-hoc', sortable: true, num: true,
      get: r => r.adHocCount, render: r => r.adHocCount > 0 ? num0(r.adHocCount) : h('span', { class: 'muted' }, '—') },
    { key: 'pedidos', label: '# ped', sortable: true, num: true,
      get: r => r.materialesPedidos, render: r => r.materialesPedidos > 0 ? num0(r.materialesPedidos) : h('span', { class: 'muted' }, '—') },
    { key: 'recibidos', label: '# rec', sortable: true, num: true,
      get: r => r.materialesRecibidos, render: r => r.materialesRecibidos > 0 ? num0(r.materialesRecibidos) : h('span', { class: 'muted' }, '—') },
    { key: 'consumidos', label: '# cons', sortable: true, num: true,
      get: r => r.materialesConsumidos, render: r => r.materialesConsumidos > 0 ? num0(r.materialesConsumidos) : h('span', { class: 'muted' }, '—') },
    { key: 'importeOpus', label: 'Importe OPUS', sortable: true, num: true,
      get: r => r.importeOpus, render: r => money(r.importeOpus) },
    { key: 'importePedido', label: 'Pedido', sortable: true, num: true,
      get: r => r.importePedido, render: r => r.importePedido > 0 ? money(r.importePedido) : h('span', { class: 'muted' }, '—') },
    { key: 'importeRecibido', label: 'Recibido', sortable: true, num: true,
      get: r => r.importeRecibido, render: r => r.importeRecibido > 0 ? money(r.importeRecibido) : h('span', { class: 'muted' }, '—') },
    { key: 'importeConsumido', label: 'Consumido', sortable: true, num: true,
      get: r => r.importeConsumido, render: r => r.importeConsumido > 0 ? money(r.importeConsumido) : h('span', { class: 'muted' }, '—') },
    { key: 'pct', label: '% cons', sortable: true, num: true,
      get: r => r.importeOpus > 0 ? r.importeConsumido / r.importeOpus : 0,
      render: r => r.importeOpus > 0 ? pct(r.importeConsumido / r.importeOpus) : h('span', { class: 'muted' }, '—') }
  ];

  let sortKey = 'importeOpus', sortDir = 'desc';
  const tbody = h('tbody', {});

  function refresh() {
    const sorted = [...allRows].sort((a, b) => {
      const col = cols.find(c => c.key === sortKey);
      if (!col) return 0;
      const va = col.get(a), vb = col.get(b);
      const cmp = (typeof va === 'number' && typeof vb === 'number')
        ? va - vb : String(va || '').localeCompare(String(vb || ''), 'es');
      return sortDir === 'asc' ? cmp : -cmp;
    });
    tbody.innerHTML = '';
    for (const r of sorted) {
      tbody.appendChild(h('tr', {}, cols.map(c =>
        h('td', { class: c.num ? 'num' : '' }, c.render ? c.render(r) : c.get(r))
      )));
    }
  }

  function headerCell(c) {
    if (!c.sortable) return h('th', { class: c.num ? 'num' : '' }, c.label);
    const arrow = sortKey === c.key ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '';
    return h('th', {
      class: c.num ? 'num' : '',
      style: { cursor: 'pointer', userSelect: 'none' },
      onClick: () => {
        if (sortKey === c.key) sortDir = sortDir === 'asc' ? 'desc' : 'asc';
        else { sortKey = c.key; sortDir = c.num ? 'desc' : 'asc'; }
        rerenderHeader();
        refresh();
      }
    }, c.label + arrow);
  }
  const thead = h('thead', {});
  function rerenderHeader() { thead.innerHTML = ''; thead.appendChild(h('tr', {}, cols.map(headerCell))); }
  rerenderHeader();
  refresh();

  return h('div', { class: 'card', style: { padding: 0, overflow: 'auto', maxHeight: '65vh' } }, [
    h('table', { class: 'tbl' }, [thead, tbody])
  ]);
}

function crumbs(obraId, nombre) {
  return [
    { label: 'Obras', to: '/' },
    { label: nombre || obraId.slice(0, 6), to: '/obras/' + obraId },
    { label: 'Dashboard' }
  ];
}
