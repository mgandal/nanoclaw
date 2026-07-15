// Namespace import (not `{ z }`): zod's index re-exports `z` as a
// namespace alias, which vitest's SSR transform fails to resolve — the
// `zod/v4` subpath as a namespace import works under both vitest and
// native ESM. (First host-side Zod use; the container package imports
// `{ z }` fine because it runs un-transformed.)
import * as z from 'zod/v4';

/**
 * Host-side Zod schemas for IPC WIRE payloads, and a `wireParse` helper that
 * turns one into an `IpcHandler.parse`. This is host-only (the container
 * writes the wire payload but does not validate it, so nothing to mirror)
 * and deliberately covers ONLY the handlers whose parse is a pure strict
 * shape-check. Handlers with lenient defaulting, field clamping, snake→camel
 * renames, or path-traversal hardening keep bespoke parse() bodies — a
 * generic schema would erase that load-bearing logic (2026-07-15: audited
 * all 22, only these are mechanically equivalent).
 *
 * Each schema must reproduce its handler's EXACT accepted shape, including
 * optionality. `.strip()` (Zod's default) drops unknown keys, matching the
 * hand-rolled parses that only read named fields.
 */

/** Non-empty string — the common `typeof x === 'string' && x.length > 0`. */
const nonEmpty = z.string().min(1);

/**
 * A lenient optional string: the guards wrote `typeof x === 'string' ? x :
 * undefined`, so a WRONG-TYPE value (e.g. sender: 42) was silently dropped
 * to undefined, NOT a rejection of the whole payload. `z.string().optional()`
 * would reject the payload instead. `.catch(undefined)` reproduces the guard:
 * anything that isn't a valid string becomes undefined.
 */
const lenientOptionalString = z
  .string()
  .optional()
  .catch(undefined as string | undefined);

export const WIRE_SCHEMAS = {
  // taskId-only actions (cancel/pause/resume share this exact shape).
  cancel_task: z.object({ taskId: nonEmpty }),
  pause_task: z.object({ taskId: nonEmpty }),
  resume_task: z.object({ taskId: nonEmpty }),

  message: z.object({
    chatJid: nonEmpty,
    text: nonEmpty,
    sender: lenientOptionalString,
    webAppUrl: lenientOptionalString,
  }),

  send_file: z.object({
    chatJid: nonEmpty,
    filePath: nonEmpty,
    caption: lenientOptionalString,
  }),
} as const;

/**
 * Build an `IpcHandler.parse` from a wire schema: returns the validated,
 * typed object on success or `null` on any mismatch — the exact contract the
 * hand-rolled guards had (a bad payload is dropped, never thrown). Optional
 * fields absent from the input stay absent (Zod omits them), matching the
 * `typeof x === 'string' ? x : undefined` idiom the guards used.
 */
export function wireParse<S extends z.ZodType>(
  schema: S,
): (raw: unknown) => z.infer<S> | null {
  return (raw: unknown) => {
    const result = schema.safeParse(raw);
    return result.success ? (result.data as z.infer<S>) : null;
  };
}
