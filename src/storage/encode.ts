// encodeComponent percent-encodes a single URI component with SigV4's strict RFC 3986 rules:
// on top of encodeURIComponent it also encodes ! ' ( ) *, so the bytes on the wire are byte for
// byte the canonical form SigV4 signs and no provider's canonicalization choice can diverge.
export function encodeComponent(component: string): string {
  const encoded = encodeURIComponent(component);

  return encoded.replace(/[!'()*]/g, percentEncode);
}

// encodeKey percent-encodes each path segment of an S3 object key individually, preserving "/" as
// the separator so keys like "notes/Don't stop!.md" become "notes/Don%27t%20stop%21.md".
export function encodeKey(key: string): string {
  const segments = key.split("/");
  const encodedSegments = segments.map((segment) => encodeComponent(segment));

  return encodedSegments.join("/");
}

// percentEncode returns the %XX form of a single ASCII character.
function percentEncode(char: string): string {
  return `%${char.charCodeAt(0).toString(16).toUpperCase()}`;
}
