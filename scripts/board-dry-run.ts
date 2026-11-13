import { main } from "../src/cli/board-dry-run.ts";
process.exit(await main(process.argv.slice(2)));
