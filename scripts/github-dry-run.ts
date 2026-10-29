import { main } from "../src/cli/github-dry-run.ts";
process.exit(await main(process.argv.slice(2)));
