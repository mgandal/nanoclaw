import type { BlogItem } from '../types.js';

interface Props {
  blogs: BlogItem[] | null;
}

export function BlogsPanel({ blogs }: Props) {
  if (blogs === null) return null;  // feature hidden
  return (
    <section class="blogs-panel">
      <h2>Blogs</h2>
      {blogs.length === 0 ? (
        <p class="empty">No new blog posts.</p>
      ) : (
        <ul>
          {blogs.map(b => (
            <li key={b.url}>
              <a href={b.url} rel="noopener noreferrer" target="_blank">
                {b.title}
              </a>
              <span class="source"> — {b.source}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
