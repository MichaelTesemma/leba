import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseSize } from "../../../lib/search/types.js";

describe("parseSize", () => {
  it("parses bytes correctly", () => {
    assert.equal(parseSize("500 B"), 0);
    assert.equal(parseSize("1 KB"), 1024);
    assert.equal(parseSize("1 MB"), 1048576);
    assert.equal(parseSize("1 GB"), 1073741824);
    assert.equal(parseSize("1 TB"), 1099511627776);
  });

  it("parses decimal values", () => {
    assert.equal(parseSize("1.5 GB"), Math.round(1.5 * 1073741824));
    assert.equal(parseSize("2.5 MB"), Math.round(2.5 * 1048576));
  });

  it("is case-insensitive", () => {
    assert.equal(parseSize("1 gb"), 1073741824);
    assert.equal(parseSize("2 Mb"), 2 * 1048576);
  });

  it("returns 0 for invalid input", () => {
    assert.equal(parseSize(""), 0);
    assert.equal(parseSize("abc"), 0);
    assert.equal(parseSize("1"), 0);
    assert.equal(parseSize("GB"), 0);
  });
});
