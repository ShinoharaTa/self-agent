import { main } from "../src/cli/cc-setup.ts";
process.exit(await main(process.argv.slice(2)));
