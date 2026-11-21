/**
 * dsh-livestream 网页端：侧栏「直播」入口 → 主人控制台（console.tsx）。
 * 用到的都是 DSH 网页端的公开服务（sessions / uiWorkspace / remote.credentials / layout / connection），照 dsh-game 的用法。
 */

import React from 'react';
import { Console, CONSOLE_CSS, bindConsole, bindCredentials, disposeConsole, type ConsoleServices } from './console';

export const PANEL_ID = '@elysia/dsh-livestream';

export const inject = ['slots', 'layout', 'uiWorkspace', 'sessions', 'remote', 'connection'];

interface ClientContext extends ConsoleServices {
  slots: { inject(name: string, callback: () => unknown): unknown; register(spec: any, component: any): () => void };
  effect(effect: () => () => void, label?: string): unknown;
  inject(deps: string[], callback: (ctx: ClientContext & { remote: any }) => void): unknown;
}

function BroadcastIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="2.2" />
      <path d="M8.2 15.8a5.4 5.4 0 0 1 0-7.6M15.8 8.2a5.4 5.4 0 0 1 0 7.6" />
      <path d="M5.2 18.8a9.6 9.6 0 0 1 0-13.6M18.8 5.2a9.6 9.6 0 0 1 0 13.6" />
    </svg>
  );
}

export function apply(ctx: ClientContext): void {
  ctx.effect(() => {
    const tag = document.createElement('style');
    tag.dataset.plugin = '@elysia/dsh-livestream';
    tag.textContent = CONSOLE_CSS;
    document.head.append(tag);
    return () => tag.remove();
  }, 'dsh-livestream styles');
  ctx.effect(() => { bindConsole(ctx); return () => disposeConsole(); }, 'elysia livestream console');
  // B 站凭据仍由 DSH 管理；声音由本地 Breeze 配置提供。
  // DSH 的服务是 ctx 上的访问器，不能展开复制 ctx，凭据单独交给控制台
  ctx.inject(['remote.credentials'], (sub) => {
    bindCredentials(sub.remote.credentials);
    sub.effect(() => () => bindCredentials(null), 'dsh-livestream credentials');
  });
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID }, Console));
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 2, label: () => '直播' }, BroadcastIcon));
}
