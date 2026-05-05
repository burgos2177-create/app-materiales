// Exporta el catálogo de materiales en el mismo formato XLSX que OPUS produce.
// Sirve para retroalimentar OPUS con los ajustes hechos en obra:
//   - Materiales ad-hoc creados desde la app (rows nuevas).
//   - Conceptos asignados manualmente vía "Otro…" en items de requisiciones,
//     agregados al "Donde se usa" del material correspondiente.
//
// Mismas 12 columnas en mismo orden que el input:
//   Clave, Descripción, Unidad, Familia, Subfamilia, Marca,
//   Cantidad, Costo, Importe, Ultima actualización, Proveedor, Donde se usa
//
// Cuando existan recepciones y salidas, el merge de "usados" se extiende
// pasando esos arreglos en `extras`.

const COL_ORDER = [
  'Clave', 'Descripción', 'Unidad',
  'Familia', 'Subfamilia', 'Marca',
  'Cantidad', 'Costo', 'Importe',
  'Ultima actualización', 'Proveedor', 'Donde se usa'
];

function epochToExcelSerial(ms) {
  if (!ms || typeof ms !== 'number') return null;
  // Excel epoch (1900) — coincide con cómo OPUS lo escribe.
  return 25569 + ms / 86400000;
}

// Construye el set de conceptoKeys "usados" por cada materialKey, recorriendo
// requisiciones y (a futuro) recepciones/salidas. Exportado para que las
// vistas (catálogo, obra) lo consuman y muestren el mismo estado que el export.
export function buildUsadosPorMaterial({ requisiciones, recepciones, salidas }) {
  const map = new Map();
  const add = (matKey, conceptoKey) => {
    if (!matKey || !conceptoKey) return;
    if (!map.has(matKey)) map.set(matKey, new Set());
    map.get(matKey).add(conceptoKey);
  };
  for (const req of Object.values(requisiciones || {})) {
    for (const it of Object.values(req.items || {})) {
      add(it.materialKey, it.conceptoKey);
    }
  }
  for (const rec of Object.values(recepciones || {})) {
    if (rec.estado === 'cancelada') continue;
    for (const it of Object.values(rec.items || {})) {
      add(it.materialKey, it.conceptoKey);
    }
  }
  for (const sal of Object.values(salidas || {})) {
    // Cada item tiene su propio conceptoKey (multi-allocation). Backward compat:
    // si el item no lo trae, caemos al de la salida (modelo antiguo).
    // Descartamos asignaciones a 'Indirecto' — no son conceptos OPUS y no
    // deben afectar el "Donde se usa".
    for (const it of Object.values(sal.items || {})) {
      const ck = it.conceptoKey || sal.conceptoKey;
      if (!ck || ck === '__indirecto__') continue;
      add(it.materialKey, ck);
    }
  }
  return map;
}

// Para cada material del catálogo, separa los conceptos en `directos` (del XLS
// de OPUS, vía conceptosDirectos) y `agregados` (provenientes de items en
// requisiciones/recepciones/salidas — típicamente "Otro" en obra). El export
// y la vista de catálogo deben mostrar el mismo resultado.
export function buildConceptosResueltos(catalogoItems, args) {
  const usados = buildUsadosPorMaterial(args || {});
  const out = new Map();
  for (const [matKey, m] of Object.entries(catalogoItems || {})) {
    const directos = new Set(m?.conceptosDirectos || []);
    const u = usados.get(matKey) || new Set();
    const agregados = new Set();
    for (const ck of u) if (!directos.has(ck)) agregados.add(ck);
    out.set(matKey, {
      directos,
      agregados,
      all: new Set([...directos, ...agregados])
    });
  }
  return out;
}

