// Selection over a Course (see CONTEXT.md): folders → sections → items.
//
//   const sel = createSelection(course);
//   sel.toggle(id); sel.state(id) → 'on' | 'off' | 'some'; sel.pickedIn(id); sel.picked(); sel.all(); sel.count();
//
// Node ids: a folder's id, `${folder.id}#${i}` for its i-th section, and an
// item's key. Picking a folder or section picks every unlocked item in it;
// locked items are never picked.

export const sectionId = (folder, i) => `${folder.id}#${i}`;

export function createSelection(course) {
  const picked = new Set(); // item keys
  const under = new Map(); // node id → the pickable items under it
  const order = []; // { folder, section, item } in course order
  for (const folder of course.folders) {
    const all = [];
    folder.sections.forEach((section, i) => {
      const items = section.items.filter((item) => !item.locked);
      under.set(sectionId(folder, i), items);
      all.push(...items);
      for (const item of section.items) {
        under.set(item.key, item.locked ? [] : [item]);
        order.push({ folder, section, item });
      }
    });
    under.set(folder.id, all);
  }

  // How many items under a node are picked.
  const pickedIn = (id) => (under.get(id) ?? []).filter((item) => picked.has(item.key)).length;
  const state = (id) => {
    const n = pickedIn(id);
    return n === 0 ? 'off' : n === (under.get(id) ?? []).length ? 'on' : 'some';
  };

  return {
    state,
    pickedIn,
    // Turns a node on, or off when it is already fully on.
    toggle(id) {
      const turnOn = state(id) !== 'on';
      for (const item of under.get(id) ?? []) turnOn ? picked.add(item.key) : picked.delete(item.key);
    },
    clear: () => picked.clear(),
    count: () => picked.size,
    // How many pickable items a node holds.
    size: (id) => (under.get(id) ?? []).length,
    picked: () => order.filter(({ item }) => picked.has(item.key)),
    // Every item, picked or not, in course order.
    all: () => order,
  };
}
