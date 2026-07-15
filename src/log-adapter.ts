import type { DataAdapter } from "obsidian";
import {
  createMemorySink,
  formatLogLine,
  type LogEntry,
  type LogSink,
  parseLogLine,
  trimLogLines,
} from "./log.ts";

// createLogSink returns the real file backed sink, or an in-memory fallback when dir is
// undefined (some embedded/test hosts never set manifest.dir).
export function createLogSink(
  adapter: DataAdapter,
  dir: string | undefined,
  maxLines: number,
): LogSink {
  if (dir === undefined) {
    return createMemorySink(maxLines);
  }
  return createObsidianLogSink(adapter, `${dir}/geode.log`, maxLines);
}

// COMPACT_INTERVAL is how many appends accumulate before the log file is trimmed back down to
// maxLines. Appending is cheap (DataAdapter.append); a full read/trim/write is not, so
// compaction runs in batches rather than after every single line.
const COMPACT_INTERVAL = 50;

// createObsidianLogSink returns a LogSink that persists to a capped file at logPath via the vault
// adapter, appending cheaply and periodically trimming back down to maxLines so the file can't
// grow unbounded over a long running session.
export function createObsidianLogSink(
  adapter: DataAdapter,
  logPath: string,
  maxLines: number,
): LogSink {
  let appendsSinceCompact = 0;

  const compact = async () => {
    const exists = await adapter.exists(logPath);
    if (!exists) {
      return;
    }
    const raw = await adapter.read(logPath);
    await adapter.write(logPath, trimLogLines(raw, maxLines));
  };

  return {
    append: async (entry) => {
      const line = `${formatLogLine(entry)}\n`;
      const exists = await adapter.exists(logPath);
      if (exists) {
        await adapter.append(logPath, line);
      } else {
        await adapter.write(logPath, line);
      }

      appendsSinceCompact += 1;
      if (appendsSinceCompact >= COMPACT_INTERVAL) {
        appendsSinceCompact = 0;
        await compact();
      }
    },
    read: async () => {
      const exists = await adapter.exists(logPath);
      if (!exists) {
        return [];
      }
      const raw = await adapter.read(logPath);
      const entries: LogEntry[] = [];
      for (const line of raw.split("\n")) {
        const entry = parseLogLine(line);
        if (entry !== undefined) {
          entries.push(entry);
        }
      }
      return entries;
    },
    clear: async () => {
      await adapter.write(logPath, "");
    },
  };
}
