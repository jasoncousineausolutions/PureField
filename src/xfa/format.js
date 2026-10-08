/**
 * Purefield / xfa / format.js
 *
 * Raw value → display string, between binding and layout (spec §6, §7).
 * Sets `display` on field instances; binding's `raw` is left untouched.
 *
 *   choiceList   the display item whose save value equals raw (two items
 *                lists: the save="1" list is save values, the other display;
 *                one list is both); no match shows raw
 *   passwordEdit one passwordChar per raw character (done in layout)
 *   others       the format/picture clause, with the locale inherited from
 *                the nearest ancestor (picture.js); ui pictures are edit-only
 */

import { formatPicture } from './picture.js';

export function formatValues(root, { log, locales = {}, locale = 'en_US' } = {}) {
  // locale is inherited down the tree from the nearest ancestor that sets one
  const walk = (n, loc) => {
    const here = n.locale ?? loc;
    if (n.type === 'field') n.display = displayValue(n, { log, locales, locale: here });
    for (const c of n.children ?? []) walk(c, here);
  };
  const rootLocale = root.locale ?? locale;
  walk(root, rootLocale);
  for (const ps of root.pageSets ?? []) walkPageSet(ps, n => walk(n, rootLocale));
  return root;
}

function walkPageSet(ps, walk) {
  for (const pa of ps.pageAreas) pa.children.forEach(walk);
  for (const sub of ps.pageSets ?? []) walkPageSet(sub, walk);
}

/** Save/display pairs from a field's items lists */
export function itemPairs(n) {
  const lists = n.items ?? [];
  if (lists.length === 0) return [];
  let save = lists.find(l => l.save);
  let disp = lists.find(l => l !== save);
  if (!save) { save = lists[0]; disp = lists[1] ?? lists[0]; }
  if (!disp) disp = save;
  return save.values.map((v, i) => ({ save: v, display: disp.values[i] ?? v }));
}

/**
 * A field's display string; a display a script set (formattedValue) wins
 * @returns {string|null} null for widgets that show no text
 */
export function displayValue(n, opts) {
  const raw = n.raw;
  const kind = n.ui?.kind;
  if (kind === 'checkButton' || kind === 'imageEdit' || kind === 'passwordEdit') return null;
  if (n.scriptDisplay !== undefined) return n.scriptDisplay;
  if (kind === 'choiceList') {
    const hit = itemPairs(n).find(p => p.save === raw);
    return hit ? hit.display : (raw ?? '');
  }
  // format/picture is the display pattern; ui/*/picture only governs editing
  // (Acrobat prints a field with just an edit picture as its raw value)
  const picture = n.picture ?? null;
  if (picture) return formatPicture(picture, raw, { ...opts, kind });
  // a numeric field with no picture and no decimal value shows its number
  // without trailing zeros (itext-dataset-2page's "2.00000000" prints as 2)
  if (kind === 'numericEdit' && n.value?.valueType !== 'decimal' && typeof raw === 'string' && /^[+-]?\d+\.\d+$/.test(raw.trim())) {
    return raw.trim().replace(/0+$/, '').replace(/\.$/, '');
  }
  return raw ?? '';
}
