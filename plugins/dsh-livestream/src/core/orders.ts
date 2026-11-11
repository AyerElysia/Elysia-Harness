/**
 * 点单队列：观众要她在游戏里做的事，一单一条。
 *
 * 只有这一份：直播线把观众的话交给游戏线时（game_side）程序按原话记一单；
 * 游戏线在说的话前面写 [开工#3] / [完成#3] / [不做#3] 改状态（和 [laugh] 换表情是同一种写法，念之前去掉）；
 * 舞台和直播线只读它。主人在控制台可以改。
 */

export type OrderState = 'queued' | 'doing' | 'done' | 'dropped';

export interface Order {
  id: number;
  /** 点单的人（名字，和 B 站 UID） */
  who: string;
  uid?: string;
  /** 他的原话 */
  text: string;
  state: OrderState;
  at: number;
  /** 最后一次改状态的时间 */
  changedAt: number;
}

export interface OrderBookData {
  seq: number;
  items: Order[];
}

/** 做完、不做的单留几条（舞台上露最近一条，剩下的只为直播线答「我的单呢」） */
const KEEP_CLOSED = 30;
/** 舞台上露几条 */
const SHOWN_OPEN = 4;
const SHOWN_CLOSED = 1;

export class OrderBook {
  private seq = 0;
  private items: Order[] = [];

  constructor(saved?: Partial<OrderBookData> | null) {
    if (!saved?.items) return;
    this.items = saved.items.filter((o) => o && Number.isInteger(o.id) && typeof o.text === 'string');
    this.seq = Math.max(Number(saved.seq) || 0, ...this.items.map((o) => o.id));
  }

  add(who: string, text: string, now: number, uid?: string): Order {
    const order: Order = { id: ++this.seq, who, ...(uid ? { uid } : {}), text, state: 'queued', at: now, changedAt: now };
    this.items.push(order);
    return order;
  }

  /** 这个人这句话已经在排着的那一单（直播线对同一件事交了两次时不重复记） */
  findOpen(uid: string, text: string): Order | undefined {
    return this.items.find((o) => (o.state === 'queued' || o.state === 'doing') && (o.uid ?? '') === uid && o.text === text);
  }

  /** 改一单的状态；没这一单返回 false */
  mark(id: number, state: OrderState, now: number): boolean {
    const order = this.items.find((o) => o.id === id);
    if (!order) return false;
    order.state = state;
    order.changedAt = now;
    const closed = this.items.filter((o) => o.state === 'done' || o.state === 'dropped');
    if (closed.length > KEEP_CLOSED) {
      const drop = new Set(closed.sort((a, b) => a.changedAt - b.changedAt).slice(0, closed.length - KEEP_CLOSED));
      this.items = this.items.filter((o) => !drop.has(o));
    }
    return true;
  }

  /** 清空（主人在控制台点的） */
  clear(): void {
    this.items = [];
  }

  /** 还没做完的：在做的在前，再按点单先后 */
  open(): Order[] {
    return this.items.filter((o) => o.state === 'queued' || o.state === 'doing')
      .sort((a, b) => (a.state === b.state ? a.id - b.id : a.state === 'doing' ? -1 : 1));
  }

  /** 舞台上放的：没做完的前几条，加最近做完的一条 */
  shown(): Order[] {
    const closed = this.items.filter((o) => o.state === 'done').sort((a, b) => b.changedAt - a.changedAt).slice(0, SHOWN_CLOSED);
    return [...this.open().slice(0, SHOWN_OPEN), ...closed];
  }

  /** 给直播线看的一行（观众问「我的单排到哪了」时照着答）；没有单返回 '' */
  summary(): string {
    const open = this.open();
    if (!open.length) return '';
    const label = (o: Order) => `#${o.id} ${o.who}「${o.text.slice(0, 20)}」${o.state === 'doing' ? '（在做）' : ''}`;
    return `点单队列（${open.length} 单没做完，按顺序）：${open.slice(0, 8).map(label).join('，')}${open.length > 8 ? '……' : ''}`;
  }

  toJSON(): OrderBookData {
    return { seq: this.seq, items: this.items };
  }
}

const TAG_STATE: Record<string, OrderState> = { 开工: 'doing', 完成: 'done', 不做: 'dropped' };

/** 游戏线说的话里的单子标记：[开工#3] [完成#3] [不做#3]；返回去掉标记的话和标记 */
export function orderTags(text: string): { text: string; marks: Array<{ id: number; state: OrderState }> } {
  const marks: Array<{ id: number; state: OrderState }> = [];
  const rest = text.replace(/\[\s*(开工|完成|不做)\s*#\s*(\d+)\s*\]/g, (_, word: string, id: string) => {
    marks.push({ id: Number(id), state: TAG_STATE[word] });
    return '';
  });
  return { text: marks.length ? rest.replace(/[ \t]{2,}/g, ' ').trim() : text, marks };
}
