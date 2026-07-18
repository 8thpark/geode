// encodeKey percent-encodes each path segment of an S3 object key individually, preserving "/" as
// the separator so keys like "notes/Foo & Bar.md" become "notes/Foo%20%26%20Bar.md".
export function encodeKey(key: string): string {
  const segments = key.split("/");
  const encodedSegments = segments.map((segment) => encodeURIComponent(segment));
  const encodedKey = encodedSegments.join("/");
  return encodedKey;
}
