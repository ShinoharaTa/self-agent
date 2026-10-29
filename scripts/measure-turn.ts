import { main } from "../src/cli/measure.ts";
process.exit(await main(process.argv.slice(2)));
