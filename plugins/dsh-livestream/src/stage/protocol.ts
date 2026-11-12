/**
 * 舞台事件流（v1）：身体推给舞台页的全部东西。模板和挂件只读这里，不含任何逻辑，
 * 所以换主题不会把直播弄坏；别人写的模板和挂件按这个版本号对接。
 *
 * 连接：GET /events?token=…（SSE，每条 data 是一个 StageEvent）。舞台念完一句回执 POST /said?id=…&token=…。
 * 放视频：视频从 GET <src>&token=… 取（舞台服务器转发）；开始放、放完、放不出来回执
 * POST /media?id=…&state=playing|ended|error&at=<秒>&token=…。
 */

export const STAGE_PROTOCOL = 1;

/** 角色包清单（assets/characters/<id>/character.json） */
export interface CharacterManifest {
  format: 1;
  id: string;
  name: string;
  /** 观众叫她时用的名字（点名判断） */
  names: string[];
  /** 默认豆包音色 */
  voice?: string;
  renderer: 'clips' | 'image';
  license?: string;
  /** 动画片段渲染器：待机循环、说话循环；有表情时先播 out，再播表情，再播 in 回到说话 */
  clips?: {
    size: [number, number];
    idle: string;
    talk: string;
    out?: string;
    in?: string;
    moods: Record<string, string>;
    /**
     * 边带表情边说话的循环（可选）：表情名 → 片段。首尾都是说话循环的姿势，带这个表情的话直接播它、不经过 out / in，
     * 开口不用等（moods 里的是不说话的反应，播完放下、拿起饭碗要好几秒）
     */
    talkMoods?: Record<string, string>;
    /**
     * 片段之间怎么切最不显眼的表（可选，tools/clip-graph.ts 算出来的 transitions.json）：
     * 切到循环片段时从和旧片段当前帧最像的那一帧开播，切到要从头播的片段时等旧片段转到最像的那一帧再切；
     * 有这张表时直接切 + 轻轻回弹，没有就交叉淡化
     */
    graph?: string;
  };
  /**
   * 角色自己的小插画（可选）：名字 → 角色包里的图片文件。挂件按名字取，没有就不画。
   * 约定的名字：rice（捧着饭碗，吃饭计数）、sleep（睡觉，开播前）、wave（挥手，下播）、
   * laptop（敲电脑，终端）、gift（举着礼物，大礼物）、kv（开场主视觉，横版）
   */
  art?: Record<string, string>;
  /** 立绘渲染器：一张图，说话时轻轻弹跳；moods 是表情差分 */
  image?: {
    size: [number, number];
    idle: string;
    moods?: Record<string, string>;
  };
  /**
   * 她对直播间里的事做什么反应（可选）：事件名（见 triggers.ts）→ 表情名（clips.moods 或 image.moods 里的）。
   * 她没在说话的时候，礼物、上舰这些事一来先做个表情，再开口道谢。例：{ "gift.huge": "laugh", "membership": "shocked" }
   */
  reactions?: Record<string, string>;
}

/** 模板清单（templates/<id>/template.json）：只管布局、主题、放哪些挂件 */
export interface TemplateManifest {
  format: 1;
  id: string;
  name: string;
  /** 画布大小，OBS 浏览器源按这个尺寸设 */
  canvas: [number, number];
  /** CSS 变量：颜色、字体……挂件都读这些变量 */
  theme: Record<string, string>;
  /** 平时（聊天）的布局 */
  widgets: WidgetPlacement[];
  /**
   * 事件名（见 triggers.ts）→ 放哪些整屏特效（effects 挂件放；有哪些、怎么自己加见 effects.tsx）。
   * 不写用默认的一套；写了就整个换掉默认的；某个事件写 [] 就是什么都不放。
   */
  effects?: Record<string, EffectSpec[]>;
  /**
   * 同一个主题里的别的布局：舞台进入这种状态时挂件平滑挪到这里写的位置，结束了挪回来。
   * video：放视频的时候（video 挂件只在这里出现）。没写的挂件留在原处；hidden 的淡出。
   * game：她在直播里玩游戏的时候（game 挂件只在这里出现）；没写就借 video 布局，视频的位置给游戏画面。
   * 画布上还会加 ls-mode-<布局名> 这个 class，模板的 style.css 可以跟着换样式
   */
  layouts?: { video?: LayoutPlacement[]; game?: LayoutPlacement[] };
}

