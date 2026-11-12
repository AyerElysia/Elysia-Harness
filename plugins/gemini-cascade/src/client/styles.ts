/** Call UI inherits the DSH shell's input, text, surface, and spacing tokens. */
export const STYLES = `
.egc-button {
  appearance:none; border:1px solid var(--dsw-alias-line-primary,#8b8b8b66);
  color:var(--dsw-alias-label-primary,inherit); background:transparent; font:inherit;
  min-height:32px; padding:4px 10px; border-radius:9px; cursor:pointer;
}
.egc-button:hover:not(:disabled) { background:var(--dsw-alias-interactive-bg-hover,#8080801c); }
.egc-button:disabled { opacity:.5; cursor:default; }
.egc-button:focus-visible, .egc-form input:focus-visible { outline:2px solid #5578d8; outline-offset:2px; }
.egc-icon-button, .egc-shortcut-button { display:inline-flex; align-items:center; gap:8px; border-color:transparent; }
.egc-icon-button { justify-content:center; width:34px; padding:0; }
.egc-start { display:inline-flex; align-items:center; gap:6px; }
.egc-inline-notice { font-size:11px; line-height:1.2; max-width:13rem; color:var(--dsw-alias-label-secondary,#777); }
.egc-shortcut { flex:0 0 auto; min-width:0; }
.egc-shortcut-button { max-width:100%; white-space:nowrap; }
.egc-shortcut-button span { overflow:hidden; text-overflow:ellipsis; }
.egc-seat { display:flex; justify-content:center; padding:8px calc(var(--dsh-composer-side-clearance,0px) + 16px) 12px; }
.egc-main-seat { padding:0; }
.egc-card {
  box-sizing:border-box; width:100%; max-width:var(--dsh-chat-content-width,760px);
  padding:12px 14px; display:grid; gap:10px; border-radius:var(--dsw-radius-xl,16px);
  border:1px solid var(--dsw-alias-line-primary,#8b8b8b66); box-shadow:var(--dsw-shadow-lv2,0 4px 20px #0001);
  background:var(--dsw-specific-input-major,Canvas); color:var(--dsw-alias-label-primary,CanvasText);
}
.egc-bar,.egc-consent,.egc-form,.egc-actions { display:flex; align-items:center; gap:8px; }
.egc-bar,.egc-consent { flex-wrap:wrap; }
.egc-status { flex:1; min-width:8rem; display:grid; gap:3px; }
.egc-status strong { font-size:14px; font-weight:600; }
.egc-status span,.egc-consent p,.egc-notice,.egc-note { font-size:12px; color:var(--dsw-alias-label-secondary,#727272); }
.egc-consent p,.egc-notice,.egc-note { margin:0; line-height:1.5; }
.egc-consent p { flex:1; min-width:12rem; }
.egc-actions { justify-content:flex-end; flex-wrap:wrap; }
.egc-hangup { color:var(--dsw-alias-state-error-primary,#bd3434); }
.egc-accept { font-weight:600; color:var(--dsw-alias-label-primary,CanvasText); }
.egc-indicator {
  width:36px; height:36px; border-radius:50%; display:flex; justify-content:center; align-items:center;
  gap:2px; background:#9a7ce422; color:#815ec9; flex:0 0 auto;
}
.egc-indicator i { display:block; width:2px; height:4px; border-radius:3px; background:currentColor; }
.egc-indicator i:nth-child(2),.egc-indicator i:nth-child(4) { height:9px; }
.egc-indicator i:nth-child(3) { height:14px; }
.egc-indicator[data-phase="listening"] { background:#4b9a7622; color:#40815e; }
.egc-indicator[data-phase="speaking"] i { animation:egc-wave .65s ease-in-out infinite alternate; }
.egc-indicator[data-phase="speaking"] i:nth-child(2n) { animation-delay:-.3s; }
@keyframes egc-wave { from { transform:scaleY(.55); } to { transform:scaleY(1.2); } }
@media(prefers-reduced-motion:reduce) { .egc-indicator[data-phase="speaking"] i { animation:none; } }
.egc-form input {
  flex:1; min-width:0; border-radius:9px; border:1px solid var(--dsw-alias-line-primary,#8b8b8b66);
  color:inherit; background:transparent; padding:6px 9px; min-height:32px; font:inherit;
}
`
