// 板・確認・知らせ（docs/plan/web-ui-components.md §6 の K2）: Sheet・Confirm・Toast。
// hook を使うのは Sheet だけ（自分の <dialog> の ref だけに触る）。Confirm・Toast は Node から呼べる。タイマーは持たない（自動で消すのは入口の側）
import { html, useRef, useLayoutEffect, useEffect } from "./c-lib.js";
import { Button, IconButton } from "./c-atoms.js";

/** 点が箱の外か（辺の上は中） */
export function isOutside(rect, x, y) {
  return x < rect.left || x > rect.right || y < rect.top || y > rect.bottom;
}

/**
 * <dialog> の showModal() で出す板（スマホは下に付き、PC は中央）。外側の不活性・Esc・閉じた後のフォーカスの戻りは native に任せる。
 * native が閉じた（Esc・戻る操作）ときは close の事象で onClose を呼ぶ。prop で閉じたときは呼ばない（onClose は 1 回だけ）。
 * 背景は押し始めと離した所の両方が箱の外のときだけ閉じる
 */
export function Sheet({ open, id, title, closeButton = true, onClose, footer, children }) {
  const ref = useRef(null);
  const downOutside = useRef(false);
  const outside = (event) => event.target === ref.current && isOutside(ref.current.getBoundingClientRect(), event.clientX, event.clientY);

  useLayoutEffect(() => {
    const d = ref.current;
    if (open && !d.open) d.showModal();
    else if (!open && d.open) d.close();
  }, [open]);

  useEffect(
    () => () => {
      const d = ref.current;
      if (d && d.open) d.close();
    },
    [],
  );

  return html`<dialog class="c-sheet" id=${id} ref=${ref} aria-labelledby=${id + "-title"}
      onClose=${() => {
        if (open) onClose();
      }}
      onPointerDown=${(event) => {
        downOutside.current = outside(event);
      }}
      onClick=${(event) => {
        const hit = downOutside.current && outside(event);
        downOutside.current = false;
        if (hit) onClose();
      }}>
    <div class="c-sheet-head">
      <h2 class="c-sheet-title" id=${id + "-title"}>${title}</h2>
      ${closeButton ? html`<${IconButton} icon="x" label="閉じる" onPress=${onClose} />` : null}
    </div>
    <div class="c-sheet-body">${children}</div>
    ${footer ? html`<div class="c-sheet-foot">${footer}</div>` : null}
  </dialog>`;
}

/** 確認に出す対象の文（空白を畳み、80 字を超えたら省いて「」で囲む。ui.js の targetLine と同じ） */
export function confirmTarget(target) {
  const text = String(target).replace(/\s+/g, " ").trim();
  const chars = [...text];
  return `「${chars.length > 80 ? chars.slice(0, 80).join("") + "…" : text}」`;
}

/** 危ない操作は実行を danger の塗りにし、最初のフォーカスを [やめる] に置く（Enter の連打で走らせない） */
export function confirmButtons({ danger, okLabel = "実行する", cancelLabel = "やめる" }) {
  return {
    cancel: { kind: "secondary", label: cancelLabel, autofocus: !!danger },
    ok: { kind: danger ? "danger" : "primary", label: okLabel, autofocus: !danger },
  };
}

/** 並びは [やめる]（左）・実行（右）。Esc・背景は onCancel */
export function Confirm({ open, id, title, target, body, okLabel, cancelLabel, danger = false, busy = false, onOk, onCancel }) {
  const b = confirmButtons({ danger, okLabel, cancelLabel });
  return html`<${Sheet} open=${open} id=${id} title=${title} closeButton=${false} onClose=${onCancel}
      footer=${html`<${Button} ...${b.cancel} onPress=${onCancel} /><${Button} ...${b.ok} busy=${busy} onPress=${onOk} />`}>
    ${target ? html`<p class="c-confirm-target">${confirmTarget(target)}</p>` : null}
    ${body ? html`<p class="c-confirm-body">${body}</p>` : null}
  <//>`;
}

/** 失敗（level が error）だけ割り込んで読ませる（順はそのまま） */
export function toastSplit(items) {
  return { status: items.filter((item) => item.level !== "error"), alert: items.filter((item) => item.level === "error") };
}

/** 知らせの入れ物。読み上げの領域は先に在る必要があるので、中が空でも 2 つとも出す */
export function Toast({ items, onDismiss }) {
  const { status, alert } = toastSplit(items);
  const row = (item) => html`<div class="c-toast-item" key=${item.id} data-level=${item.level === "error" ? "error" : "info"}>
    <p class="c-toast-text">${item.text}</p>
    ${item.actionLabel ? html`<${Button} kind="ghost" size="sm" label=${item.actionLabel} onPress=${item.onAction} />` : null}
    <${IconButton} icon="x" size="sm" label="閉じる" onPress=${() => onDismiss(item.id)} />
  </div>`;
  return html`<div class="c-toast">
    <div class="c-toast-list" role="status" aria-live="polite">${status.map(row)}</div>
    <div class="c-toast-list" role="alert" aria-live="assertive">${alert.map(row)}</div>
  </div>`;
}
