import { createRequire } from "node:module";

const metadata = createRequire(import.meta.url)("../package.json") as { version: string };

export const PACKAGE_VERSION = metadata.version;
export const CAPTURE_PROTOCOL_VERSION = 3;
