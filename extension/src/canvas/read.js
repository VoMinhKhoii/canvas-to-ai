import { stopsTheRun } from './stops.js';

// A Canvas listing read whole: Canvas gives it a page at a time, each with
// a link to the next. get(url) → { data, next }.
export async function readAll(get, url) {
  const out = [];
  for (let next = url; next; ) {
    const page = await get(next);
    out.push(...page.data);
    next = page.next;
  }
  return out;
}

// A listing a reader can do without: what was read before a failure is kept
// and the reader goes on, unless the failure stops the run.
export async function readSome(canvas, url) {
  const out = [];
  try {
    for (let next = url; next; ) {
      const page = await canvas.get(next);
      out.push(...page.data);
      next = page.next;
    }
  } catch (e) {
    if (stopsTheRun(e)) throw e;
  }
  return out;
}