/** 布局里的一个挂件：按 type 对上平时布局里的同一个挂件（同类型有几个时按出现顺序） */
export interface LayoutPlacement extends Partial<WidgetPlacement> {
  type: WidgetType;
  /** 整体缩放（以左上角为原点），角色缩到角落用 */
  scale?: number;
  hidden?: boolean;
}

/** 一个特效：名字，或者名字加参数（ms 是放多久，其余参数看特效自己） */
export type EffectSpec = string | { name: string; ms?: number; [option: string]: unknown };

/**
 * reply：「她在回」卡片（她正在回应的那几位观众和他们说的话；热闹时那条弹幕早滚出弹幕列表了）
 * rice：她吃了多少饭（这场用掉的 token 换算成电、再换算成米饭）
 * terminal：终端，滚动显示身体和大脑在干什么（推了什么给她、她想了多久、用了多少 token）
 * scene：整屏的过场：开播前的等待画面、开场动画、下播谢幕（放在画布 0,0，宽高和画布一样）
 * video：放视频的画面（她在放视频时才有，放在 layouts.video 里）
 * game：她在玩的游戏的画面位（她在直播里玩游戏时才有）：网页画面直接放这里；游戏窗口由 OBS 抓来叠在这一块上
 * effects：整屏特效层：进场、礼物、上舰时放的彩带、横幅……（放在画布 0,0，宽高和画布一样，排在 scene 前面）
 */
export type WidgetType = 'character' | 'subtitle' | 'chat' | 'alerts' | 'status' | 'ai-label' | 'reply' | 'rice' | 'terminal' | 'scene' | 'video' | 'effects' | 'board' | 'game' | 'orders';

/** 点单栏的一行（见 core/orders） */
export interface StageOrder {
  id: number;
  who: string;
  text: string;
  state: 'queued' | 'doing' | 'done' | 'dropped';
}

/**
 * 游戏画面从哪来（dsh-game 给的，见 docs/game-live-contract.md）：
 * url 是一个网页，直接放在游戏位上；window 是 OBS 窗口捕获认窗口用的字符串（标题:窗口类:程序），
 * overlay 是叠在窗口上、一样大的透明网页（Minecraft 的血量、饱食度、快捷栏）
 */
export type GameSource = { url: string } | { window: string; overlay?: string };

/** 游戏画面上那一行「她在干嘛」 */
export interface GameStatus {
  /** 身体正在做的事（中文），没在做事时为空：她在想下一步 */
  doing: string;
  /** 这件事做了几秒 */
  seconds?: number;
  health?: number;
  /** 白天、夜晚、黄昏、清晨…… */
  time?: string;
}

export interface WidgetPlacement {
  type: WidgetType;
  /** 画布坐标（像素） */
  x: number;
  y: number;
  w?: number;
  h?: number;
  /** 挂件自己的参数 */
  options?: Record<string, unknown>;
}

/** 观众（舞台显示用，已清洗） */
export interface StageUser {
  id: string;
  name: string;
  face?: string;
  guard?: number;
  medal?: { name: string; level: number };
  admin?: boolean;
}

export type StageLiveEvent =
  | { kind: 'chat'; id: string; user: StageUser; text: string; sticker?: string }
  | { kind: 'gift'; id: string; user: StageUser; gift: string; count: number; yuan: number }
  | { kind: 'superchat'; id: string; user: StageUser; text: string; yuan: number }
  | { kind: 'membership'; id: string; user: StageUser; level: string; count: number }
  | { kind: 'enter' | 'follow'; id: string; user: StageUser };

