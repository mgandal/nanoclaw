import type { Snapshot } from '../types.js';

export type SchemaCheck =
  | { match: true }
  | { match: false; got: number; expected: number };

export function checkSchema(snapshot: Snapshot, expected: number): SchemaCheck {
  if (snapshot.schema_version === expected) return { match: true };
  return { match: false, got: snapshot.schema_version, expected };
}
