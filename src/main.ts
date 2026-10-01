import { loadConfig } from "./config.ts";

const config = loadConfig();

console.log(
  `self-agent: P0 scaffold。Discord 連携は P1 で実装。` +
    `token=${config.oauthTokenPresent ? "present" : "missing"}, model=${config.model}`,
);
