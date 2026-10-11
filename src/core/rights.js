/**
 * Purefield / core / rights.js
 *
 * Reader Extensions usage rights (/Perms /UR3) that change what prints.
 */

/**
 * Whether the file's usage rights (/Perms /UR3, Reader Extensions) grant
 * paper forms barcodes (/Form /BarcodePlaintext): without them Reader
 * prints a paper forms barcode as a grey box. Validity of the signature is
 * not checked.
 */
export async function barcodeRights(doc) {
  const get = async v => (v?.type === 'ref' ? (await doc.getObject(v.num))?.value ?? null : v);
  const dict = o => (o?.type === 'dict' ? o.value : null);
  const arr = o => (o?.type === 'array' ? o.value : []);
  const cat = (await doc.catalog())?.value?.value ?? {};
  const perms = dict(await get(cat.Perms));
  const ur = dict(await get(perms?.UR3 ?? perms?.UR));
  if (!ur) return false;
  for (const r of arr(await get(ur.Reference))) {
    const ref = dict(await get(r));
    const tp = dict(await get(ref?.TransformParams));
    for (const f of arr(await get(tp?.Form))) {
      const v = await get(f);
      if (v?.type === 'name' && v.value === 'BarcodePlaintext') return true;
    }
  }
  return false;
}
