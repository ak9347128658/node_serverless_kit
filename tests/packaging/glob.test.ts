import path from "node:path";
import { describe, expect, it } from "vitest";
import { collectFiles, DEFAULT_EXCLUDES, globToRegExp } from "../../src/packaging/glob.js";
import { tempDir, writeFiles } from "../helpers.js";

describe("globToRegExp", () => {
  it.each([
    ["**/*.ts", "a/b/c.ts", true],
    ["**/*.ts", "c.ts", true],
    ["**/*.ts", "c.tsx", false],
    ["*.ts", "a/c.ts", false],
    ["*.ts", "c.ts", true],
    [".git/**", ".git/config", true],
    [".git/**", ".github/x", false],
    ["tests/", "tests/x/y.ts", true],
    ["tests/", "tests", false],
    ["./app/*.ts", "app/x.ts", true],
    ["app/?.ts", "app/x.ts", true],
    ["app/?.ts", "app/xy.ts", false],
    ["app/?.ts", "app//.ts", false],
    ["templates/**", "templates/a/b/c.html", true],
    ["templates/**/*.html", "templates/x.html", true],
    ["data/*.json", "data/a.json", true],
    ["data/*.json", "data/sub/a.json", false],
    ["a+b(c)[d]{e}^$|.txt", "a+b(c)[d]{e}^$|.txt", true],
    ["a+b.txt", "aab.txt", false],
    ["win\\path\\*.txt", "win/path/x.txt", true],
    ["**", "anything/at/all", true],
    ["**/.DS_Store", "deep/dir/.DS_Store", true],
    ["nskit*.yml", "nskit.prod.yml", true],
  ])("%s matches %s: %s", (pattern, file, expected) => {
    expect(globToRegExp(pattern).test(file)).toBe(expected);
  });
});

describe("collectFiles", () => {
  const tree = [
    "src/a.ts",
    "src/nested/b.ts",
    "templates/mail.html",
    "templates/partials/footer.html",
    "data/x.json",
    "data/secret_keys.json",
    ".git/HEAD",
    ".nskit/aws-dev/main.tf.json",
    "node_modules/pkg/index.js",
    "coverage/lcov.info",
    ".vscode/settings.json",
    "sub/.DS_Store",
    ".env",
    ".env.local",
    "nskit.yml",
    "nskit.prod.yml",
    "terraform.tfstate",
    "deep/terraform.tfstate.backup",
    "README.md",
  ];

  it("applies default excludes and returns sorted absolute paths", () => {
    const root = tempDir();
    writeFiles(root, Object.fromEntries(tree.map((f) => [f, "x"])));
    const files = collectFiles(root, ["**/*"]).map((f) => path.relative(root, f).split(path.sep).join("/"));
    expect(files).toEqual([
      "README.md",
      "data/secret_keys.json",
      "data/x.json",
      "src/a.ts",
      "src/nested/b.ts",
      "templates/mail.html",
      "templates/partials/footer.html",
    ]);
    expect(collectFiles(root, ["**/*"]).every((f) => path.isAbsolute(f))).toBe(true);
  });

  it("include and exclude patterns", () => {
    const root = tempDir();
    writeFiles(root, Object.fromEntries(tree.map((f) => [f, "x"])));
    const rel = (inc: string[], exc: string[] = []) => collectFiles(root, inc, exc).map((f) => path.relative(root, f).split(path.sep).join("/"));
    expect(rel(["templates/**"])).toEqual(["templates/mail.html", "templates/partials/footer.html"]);
    expect(rel(["data/*.json"], ["data/secret_*"])).toEqual(["data/x.json"]);
    expect(rel(["templates/**", "*.md"], ["templates/partials/"])).toEqual(["README.md", "templates/mail.html"]);
    expect(rel([])).toEqual([]);
    expect(rel(["node_modules/**"])).toEqual([]); // default excludes always win
    expect(rel([".env"])).toEqual([]);
  });

  it("DEFAULT_EXCLUDES covers secrets and build output", () => {
    for (const p of [".env", ".nskit/**", "node_modules/**", "**/*.tfstate"]) expect(DEFAULT_EXCLUDES).toContain(p);
  });
});
