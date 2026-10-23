// A/B subject lines with open and click tracking, for newsletters and press
// releases.
//
//   sql.js     columns on blasts / blast_recipients; blast_links
//   send.js    the tracked send path (tokens, HTML part with pixel and
//              links, A/B groups, idempotency keys, the tie rule) — used by
//              blast.send / blast.resend in actions/field.js, by the send
//              job that carries their sends on, and by the winner job
//   track.js   public GET /o/<token>.gif and /c/<token>/<n>, written without
//              the campaign lock; the job that logs first opens and clicks
//   winner.js  the job that picks the winner and sends it to the rest, a
//              few at a time, never holding the campaign lock while it sends
//   stats.js   GET /api/blasts/stats (desk only)
export { sql } from './sql.js';
export { publicRoutes } from './track.js';
export { api } from './stats.js';
import { pickWinner } from './winner.js';
import { LOG_JOB, logHits } from './track.js';
import { SEND_JOB, WINNER_JOB, runSendJob } from './send.js';

export const jobs = { [WINNER_JOB]: pickWinner, [SEND_JOB]: runSendJob, [LOG_JOB]: logHits };

// In the full export: the links each send carried.
export const exportTables = ['blast_links'];

// Open and click counts per send are the desk's, like the sends themselves.
export const deskOnlyReads = ['/blasts/stats'];
