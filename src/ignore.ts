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

// shouldIgnore reports whether path should be excluded from sync, checking the built-in local_
// prefix convention first, then any user-configured glob patterns.
export function shouldIgnore(path: string, patterns: string[]): boolean {
  if (hasLocalPrefix(path)) {
    return true;
  }
  for (const pattern of patterns) {
    if (matchesGlob(path, pattern)) {
      return true;
    }
  }

  return false;
}
