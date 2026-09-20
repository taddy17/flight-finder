/**
 * Serverless entry point for /api/*.
 *
 * Vercel has no place to run a long-lived http server, so server.js exports
 * its request handler and this file hands each invocation straight to it. The
 * catch-all name means one function answers every /api route and sees the
 * original URL, so the routing inside server.js keeps working untouched.
 *
 * The static front-end does not come through here at all: public/ is served
 * from Vercel's CDN (see vercel.json), which is both faster and cheaper than
 * waking a function for every file.
 */

const { handleRequest } = require('../server.js');

module.exports = handleRequest;
