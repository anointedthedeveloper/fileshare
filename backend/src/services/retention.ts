import { HARD_MAX_RETENTION_SECONDS, RETENTION_OPTIONS } from '../config.js';
import { badRequest } from '../utils/errors.js';

/**
 * Resolves the requested retention to seconds. Accepts a named option ("7d") or an
 * exact `retentionSeconds` that must equal one of the allowed options. Anything
 * longer than 30 days is rejected regardless of the admin-configured option list.
 */
export function resolveRetention(input: { retention?: string; retentionSeconds?: number }, allowedKeys: string[]): number {
  let seconds: number | undefined;
  if (input.retention !== undefined) {
    const opt = RETENTION_OPTIONS.find((o) => o.key === input.retention);
    if (!opt) throw badRequest('retention_invalid', 'Unknown retention option');
    seconds = opt.seconds;
  } else if (input.retentionSeconds !== undefined) {
    seconds = input.retentionSeconds;
  } else {
    throw badRequest('retention_required', 'A retention period is required');
  }
  if (!Number.isInteger(seconds) || seconds <= 0) throw badRequest('retention_invalid', 'Retention must be a positive integer');
  if (seconds > HARD_MAX_RETENTION_SECONDS) {
    throw badRequest('retention_too_long', 'Retention cannot exceed 30 days');
  }
  const opt = RETENTION_OPTIONS.find((o) => o.seconds === seconds);
  if (!opt || !allowedKeys.includes(opt.key)) {
    throw badRequest('retention_not_allowed', 'That retention period is not available');
  }
  return seconds;
}

export const computeExpiry = (seconds: number, from = new Date()) => new Date(from.getTime() + seconds * 1000);
