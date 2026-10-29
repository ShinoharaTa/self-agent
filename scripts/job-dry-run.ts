import { main } from "../src/cli/job-dry-run.ts";
process.exit(await main(process.argv.slice(2)));
