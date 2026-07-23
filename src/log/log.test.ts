import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createLogger,
  createMemorySink,
  formatLogLine,
  type LogEntry,
  levelEnabled,
  parseLogLine,
  trimLogLines,
} from "./log.ts";

test("formatLogLine and parseLogLine round trip", () => {
  const entry: LogEntry = {
    time: Date.parse("2026-07-14T10:00:00.000Z"),
    level: "warn",
    message: "disk nearly full",
  };

  const parsed = parseLogLine(formatLogLine(entry));

  assert.deepEqual(parsed, entry);
});

test("parseLogLine preserves tabs inside the message", () => {
  const entry: LogEntry = {
    time: Date.parse("2026-07-14T10:00:00.000Z"),
    level: "info",
    message: "a\tb",
  };

  const parsed = parseLogLine(formatLogLine(entry));

  assert.deepEqual(parsed, entry);
});

const messageRoundTripCases: { message: string; label: string }[] = [
  { label: "embedded newline", message: "error\nstacktrace" },
  { label: "embedded CR", message: "line1\rline2" },
  { label: "literal backslash-n", message: "path\\nother" },
  { label: "both literal backslash-n and real newline", message: "path\\nother\nand more" },
  { label: "multiple newlines", message: "a\nb\nc" },
  { label: "CRLF", message: "line1\r\nline2" },
];

for (const { message, label } of messageRoundTripCases) {
  test(`formatLogLine/parseLogLine round trip: ${label}`, () => {
    const entry: LogEntry = {
      time: Date.parse("2026-07-14T10:00:00.000Z"),
      level: "error",
      message,
    };

    const parsed = parseLogLine(formatLogLine(entry));

    assert.deepEqual(parsed, entry);
  });
}

test("formatLogLine produces a single physical line for a message with newlines", () => {
  const entry: LogEntry = {
    time: Date.parse("2026-07-14T10:00:00.000Z"),
    level: "error",
    message: "ENOENT\n  at readFileSync",
  };

  const line = formatLogLine(entry);

  assert.equal(line.includes("\n"), false);
});

test("parseLogLine survives the adapter's split-on-newline path", () => {
  const entry: LogEntry = {
    time: Date.parse("2026-07-14T10:00:00.000Z"),
    level: "error",
    message: "sync: ENOENT\n  at readFileSync\n  at load",
  };

  const persisted = `${formatLogLine(entry)}\n`;

  const entries: LogEntry[] = [];
  for (const line of persisted.split("\n")) {
    if (line !== "") {
      const parsed = parseLogLine(line);
      if (parsed !== undefined) {
        entries.push(parsed);
      }
    }
  }

  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0], entry);
});

const malformedLines = [
  "",
  "not a log line",
  "2026-07-14T10:00:00.000Z\tinfo",
  "garbage\tinfo\thello",
];

for (const line of malformedLines) {
  test(`parseLogLine: rejects malformed line ${JSON.stringify(line)}`, () => {
    assert.equal(parseLogLine(line), undefined);
  });
}

test("trimLogLines keeps only the last maxLines lines", () => {
  const text = ["a", "b", "c", "d", "e"].join("\n");

  assert.equal(trimLogLines(text, 2), "d\ne\n");
});

test("trimLogLines is a no-op when under the limit", () => {
  const text = ["a", "b"].join("\n");

  assert.equal(trimLogLines(text, 5), "a\nb\n");
});

test("trimLogLines preserves the trailing newline appending relies on", () => {
  const text = "a\nb\nc\n";

  assert.equal(trimLogLines(text, 2), "b\nc\n");
});

test("trimLogLines of an already empty log stays empty", () => {
  assert.equal(trimLogLines("", 5), "");
});

test("a line appended after trimLogLines still parses on its own, not merged into the last kept line", () => {
  const a: LogEntry = { time: 1, level: "info", message: "a" };
  const b: LogEntry = { time: 2, level: "info", message: "b" };
  const c: LogEntry = { time: 3, level: "info", message: "c" };
  const beforeCompaction = `${formatLogLine(a)}\n${formatLogLine(b)}\n`;

  const compacted = trimLogLines(beforeCompaction, 1);
  const appended = `${compacted}${formatLogLine(c)}\n`;

  const parsedLines: (LogEntry | undefined)[] = [];
  for (const line of appended.split("\n")) {
    if (line !== "") {
      parsedLines.push(parseLogLine(line));
    }
  }
  assert.deepEqual(parsedLines, [b, c]);
});

const levelEnabledCases: {
  level: "debug" | "info" | "warn" | "error";
  minLevel: "debug" | "info" | "warn" | "error";
  want: boolean;
}[] = [
  { level: "debug", minLevel: "info", want: false },
  { level: "info", minLevel: "info", want: true },
  { level: "error", minLevel: "debug", want: true },
  { level: "warn", minLevel: "error", want: false },
];

for (const { level, minLevel, want } of levelEnabledCases) {
  test(`levelEnabled: ${level} at minimum ${minLevel}`, () => {
    assert.equal(levelEnabled(level, minLevel), want);
  });
}

test("createMemorySink: append then read returns entries in order", async () => {
  const sink = createMemorySink(10);

  await sink.append({ time: 1, level: "info", message: "first" });
  await sink.append({ time: 2, level: "warn", message: "second" });

  assert.deepEqual(await sink.read(), [
    { time: 1, level: "info", message: "first" },
    { time: 2, level: "warn", message: "second" },
  ]);
});

test("createMemorySink: caps at maxLines, dropping the oldest", async () => {
  const sink = createMemorySink(2);

  await sink.append({ time: 1, level: "info", message: "first" });
  await sink.append({ time: 2, level: "info", message: "second" });
  await sink.append({ time: 3, level: "info", message: "third" });

  assert.deepEqual(await sink.read(), [
    { time: 2, level: "info", message: "second" },
    { time: 3, level: "info", message: "third" },
  ]);
});

test("createMemorySink: clear empties the log", async () => {
  const sink = createMemorySink(10);
  await sink.append({ time: 1, level: "info", message: "first" });

  await sink.clear();

  assert.deepEqual(await sink.read(), []);
});

test("createLogger: messages below minLevel are not persisted", async () => {
  const sink = createMemorySink(10);
  const logger = createLogger(sink, "warn");

  logger.debug("noisy");
  logger.info("still noisy");
  logger.warn("worth keeping");

  const messages: string[] = [];
  for (const entry of await sink.read()) {
    messages.push(entry.message);
  }
  assert.deepEqual(messages, ["worth keeping"]);
});

test("createLogger: debug messages persist once minLevel is debug", async () => {
  const sink = createMemorySink(10);
  const logger = createLogger(sink, "debug");

  logger.debug("verbose detail");

  const messages: string[] = [];
  for (const entry of await sink.read()) {
    messages.push(entry.message);
  }
  assert.deepEqual(messages, ["verbose detail"]);
});
