/**
 * Utility for generating readable unified diffs between file contents.
 */
export function createUnifiedDiff(
  filePath: string,
  oldContent: string | null,
  newContent: string
): string {
  const oldHeader = oldContent === null ? "/dev/null" : `a/${filePath}`;
  const newHeader = `b/${filePath}`;
  const oldLines = oldContent === null ? [] : oldContent.split(/\r?\n/);
  const newLines = newContent.split(/\r?\n/);

  if (oldContent === newContent) {
    return `# No changes for ${filePath}\n`;
  }

  const lines: string[] = [
    `--- ${oldHeader}`,
    `+++ ${newHeader}`,
    `@@ -1,${Math.max(1, oldLines.length)} +1,${Math.max(1, newLines.length)} @@`,
  ];

  if (oldContent === null) {
    for (const line of newLines) {
      lines.push(`+${line}`);
    }
    return lines.join("\n") + "\n";
  }

  // Generate line-by-line diff
  let i = 0;
  let j = 0;
  while (i < oldLines.length || j < newLines.length) {
    if (i < oldLines.length && j < newLines.length && oldLines[i] === newLines[j]) {
      lines.push(` ${oldLines[i]}`);
      i++;
      j++;
    } else if (
      i < oldLines.length &&
      (j >= newLines.length || !newLines.slice(j).includes(oldLines[i]))
    ) {
      lines.push(`-${oldLines[i]}`);
      i++;
    } else if (j < newLines.length) {
      lines.push(`+${newLines[j]}`);
      j++;
    } else {
      lines.push(`-${oldLines[i]}`);
      i++;
    }
  }

  return lines.join("\n") + "\n";
}
