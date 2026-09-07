import { parse } from "smol-toml";

// A prefix is complete only outside multiline strings, arrays and inline tables.
function completePrefix(content: string): boolean {
  try {
    parse(content);
    return true;
  } catch {
    return false;
  }
}

/** Update one root scalar while retaining all unrelated TOML text. */
export function updateRootString(content: string, key: string, value: string): string {
  parse(content); // Reject malformed input before producing a mutation.
  let rootEnd = content.length;
  for (const match of content.matchAll(/^[ \t]*\[/gm)) {
    if (completePrefix(content.slice(0, match.index))) {
      rootEnd = match.index;
      break;
    }
  }
  const root = content.slice(0, rootEnd);
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const assignment = new RegExp(`^[ \\t]*(?:${escapedKey}|"${escapedKey}"|'${escapedKey}')[ \\t]*=`, "gm");
  const newline = content.includes("\r\n") ? "\r\n" : "\n";
  const replacement = `${key} = ${JSON.stringify(value)}${newline}`;
  for (const match of root.matchAll(assignment)) {
    const start = match.index!;
    if (!completePrefix(root.slice(0, start))) continue;
    let end = root.indexOf("\n", start);
    while (true) {
      const boundary = end === -1 ? root.length : end + 1;
      if (completePrefix(root.slice(0, boundary))) {
        const updated = content.slice(0, start) + replacement + content.slice(boundary);
        parse(updated);
        return updated;
      }
      if (end === -1) break;
      end = root.indexOf("\n", end + 1);
    }
  }
  const updated = replacement + content;
  parse(updated);
  return updated;
}

export function rootValue(content: string, key: string): unknown {
  return parse(content)[key];
}
