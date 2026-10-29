import { main } from "../src/cli/devlog.ts";
process.exit(await main(process.argv.slice(2)));
