import { globSync, readFileSync } from "node:fs";

// ISSUE_REFERENCE matches the tracker references banned from comments, so that reasoning lives in
// documentation a reader can reach without the tracker.
const ISSUE_REFERENCE = /#\d+/;

// MAX_BLOCK_LINES caps a comment block, per rule 18 of typescript-as-go.
const MAX_BLOCK_LINES = 3;

// Only whole line comments are checked: a trailing comment is short by construction, and telling a
// real one from "//" inside a string literal needs a parser this check does not want.
function violations(path) {
  const found = [];
  // The trailing empty line closes a block that runs to the end of the file.
  const lines = [...readFileSync(path, "utf8").split("\n"), ""];
  let blockStart = 0;
  let blockLength = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    if (!line.startsWith("//")) {
      if (blockLength > MAX_BLOCK_LINES) {
        found.push({
          line: blockStart,
          message: `comment block is ${blockLength} lines, cap is ${MAX_BLOCK_LINES}`,
        });
      }
      blockLength = 0;
      continue;
    }

    if (blockLength === 0) {
      blockStart = i + 1;
    }
    blockLength++;

    if (ISSUE_REFERENCE.test(line)) {
      found.push({ line: i + 1, message: "comment references an issue, move it to docs/" });
    }
  }

  found.sort((a, b) => a.line - b.line);

  return found;
}

const files = globSync("src/**/*.ts").sort();
const failures = [];

for (const file of files) {
  for (const violation of violations(file)) {
    failures.push(`${file}:${violation.line}: ${violation.message}`);
  }
}

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(failure);
  }
  console.error(`\n${failures.length} comment violations; see rule 18 of typescript-as-go`);
  process.exit(1);
}

console.log(`comments clean: ${files.length} files checked`);
