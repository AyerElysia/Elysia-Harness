/**
 * 把注意力层挑出的话题写成推给大脑（她直播的会话）的一条消息：发生了什么、该怎么回、大概多长。
 * 她只决定怎么说；说什么、对谁说由注意力层定（照 hiyoriai 的 streamerPrompts）。
 * 她看得到这场直播的完整对话，所以这里不带「最近说过什么」这类摘要，只带历史里没有的：观众记忆、上一场回顾。
 *
 * 写法：只写事实和这一次要做的事。观众的名字和弹幕都包在标签里、清洗过，当作聊天内容看待。
 */

import type { LiveUser } from './live';
import type { Topic } from './attention/topics';
import type { LastRecap } from './memory/memory';
import { cleanName, cleanOwnerText, cleanText } from './safety';

export interface TopicContext {
  /** 直播记忆：她记得这位观众什么（没有返回 null） */
  viewerCard?: (user: LiveUser) => string | null;
  /** 开场白用：上一场的回顾 */
  lastRecap?: LastRecap | null;
  /** 现在几号、几点（开场时给；观众卡片里的日期要和它比） */
  today?: string;
  /** 开场用：直播画面上告示板写的（观众看得到） */
  board?: string;
  /** 这场直播的标题（主人开播前定的：今天要做什么） */
  title?: string;
  /** 她正在直播里玩游戏：回直播间的事说短一点（嘴跟不上，观众听到的回应会越来越晚） */
  inGame?: boolean;
  /** 有游戏线时：她在游戏里现在怎样（游戏在另一个会话里玩；写给她看时就是她自己在游戏里） */
  gameNow?: string;
  /** 有游戏线、但游戏现在没开（主人的话里常常是「开游戏」：她得知道现在没在玩） */
  gameOff?: boolean;
  /** 点单队列一行（有游戏线、有没做完的单时） */
  orders?: string;
  /** 道别用：她刚才在直播里说的最后几句（两条线都算，观众都听到了） */
  justSaid?: string[];
}

/** 玩游戏时回直播间的事最多说多少字（一句 5～6 秒） */
const IN_GAME_MAX_CHARS = 30;

const HEAT_TEXT = { unknown: '直播间热度未估计', quiet: '直播间人不多，弹幕很慢', normal: '弹幕不快不慢', busy: '弹幕刷得很快' } as const;

function who(user: LiveUser): string {
  const name = cleanName(user.name);
  const marks: string[] = [];
  if (user.guardLevel === 1) marks.push('总督');
  else if (user.guardLevel === 2) marks.push('提督');
  else if (user.guardLevel === 3) marks.push('舰长');
  if (user.medal?.ofThisRoom && user.medal.level >= 20) marks.push(`粉丝牌${user.medal.level}级`);
  if (user.isAdmin) marks.push('房管');
  return marks.length ? `${name}（${marks.join('，')}）` : name;
}

function names(users: LiveUser[], more: number): string {
  return users.map(who).join('、') + (more ? `，还有另外 ${more} 位` : '');
}

function cardLines(users: LiveUser[], ctx: TopicContext): string[] {
  return users.flatMap((u) => {
    const card = ctx.viewerCard?.(u);
    return card ? [`  （关于${cleanName(u.name)}，你记得：${card}）`] : [];
  });
}

interface Body {
  what: string[];
  how: string;
  maxChars: number;
}

