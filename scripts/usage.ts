import { main } from "../src/cli/usage.ts";
process.exit(await main(process.argv.slice(2)));
