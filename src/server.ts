/**
 * HTTP API over a persistent, replayed ledger, built on Express.
 *
 *   GET  /accounts/:accountNumber/ledger  → 200 AccountLedger JSON (see account-ledger.ts)
 *                                         → 404 UNKNOWN_ACCOUNT
 *   POST /accounts/:accountNumber/events  → 201 event accepted, appended to the events file
 *                                         → 422 rejected by the ledger (nothing written)
 *                                         → 400 malformed body / account mismatch
 *                                         → 404 UNKNOWN_ACCOUNT
 * Other methods on those paths are 405; any other path is 404 NOT_FOUND.
 * Errors are JSON: { "error": { "code": "...", "message": "..." } }.
 */
import express, { type ErrorRequestHandler, type Express, type RequestHandler } from 'express';
import { CODES } from './errors';
import type { LedgerStore } from './ledger-store';

const error = (code: string, message: string) => ({ error: { code, message } });

const methodNotAllowed = (allow: string): RequestHandler => (req, res) => {
  res.status(405).set('allow', allow).json(error('METHOD_NOT_ALLOWED', `${req.method} not allowed; use ${allow.split(',')[0]}`));
};

export function createApp(store: LedgerStore): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('json spaces', 2);

  app.route('/accounts/:accountNumber/ledger')
    .get((req, res) => {
      // Express has already URL-decoded the parameter.
      const { accountNumber } = req.params;
      const ledger = store.ledger(accountNumber);
      if (!ledger) {
        res.status(404).json(error(CODES.UNKNOWN_ACCOUNT, `unknown account ${accountNumber}`));
        return;
      }
      res.json(ledger);
    })
    .all(methodNotAllowed('GET, HEAD'));

  app.route('/accounts/:accountNumber/events')
    .post(express.json({ limit: '64kb' }), async (req, res) => {
      const { accountNumber } = req.params;
      const body: unknown = req.body;
      if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        res.status(400).json(error('BAD_REQUEST', 'body must be one JSON event object (Content-Type: application/json)'));
        return;
      }
      const input = body as Record<string, unknown>;
      if (input.account !== undefined && input.account !== accountNumber) {
        res.status(400).json(error('BAD_REQUEST', `body account ${JSON.stringify(input.account)} does not match path ${accountNumber}`));
        return;
      }
      if (!store.ledger(accountNumber)) {
        res.status(404).json(error(CODES.UNKNOWN_ACCOUNT, `unknown account ${accountNumber}`));
        return;
      }
      const r = await store.addEvent(accountNumber, input);
      if (r.status === 'REJECTED') {
        res.status(422).json({ error: { code: r.log.code, message: r.log.narration }, event: r.event });
        return;
      }
      res.status(201).location(`/accounts/${encodeURIComponent(accountNumber)}/ledger`).json({
        status: r.status,
        outcome: r.log.outcome,
        postingDay: r.log.postingDate,
        processedOnDay: r.log.processedOnDay,
        narration: r.log.narration,
        event: r.event,
        entries: r.entries.map((e) => e.entryId),
        ledger: r.ledger,
      });
    })
    .all(methodNotAllowed('POST'));

  app.use((req, res) => {
    res.status(404).json(error('NOT_FOUND', `no route for ${req.path}`));
  });

  const onError: ErrorRequestHandler = (err, req, res, next) => {
    // Malformed URL encoding or a malformed JSON body surface here with a 4xx status.
    const status = typeof err?.status === 'number' ? err.status : 500;
    if (res.headersSent) { next(err); return; }
    if (status >= 500) {
      // A bug, not a client error: log it, answer without leaking internals, keep serving.
      process.stderr.write(`request ${req.method} ${req.originalUrl} failed: ${err instanceof Error ? err.stack : err}\n`);
      res.status(500).json(error(CODES.INTERNAL_ERROR, 'internal error'));
      return;
    }
    res.status(status).json(error('BAD_REQUEST', err instanceof Error ? err.message : 'bad request'));
  };
  app.use(onError);

  return app;
}
