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
