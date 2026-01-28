/**
 * Path utilities tests
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  extractSkillName,
  isSkillRead,
  refreshCwdCache,
  stripCdPrefix,
  toRelativePath,
} from "./utils.js";

describe("path utilities", () => {
  const originalHome = process.env.HOME;

  beforeEach(() => {
    // Mock CWD and HOME for predictable tests
    vi.spyOn(process, "cwd").mockReturnValue("/Users/test/project");
    process.env.HOME = "/Users/test";
    refreshCwdCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env.HOME = originalHome;
  });

  describe("toRelativePath", () => {
    it("returns relative path when path starts with CWD", () => {
      expect(toRelativePath("/Users/test/project/src/index.ts")).toBe("src/index.ts");
    });

    it("returns relative path for nested directories", () => {
      expect(toRelativePath("/Users/test/project/src/lib/utils.ts")).toBe("src/lib/utils.ts");
    });

    it("returns '.' when path is exactly CWD", () => {
      expect(toRelativePath("/Users/test/project")).toBe(".");
      expect(toRelativePath("/Users/test/project/")).toBe(".");
    });

    it("returns path as-is when outside CWD", () => {
      expect(toRelativePath("/Users/test/other/file.ts")).toBe("/Users/test/other/file.ts");
    });

    it("handles ~ prefix when under HOME", () => {
      expect(toRelativePath("~/project/src/file.ts")).toBe("src/file.ts");
    });

    it("returns path as-is for ~ prefix outside CWD", () => {
      expect(toRelativePath("~/other/file.ts")).toBe("~/other/file.ts");
    });

    it("handles empty string", () => {
      expect(toRelativePath("")).toBe("");
    });

    it("handles already relative paths", () => {
      expect(toRelativePath("src/index.ts")).toBe("src/index.ts");
    });
  });

  describe("stripCdPrefix", () => {
    it("strips cd <cwd> && prefix", () => {
      expect(stripCdPrefix("cd /Users/test/project && ls")).toBe("ls");
    });

    it("strips cd <cwd>/ && prefix (with trailing slash)", () => {
      expect(stripCdPrefix("cd /Users/test/project/ && echo hello")).toBe("echo hello");
    });

    it("strips cd with quotes", () => {
      expect(stripCdPrefix('cd "/Users/test/project" && pwd')).toBe("pwd");
      expect(stripCdPrefix("cd '/Users/test/project' && pwd")).toBe("pwd");
    });

    it("preserves cd to different directory", () => {
      expect(stripCdPrefix("cd /other/path && ls")).toBe("cd /other/path && ls");
    });

    it("strips cd with ~ prefix when under HOME", () => {
      expect(stripCdPrefix("cd ~/project && make")).toBe("make");
      expect(stripCdPrefix("cd ~/project/ && make")).toBe("make");
    });

    it("handles empty string", () => {
      expect(stripCdPrefix("")).toBe("");
    });

    it("handles command without cd prefix", () => {
      expect(stripCdPrefix("ls -la")).toBe("ls -la");
    });

    it("handles multiline commands", () => {
      // Only strips first cd if it matches CWD
      const cmd = "cd /Users/test/project && ls\necho done";
      expect(stripCdPrefix(cmd)).toBe("ls\necho done");
    });
  });

  describe("isSkillRead", () => {
    it("returns true for SKILL.md file path", () => {
      expect(isSkillRead("/Users/sercans/.pi/agent/skills/ascii-diagram/SKILL.md")).toBe(true);
    });

    it("returns true for any path ending with /SKILL.md", () => {
      expect(isSkillRead("/path/to/skill/SKILL.md")).toBe(true);
      expect(isSkillRead("skills/my-skill/SKILL.md")).toBe(true);
    });

    it("returns true for bare SKILL.md", () => {
      expect(isSkillRead("SKILL.md")).toBe(true);
    });

    it("returns false for non-SKILL.md files", () => {
      expect(isSkillRead("/path/to/README.md")).toBe(false);
      expect(isSkillRead("/path/to/skill.md")).toBe(false);
      expect(isSkillRead("/path/to/SKILL.txt")).toBe(false);
    });

    it("returns false for empty string", () => {
      expect(isSkillRead("")).toBe(false);
    });

    it("returns false when SKILL.md is not at end", () => {
      expect(isSkillRead("/path/SKILL.md/other")).toBe(false);
    });
  });

  describe("extractSkillName", () => {
    it("extracts skill name from full path", () => {
      expect(extractSkillName("/Users/sercans/.pi/agent/skills/ascii-diagram/SKILL.md")).toBe(
        "ascii-diagram"
      );
    });

    it("extracts skill name from relative path", () => {
      expect(extractSkillName("skills/code-review/SKILL.md")).toBe("code-review");
    });

    it("extracts skill name with various naming conventions", () => {
      expect(extractSkillName("/path/to/my_skill/SKILL.md")).toBe("my_skill");
      expect(extractSkillName("/path/to/MySkill/SKILL.md")).toBe("MySkill");
    });

    it("returns unknown for bare SKILL.md", () => {
      expect(extractSkillName("SKILL.md")).toBe("unknown");
    });

    it("returns unknown for empty string", () => {
      expect(extractSkillName("")).toBe("unknown");
    });

    it("handles paths with trailing slash in directory", () => {
      // Edge case: shouldn't happen in practice, but defensive
      expect(extractSkillName("/skills/test/SKILL.md")).toBe("test");
    });
  });
});
