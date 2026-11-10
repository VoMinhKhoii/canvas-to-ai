// A failed request that says nothing about the thing asked for: Canvas
// slowing down, no connection, or the login gone. Every reader that turns a
// failure into "not available" lets these through instead, so the run stops
// and can continue later, rather than keeping a gap as if Canvas had refused.
export const stopsTheRun = (e) => Boolean(e?.throttled || e?.offline || e?.loggedOut);

// Why such a failure stopped the run, in a few words.
export const stopReason = (e) => (e.loggedOut ? 'Your Canvas login ended' : e.offline ? 'The connection to Canvas dropped' : e.throttled ? 'Canvas asked to slow down' : e.message);
