import { createHmac, timingSafeEqual } from 'node:crypto';
import express, { type Express, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import type { Db } from '../db.js';
import { inboundSubmissionSchema, LeadCaptureError } from './types.js';
import {
  getCaptureSourceById,
  readCaptureSourceSigningSecrets,
  recordCaptureSourceAccepted,
  recordCaptureSourceRejected
} from './sources.js';
import { acceptInboundSubmission, payloadHash } from './submissions.js';

const MAX_BODY_BYTES = 128 * 1024;
const MAX_CLOCK_SKEW_SECONDS = 5 * 60;
const IDEMPOTENCY_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/;

function equalHex(left: string, right: string): boolean {
  if (!/^[a-f0-9]+$/i.test(left) || !/^[a-f0-9]+$/i.test(right)) return false;
  const a = Buffer.from(left, 'hex');
  const b = Buffer.from(right, 'hex');
  return a.length > 0 && a.length === b.length && timingSafeEqual(a, b);
}

async function handleIntake(db: Db, req: Request, res: Response): Promise<void> {
  const sourceId = String(req.headers['x-trevra-source'] ?? '').trim();
  const timestampRaw = String(req.headers['x-trevra-timestamp'] ?? '').trim();
  const idempotencyKey = String(req.headers['x-trevra-idempotency-key'] ?? '').trim();
  const signature = String(req.headers['x-trevra-signature'] ?? '')
    .trim()
    .replace(/^sha256=/i, '');

  const source = sourceId ? await getCaptureSourceById(db, sourceId) : null;
  if (!source) {
    res.status(404).json({ error: 'Capture source not found' });
    return;
  }
  const reject = async (status: number, message: string) => {
    await recordCaptureSourceRejected(db, source.id);
    res.status(status).json({ error: message });
  };
  if (source.status !== 'active') return void (await reject(401, 'Capture source is disabled'));
  if (!IDEMPOTENCY_RE.test(idempotencyKey))
    return void (await reject(400, 'A valid X-Trevra-Idempotency-Key is required'));
  const timestamp = Number(timestampRaw);
  if (!Number.isInteger(timestamp)) return void (await reject(401, 'Invalid capture timestamp'));
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSeconds - timestamp) > MAX_CLOCK_SKEW_SECONDS)
    return void (await reject(401, 'Capture timestamp is outside the replay window'));

  const rawBody = Buffer.isBuffer(req.body)
    ? req.body
    : Buffer.from(String(req.body ?? ''), 'utf8');
  const secrets = await readCaptureSourceSigningSecrets(db, source);
  if (secrets.length === 0) return void (await reject(401, 'Capture source has no usable secret'));
  const signed = Buffer.concat([
    Buffer.from(`${timestampRaw}.${idempotencyKey}.`, 'utf8'),
    rawBody
  ]);
  const valid = secrets.some((secret) =>
    equalHex(signature, createHmac('sha256', secret).update(signed).digest('hex'))
  );
  if (!valid) return void (await reject(401, 'Invalid capture signature'));

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return void (await reject(400, 'Invalid JSON body'));
  }
  const validated = inboundSubmissionSchema.safeParse(parsed);
  if (!validated.success)
    return void (await reject(
      400,
      validated.error.issues.map((issue) => issue.message).join('; ')
    ));

  try {
    const result = await acceptInboundSubmission(db, {
      source,
      idempotencyKey,
      body: validated.data,
      payloadHash: payloadHash(rawBody)
    });
    await recordCaptureSourceAccepted(db, source.id);
    res.status(result.duplicate ? 200 : 202).json({
      submissionId: result.submission.id,
      personId: result.contactId,
      accountId: result.accountId,
      duplicate: result.duplicate
    });
  } catch (error) {
    if (error instanceof LeadCaptureError) {
      await recordCaptureSourceRejected(db, source.id);
      res.status(error.status).json({ error: error.message });
      return;
    }
    throw error;
  }
}

export function registerLeadCaptureIntake(app: Express, db: Db): void {
  const limiter = rateLimit({
    windowMs: 60_000,
    limit: 120,
    standardHeaders: true,
    legacyHeaders: false,
    // Unknown/missing sources intentionally share one bucket. Once a source ID
    // is present it becomes the quota key, so IPv6 address normalisation never
    // enters this limiter and one source cannot spend another source's quota.
    keyGenerator: (req) => String(req.headers['x-trevra-source'] ?? 'unknown'),
    message: {
      error: 'Capture source has made too many requests. Retry with the same idempotency key.'
    }
  });

  app.post(
    '/api/intake/v1/submissions',
    limiter,
    express.raw({ type: 'application/json', limit: MAX_BODY_BYTES }),
    async (req, res, next) => {
      try {
        await handleIntake(db, req, res);
      } catch (error) {
        if (
          error &&
          typeof error === 'object' &&
          'type' in error &&
          (error as { type?: string }).type === 'entity.too.large'
        ) {
          res.status(413).json({ error: 'Capture payload is too large' });
          return;
        }
        next(error);
      }
    }
  );
}
