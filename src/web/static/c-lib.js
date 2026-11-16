// 部品の入口（docs/plan/web-ui-components.md §8）。部品は Preact・htm をここからだけ import する（vendor-*.js を直に読まない）
import { h } from "./vendor-preact.js";
import htm from "./vendor-htm.js";

export { h, render, Fragment } from "./vendor-preact.js";
export { useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback } from "./vendor-preact-hooks.js";

/** htm のタグ付きテンプレート（html`<p class="x">a</p>` → vnode） */
export const html = htm.bind(h);
