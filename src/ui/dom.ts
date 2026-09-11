/** 最小的 DOM 工具。 */

export function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error('找不到 #' + id);
  return el;
}

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K, cls = '', text = '',
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text) el.textContent = text;
  return el;
}
