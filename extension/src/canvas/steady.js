// steady(canvas) → the same get(url) (and graphql), paced for a run of thousands of requests.
//
// Canvas meters requests with a leaky bucket: each one costs quota, part of it
// held up front while the request runs, and the bucket refills at about 10
// units a second. So few requests run at once, everything waits when quota
// runs low, and a request Canvas turned away is sent again after a pause.
// So is one lost to the connection (Wi-Fi dropping, a laptop waking up) or
// to the Canvas tab moving on: a few minutes of that is waited out.
import { limiter } from '../limit.js';

const PARALLEL = 6; // on RMIT's Canvas, 3 at once left the quota all but full
const LOW_QUOTA = 250; // of about 700
const REFILL_MS = 100; // per unit of quota
const RETRIES = 12; // 2 s, 4 s, … then every 30 s: about 5 minutes in all
const LONGEST_WAIT = 30_000;
const again = (e) => e.throttled || e.offline || e.status >= 500;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function steady(canvas, { sleep = wait, now = Date.now } = {}) {
  const limit = limiter(PARALLEL);
  let holdUntil = 0; // one hold for every request: the quota is shared
  const hold = (ms) => {
    holdUntil = Math.max(holdUntil, now() + ms);
  };
  const clear = async () => {
    for (let left = holdUntil - now(); left > 0; left = holdUntil - now()) await sleep(left);
  };
  const paced = (request) => limit(async () => {
    for (let attempt = 0; ; attempt++) {
      await clear();
      try {
        const res = await request();
        if (res.remaining < LOW_QUOTA) hold((LOW_QUOTA - res.remaining) * REFILL_MS);
        return res;
      } catch (e) {
        if (!again(e) || attempt === RETRIES) throw e;
        hold(Math.min(2000 * 2 ** attempt, LONGEST_WAIT));
      }
    }
  });
  return {
    get: (url) => paced(() => canvas.get(url)),
    graphql: (query, variables) => paced(() => canvas.graphql(query, variables)),
  };
}