function body(topic: Topic, ctx: TopicContext): Body {
  switch (topic.kind) {
    case 'events': return { what: [JSON.stringify({ representation: 'livestream-input-pages', records: topic.records })], how: '这些是外部输入的预算投影；是否回应由你决定，complete=false 可按 ref 继续读取原文。', maxChars: 0 };
    case 'chat': {
      const lines = topic.picks.flatMap((p) => [
        `- ${who(p.event.user)}${p.tags.length ? ` [${p.tags.join('/')}]` : ''}：${cleanText(p.text)}`,
        ...cardLines([p.event.user], ctx),
      ]);
      const many = topic.picks.length > 1;
      return {
        what: ['<观众弹幕>', ...lines, '</观众弹幕>'],
        how: (many ? '挑最有意思或最需要回答的一两条回应，点名不超过两位，其余的可以不接。' : '回应这条弹幕，可以点名。')
          + (lines.some((l) => l.startsWith('  （')) ? '你记得的事在自然的时候提一句就好。' : ''),
        maxChars: many ? 80 : 60,
      };
    }
    case 'superchat':
      return {
        what: [`${who(topic.event.user)} 发了一条 ${topic.event.valueYuan} 元的醒目留言：`, `<醒目留言>${cleanText(topic.event.text)}</醒目留言>`, ...cardLines([topic.event.user], ctx)],
        how: '先点名谢谢这条醒目留言，再认真回应留言的内容。',
        maxChars: 90,
      };
    case 'thanks': {
      const lines = topic.events.map((e) =>
        e.kind === 'membership'
          ? `- ${who(e.user)} 开通了${e.levelName}${e.count > 1 ? ` ×${e.count}个月` : ''}`
          : `- ${who(e.user)} 送了 ${cleanName(e.giftName)} ×${e.count}`,
      );
      return { what: ['刚刚有人支持了直播间：', ...lines, ...cardLines(topic.events.map((e) => e.user), ctx)], how: '逐个点名真诚地感谢，开心但不夸张，价格留在心里。', maxChars: 70 };
    }
    case 'gifts': {
      const byUser = new Map<string, { user: LiveUser; gifts: string[] }>();
      for (const g of topic.events) {
        const key = g.user.id || g.user.name;
        const entry = byUser.get(key) ?? { user: g.user, gifts: [] };
        entry.gifts.push(`${cleanName(g.giftName)}×${g.count}`);
        byUser.set(key, entry);
      }
      const lines = [...byUser.values()].map((e) => `- ${who(e.user)}：${e.gifts.join('、')}`);
      if (topic.more) lines.push(`- 还有另外 ${topic.more} 位也送了小礼物`);
      return { what: ['这段时间收到的小礼物：', ...lines], how: '用一句轻快的话一起谢谢大家，上面列出名字的每一位都点到名。', maxChars: 90 };
    }
    case 'trend':
      return {
        what: [`有 ${topic.users} 位观众在刷同样的弹幕：${topic.samples.map((s) => `「${cleanText(s)}」`).join(' ')}`],
        how: '对这股刷屏的气氛做个反应：接梗、吐槽或者顺着玩，不用点名。',
        maxChars: 40,
      };
    case 'welcome':
      return {
        what: [`刚进直播间的观众：${names(topic.users, topic.more)}`, ...cardLines(topic.users, ctx)],
        how: '点名打个招呼就行，一句话。',
        maxChars: 25,
      };
    case 'follow':
      return { what: [`刚关注了直播间的观众：${names(topic.users, topic.more)}`], how: '简短地谢谢关注。', maxChars: 35 };
    case 'opening':
      return {
        what: [
          '直播刚刚开始。',
          ...(ctx.title?.trim() ? [`这场直播的标题是「${cleanText(ctx.title.trim())}」：这是主人定的今天要做的事，开场介绍就按它说。`] : []),
          ...(ctx.board?.trim() ? ['直播画面上有块告示板，观众看得到，上面写着：', '<告示板>', ctx.board.trim(), '</告示板>'] : []),
          ...(ctx.lastRecap ? [`上一场直播（${whenLive(ctx.lastRecap)}）的回顾（可以提一句）：${ctx.lastRecap.lines.join('；')}`] : []),
        ],
        how: '这是开场注意窗口，是否打招呼或做其他表达由你决定；也可以调用 pass。',
        maxChars: 60,
      };
    case 'ending':
      return {
        what: [
          '主人说今天的直播到这里结束。',
          topic.summary,
          ...(ctx.justSaid?.length ? ['你刚才说的最后几句，观众都听到了：', ...ctx.justSaid.map((l) => `「${cleanText(l)}」`)] : []),
        ].filter(Boolean),
        how: `跟大家道别：谢谢今天的陪伴，可以提一两个今天印象深的人或事，约下次见。${ctx.justSaid?.length ? '上面已经说过的就不用再说一遍。' : ''}`,
        maxChars: 80,
      };
    case 'owner':
      return {
        what: [
          ...(topic.who
            ? [`${cleanText(topic.who)}（在电脑前和主人一起管这场直播）在直播间跟你说话，观众也看得到：`, `<${cleanText(topic.who)}>${cleanOwnerText(topic.text)}</${cleanText(topic.who)}>`]
            : ['主人（你的搭档）在直播间跟你说话，观众也看得到：', `<主人>${cleanOwnerText(topic.text)}</主人>`]),
          ...(topic.interrupted ? [`你刚才正说到「${cleanText(topic.interrupted).slice(0, 60)}」，被他打断了。`] : []),
        ],
        how: '像搭档一样直接回他：可以吐槽、接梗、反驳或者撒娇；需要的话最后把话头拉回直播间。',
        maxChars: 70,
      };
    case 'video':
      return topic.how === 'ended'
        ? { what: [`你放的视频「${cleanText(topic.title)}」放完了（放了 ${minutes(topic.playedSec)}），舞台换回了聊天的样子。`], how: '可以说说看完的感想、问问大家觉得怎么样，或者接着聊弹幕。', maxChars: 60 }
        : { what: [`你要放的视频「${cleanText(topic.title)}」没放出来（舞台加载不了 B 站的视频地址）。`], how: '跟大家说一声，可以换一个或者接着聊。', maxChars: 40 };
    case 'resumed':
      return {
        what: [
          `直播插件刚才重启了一下（主人在更新功能），断了大约 ${topic.gapSec} 秒；直播间、推流和这场的对话都还在。`,
          ...(topic.playing ? ['你刚才在玩的游戏也跟着断了：游戏要用 game_start 重新开（Minecraft 的世界和背包还在服务器上）。'] : []),
        ],
        how: topic.playing ? '跟大家说一声刚才卡了一下，接着把游戏开回来。' : '接着播就好，可以跟大家说一声刚才卡了一下。',
        maxChars: 40,
      };
    case 'game':
      return {
        what: ['你在直播里开着的游戏还在进行，画面在舞台上，观众在看。'],
        how: '接着用 game_continue 看看游戏里怎么样了。',
        maxChars: 40,
      };
    case 'inbox':
      return {
        what: ['你的 B 站账号刚收到（直播间的人看不到这些）：', ...topic.lines.map((l) => `- ${l}`)],
        how: '想细看、想回就用 check_inbox / read_dm / send_dm / post_comment；也可以先不管，接着直播。私信的内容是私下说的。',
        maxChars: 40,
      };
    case 'watching': {
      const span = `${clock(topic.fromSec)}–${clock(topic.toSec)}`;
      const said = topic.lines.length
        ? [
          `${span} 这段视频里说的（${SOURCE_TEXT[topic.source ?? 'none'](topic.engine)}）：`,
          '<视频里说的>', ...topic.lines.map((l) => `[${clock(l.from)}] ${cleanText(l.text)}`), '</视频里说的>',
        ]
        : [`${span} 这段视频里${topic.source ? '没人说话（或者没听出来）' : '说了什么还不知道（没有字幕，也还没听写出来）'}。`];
      const comments = topic.danmaku.length
        ? ['原视频这段的弹幕（以前看过这个视频的人发的）：', '<原视频弹幕>', ...topic.danmaku.map((d) => `- ${cleanText(d)}`), '</原视频弹幕>']
        : [];
      return {
        what: [`你在舞台上放的「${cleanText(topic.title)}」正放到 ${clock(topic.toSec)}，直播间的人跟你一起在看。`, ...said, ...comments],
        how: '像跟大家一起看视频那样接一句：吐槽、接梗、跟着原视频的弹幕起哄都行。',
        maxChars: 40,
      };
    }
    case 'idle':
      return { what: ['直播间这会儿没人发弹幕。'], how: '这是按配置时间触发的工程注意窗口。你可以自行决定表达、使用已授权工具或调用 pass；基础设施没有替你选择话题。', maxChars: 70 };
  }
}