export function buildExportRows({
  catalogoItems, conceptos, requisiciones, recepciones, salidas
}) {
  // Map conceptoKey → clave OPUS (para escribir [clave] en "Donde se usa")
  const claveByConceptoKey = {};
  for (const [ck, c] of Object.entries(conceptos || {})) {
    if (c?.tipo === 'precio_unitario' && c.clave) {
      claveByConceptoKey[ck] = c.clave;
    }
  }

  const usadosPorMaterial = buildUsadosPorMaterial({ requisiciones, recepciones, salidas });

  const rows = [];
  for (const [matKey, m] of Object.entries(catalogoItems || {})) {
    if (m?.archivado) continue;

    // Conceptos: directos + usados; dedupe por conceptoKey.
    const allConceptosKeys = new Set(m.conceptosDirectos || []);
    if (usadosPorMaterial.has(matKey)) {
      for (const ck of usadosPorMaterial.get(matKey)) allConceptosKeys.add(ck);
    }

    // Convertir a claves OPUS, dedupe por clave (puede haber Torre 1 / Torre 2
    // con misma clave: en el XLS de OPUS aparecía la clave una sola vez por
    // PU listado; al juntar conceptoKeys distintos pero misma clave, dedupe).
    const clavesSet = new Set();
    for (const ck of allConceptosKeys) {
      const cl = claveByConceptoKey[ck];
      if (cl) clavesSet.add(cl);
      // Si el conceptoKey no está en el catálogo actual (ya borrado), saltamos.
    }
    const dondeSeUsa = [...clavesSet].map(c => `[${c}]`).join(', ');

    rows.push({
      'Clave': m.clave || '',
      'Descripción': m.descripcion || '',
      'Unidad': m.unidad || '',
      'Familia': m.familia || '',
      'Subfamilia': m.subfamilia || '',
      'Marca': m.marca || '',
      'Cantidad': Number(m.cantidadOpus) || 0,
      'Costo': Number(m.costoUnitario) || 0,
      'Importe': Number(m.importe) || 0,
      'Ultima actualización': epochToExcelSerial(m.ultimaActualizacion),
      'Proveedor': m.proveedor || '',
      'Donde se usa': dondeSeUsa
    });
  }

  // Orden estable: alfabético por clave (igual que el listado nativo de OPUS).
  rows.sort((a, b) => String(a.Clave).localeCompare(String(b.Clave), 'es'));
  return rows;
}

// Genera y dispara la descarga del XLSX. Devuelve el filename usado.
export function downloadCatalogoXLSX(args) {
  if (!window.XLSX) throw new Error('SheetJS no cargado');
  const rows = buildExportRows(args);
  const ws = window.XLSX.utils.json_to_sheet(rows, { header: COL_ORDER });

  // Marcar la columna "Ultima actualización" como tipo fecha cuando hay valor.
  // Iteramos las celdas de esa columna y cambiamos el tipo + format.
  const range = window.XLSX.utils.decode_range(ws['!ref']);
  const colIdx = COL_ORDER.indexOf('Ultima actualización');
  for (let r = 1; r <= range.e.r; r++) {
    const addr = window.XLSX.utils.encode_cell({ r, c: colIdx });
    const cell = ws[addr];
    if (cell && typeof cell.v === 'number' && cell.v > 0) {
      cell.t = 'n';
      cell.z = 'dd/mm/yyyy';
    }
  }

  // Anchos cómodos para abrir directo en Excel (no afecta a OPUS).
  ws['!cols'] = [
    { wch: 14 }, { wch: 50 }, { wch: 8 },
    { wch: 18 }, { wch: 18 }, { wch: 16 },
    { wch: 11 }, { wch: 11 }, { wch: 13 },
    { wch: 14 }, { wch: 22 }, { wch: 60 }
  ];

  const wb = window.XLSX.utils.book_new();
  window.XLSX.utils.book_append_sheet(wb, ws, 'Materiales');

  const safeNombre = (args.obraNombre || 'obra').replace(/[^a-zA-Z0-9_-]+/g, '-');
  const dateStr = new Date().toISOString().slice(0, 10);
  const filename = `materiales-${safeNombre}-${dateStr}.xlsx`;
  window.XLSX.writeFile(wb, filename);
  return { filename, rowCount: rows.length };
}