/** 大脑现在在干什么：舞台上「正在想…」的提示用 */
export type BrainState = 'off' | 'listening' | 'thinking' | 'speaking' | 'away';

/** State reported by the browser that owns this sentence's audio. */
export type SpeechPlaybackState = 'ended' | 'failed' | 'cancelled' | 'timeout';

export type StageEvent =
  /** Per-connection identity for reports from a speaking browser source. */
  | { v: 1; type: 'playback-owner'; playbackId: string; at: number }
  /** Captions start only after the owner reports actual playback. */
  | { v: 1; type: 'subtitle'; state: 'started'; id: string; text: string; mood: string; estimateMs: number; timeline?: Array<{ chars: number; atMs: number }>; speaker?: string; elapsedMs: number; at: number }
  | { v: 1; type: 'subtitle'; state: SpeechPlaybackState; id: string; at: number }
  /** build：舞台页代码的版本（插件更新后变）；连上时先发 */
  | { v: 1; type: 'hello'; character: CharacterManifest; template: TemplateManifest; build?: string; at: number }
  /**
   * 她说一句话。timeline：逐字时间（音频里的毫秒 → 亮到第几个字），字幕按实际播放位置走；
   * 没有时（没语音、旧版身体）按 estimateMs 匀速走
   */
  | { v: 1; type: 'say'; id: string; text: string; mood: string; audio: string | null; audioMime?: 'audio/mpeg' | 'audio/wav'; timingSource?: 'estimated' | 'aligned'; estimateMs: number; timeline?: Array<{ chars: number; atMs: number }>; speaker?: string; at: number }
  | { v: 1; type: 'brain'; state: BrainState; detail?: string; at: number }
  /** 她调用了一个工具（终端里记一行「调用 工具名 对象」）；doing：提示符上显示她在干什么 */
  | { v: 1; type: 'tool'; name: string; detail: string; doing?: string; at: number }
  /** 终端里记一行身体自己在做的事（不是她调用的工具，比如后台听写视频）；不改她的状态 */
  | { v: 1; type: 'note'; tag: string; text: string; at: number }
  /** 告示板：主人想让观众知道的（空行分页，每页第一行是标题）；空串不显示 */
  | { v: 1; type: 'board'; text: string; at: number }
  | { v: 1; type: 'orders'; items: StageOrder[]; at: number }
  /** 滚动通知（主人在控制台写的，出状况时告诉观众）；空串收起 */
  | { v: 1; type: 'notice'; text: string; at: number }
  /** isUpdate：同 id 再来一次（礼物连击累加） */
  | { v: 1; type: 'live'; event: StageLiveEvent; isUpdate: boolean; at: number }
  /** 她正在回应这几位观众（弹幕流里高亮） */
  | { v: 1; type: 'focus'; userIds: string[]; at: number }
  | { v: 1; type: 'room'; online?: number; title?: string; onAir: boolean; at: number }
  /** 这场直播她用掉的 token（累计）；turn 是刚结束的这一步用的，model 是哪个模型 */
  | { v: 1; type: 'usage'; tokens: number; turn?: number; model?: string; at: number }
  /**
   * 放视频（她用 play_video）：舞台换成 video 布局，从 from 秒放到 until 秒；她说话时视频声音调小。
   * 中途连上的舞台从 from + (现在 - at) 接着放。stop：停下、换回平时的布局
   */
  | { v: 1; type: 'media'; action: 'play'; id: string; title: string; up: string; src: string; from: number; until: number; at: number }
  | { v: 1; type: 'media'; action: 'stop'; id: string; at: number }
  /** 她在直播里玩游戏：游戏画面上舞台（null：这局结束了） */
  | { v: 1; type: 'game'; source: GameSource | null; at: number }
  /** 游戏画面上那一行「她在干嘛」（身体在做的事、血量、白天黑夜）；null：没在玩 */
  | { v: 1; type: 'gameStatus'; status: GameStatus | null; at: number }
  /** 模板或角色换了：舞台重新加载 */
  | { v: 1; type: 'reload'; at: number };
