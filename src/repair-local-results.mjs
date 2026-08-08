import path from "node:path";
import { fileURLToPath } from "node:url";
import { repairLocalResultHistory } from "./logger.mjs";

const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
const rootDirectory = path.dirname(sourceDirectory);
const result = await repairLocalResultHistory(
  path.join(rootDirectory, "logs"),
  path.join(rootDirectory, "data", "site-state.json"),
);
console.log(JSON.stringify(result, null, 2));
