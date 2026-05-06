import { h, toast, modal } from '../util/dom.js';
import { renderShell } from './shell.js';
import { state, setState } from '../state/store.js';
import {
  getObraMetaLegacy, loadCatalogoConceptos, loadCatalogoMateriales, saveCatalogoMateriales,
  listRequisiciones, listRecepciones, listSalidas,
  listMovimientosCajaChica, getCajaChicaMeta, computeSaldoCajaChica
} from '../services/db.js';
import { parseMaterialesXLS, buildCatalogoFromXLS } from '../services/opus-materiales-parser.js';
import { isAdHoc } from '../services/origen.js';
import { downloadCatalogoXLSX, buildConceptosResueltos } from '../services/opus-materiales-exporter.js';
import { navigate } from '../state/router.js';
import { money, dateMx, num0 } from '../util/format.js';

export async function renderObra({ params }) {
  const obraId = params.id;
  setState({ obraActual: obraId });
  renderShell(crumbs(obraId, '...'), h('div', { class: 'empty' }, 'Cargando obra…'));

  const [meta, catMat, catCon, requisiciones, recepciones, salidas, ccMovs, ccMeta] = await Promise.all([
    getObraMetaLegacy(obraId),
    loadCatalogoMateriales(obraId),
    loadCatalogoConceptos(obraId),
    listRequisiciones(obraId),
    listRecepciones(obraId),
    listSalidas(obraId),
    listMovimientosCajaChica(obraId),
    getCajaChicaMeta(obraId)
  ]);
  const ccSums = computeSaldoCajaChica(ccMovs);
  const ccUmbral = ccMeta?.umbralAlerta ?? 1000;
  const ccLow = ccSums.saldo < ccUmbral && ccSums.totalDepositado > 0;

  if (!meta) {
    renderShell(crumbs(obraId, '...'), h('div', { class: 'empty' }, 'Obra no encontrada en el catálogo central.'));
    return;
  }

  setState({ catalogo: catMat, conceptos: catCon?.conceptos || null });

  const numMaterials = catMat?.items ? Object.keys(catMat.items).length : 0;
  const numConceptos = catCon?.conceptos ? Object.keys(catCon.conceptos).length : 0;

  // Estado enriquecido: lo mismo que verá el export y el catálogo.
  const resueltosMap = catMat?.items
    ? buildConceptosResueltos(catMat.items, { requisiciones, recepciones, salidas })
    : new Map();
  state._materialesExtras = { requisiciones, recepciones, salidas };
  let materialesConAlguno = 0, materialesSinResolver = 0, materialesConAgregados = 0, adHocCount = 0;
  for (const [k, m] of Object.entries(catMat?.items || {})) {
    if (isAdHoc(m.origen)) adHocCount++;
    const r = resueltosMap.get(k) || { directos: new Set(), agregados: new Set(), all: new Set() };
    if (r.all.size > 0) materialesConAlguno++; else materialesSinResolver++;
    if (r.agregados.size > 0) materialesConAgregados++;
  }

  const headerCard = h('div', { class: 'card' }, [
    h('h3', {}, 'Datos de la obra'),
    h('div', { class: 'grid-3' }, [
      kv('Nombre', meta.nombre),
      kv('Contrato', meta.contratoNo),
      kv('Cliente', meta.cliente),
      kv('Constructora', meta.construye),
      kv('Ubicación', `${meta.ubicacion || ''}${meta.municipio ? ', ' + meta.municipio : ''}`),
      kv('Monto C/IVA', money(meta.montoContratoCIVA))
    ]),
    h('div', { class: 'muted', style: { marginTop: '8px', fontSize: '12px' } },
      'Estos datos se administran desde la app de estimaciones — aquí son solo lectura.')
  ]);

  const conceptosCard = h('div', { class: 'card' }, [
    h('h3', {}, 'Catálogo de conceptos'),
    numConceptos === 0
      ? h('div', { class: 'empty' }, 'No hay catálogo de conceptos cargado en /shared/catalogos. Cárgalo primero desde la app de estimaciones.')
      : h('div', { class: 'row' }, [
        h('div', {}, [h('b', {}, num0(numConceptos)), ' conceptos disponibles para resolver "Donde se usa".'])
      ])
  ]);

  const materialesCard = h('div', { class: 'card' }, [
    h('h3', {}, 'Catálogo de materiales'),
    numMaterials === 0
      ? h('div', { class: 'empty' }, [
        h('div', {}, 'No hay catálogo de materiales todavía.'),
        state.user.role === 'admin' && numConceptos > 0
          ? h('div', { style: { marginTop: '12px' } }, importButton(obraId))
          : numConceptos === 0
            ? h('div', { class: 'muted', style: { marginTop: '8px', fontSize: '12px' } }, 'Carga primero el catálogo de conceptos.')
            : null
      ])
      : h('div', {}, [
        h('div', { class: 'row' }, [
          h('div', {}, [
            h('b', {}, num0(numMaterials)), ' materiales · ',
            h('span', { class: 'muted' }, catMat.meta?.sourceFileName || ''), ' · ',
            h('span', { class: 'muted' }, dateMx(catMat.meta?.importedAt))
          ]),
          h('div', { style: { flex: 1 } }),
          h('button', { class: 'btn', onClick: () => navigate(`/obras/${obraId}/catalogo`) }, 'Ver catálogo'),
          h('button', {
            class: 'btn',
            title: 'Descarga un .xlsx con las mismas columnas que el export de OPUS, listo para reimportar allá. Incluye materiales ad-hoc y los conceptos asignados manualmente vía "Otro" en items de requisiciones.',
            onClick: () => onExport(obraId, meta?.nombre, catMat.items, state.conceptos)
          }, '↓ Exportar para OPUS'),
          state.user.role === 'admin' && importButton(obraId, true)
        ]),
        h('div', { class: 'muted', style: { marginTop: '8px', fontSize: '12px' } }, [
          h('b', {}, num0(materialesConAlguno)), ' materiales con concepto · ',
          h('b', {}, num0(materialesSinResolver)), ' sin resolver',
          materialesConAgregados > 0
            ? h('span', {}, [' · ', h('b', { style: { color: 'var(--accent)' } }, '★ ' + num0(materialesConAgregados)), ' con agregados en obra'])
            : null,
          adHocCount > 0
            ? h('span', {}, [' · ', h('b', {}, num0(adHocCount)), ' ad-hoc'])
            : null
        ])
      ])
  ]);

  const accionesCard = h('div', { class: 'card' }, [
    h('h3', {}, 'Movimientos y análisis'),
    h('div', { class: 'row' }, [
      h('button', { class: 'btn', onClick: () => navigate(`/obras/${obraId}/dashboard`) }, '📊 Dashboard'),
      h('button', { class: 'btn', onClick: () => navigate(`/obras/${obraId}/requisiciones`) }, 'Requisiciones'),
      h('button', { class: 'btn', onClick: () => navigate(`/obras/${obraId}/recepciones`) }, 'Recepciones'),
      h('button', { class: 'btn', onClick: () => navigate(`/obras/${obraId}/salidas`) }, 'Salidas')
    ])
  ]);

  const cajaChicaCard = h('div', { class: 'card' }, [
    h('div', { class: 'row' }, [
      h('h3', { style: { margin: 0 } }, '💰 Caja chica'),
      h('div', { style: { flex: 1 } }),
      h('button', { class: 'btn', onClick: () => navigate(`/obras/${obraId}/caja-chica`) }, 'Ver módulo →')
    ]),
    h('div', { class: 'row', style: { marginTop: '12px', gap: '24px' } }, [
      h('div', {}, [
        h('div', { class: 'muted', style: { fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.4px' } }, 'Saldo conciliado'),
        h('div', {
          style: {
            fontSize: '20px', fontWeight: 600, marginTop: '2px',
            color: ccSums.saldo <= 0 && ccSums.totalDepositado > 0 ? 'var(--danger)' : (ccLow ? 'var(--warn)' : (ccSums.saldo > 0 ? 'var(--ok)' : 'var(--text-2)'))
          }
        }, money(ccSums.saldo))
      ]),
      ccSums.totalReportadoPendiente > 0 && h('div', {}, [
        h('div', { class: 'muted', style: { fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.4px' } }, 'Reportado pendiente'),
        h('div', { style: { fontSize: '14px', marginTop: '2px', color: 'var(--accent)' } }, money(ccSums.totalReportadoPendiente))
      ]),
      ccLow && h('div', { class: 'tag warn' }, `⚠ saldo bajo (umbral ${money(ccUmbral)})`),
      ccSums.saldo <= 0 && ccSums.totalDepositado > 0 && h('div', { class: 'tag danger' }, '🔴 saldo agotado')
    ])
  ]);

  renderShell(crumbs(obraId, meta.nombre), h('div', {}, [
    headerCard, conceptosCard, materialesCard, accionesCard, cajaChicaCard
  ]));
}

function crumbs(obraId, nombre) {
  return [{ label: 'Obras', to: '/' }, { label: nombre || obraId.slice(0, 6) }];
}

function kv(label, val) {
  return h('div', { class: 'field' }, [
    h('label', {}, label),
    h('div', {}, val || '—')
  ]);
}

function importButton(obraId, compact = false) {
  const fileInput = h('input', {
    type: 'file', accept: '.xls,.xlsx', style: { display: 'none' },
    onChange: (e) => handleFile(obraId, e.target.files[0])
  });
  const label = compact ? 'Re-importar XLS' : 'Subir XLS de materiales';
  const btn = h('button', { class: compact ? 'btn sm' : 'btn primary', onClick: () => fileInput.click() }, label);
  return h('div', {}, [fileInput, btn]);
}

async function onExport(obraId, obraNombre, catalogoItems, conceptos) {
  if (!catalogoItems || Object.keys(catalogoItems).length === 0) {
    toast('No hay catálogo para exportar', 'danger');
    return;
  }
  if (!conceptos) {
    toast('Falta el catálogo de conceptos', 'danger');
    return;
  }
  try {
    toast('Generando XLSX…');
    const [requisiciones, recepciones, salidas] = await Promise.all([
      listRequisiciones(obraId), listRecepciones(obraId), listSalidas(obraId)
    ]);
    const { filename, rowCount } = downloadCatalogoXLSX({
      obraNombre, catalogoItems, conceptos, requisiciones, recepciones, salidas
    });
    toast(`${filename} (${rowCount} materiales)`, 'ok');
  } catch (err) {
    console.error(err);
    toast('Error: ' + err.message, 'danger');
  }
}

async function handleFile(obraId, file) {
  if (!file) return;
  try {
    const conceptos = state.conceptos;
    if (!conceptos) {
      toast('Falta cargar el catálogo de conceptos', 'danger');
      return;
    }
    toast('Parseando XLS…');
    const { rows, sourceFileName } = await parseMaterialesXLS(file);
    const { meta, items, stats } = buildCatalogoFromXLS({ rows, sourceFileName, conceptos });

    const body = h('div', {}, [
      h('p', {}, [
        'Se importarán ', h('b', {}, stats.totalMaterials), ' materiales desde ',
        h('code', {}, sourceFileName), '.'
      ]),
      h('ul', { style: { fontSize: '13px', lineHeight: '1.6' } }, [
        h('li', {}, [h('b', {}, stats.materialesResueltos), ' con al menos un concepto resuelto']),
        stats.materialesNoResueltos > 0 ? h('li', {}, [h('b', {}, stats.materialesNoResueltos), ' sin concepto resuelto (refs no encontradas en /shared/catalogos)']) : null,
        h('li', {}, [h('b', {}, stats.refsResueltas), ' / ', h('b', {}, stats.refsResueltas + stats.refsNoResueltas), ' refs "Donde se usa" resueltas'])
      ]),
      h('p', { class: 'muted', style: { fontSize: '12px' } },
        'Esta versión sobrescribe el catálogo previo. Cuando haya movimientos en producción, los materiales referenciados que ya no aparezcan se preservarán como archivados.')
    ]);

    const ok = await modal({
      title: 'Importar catálogo de materiales',
      body, confirmLabel: 'Importar',
      onConfirm: async () => {
        await saveCatalogoMateriales(obraId, meta, items);
        toast('Catálogo importado', 'ok');
        return true;
      }
    });
    if (ok) renderObra({ params: { id: obraId } });
  } catch (err) {
    console.error(err);
    toast('Error: ' + err.message, 'danger');
  }
}
