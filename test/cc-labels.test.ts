import { test } from "node:test";
import assert from "node:assert/strict";
import { CC_RC_URL_PREFIX, ccRcUrl } from "../src/cc/labels.ts";
import { sinceOf } from "../src/cc/registry.ts";

test("ccRcUrl: RC のリンクは前半 + bridgeSessionId で、検証済みの形の値は変わらない", () => {
  assert.equal(CC_RC_URL_PREFIX, "https://claude.ai/code/");
  assert.equal(ccRcUrl("session_01ABC-x_y"), "https://claude.ai/code/session_01ABC-x_y");
});

test("ccRcUrl: 検証の形の外の文字は encodeURIComponent で崩す", () => {
  assert.equal(ccRcUrl("session_a/b?c"), "https://claude.ai/code/session_a%2Fb%3Fc");
});

test("sinceOf: 判断待ちは待ち始め（無ければ最後の活動）、それ以外は最後の活動", () => {
  assert.equal(sinceOf({ state: "needs_input", waitingSince: 10, lastActivityAt: 20 }), 10);
  assert.equal(sinceOf({ state: "needs_input", waitingSince: undefined, lastActivityAt: 20 }), 20);
  assert.equal(sinceOf({ state: "running", waitingSince: 10, lastActivityAt: 20 }), 20);
  assert.equal(sinceOf({ state: "idle", waitingSince: undefined, lastActivityAt: undefined }), undefined);
});
