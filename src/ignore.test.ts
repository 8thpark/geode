import assert from "node:assert/strict";
import { test } from "node:test";
import { hasLocalPrefix, matchesGlob, shouldIgnore } from "./ignore.ts";

const hasLocalPrefixCases: { name: string; path: string; want: boolean }[] = [
  { name: "top-level local_ folder", path: "local_notes/note.md", want: true },
  { name: "nested local_ folder", path: "a/b/local_notes/note.md", want: true },
  { name: "local_ file at root", path: "local_draft.md", want: true },
  { name: "local_ file nested", path: "docs/local_draft.md", want: true },
  { name: "no match", path: "notes/note.md", want: false },
  { name: "partial prefix match", path: "local_not/stuff.md", want: true },
  {
    name: "local_ in middle of segment",
    path: "not_local_/file.md",
    want: false,
  },
  { name: "empty path", path: "", want: false },
];

for (const { name, path, want } of hasLocalPrefixCases) {
  test(`hasLocalPrefix: ${name}`, () => {
    assert.strictEqual(hasLocalPrefix(path), want);
  });
}

const matchesGlobCases: {
  name: string;
  path: string;
  pattern: string;
  want: boolean;
}[] = [
  {
    name: "exact match",
    path: "notes/note.md",
    pattern: "notes/note.md",
    want: true,
  },
  {
    name: "exact mismatch",
    path: "notes/note.md",
    pattern: "other/note.md",
    want: false,
  },
  {
    name: "star matches within segment",
    path: "docs/file.md",
    pattern: "docs/*.md",
    want: true,
  },
  {
    name: "star does not cross segments",
    path: "a/b/file.md",
    pattern: "a/*.md",
    want: false,
  },
  {
    name: "star matches any extension",
    path: "docs/file.txt",
    pattern: "docs/*",
    want: true,
  },
  {
    name: "double star at start",
    path: "a/b/c.md",
    pattern: "**/*.md",
    want: true,
  },
  { name: "double star at end", path: "a/b/c.md", pattern: "a/**", want: true },
  {
    name: "double star matches empty segments",
    path: "a.md",
    pattern: "**/a.md",
    want: true,
  },
  {
    name: "double star in middle",
    path: "a/b/c/d.md",
    pattern: "a/**/d.md",
    want: true,
  },
  {
    name: "question mark matches one char",
    path: "file1.md",
    pattern: "file?.md",
    want: true,
  },
  {
    name: "question mark does not match slash",
    path: "a/b",
    pattern: "a?b",
    want: false,
  },
  {
    name: "question mark fails on two chars",
    path: "file12.md",
    pattern: "file?.md",
    want: false,
  },
  {
    name: "leading slash ignored",
    path: "notes/note.md",
    pattern: "/notes/note.md",
    want: true,
  },
  {
    name: "trailing slash pattern",
    path: "docs",
    pattern: "docs/",
    want: false,
  },
  {
    name: "complex pattern",
    path: "src/components/Button.tsx",
    pattern: "src/**/*.tsx",
    want: true,
  },
  {
    name: "no match",
    path: "notes/note.md",
    pattern: "docs/*.md",
    want: false,
  },
  { name: "empty pattern", path: "notes/note.md", pattern: "", want: false },
  { name: "empty path with star pattern", path: "", pattern: "*", want: true },
];

for (const { name, path, pattern, want } of matchesGlobCases) {
  test(`matchesGlob: ${name}`, () => {
    assert.strictEqual(matchesGlob(path, pattern), want);
  });
}

const shouldIgnoreCases: {
  name: string;
  path: string;
  patterns: string[];
  want: boolean;
}[] = [
  {
    name: "local_ prefix ignored",
    path: "local_notes/note.md",
    patterns: [],
    want: true,
  },
  {
    name: "glob pattern ignored",
    path: "private/secret.md",
    patterns: ["private/**"],
    want: true,
  },
  {
    name: "no match with patterns",
    path: "notes/note.md",
    patterns: ["private/**"],
    want: false,
  },
  {
    name: "empty patterns no match",
    path: "notes/note.md",
    patterns: [],
    want: false,
  },
  {
    name: "multiple patterns second match",
    path: "temp/file.md",
    patterns: ["private/**", "temp/*"],
    want: true,
  },
  {
    name: "local_ takes precedence",
    path: "local_x/file.md",
    patterns: [],
    want: true,
  },
];

for (const { name, path, patterns, want } of shouldIgnoreCases) {
  test(`shouldIgnore: ${name}`, () => {
    assert.strictEqual(shouldIgnore(path, patterns), want);
  });
}
