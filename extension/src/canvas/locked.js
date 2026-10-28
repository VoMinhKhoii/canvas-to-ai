// Why Canvas says something is locked, in plain words, or '' when it isn't.
// Canvas explains in HTML ("This file is locked until <b>…</b>").
const plain = (html) => (html ?? '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
export const lockedReason = (o, locked = o?.locked_for_user) => (locked ? plain(o.lock_explanation) || 'Locked' : '');
