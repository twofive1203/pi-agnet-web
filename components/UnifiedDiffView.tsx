interface Props {
  diff: string;
}

function lineClass(line: string): string {
  if (line.startsWith("@@")) return "is-hunk";
  if (line.startsWith("+++") || line.startsWith("---")) return "is-file";
  if (line.startsWith("+")) return "is-add";
  if (line.startsWith("-")) return "is-delete";
  return "is-context";
}

export function UnifiedDiffView({ diff }: Props) {
  const lines = diff ? diff.split("\n") : [];
  return (
    <pre className="diff-unified">
      {lines.map((line, index) => (
        <div key={index} className={`diff-unified-row ${lineClass(line)}`}>
          <span className="diff-unified-line-number">{index + 1}</span>
          <span className="diff-unified-content">{line || " "}</span>
        </div>
      ))}
    </pre>
  );
}
