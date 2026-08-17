import type { ObjectMeta } from "./storage.ts";

// ListPage is one successfully parsed page of a ListObjectsV2 response: the objects it carries
// and, when the listing is truncated, the token that fetches the next page.
// nextContinuationToken is undefined once the listing is complete.
export type ListPage = {
  objects: ObjectMeta[];
  nextContinuationToken: string | undefined;
};

// ParsedListPage is the outcome of parsing a ListObjectsV2 XML response. ok is false when the
// body doesn't match the shape this parser understands.
export type ParsedListPage = { ok: true; page: ListPage } | { ok: false; message: string };

// parseListObjectsXml extracts keys, sizes, timestamps, and any continuation token from a
// ListObjectsV2 response, by regex since DOMParser is unavailable outside a browser runtime.
export function parseListObjectsXml(xml: string): ParsedListPage {
  const objects: ObjectMeta[] = [];
  const contentsPattern = /<Contents>([\s\S]*?)<\/Contents>/g;
  let match = contentsPattern.exec(xml);

  while (match !== null) {
    const block = match[1];
    objects.push({
      key: decodeXmlText(fieldFrom(block, "Key")),
      size: Number(fieldFrom(block, "Size")),
      lastModified: fieldFrom(block, "LastModified"),
    });
    match = contentsPattern.exec(xml);
  }

  // Counting every tag that merely looks like a Contents element catches a listing this parser read
  // incompletely, which a first sync would otherwise read as an empty bucket and orphan every entry
  // it dropped.
  const looseContentsCount = looseTagCount(xml, "Contents");
  const recognizable = hasTag(xml, "KeyCount") || hasTag(xml, "IsTruncated");
  if (looseContentsCount !== objects.length || (objects.length === 0 && !recognizable)) {
    return {
      ok: false,
      message: "listing response XML shape is unrecognized; refusing to guess it is empty",
    };
  }

  // A token is only meaningful when IsTruncated is true. Guarding on both avoids looping forever
  // if a provider echoes a stale token on the final page.
  const truncated = fieldFrom(xml, "IsTruncated") === "true";
  const token = decodeXmlText(fieldFrom(xml, "NextContinuationToken"));
  let nextContinuationToken: string | undefined;
  if (truncated && token !== "") {
    nextContinuationToken = token;
  }

  return {
    ok: true,
    page: { objects, nextContinuationToken },
  };
}

// decodeXmlText returns the plain text represented by XML character and entity references.
function decodeXmlText(text: string): string {
  return text.replace(
    /&#(x[0-9a-fA-F]+|[0-9]+);|&(amp|lt|gt|quot|apos);/g,
    (match, numeric, named) => {
      if (numeric !== undefined) {
        let codePoint = 0;
        if (numeric.startsWith("x") || numeric.startsWith("X")) {
          codePoint = Number.parseInt(numeric.slice(1), 16);
        } else {
          codePoint = Number.parseInt(numeric, 10);
        }
        if (Number.isNaN(codePoint)) {
          return match;
        }
        return String.fromCodePoint(codePoint);
      }

      if (named === "amp") {
        return "&";
      }
      if (named === "lt") {
        return "<";
      }
      if (named === "gt") {
        return ">";
      }
      if (named === "quot") {
        return '"';
      }
      if (named === "apos") {
        return "'";
      }

      return match;
    },
  );
}

// fieldFrom returns the text content of the first <tag>...</tag> found in an XML fragment, or
// "" if it isn't present.
function fieldFrom(block: string, tag: string): string {
  const pattern = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`);
  const found = pattern.exec(block);
  if (found === null) {
    return "";
  }

  return found[1];
}

// hasTag reports whether a bare opening <tag> is present anywhere in the XML.
function hasTag(xml: string, tag: string): boolean {
  return new RegExp(`<${tag}>`).test(xml);
}

// looseTagCount counts opening tags matching the given local name anywhere in the XML, regardless
// of a namespace prefix or trailing attributes, deliberately looser than the exact <tag> form
// fieldFrom and the Contents block pattern require.
function looseTagCount(xml: string, tag: string): number {
  const pattern = new RegExp(`<(?!/)[\\w:-]*${tag}\\b`, "g");
  const found = xml.match(pattern);
  if (found === null) {
    return 0;
  }

  return found.length;
}
