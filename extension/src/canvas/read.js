import { stopsTheRun } from './stops.js';

// A Canvas listing read whole: Canvas gives it a page at a time, each with
// a link to the next. get(url) → { data, next }. Pages are added to `out` as
// they come, so a caller can keep what was read before a failure.
export async function readAll(get, url, out = []) {
  for (let next = url; next; ) {
    const page = await get(next);
    out.push(...page.data);
    next = page.next;
  }
  return out;
}

// A listing a reader can do without: what was read before a failure is kept
// and the reader goes on, unless the failure stops the run.
async function readSome(get, url) {
  const out = [];
  try {
    await readAll(get, url, out);
  } catch (e) {
    if (stopsTheRun(e)) throw e;
  }
  return out;
}

// The student's enrollments in every course (each carries that course's
// grades) and the student's groups (each names its course, or none).
export const studentEnrollments = (canvas) => readSome((u) => canvas.get(u), '/api/v1/users/self/enrollments?type[]=StudentEnrollment&state[]=active&state[]=completed&per_page=100');
export const studentGroups = (canvas) => readSome((u) => canvas.get(u), '/api/v1/users/self/groups?per_page=100');
