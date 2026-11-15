import { test } from "node:test";
import assert from "node:assert/strict";
import { CC_RC_URL_PREFIX, ccRcUrl, projectOf } from "../src/cc/labels.ts";
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

test("projectOf: 直下とその下は先頭の 1 要素、ワークスペースそのもの・外・名前が形に合わないものは null、末尾の / を無視する", () => {
  const ws = "/home/owner/workspace";
  assert.deepEqual(projectOf(`${ws}/alpha`, ws), { dir: "alpha" });
  assert.deepEqual(projectOf(`${ws}/alpha/src/deep`, ws), { dir: "alpha" });
  assert.deepEqual(projectOf(`${ws}/alpha`, `${ws}//`), { dir: "alpha" });
  assert.equal(projectOf(ws, ws), null);
  assert.equal(projectOf(`${ws}/`, ws), null);
  assert.equal(projectOf("/home/owner/workspace-other/alpha", ws), null);
  assert.equal(projectOf("/tmp/alpha", ws), null);
  assert.equal(projectOf(`${ws}/has space`, ws), null);
  assert.equal(projectOf(`${ws}/.hidden`, ws), null);
  assert.equal(projectOf(`${ws}/${"a".repeat(65)}`, ws), null);
  assert.equal(projectOf(undefined, ws), null);
  assert.equal(projectOf("", ws), null);
  assert.equal(projectOf(`${ws}/alpha`, "/"), null);
});
