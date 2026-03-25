import { existsSync } from "node:fs";

const isProduction = process.env.NODE_ENV === "production";
const isCi = process.env.CI === "true";
const isDisabled = process.env.HUSKY === "0";

if (isProduction || isCi || isDisabled) {
  process.exit(0);
}

if (!existsSync(".git")) {
  process.exit(0);
}

try {
  const husky = (await import("husky")).default;
  husky();
} catch {
  process.exit(0);
}
