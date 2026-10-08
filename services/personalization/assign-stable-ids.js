#!/usr/bin/env node
/**
 * One-off migration: adds a deterministic `stableId` to every section + item in conf.yml
 * that lacks one. Keeps comments + formatting, and never changes existing valid IDs.
 * Commit the result. IDs are then owned by the YAML and survive renames/reorders.
 *
 *   node services/personalization/assign-stable-ids.js [path/to/conf.yml] [--check]
 *   --check  exit 1 if any ID is missing/invalid/duplicated, without writing (for CI)
 */
const fs = require('fs');
const path = require('path');
const YAML = require('yaml');
const { isGlobalId, suggestSectionId, suggestItemId } = require('./stable-ids');

/* Sets `stableId` right after the `after` key (name/title), so it reads naturally in the YAML */
const setIdAfter = (map, after, id) => {
  map.delete('stableId');
  const pair = new YAML.Pair(new YAML.Scalar('stableId'), new YAML.Scalar(id));
  const index = map.items.findIndex((p) => YAML.isScalar(p.key) && p.key.value === after);
  map.items.splice(index === -1 ? 0 : index + 1, 0, pair);
};

function assignStableIds(source) {
  const doc = YAML.parseDocument(source);
  if (doc.errors.length) throw new Error(doc.errors[0].message);
  const sections = doc.get('sections');
  const changes = [];
  if (!YAML.isSeq(sections)) return { output: source, changes };

  // Reserve every existing valid, unique ID first
  const taken = new Set();
  const seen = new Set();
  const keep = (node) => {
    const id = node.get('stableId');
    if (isGlobalId(id) && !seen.has(id)) { seen.add(id); taken.add(id); return true; }
    return false;
  };
  const keepFlags = sections.items.map((sec) => ({
    section: YAML.isMap(sec) && keep(sec),
    items: YAML.isMap(sec) && YAML.isSeq(sec.get('items'))
      ? sec.get('items').items.map((item) => YAML.isMap(item) && keep(item)) : [],
  }));

  sections.items.forEach((sec, si) => {
    if (!YAML.isMap(sec)) return;
    const plain = { name: sec.get('name') };
    if (!keepFlags[si].section) {
      const id = suggestSectionId(plain, taken);
      setIdAfter(sec, 'name', id);
      changes.push(`section '${plain.name}' -> ${id}`);
    }
    const items = sec.get('items');
    if (!YAML.isSeq(items)) return;
    items.items.forEach((item, ii) => {
      if (!YAML.isMap(item) || keepFlags[si].items[ii]) return;
      const id = suggestItemId(plain, { title: item.get('title') }, taken);
      setIdAfter(item, 'title', id);
      changes.push(`item '${item.get('title')}' in '${plain.name}' -> ${id}`);
    });
  });
  return { output: changes.length ? doc.toString({ lineWidth: 0 }) : source, changes };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const check = args.includes('--check');
  const file = path.resolve(args.find((a) => !a.startsWith('--'))
    || path.join(process.env.USER_DATA_DIR || 'user-data', 'conf.yml'));
  const { output, changes } = assignStableIds(fs.readFileSync(file, 'utf8'));

  if (!changes.length) {
    console.log(`All sections and items in ${file} have stable IDs.`);
  } else if (check) {
    console.error(`${changes.length} stableId(s) missing or invalid in ${file}:\n  ${changes.join('\n  ')}`);
    process.exitCode = 1;
  } else {
    fs.writeFileSync(file, output);
    console.log(`Assigned ${changes.length} stableId(s) in ${file}:\n  ${changes.join('\n  ')}`);
    console.log('Review and commit this file. Do not regenerate IDs on each deploy.');
  }

}

module.exports = { assignStableIds };
