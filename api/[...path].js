/**
 * Serverless entry point for /api/*.
 *
 * Vercel has no place to run a long-lived http server, so server.js exports
 * its request handler and this file hands each invocation straight to it. The
 * catch-all name means one function answers every /api route and sees the
 * original URL, so the routing inside server.js keeps working untouched.
 *
 * The static front-end does not come through here at all: public/ is served
 * from Vercel's CDN, which is both faster and cheaper than waking a function
 * for a file that never changes. Its default there is already
 * revalidate-on-use, which is what the unversioned app.js and styles.css
 * need, so vercel.json sets no header rules.
 *
 * Two settings there are load-bearing, and neither is obvious:
 *   - includeFiles, because public/airports.json is read with fs at runtime.
 *     Vercel traces imports, cannot see that read, and would otherwise leave
 *     the file out of the bundle.
 *   - maxDuration, because the upstream timeout in server.js is 12s and the
 *     10s default would cut a slow lookup short.
 *
 * vercel.json itself is validated against a strict schema that forbids keys
 * it does not know, so none of this can be written down beside it — a "//"
 * comment key there fails the deploy before it starts.
 */

const { handleRequest } = require('../server.js');

module.exports = handleRequest;
