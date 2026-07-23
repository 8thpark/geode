// hasLocalPrefix reports whether any segment of path starts with "local_", the built-in
// convention for vault content that should never be synced.
export function hasLocalPrefix(path: string): boolean {
  const segments = path.split("/");
  for (const segment of segments) {
    if (segment.startsWith("local_")) {
      return true;
    }
  }
  return false;
}

// globToRegex converts a simplified glob pattern to a regular expression. Supported syntax:
//   *  — matches any characters within one path segment (stops at /)
//   ** — matches zero or more path segments
//   ?  — matches exactly one character (not /)
//   All other characters match literally. A leading / in the pattern is stripped.
function globToRegex(pattern: string): RegExp {
  const pat = pattern.startsWith("/") ? pattern.slice(1) : pattern;
  const body = pat.replace(/\*\*\/|\*\*|\*|\?|[.+^${}()|[\]\\]/g, (token) => {
    switch (token) {
      case "**/":
        return "(.*/)?";
      case "**":
        return ".*";
      case "*":
        return "[^/]*";
      case "?":
        return "[^/]";
      default:
        return `\\${token}`; // escaped regex metachar
    }
  });
  return new RegExp(`^${body}$`);
}

// matchesGlob reports whether path matches a simplified glob pattern.
export function matchesGlob(path: string, pattern: string): boolean {
  return globToRegex(pattern).test(path);
}

// compilePatterns converts a list of glob patterns to regular expressions once
// so the compiled forms can be reused across many shouldIgnoreCompiled calls.
export function compilePatterns(patterns: string[]): RegExp[] {
  const compiled: RegExp[] = [];
  for (const pattern of patterns) {
    compiled.push(globToRegex(pattern));
  }
  return compiled;
}

// shouldIgnoreCompiled is like shouldIgnore but accepts pre-compiled patterns
// for callers that filter many paths against a fixed pattern set.
export function shouldIgnoreCompiled(path: string, compiled: RegExp[]): boolean {
  if (hasLocalPrefix(path)) {
    return true;
  }
  for (const re of compiled) {
    if (re.test(path)) {
      return true;
    }
  }
  return false;
}

// shouldIgnore reports whether path should be excluded from sync, checking the built-in local_
// prefix convention first, then any user-configured glob patterns.
export function shouldIgnore(path: string, patterns: string[]): boolean {
  return shouldIgnoreCompiled(path, compilePatterns(patterns));
}
