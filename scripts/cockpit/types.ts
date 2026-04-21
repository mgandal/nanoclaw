// Schema version. Bump when Snapshot shape changes in a breaking way.
export const SCHEMA_VERSION = 1;

export interface Snapshot {
  generated_at: string;
  schema_version: number;
  groups: GroupSnapshot[];
  tasks: TaskSnapshot[];
  ingestion: IngestionSnapshot;
  watchlists: WatchlistGroup[];
  blogs: BlogItem[] | null;
  priorities: string[];
  vault_tree: VaultNode;
  vault_pages_available: string[];
}

export interface GroupSnapshot {
  folder: string;
  display_name: string;
  last_active_at: string | null;
  messages_24h: number;
}

export interface TaskSnapshot {
  id: string;
  group: string;
  name: string;
  schedule_raw: string;
  schedule_human: string;
  last_run: string | null;
  last_status: 'success' | 'error' | 'skipped' | null;
  last_result_excerpt: string | null;
  next_run: string | null;
  success_7d: [number, number];
  consecutive_failures: number;
}

export interface IngestionSnapshot {
  emails: IngestionEmails;
  papers: IngestionPapers;
  vault: IngestionVault;
}

export interface IngestionEmails {
  count_24h: number;
  last_at: string | null;
  recent: Array<{ subject: string; from: string; at: string }>;
}

export interface IngestionPapers {
  count_24h: number;
  last_at: string | null;
  recent: Array<{ title: string; authors: string; at: string; verdict?: 'ADOPT' | 'STEAL' | 'SKIP'; url?: string }>;
}

export interface IngestionVault {
  count_24h: number;
  last_at: string | null;
  recent: Array<{ path: string; title: string; at: string; kind: VaultKind }>;
}

export type VaultKind = 'paper' | 'synthesis' | 'tool' | 'daily' | 'wiki' | 'inbox' | 'other';

export interface WatchlistGroup {
  scope: 'group' | 'agent';
  scope_name: string;
  items: WatchlistItem[];
}

export interface WatchlistItem {
  title: string;
  url?: string;
  note?: string;
  added_at?: string;
}

export interface BlogItem {
  source: string;
  title: string;
  url: string;
  published_at: string;
  summary?: string;
}

export interface VaultNode {
  name: string;
  path: string;
  kind: 'dir' | 'file';
  children?: VaultNode[];
  edited_at?: string;
}
