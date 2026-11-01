import { main } from "../src/cli/cc-dry-run.ts";
process.exit(await main(process.argv.slice(2)));
