// What people wrote, as page HTML: discussion replies, grades and teacher
// comments, inbox messages.
import { fileDetails } from './file.js';
import { stopsTheRun } from './stops.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const text = (s) => esc(s).replace(/\n/g, '<br>'); // plain text from Canvas, never markup
const day = (iso) => iso?.slice(0, 10) ?? '';

// A discussion's replies (Canvas's /view answer), in thread order and flat:
// each says who it answers, so a deep thread needs no deep nesting.
export function threadHtml({ view = [], new_entries: fresh = [], participants = [] }) {
  const names = new Map(participants.map((p) => [p.id, p.display_name]));
  const authors = new Map(); // entry id → name
  const seen = new Set();
  const parts = [];
  const stack = [...fresh].reverse().concat([...view].reverse()).map((entry) => [entry, null]); // an explicit stack: threads can be deep
  while (stack.length) {
    const [entry, parent] = stack.pop();
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    const who = names.get(entry.user_id) ?? 'Someone';
    authors.set(entry.id, who);
    const answers = parent ?? authors.get(entry.parent_id);
    if (!entry.deleted) parts.push(`<h4>${esc(who)}${answers ? `, replying to ${esc(answers)}` : ''} (${day(entry.created_at)})</h4>${entry.message ?? ''}`);
    for (const reply of [...(entry.replies ?? [])].reverse()) stack.push([reply, who]);
  }
  return parts.length ? `<h2>Replies</h2>${parts.join('')}` : '';
}

// An anonymous discussion's replies, which Canvas keeps out of /view: its
// GraphQL API has them, with each name as Canvas shows it to the student.
// Returned in the shape of /view's answer, so threadHtml writes both.
const REPLIES = `query($id: ID!, $after: String) { legacyNode(_id: $id, type: Discussion) { ... on Discussion {
  discussionEntriesConnection(first: 100, after: $after) { pageInfo { hasNextPage endCursor }
    nodes { _id parentId message createdAt deleted author { shortName } anonymousAuthor { shortName } } } } } }`;

export async function readReplies(canvas, topicId) {
  const nodes = [];
  for (let after = null; ; ) {
    const page = (await canvas.graphql(REPLIES, { id: String(topicId), after })).data.legacyNode?.discussionEntriesConnection;
    if (!page) throw new Error('Not available');
    nodes.push(...page.nodes);
    if (!page.pageInfo.hasNextPage) break;
    after = page.pageInfo.endCursor;
  }
  nodes.sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''));
  const entries = new Map(nodes.map((n) => [n._id, { id: n._id, user_id: n._id, created_at: n.createdAt, message: n.message, deleted: n.deleted, replies: [] }]));
  const view = [];
  for (const n of nodes) (entries.get(n.parentId)?.replies ?? view).push(entries.get(n._id));
  return { view, participants: nodes.map((n) => ({ id: n._id, display_name: n.author?.shortName ?? n.anonymousAuthor?.shortName ?? 'Someone' })) };
}

// One submission's grade, rubric marks and teacher comments; '' when it has none.
export function feedbackHtml(s) {
  const out = [];
  if (s.grade != null) out.push(`<p>Grade: ${esc(s.grade)}${s.assignment?.points_possible != null && s.score != null ? ` (${esc(s.score)} out of ${esc(s.assignment.points_possible)})` : ''}</p>`);
  out.push(rubricHtml(s));
  for (const c of s.submission_comments ?? []) out.push(`<h4>${esc(c.author_name)} (${day(c.created_at)})</h4><p>${text(c.comment)}</p>`);
  return out.join('');
}

// The marker's rubric: each criterion's points, rating and comment.
function rubricHtml({ rubric_assessment: marks, assignment }) {
  const criteria = assignment?.rubric;
  if (!marks || !criteria?.length) return '';
  const points = !assignment.rubric_settings?.hide_points;
  const rows = criteria.map((c) => {
    const m = marks[c.id] ?? {};
    const rating = c.ratings?.find((r) => r.id === m.rating_id)?.description ?? '';
    return `<tr><td>${esc(c.description)}</td>${points ? `<td>${m.points == null ? '' : `${esc(m.points)} / ${esc(c.points)}`}</td>` : ''}<td>${esc(rating)}</td><td>${text(m.comments ?? '')}</td></tr>`;
  });
  return `<h3>Rubric</h3><table><tr><th>Criterion</th>${points ? '<th>Points</th>' : ''}<th>Rating</th><th>Comment</th></tr>${rows.join('')}</table>`;
}

