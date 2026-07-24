import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeComponent, encodeKey } from "./encode.ts";

const encodeKeyCases: { name: string; key: string; want: string }[] = [
  {
    name: "plain key passes through",
    key: "notes/hello.md",
    want: "notes/hello.md",
  },
  {
    name: "space and ampersand",
    key: "notes/Foo & Bar.md",
    want: "notes/Foo%20%26%20Bar.md",
  },
  {
    name: "hash and percent",
    key: "notes/100% #special.md",
    want: "notes/100%25%20%23special.md",
  },
  {
    name: "SigV4-sensitive characters ! ' ( ) * are percent encoded",
    key: "notes/Don't forget! (draft) *.md",
    want: "notes/Don%27t%20forget%21%20%28draft%29%20%2A.md",
  },
  {
    name: "slashes separate segments and survive encoding",
    key: "a b/c d/e.md",
    want: "a%20b/c%20d/e.md",
  },
  {
    name: "non-ASCII is UTF-8 percent encoded",
    key: "notes/café 😀.md",
    want: "notes/caf%C3%A9%20%F0%9F%98%80.md",
  },
];

for (const { name, key, want } of encodeKeyCases) {
  test(`encodeKey: ${name}`, () => {
    assert.equal(encodeKey(key), want);
  });
}

test("encodeComponent percent-encodes slashes, unlike encodeKey", () => {
  assert.equal(encodeComponent("a/b!.md"), "a%2Fb%21.md");
});
