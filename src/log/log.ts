const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

// LogEntry is one line of geode's log.
export type LogEntry = {
  time: number;
  level: LogLevel;
  message: string;
};

// Logger is the interface the rest of the plugin logs through.
export type Logger = {
  debug: (message: string) => void;
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
};

// LogLevel orders from least to most severe.
export type LogLevel = "debug" | "info" | "warn" | "error";

// LogSink persists log entries and reads them back. The real implementation writes to a capped
// file inside the plugin's own data directory (see adapter.ts); tests, and the fallback used
// when there's nowhere to persist to, use an in-memory sink (see createMemorySink below).
export type LogSink = {
  append: (entry: LogEntry) => Promise<void>;
  read: () => Promise<LogEntry[]>;
  clear: () => Promise<void>;
};

// createLogger returns a Logger that mirrors every message to the console and persists it via
// sink, both gated by the same minLevel.
export function createLogger(sink: LogSink, minLevel: LogLevel): Logger {
  const log = (level: LogLevel, message: string) => {
    if (!levelEnabled(level, minLevel)) {
      return;
    }
    consoleFor(level)(`geode: ${message}`);
    // Fire and forget: the Logger API is synchronous, so append can't be awaited. Report a
    // failed persist to the console rather than leaving it as an unhandled rejection, and never
    // back into sink, which would recurse if the sink itself is what's failing.
    sink.append({ time: Date.now(), level, message }).catch((err) => {
      console.error(`geode: log sink append failed: ${err}`);
    });
  };

  return {
    debug: (message) => log("debug", message),
    info: (message) => log("info", message),
    warn: (message) => log("warn", message),
    error: (message) => log("error", message),
  };
}

// createMemorySink returns a LogSink backed by an in-memory array, capped at maxLines. Used as
// the fallback logger when there's nowhere to persist to, and as the fake sink in tests.
export function createMemorySink(maxLines: number): LogSink {
  let entries: LogEntry[] = [];

  return {
    append: async (entry) => {
      entries.push(entry);
      if (entries.length > maxLines) {
        entries = entries.slice(entries.length - maxLines);
      }
    },
    read: async () => [...entries],
    clear: async () => {
      entries = [];
    },
  };
}

// escapeMessage encodes control characters in a log message so the result is a single physical
// line. Backslashes are escaped first so a pre-existing literal "\n" (two characters) is not
// misinterpreted when newlines are escaped next.
export function escapeMessage(msg: string): string {
  return msg
    .split("\\")
    .join("\\\\")
    .split("\n")
    .join("\\n")
    .split("\r")
    .join("\\r");
}

// formatLogLine renders one entry as a single persisted line: an ISO timestamp, the level, then
// the message, tab separated so parseLogLine can split on the same delimiter without tripping
// over spaces in either the level or the message.
export function formatLogLine(entry: LogEntry): string {
  return `${new Date(entry.time).toISOString()}\t${entry.level}\t${escapeMessage(entry.message)}`;
}

// levelEnabled reports whether a message at level should be logged when the minimum is minLevel.
export function levelEnabled(level: LogLevel, minLevel: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[minLevel];
}

// parseLogLine reverses formatLogLine. A malformed line (a corrupt or truncated file) is dropped
// rather than thrown, consistent with how state.json failures fail open elsewhere.
export function parseLogLine(line: string): LogEntry | undefined {
  const [rawTime, rawLevel, ...rest] = line.split("\t");
  if (rawTime === undefined || rawLevel === undefined || rest.length === 0) {
    return undefined;
  }
  const time = Date.parse(rawTime);
  if (Number.isNaN(time) || !isLogLevel(rawLevel)) {
    return undefined;
  }
  return { time, level: rawLevel, message: unescapeMessage(rest.join("\t")) };
}

// unescapeMessage reverses escapeMessage. Unlike escape, unescape must
// scan character by character to avoid matching "\n" inside the stored "\\" sequence.
export function unescapeMessage(msg: string): string {
  let result = "";
  for (let i = 0; i < msg.length; i++) {
    if (msg[i] === "\\" && i + 1 < msg.length) {
      const next = msg[i + 1];
      if (next === "n") {
        result += "\n";
        i++;
      } else if (next === "r") {
        result += "\r";
        i++;
      } else if (next === "\\") {
        result += "\\";
        i++;
      } else {
        result += msg[i];
      }
    } else {
      result += msg[i];
    }
  }

  return result;
}

// trimLogLines keeps only the last maxLines lines of a log, dropping the oldest. The result keeps
// the same trailing newline the input had: appending assumes the file already ends in one, and
// dropping it here would glue the next appended line onto the last one still kept.
export function trimLogLines(text: string, maxLines: number): string {
  const lines = linesOf(text);
  let kept = lines;
  if (lines.length > maxLines) {
    kept = lines.slice(lines.length - maxLines);
  }
  if (kept.length === 0) {
    return "";
  }
  return `${kept.join("\n")}\n`;
}

// consoleFor returns the console method matching level, so console and persisted output agree on
// severity.
function consoleFor(level: LogLevel): (message: string) => void {
  if (level === "warn") {
    return (message) => console.warn(message);
  }
  if (level === "error") {
    return (message) => console.error(message);
  }
  return (message) => console.log(message);
}

function isLogLevel(value: string): value is LogLevel {
  return (
    value === "debug" ||
    value === "info" ||
    value === "warn" ||
    value === "error"
  );
}

// linesOf splits a log's text into its lines. Every persisted line ends in "\n", so a naive split
// leaves one trailing empty element; drop only that one rather than filtering every blank line
// generically, so a line that was genuinely empty for some other reason is never silently eaten.
function linesOf(text: string): string[] {
  if (text === "") {
    return [];
  }
  const parts = text.split("\n");
  if (parts[parts.length - 1] === "") {
    return parts.slice(0, -1);
  }
  return parts;
}