// A course's grades on one page: its total (Canvas's enrollment grades),
// then each graded assignment. '' when there is nothing graded.
export function gradesHtml(total, submissions) {
  const grade = total?.final_grade ?? total?.current_grade;
  const score = total?.final_score ?? total?.current_score;
  const percent = score != null && `${score}%`;
  const head = grade != null || percent ? `<p>Course total: ${esc(grade != null ? [grade, percent && `(${percent})`].filter(Boolean).join(' ') : percent)}</p>` : '';
  const rows = submissions
    .filter((s) => s.grade != null || s.score != null)
    .map((s) => `<tr><td>${esc(s.assignment?.name?.trim() || 'Assignment')}</td><td>${esc(s.grade ?? '')}</td><td>${s.score == null ? '' : `${esc(s.score)}${s.assignment?.points_possible != null ? ` / ${esc(s.assignment.points_possible)}` : ''}`}</td></tr>`);
  return head + (rows.length ? `<table><tr><th>Assignment</th><th>Grade</th><th>Score</th></tr>${rows.join('')}</table>` : '');
}

// A quiz's own result: the score Canvas keeps, out of the quiz's points.
export function quizScoreHtml(quiz, attempts) {
  const kept = attempts.find((a) => a.kept_score != null) ?? attempts[0];
  if (!kept || kept.kept_score == null && kept.score == null) return '';
  const tries = Math.max(...attempts.map((a) => a.attempt ?? 1));
  return `<p>Your score: ${esc(kept.kept_score ?? kept.score)}${quiz.points_possible != null ? ` out of ${esc(quiz.points_possible)}` : ''}${tries > 1 ? ` (${tries} attempts)` : ''}</p>`;
}

function conversationHtml(data) {
  const names = new Map((data.participants ?? []).map((p) => [p.id, p.name]));
  // Newest first from Canvas; read top to bottom here. Forwarded messages sit inside the one that forwarded them.
  const messages = [...(data.messages ?? [])].reverse().flatMap((m) => [m, ...(m.forwarded_messages ?? [])]);
  const body = messages.map((m) => {
    const files = (m.attachments ?? []).map((a) => a.display_name);
    return `<h3>${esc(names.get(m.author_id) ?? 'Someone')} (${day(m.created_at)})</h3><p>${text(m.body)}</p>${files.length ? `<p>Attached: ${esc(files.join(', '))}</p>` : ''}`;
  });
  return { messages, html: `<p>Between: ${esc([...names.values()].join(', '))}</p>${body.join('')}` };
}

const TITLE = (c) => [day(c.last_message_at ?? c.last_authored_message_at), c.subject?.trim() || 'No subject'].filter(Boolean).join(' ');

// One conversation as a section: its text, and its attachments under its own
// name so they sit together.
function conversationSection(data) {
  const { messages, html } = conversationHtml(data);
  const title = TITLE(data);
  const files = messages.flatMap((m) => m.attachments ?? []).map((a) => {
    const details = fileDetails(a);
    return { kind: 'file', id: a.id, title: details.name, fileName: details.name, locked: details.locked, details };
  });
  return { title: files.length ? title : null, items: [{ kind: 'page', title, html }, ...files] };
}

// Every conversation the student has: the inbox, archived and sent. Returns
// [{ context, contextName, section }]. Opening a conversation marks it read
// unless Canvas is told not to; an export must leave the inbox as it found it.
export async function readMessages(canvas, onProgress = () => {}) {
  const all = async (url) => {
    const out = [];
    for (let next = url; next; ) {
      const page = await canvas.get(next);
      out.push(...page.data);
      next = page.next;
    }
    return out;
  };
  const lists = await Promise.all(['', '&scope=archived', '&scope=sent'].map((q) => all(`/api/v1/conversations?per_page=100${q}`)));
  const unique = [...new Map(lists.flat().map((c) => [c.id, c])).values()];
  let done = 0;
  return Promise.all(unique.map(async (c) => {
    const at = { context: c.context_code, contextName: c.context_name };
    try {
      const { data } = await canvas.get(`/api/v1/conversations/${c.id}?auto_mark_as_read=false`);
      return { ...at, section: conversationSection(data) };
    } catch (e) {
      if (stopsTheRun(e)) throw e;
      return { ...at, section: { title: null, items: [{ kind: 'page', title: TITLE(c), html: '', locked: 'Not available' }] } };
    } finally {
      onProgress(++done, unique.length);
    }
  }));
}
