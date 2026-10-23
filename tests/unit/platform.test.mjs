import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isPathWithin, normalizePath, pipePath } from "../../hub/platform.mjs";

describe("hub/platform.mjs", () => {
  it("normalizes Windows paths for comparison-friendly slash output", () => {
    assert.equal(
      normalizePath("C:\\Users\\example\\Desktop\\..\\tmp\\file.txt", {
        platform: "win32",
      }),
      "C:/Users/example/tmp/file.txt",
    );
  });

  it("normalizes POSIX paths without introducing Windows separators", () => {
    assert.equal(
      normalizePath("/tmp/project/../repo/file.txt", { platform: "linux" }),
      "/tmp/repo/file.txt",
    );
  });

  it("pipePath builds Windows named pipe paths", () => {
    assert.equal(
      pipePath("triflux", 1234, { platform: "win32" }),
      "\\\\.\\pipe\\triflux-1234",
    );
  });

  it("pipePath builds Unix socket paths in the supplied temp dir", () => {
    assert.equal(
      pipePath("triflux", 1234, { platform: "linux", tempDir: "/tmp" }),
      "/tmp/triflux-1234.sock",
    );
  });

  it("isPathWithin handles case-insensitive Windows paths", () => {
    assert.equal(
      isPathWithin("C:\\Work\\Repo\\src\\index.mjs", "c:\\work\\repo", {
        platform: "win32",
      }),
      true,
    );
  });

  it("isPathWithin rejects paths outside the target directory", () => {
    assert.equal(
      isPathWithin("/tmp/repo/../other/file.txt", "/tmp/repo", {
        platform: "linux",
      }),
      false,
    );
  });
});
