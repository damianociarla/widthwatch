import { createRequire } from "node:module";

const metadata = createRequire(import.meta.url)("../package.json") as { version: string };

export const API_VERSION = metadata.version;
