import { z } from 'zod';
import { XUserStateSchema } from './x-source.js';

const FileRequestSchema = z.object({
  protocol_version: z.literal(1),
  job_id: z.string(),
  operation: z.enum(['parse_feed', 'extract_article']),
  input_path: z.string(),
  original_url: z.string().nullable().optional(),
  final_url: z.string().nullable().optional(),
  response_meta: z
    .object({
      content_type: z.string().optional(),
      status_code: z.number().int().optional(),
    })
    .default({}),
  options: z.record(z.unknown()).default({}),
});

/** Network collection gets its own envelope instead of a fake input file. */
const XUserRequestSchema = z.object({
  protocol_version: z.literal(1),
  job_id: z.string(),
  operation: z.literal('collect_x_user'),
  handle: z.string().regex(/^\w{1,15}$/),
  accounts_db: z.string(),
  state: XUserStateSchema,
  budget: z.object({
    max_pages: z.number().int().min(1).max(10),
    deadline_seconds: z.number().positive(),
  }),
});

export const PythonWorkerRequestSchema = z.discriminatedUnion('operation', [FileRequestSchema, XUserRequestSchema]);
export type PythonWorkerRequest = z.input<typeof PythonWorkerRequestSchema>;

export const PythonWorkerErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  retryable: z.boolean(),
  retry_after_seconds: z.number().nullable().optional(),
});
export type PythonWorkerError = z.infer<typeof PythonWorkerErrorSchema>;

export const PythonWorkerResponseSchema = z.object({
  protocol_version: z.literal(1),
  job_id: z.string(),
  status: z.enum(['success', 'partial', 'failed']),
  data: z.unknown().nullable().optional(),
  issues: z.array(z.string()).default([]),
  error: PythonWorkerErrorSchema.nullable().optional(),
});
export type PythonWorkerResponse = z.infer<typeof PythonWorkerResponseSchema>;