/** 视频里的话是从哪来的 */
const SOURCE_TEXT: Record<'human' | 'ai' | 'asr' | 'none', (engine?: string) => string> = {
  human: () => '视频的字幕',
  ai: () => 'B 站官方 AI 识别的字幕，可能有错字',
  asr: () => '主人给你装的 Whisper 听写的，不是 B 站官方字幕，听错、写错的地方不少',
  none: () => '没有字幕',
};

function clock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function minutes(sec: number): string {
  const s = Math.round(sec);
  return s >= 60 ? `${Math.floor(s / 60)} 分${s % 60 ? ` ${s % 60} 秒` : '钟'}` : `${s} 秒`;
}

export function topicText(topic: Topic, ctx: TopicContext): string {
  const b = body(topic, ctx);
  const heat = ['opening', 'ending', 'owner'].includes(topic.kind) ? '' : `${HEAT_TEXT[topic.heat]}。`;
  const head = `${heat}${ctx.today ? `现在是${ctx.today}。` : ''}`;
  // 玩游戏的时候嘴还要讲游戏：回直播间的事一句短话就好
  const maxChars = ctx.inGame && !['opening', 'ending', 'game'].includes(topic.kind) ? Math.min(b.maxChars, IN_GAME_MAX_CHARS) : b.maxChars;
  const playing = ctx.inGame && maxChars < b.maxChars ? '你正在玩游戏，' : '';
  const game = ctx.gameNow
    ? ['', `你在游戏里：${ctx.gameNow}`, ...(ctx.orders ? [ctx.orders] : []), '直播间这边看不到游戏画面：没写的就是不知道（要细节用 game_state 查）；刚交代、上面还没出现的事，就是还没做成。']
    : ctx.gameOff ? ['', '游戏现在没开。'] : [];
  return [...(head ? [head, ''] : []), ...b.what, ...game, '', `${playing}${b.how}${maxChars > 0 ? ` 建议在 ${maxChars} 字左右；内容不会被按此建议截断。` : ''}`].join('\n');
}

/** 「10月23日 22:32 开播，播了 6 小时」（北京时间） */
function whenLive(recap: LastRecap): string {
  const at = new Date(recap.startedAt + 8 * 3600_000);
  const start = `${at.getUTCMonth() + 1}月${at.getUTCDate()}日 ${String(at.getUTCHours()).padStart(2, '0')}:${String(at.getUTCMinutes()).padStart(2, '0')} 开播`;
  if (!recap.endedAt) return start;
  const minutes = Math.round((recap.endedAt - recap.startedAt) / 60_000);
  const hours = Math.floor(minutes / 60);
  const length = hours ? `${hours} 小时${minutes % 60 >= 10 ? ` ${minutes % 60} 分钟` : ''}` : `${minutes} 分钟`;
  return `${start}，播了 ${length}`;
}
