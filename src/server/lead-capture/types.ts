import { z } from 'zod';

export const CAPTURE_SOURCE_KINDS = [
  'website',
  'form',
  'signup',
  'partner',
  'integration'
] as const;
export type CaptureSourceKind = (typeof CAPTURE_SOURCE_KINDS)[number];

export const captureSourceCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    kind: z.enum(CAPTURE_SOURCE_KINDS).default('website')
  })
  .strict();

const e164 = /^\+[1-9]\d{7,14}$/;
const submissionKind = /^[a-z][a-z0-9._-]{0,79}$/;
const forbiddenTelemetryKinds = new Set([
  'page_view',
  'button_clicked',
  'job_finished',
  'database_changed',
  'feature_used',
  'error',
  'exception'
]);

const boundedString = (max: number) => z.string().trim().max(max);
const primitive = z.union([z.string().max(1000), z.number().finite(), z.boolean(), z.null()]);
const primitiveArray = z.array(primitive).max(20);
const propertyValue = z.union([primitive, primitiveArray]);

export const customPropertiesSchema = z
  .record(z.string().trim().min(1).max(80), propertyValue)
  .superRefine((value, ctx) => {
    const bytes = Buffer.byteLength(JSON.stringify(value), 'utf8');
    if (bytes > 16 * 1024) ctx.addIssue({ code: 'custom', message: 'properties exceed 16 KB' });
    if (Object.keys(value).length > 100)
      ctx.addIssue({ code: 'custom', message: 'properties contain too many keys' });
  });

export const attributionSchema = z
  .object({
    utm_source: boundedString(200).optional(),
    utm_medium: boundedString(200).optional(),
    utm_campaign: boundedString(300).optional(),
    utm_term: boundedString(300).optional(),
    utm_content: boundedString(300).optional()
  })
  .strict()
  .default({});

export const consentSchema = z
  .object({
    marketingEmail: z.boolean().optional(),
    privacyAccepted: z.boolean().optional(),
    termsAccepted: z.boolean().optional(),
    capturedAt: z.string().datetime().optional(),
    textVersion: boundedString(120).optional()
  })
  .strict()
  .default({});

const personSchema = z
  .object({
    name: boundedString(200).optional(),
    email: z.string().trim().email().max(320).optional(),
    phone: z.string().trim().regex(e164, 'phone must already be E.164').optional(),
    role: boundedString(160).optional(),
    externalId: boundedString(240).nullable().optional()
  })
  .strict()
  .refine((value) => Boolean(value.email || value.phone || value.externalId), {
    message: 'person requires email, E.164 phone, or externalId'
  });

const companySchema = z
  .object({
    domain: boundedString(500),
    name: boundedString(200).optional()
  })
  .strict();

export const inboundSubmissionSchema = z
  .object({
    kind: z
      .string()
      .trim()
      .regex(submissionKind, 'kind must be a bounded GTM event identifier')
      .refine(
        (value) => !forbiddenTelemetryKinds.has(value),
        'generic telemetry kinds are not accepted'
      ),
    occurredAt: z.string().datetime().optional(),
    sourceEventId: boundedString(240).optional(),
    person: personSchema,
    company: companySchema.nullable().optional(),
    page: z
      .object({
        url: z.string().url().max(2048).optional(),
        referrer: z.string().url().max(2048).optional()
      })
      .strict()
      .optional(),
    attribution: attributionSchema.optional(),
    consent: consentSchema.optional(),
    message: z.string().max(20_000).nullable().optional(),
    properties: customPropertiesSchema.optional()
  })
  .strict();

export type InboundSubmissionInput = z.infer<typeof inboundSubmissionSchema>;

export interface ContactRecord {
  id: string;
  workspaceId: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  linkedinUrl: string | null;
  role: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CaptureSourceRecord {
  id: string;
  workspaceId: string;
  name: string;
  key: string;
  kind: CaptureSourceKind;
  status: 'active' | 'disabled';
  lastSeenAt: string | null;
  acceptedCount: number;
  rejectedCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface InboundSubmissionRecord {
  id: string;
  workspaceId: string;
  captureSourceId: string;
  contactId: string;
  accountId: string | null;
  idempotencyKey: string;
  sourceEventId: string | null;
  kind: string;
  person: {
    name: string | null;
    email: string | null;
    phone: string | null;
    role: string | null;
    externalId: string | null;
  };
  company: { domain: string; name: string | null } | null;
  message: string | null;
  pageUrl: string | null;
  referrer: string | null;
  attribution: Record<string, unknown>;
  consent: Record<string, unknown>;
  properties: Record<string, unknown>;
  occurredAt: string | null;
  receivedAt: string;
}

export class LeadCaptureError extends Error {
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message);
  }
}
