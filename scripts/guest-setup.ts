import { main } from "../src/cli/guest-setup.ts";
process.exit(await main(process.argv.slice(2)));
