import fs from 'fs';
import type { BlogItem } from './types.js';

export function readBlogs(jsonPath: string): BlogItem[] | null {
  if (!fs.existsSync(jsonPath)) return null;
  try {
    const raw = fs.readFileSync(jsonPath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed as BlogItem[];
  } catch {
    return null;
  }
}
