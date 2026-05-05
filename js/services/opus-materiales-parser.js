// Parsea el XLS de materiales exportado de OPUS con la configuración acordada:
//   Filtro `Tipo: Materiales`, Explotar hasta `Insumos básicos`,
//   Incluir solo `Materiales`. Columnas en orden:
//     Clave, Descripción, Unidad, Familia, Subfamilia, Marca,
//     Cantidad, Costo, Importe, Ultima actualización, Proveedor, Donde se usa
//
// Se usa SheetJS (cargado en index.html) — disponible como `window.XLSX`.

import { computeMaterialKey } from './material-keys.js';

const REQUIRED_COLS = ['Clave', 'Descripción', 'Unidad', 'Cantidad', 'Costo', 'Importe', 'Donde se usa'];

// Parsea un File del input → { rows, sourceFileName } sin resolver conceptosDirectos
// (para resolver hace falta el catálogo de la obra; lo hace `buildCatalogoFromXLS`).
export async function parseMaterialesXLS(file) {
  if (!window.XLSX) throw new Error('SheetJS no cargado');
  const buf = await file.arrayBuffer();
  const wb = window.XLSX.read(buf, { type: 'array' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) throw new Error('XLS sin hojas');
  const rows = window.XLSX.utils.sheet_to_json(ws, { defval: null });
  if (rows.length === 0) throw new Error('XLS vacío');

  // Validar columnas mínimas
  const cols = Object.keys(rows[0] || {});
  for (const need of REQUIRED_COLS) {
    if (!cols.includes(need)) {
      throw new Error(`Falta columna "${need}" en el XLS. Columnas detectadas: ${cols.join(', ')}`);
    }
  }

  // Limpiar filas vacías (OPUS a veces deja 1-2 al final)
  const valid = rows.filter(r => r['Clave'] && String(r['Clave']).trim());
  return { rows: valid, sourceFileName: file.name };
}

// Excel serial date → epoch ms. OPUS usa el sistema 1900 (epoch = 1899-12-30).
function excelSerialToEpoch(serial) {
  if (!serial || typeof serial !== 'number') return null;
  const ms = (serial - 25569) * 86400 * 1000;
  return Math.round(ms);
}

// Extrae las claves de "Donde se usa" — formato `[clave1], [clave2], ...`.
function extractRefs(dws) {
  if (!dws) return [];
  const matches = String(dws).match(/\[([^\]]+)\]/g) || [];
  // dedupe preservando orden
  const seen = new Set(); const out = [];
  for (const m of matches) {
    const k = m.slice(1, -1).trim();
    if (k && !seen.has(k)) { seen.add(k); out.push(k); }
  }
  return out;
}

// Construye un map clave → [conceptoKey, ...] desde los conceptos del catálogo.
// Solo incluye PUs (no agrupadores). Una clave puede mapear a múltiples conceptos
// si hay colisión Torre 1 / Torre 2 (caso documentado en CLAUDE.md).
export function buildClaveToConceptoKeysMap(conceptos) {
  const map = new Map();
  for (const [conceptoKey, c] of Object.entries(conceptos || {})) {
    if (c.tipo !== 'precio_unitario') continue;
    const k = (c.clave || '').trim();
    if (!k) continue;
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(conceptoKey);
  }
  return map;
}

// Toma rows parseados + conceptos del catálogo y produce el catálogo de
// materiales listo para escribir a /shared/materiales/{obraId}/catalogo.
//
// Devuelve { meta, items, stats } donde stats trae contadores útiles para
// mostrar al admin después del import.
export function buildCatalogoFromXLS({ rows, sourceFileName, conceptos }) {
  const claveToConceptos = buildClaveToConceptoKeysMap(conceptos);

  const items = {};
  const usedKeyCount = new Map();

  let resueltos = 0;       // materiales con al menos 1 conceptoDirecto
  let noResueltos = 0;     // materiales sin conceptosDirectos (refsRaw vacías o sin match)
  let totalRefsRaw = 0;
  let refsResueltas = 0;
  let totalImporte = 0;

  for (const r of rows) {
    const refsRaw = extractRefs(r['Donde se usa']);
    totalRefsRaw += refsRaw.length;

    const conceptosDirectosSet = new Set();
    for (const ref of refsRaw) {
      const matches = claveToConceptos.get(ref);
      if (matches) {
        refsResueltas++;
        for (const ck of matches) conceptosDirectosSet.add(ck);
      }
    }
    const conceptosDirectos = [...conceptosDirectosSet];
    if (conceptosDirectos.length > 0) resueltos++; else noResueltos++;

    const m = {
      clave: String(r['Clave'] || '').trim(),
      descripcion: String(r['Descripción'] || '').trim(),
      unidad: String(r['Unidad'] || '').trim(),
      familia: r['Familia'] ? String(r['Familia']).trim() : '',
      subfamilia: r['Subfamilia'] ? String(r['Subfamilia']).trim() : '',
      marca: r['Marca'] ? String(r['Marca']).trim() : '',
      proveedor: r['Proveedor'] ? String(r['Proveedor']).trim() : '',
      cantidadOpus: Number(r['Cantidad']) || 0,
      costoUnitario: Number(r['Costo']) || 0,
      importe: Number(r['Importe']) || 0,
      ultimaActualizacion: excelSerialToEpoch(r['Ultima actualización']),
      conceptosDirectos,
      refsRaw,
      origen: 'opus',
      archivado: false
    };
    totalImporte += m.importe;

    // Disambiguación si dos filas distintas colapsan al mismo materialKey
    // (no debería pasar con stableKey = clave+desc+unidad, pero por seguridad).
    const baseKey = computeMaterialKey(m);
    const count = usedKeyCount.get(baseKey) || 0;
    const finalKey = count === 0 ? baseKey : `${baseKey}_${count + 1}`;
    usedKeyCount.set(baseKey, count + 1);
    items[finalKey] = m;
  }

  const meta = {
    sourceFileName,
    importedAt: Date.now(),
    version: 1,
    totalMaterials: Object.keys(items).length,
    totalImporteOpus: totalImporte,
    refsResueltas,
    refsNoResueltas: totalRefsRaw - refsResueltas,
    materialesResueltos: resueltos,
    materialesNoResueltos: noResueltos
  };

  return {
    meta, items,
    stats: {
      totalMaterials: meta.totalMaterials,
      totalImporteOpus: meta.totalImporteOpus,
      refsResueltas, refsNoResueltas: meta.refsNoResueltas,
      materialesResueltos: resueltos, materialesNoResueltos: noResueltos
    }
  };
}

// Re-import idempotente. Preserva movimientos: lo que cambia es el catálogo +
// resolución de conceptosDirectos. Si un materialKey existía antes y ya no
// aparece en el XLS pero hay movimientos (recepciones/salidas), se conserva
// con `archivado: true`. Por simplicidad inicial NO hacemos esa preservación
// — al MVP basta sobrescribir. Cuando haya movimientos en producción, se
// agrega aquí la lógica análoga a reconcileCatalogo de estimaciones.
