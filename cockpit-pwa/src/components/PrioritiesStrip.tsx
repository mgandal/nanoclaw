interface Props {
  priorities: string[];
}

export function PrioritiesStrip({ priorities }: Props) {
  if (priorities.length === 0) return null;
  return (
    <header class="priorities-strip">
      <ol>
        {priorities.map((p, i) => (
          <li key={i}>{p}</li>
        ))}
      </ol>
    </header>
  );
}
