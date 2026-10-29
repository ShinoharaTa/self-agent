import { main } from "../src/cli/shell-check.ts";
process.exit(await main(process.argv.slice(2)));
