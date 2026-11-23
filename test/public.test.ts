import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SDK } from "../src/platform.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * SHA-256 of words that must never appear in anything public (a real person's name, his apps,
 * his account). Only the digests are written here, so this file never spells them.
 */
const PRIVATE_WORDS = new Set([
  "4859d1729b697a9ccc9bf17b6a3c676bc935834e5640d203a7cfa489bd45d619",
  "976c617a20d12e4261e40bd8e4ce88493578ec463d082af3b2784b642b82ef0d",
  "b9e5b115929357704655d70d95b79daf630c3cea6e084adec79b4bcb7e0cd7b1",
  "34eb8131c759d8ea0bdf432f943e6e78d8bd2e1d9ad50f2bf166fad074edcea8",
  "7e421181fc7b52ab66f2c22bd396acce92c3cdd9a29122dde0f1b7ddc0eb4435",
]);

/** Everything that ships or is published with the repository: docs, metadata, sources, tests. */
function publicFiles(): string[] {
  const files = ["README.md", "LICENSE", "package.json", "tsup.config.ts", "vitest.config.ts", "tsconfig.json", "tsconfig.build.json"];
  for (const dir of ["src", "test"]) {
    for (const name of fs.readdirSync(path.join(root, dir))) files.push(path.join(dir, name));
  }
  return files.filter((file) => fs.existsSync(path.join(root, file)));
}

describe("public files (0.9.1)", () => {
  it("name no real person, nor his apps or accounts", () => {
    const found: string[] = [];
    for (const file of publicFiles()) {
      const words = fs.readFileSync(path.join(root, file), "utf8").toLowerCase().split(/[^\p{L}\p{N}]+/u);
      for (const word of words) {
        if (word && PRIVATE_WORDS.has(createHash("sha256").update(word).digest("hex"))) found.push(file);
      }
    }
    expect([...new Set(found)]).toEqual([]);
  });

  it("carry the project's identity: licence, author, repository", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as Record<string, unknown>;
    expect(fs.readFileSync(path.join(root, "LICENSE"), "utf8")).toContain("Copyright (c) 2026 Lyrelog\n");
    expect(pkg.author).toBe("Lyrelog <hello@lyrelog.com>");
    expect(pkg.homepage).toBe("https://lyrelog.com");
    expect(pkg.repository).toEqual({ type: "git", url: "git+https://github.com/lyrelog/lyrelog-js.git" });
    expect(pkg.bugs).toEqual({ url: "https://github.com/lyrelog/lyrelog-js/issues" });
  });

  it("is version 0.9.1 in the package and the SDK string", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { version: string; scripts: Record<string, string> };
    expect(pkg.version).toBe("0.9.1");
    expect(SDK).toBe("lyrelog-js/0.9.1");
    expect(pkg.scripts.prepublishOnly).toBe("pnpm test && pnpm typecheck && pnpm build");
  });
});
