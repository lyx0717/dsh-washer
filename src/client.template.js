window.__ModuleLoader__.load({
  id: 'dsh-washer',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /* ------------------------------------------------------------------ *
     * 状态核心（构建时由 src/core.js 内联；纯函数，单测见 test/core.test.mjs）
     * ------------------------------------------------------------------ */
    /*__CORE__*/

    /* ------------------------------------------------------------------ *
     * 素材（构建时内联）
     * ------------------------------------------------------------------ */
    const SPRITE_SVG = __SPRITE__;
    const MACHINE_SVG = __MACHINE__;
    const CSS = __CSS__;

    const LOCALE_NS = 'washer';
    const ENTRY_ID = 'washer';

    const ZH = {
      'state.off': '未连接',
      'state.idle': '待机',
      'state.starting': '启动中',
      'state.washing': '洗涤中',
      'state.rinsing': '漂洗中',
      'state.spinning': '脱水中',
      'state.waiting': '等你确认',
      'state.draining': '排水换水中',
      'state.done': '洗完了',
      'state.error': '故障',
      'sub.off': '没有进行中的会话',
      'sub.idle': '滚筒停着，随时可以开工',
      'sub.idleLast': '上次洗完 {time}',
      'sub.starting': '正在起转 · {elapsed}',
      'sub.washing': '{elapsed} · 第 {n} 件',
      'sub.rinsing': '{tool} · {elapsed}',
      'sub.rinsingBare': '{elapsed}',
      'sub.spinning': '收尾整理 · {elapsed}',
      'sub.waiting': '有个地方要你拍板',
      'sub.draining': '上下文压缩中 · 第 {n} 件',
      'sub.done': '用时 {dur} · 共 {n} 件',
      'sub.error': '{code} · 点开看看',
      'label.washer': '洗衣机状态',
      'overlay.running': '浮窗模式 · 想看得更全请切回 dock',
      'label.skin': '外观',
      'skin.precision': '精密家电',
      'skin.anime': '动漫',
      'skin.pixel': '像素',
      'set.title': '洗衣机',
      'set.intro': 'Agent 干活时的状态指示。改完立即生效。',
      'set.nav': '洗衣机',
      'set.hideIdle': '空闲时隐藏',
      'set.restartHint': '档位和外观改完不用重启；成本需要先配好单价才会显示金额。',
      'set.overlay': '桌面悬浮窗',
      'set.overlayOn': '显示悬浮窗',
      'set.skinHint': '主界面和桌面悬浮窗共用这一套皮肤，改这里两边一起变。',
      'set.overlayHint': '开启后随客户端启动，在桌面角落显示一台洗衣机；关掉会立刻收起。',
      'set.overlaySize': '悬浮窗大小',
      'ov.normal': '正常',
      'ov.tiny': '极简',
      'set.overlaySizeHint': '「极简」只留指示灯，不显示状态文字，占桌面空间最小。',
      'set.overlayThrough': '鼠标穿透',
      'set.overlayThroughHint': '开启后点击直接落到底下的应用，悬浮窗不再接收鼠标；按 ⌥⌘W 可以随时关掉。',
      'err.e00.title': '出了点问题',
      'err.e00.hint': '原因不明，可以重试一次',
      'err.e10.title': '账号或服务不可用',
      'err.e10.hint': '检查登录状态和网络后重试',
      'err.e20.title': '工具有一步没跑成',
      'err.e21.title': '你拒绝了这一步',
      'err.e21.hint': '需要的话重新发一次，或放宽权限',
      'err.e30.title': '上下文塞满了',
      'err.e30.hint': '开新会话，或让它先压缩一下',
      'err.e40.title': '被中断了',
      'err.e40.hint': '不是故障，重新发一次就能续上',
      'err.e50.title': '被策略拦下了',
      'err.e50.hint': '这一步触发了限制，换个说法试试',
    };

    const EN = {
      'state.off': 'Offline',
      'state.idle': 'Idle',
      'state.starting': 'Starting',
      'state.washing': 'Thinking',
      'state.rinsing': 'Running tool',
      'state.spinning': 'Finishing',
      'state.waiting': 'Waiting on you',
      'state.draining': 'Compacting',
      'state.done': 'Done',
      'state.error': 'Failed',
      'sub.off': 'No active session',
      'sub.idle': 'Drum is still, ready when you are',
      'sub.idleLast': 'Last run {time}',
      'sub.starting': 'Spinning up · {elapsed}',
      'sub.washing': '{elapsed} · {n} pcs',
      'sub.rinsing': '{tool} · {elapsed}',
      'sub.rinsingBare': '{elapsed}',
      'sub.spinning': 'Wrapping up · {elapsed}',
      'sub.waiting': 'Something needs your call',
      'sub.draining': 'Compacting context · {n} pcs',
      'sub.done': 'Took {dur} · {n} pcs',
      'sub.error': '{code} · tap to inspect',
      'label.washer': 'Washer status',
      'overlay.running': 'Overlay mode - switch back to dock for full detail',
      'label.skin': 'Skin',
      'skin.precision': 'Precision',
      'skin.anime': 'Anime',
      'skin.pixel': 'Pixel',
      'set.title': 'Washer',
      'set.intro': 'Live status while the agent works. Changes take effect immediately.',
      'set.nav': 'Washer',
      'set.hideIdle': 'Hide when idle',
      'set.restartHint': 'Skin and size apply instantly; cost only shows once a unit price is configured.',
      'set.overlay': 'Desktop overlay',
      'set.overlayOn': 'Show overlay',
      'set.skinHint': 'One skin shared by the dock bar and the desktop overlay — change it once, both update.',
      'set.overlayHint': 'Starts with the app and shows a washer in the corner of your desktop. Turning it off removes it immediately.',
      'set.overlaySize': 'Overlay size',
      'ov.normal': 'Normal',
      'ov.tiny': 'Minimal',
      'set.overlaySizeHint': '"Minimal" keeps only the indicator light with no status text - the smallest footprint.',
      'set.overlayThrough': 'Click-through',
      'set.overlayThroughHint': 'Let clicks fall through to the app underneath. Press Opt+Cmd+W to turn it off.',
      'err.e00.title': 'Something went wrong',
      'err.e00.hint': 'Unknown cause - try again',
      'err.e10.title': 'Account or service unavailable',
      'err.e10.hint': 'Check your sign-in and network, then retry',
      'err.e20.title': 'A tool step failed',
      'err.e21.title': 'You declined that step',
      'err.e21.hint': 'Send it again, or loosen the permission',
      'err.e30.title': 'Context is full',
      'err.e30.hint': 'Start a new session, or let it compact first',
      'err.e40.title': 'Interrupted',
      'err.e40.hint': 'Not a failure - send it again to continue',
      'err.e50.title': 'Blocked by policy',
      'err.e50.hint': 'This step hit a limit - rephrase and retry',
    };

    /* 每状态：水位 / 转速 / 泡沫。机型自己的表，和文案解耦 */
    const PW_WATER = { off: 0, idle: 0, starting: 15, washing: 48, rinsing: 42, spinning: 18, waiting: 35, draining: 4, done: 0, error: 26 };
    const AW_WATER = { off: 2, idle: 4, starting: 10, washing: 34, rinsing: 30, spinning: 16, waiting: 26, draining: 6, done: 2, error: 20 };
    const SPEED = { off: '0s', idle: '0s', starting: '2.2s', washing: '1.7s', rinsing: '2.6s', spinning: '0.55s', waiting: '0s', draining: '3.4s', done: '0s', error: '0s' };
    const BUBBLE = { off: 0, idle: 0, starting: 0.2, washing: 1, rinsing: 0.5, spinning: 0, waiting: 0.25, draining: 0, done: 0, error: 0 };

    // 机型的自然尺寸（headless Chrome 实测，1:1 下的像素盒）。
    // h 必须把伸出机身的部件算进去：动漫风底脚在 bottom:-3%、电源线在 right:2%/bottom:6%，
    // 所以机身本身 246 之外还要再留 12；精密家电的底脚同理，397 之外留到 412。
    const NATURAL = {
      pixel: { w: 256, h: 312 },
      precision: { w: 330, h: 412 },
      anime: { w: 230, h: 258 },
    };

    /*
     * 停靠条里那台机器的显示宽度。和 .dw-sprite 的 32px 对齐——
     * 条高 52px，机器占 32×40，右边留文字。三套造型都缩到同一宽度，
     * 换皮肤时文字位置不会跟着跳。
     */
    const WASHER_STRIP_MACHINE_W = 32;

    const DEFAULT_CONFIG = {
      enabled: true,
      mode: 'dock',
      /*
       * 停靠条只有一种形态：不再有 S/M/L 三档，也不再点击展开。
       * size / expandedByDefault 是旧字段，留着只为兼容老 config 不报错，
       * 但已经没有任何代码读它们——渲染永远是 S 档停靠条。
       */
      /*
       * 默认皮肤。以前是 'auto'（按尺寸自动挑 pixel/anime），
       * 用户要求去掉"自动"选项——那就不能留个默认值让下拉里没有任何一项被选中。
       * 直接落成 pixel：停靠条本身就是像素 sprite，视觉最连贯。
       */
      skin: 'pixel',
      /*
       * 皮肤只有一份：主界面停靠条和桌面悬浮窗共用同一个 skin。
       *
       * 早先分成 skin（主界面）和 desktopOverlaySkin（浮窗）两个字段，
       * 结果是用户改了一个另一个不变，界面上两组"精密/动漫/像素"看着一模一样
       * 却各自独立，本身就是误导。现在合并成一份，浮窗启动参数也读这个字段。
       *
       * skinBySize 只保留 xs/lg 两档宽度：停靠条里的迷你 sprite 和
       * 悬浮窗/浮层用的大图。sm/md 是旧三档时代的产物，已无人使用。
       */
      skinBySize: { xs: 'pixel', lg: 'pixel' },
      costPerKToken: 0,
      costCurrency: 'CNY',
      hideWhenIdle: false,
      overlayOnlyWhenBusy: true,
      doneHoldMs: 6000,
      toolHistoryLimit: 6,
      // 桌面悬浮窗（Electron 壳）：靠 localStorage 持久化，
      // 宿主侧 apply() 读的是 cordis 配置，所以这里只负责"设置页能改、能同步给浮窗"
      //
      // desktopOverlay 必须在默认值里显式给出：设置页读的是 cfg.desktopOverlay === true，
      // 这个键一旦缺失就比较成 undefined，"未配置"和"用户关了"会显示成同一个样子。
      // 它同时决定宿主要不要拉起 Electron，默认必须是关——装了不看的人
      // 不该莫名多一个后台进程和端口。
      desktopOverlay: false,
      desktopOverlaySize: 'normal',
      /*
       * 鼠标穿透：开启后浮窗不再接收任何鼠标事件，点击直接落到底下的应用。
       * 以前这是浮窗上双击切换的，现在挪到设置页（理由见 OVERLAY_PREF_KEYS）。
       */
      desktopOverlayClickThrough: false,
    };

    /* ------------------------------------------------------------------ *
     * 纯工具
     * ------------------------------------------------------------------ */
    function mergeConfig(patch) {
      const out = {};
      Object.keys(DEFAULT_CONFIG).forEach((key) => { out[key] = DEFAULT_CONFIG[key]; });
      if (!patch || typeof patch !== 'object') return out;
      Object.keys(patch).forEach((key) => {
        if (patch[key] !== undefined) out[key] = patch[key];
      });
      if (patch.skinBySize && typeof patch.skinBySize === 'object') {
        out.skinBySize = Object.assign({}, DEFAULT_CONFIG.skinBySize, patch.skinBySize);
      }
      return out;
    }

    function fill(template, params) {
      if (typeof template !== 'string') return '';
      if (!params) return template;
      return template.replace(/\{(\w+)\}/g, (whole, key) => (
        params[key] === undefined || params[key] === null ? whole : String(params[key])
      ));
    }

    function formatClock(ts) {
      if (typeof ts !== 'number' || !Number.isFinite(ts)) return '';
      const d = new Date(ts);
      return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    }


    /**
     * 皮肤只有三个合法值。老配置里可能还留着 skin:'auto'，按 pixel 处理，
     * 免得渲染时拿到一个谁都不认识的字符串。
     */
    function pickSkin(cfg, bucket) {
      if (cfg.skin !== 'auto') return cfg.skin;
      const mapped = cfg.skinBySize ? cfg.skinBySize[bucket] : undefined;
      return mapped === 'precision' || mapped === 'anime' || mapped === 'pixel' ? mapped : 'pixel';
    }

    /**
     * 减弱动态效果：只跟随系统，不再提供设置项。
     *
     * 原先有个三态设置（始终/从不/跟随系统），但「从不」等于无视用户的
     * 无障碍设置，「始终」又让状态动效（滚筒、指示灯）也被冻住——它们本来
     * 是传达信息的手段，不是装饰。既然两头都会把人带沟里，就不该让用户选。
     *
     * 只读一次系统偏好：实时变化由 CSS 里各处的 @media 自己兜底。
     */
    function systemPrefersReducedMotion() {
      try {
        return typeof window !== 'undefined'
          && typeof window.matchMedia === 'function'
          && window.matchMedia('(prefers-reduced-motion: reduce)').matches === true;
      } catch (_error) {
        return false;
      }
    }

    function reduceMotionFlag() {
      return systemPrefersReducedMotion() ? '1' : '0';
    }

    /* ------------------------------------------------------------------ *
     * 机型
     * ------------------------------------------------------------------ */

    /* 32px 像素 sprite：水 / 泡沫 / LED 三个可动图层靠 CSS 变量驱动 */
    function PixelSprite(state) {
      const visual = VISUAL[state] || VISUAL.idle;
      const blink = visual.blink === 0.6 ? '1' : (visual.blink === 0.35 ? '2' : '0');
      return h('span', {
        className: 'dw-sprite dw-px',
        'data-blink': blink,
        'aria-hidden': 'true',
        style: {
          '--dw-water': String(visual.water),
          '--dw-foam': String(visual.foam),
          '--dw-led': visual.led,
        },
        dangerouslySetInnerHTML: { __html: SPRITE_SVG },
      });
    }

    /**
     * 停靠条里那台小机器：按皮肤选造型。
     *
     * 宽度固定 30px。'auto'（老配置残留）走 pickSkin 落到 pixel，
     * 不认识的值也一样——不能让停靠条因为一个脏字段变空白。
     */
    function MachineStrip(skin, state, screenTime) {
      const resolved = skin === 'precision' || skin === 'anime' || skin === 'pixel' ? skin : 'pixel';
      if (resolved === 'pixel') return PixelSprite(state);
      return BigMachine(resolved, state, WASHER_STRIP_MACHINE_W, screenTime);
    }

    /* 任意机型统一放进固定尺寸 + transform 缩放的框里：重排一次都不做 */
    function MachineFrame(skin, state, width, inner) {
      const natural = NATURAL[skin];
      const scale = width / natural.w;
      return h('div', {
        className: 'dw-frame',
        style: {
          width: Math.round(natural.w * scale) + 'px',
          height: Math.round(natural.h * scale) + 'px',
        },
        'aria-hidden': 'true',
      }, h('div', {
        className: 'dw-frame-inner',
        style: { width: natural.w + 'px', transform: 'scale(' + scale + ')' },
      }, inner));
    }

    function PixelMachine(state, width) {
      return MachineFrame('pixel', state, width,
        h('div', { dangerouslySetInnerHTML: { __html: MACHINE_SVG }, style: { lineHeight: 0 } }));
    }

    /* 精密家电：机身小屏只说机器自己的话（WASH / SPIN / ERR…），不重复 UI 文案 */
    const SCREEN_WORD = {
      off: 'OFF', idle: 'READY', starting: 'START', washing: 'WASH', rinsing: 'RINSE',
      spinning: 'SPIN', waiting: 'HOLD', draining: 'DRAIN', done: 'DONE', error: 'ERR',
    };

    function PrecisionMachine(state, width, screenTime) {
      const play = SPEED[state] === '0s' ? 'paused' : 'running';
      const water = PW_WATER[state];
      return MachineFrame('precision', state, width,
        h('div', {
          className: 'dw-pw',
          'data-state': state,
          style: {
            '--water-lvl': water + '%',
            '--bubble': String(BUBBLE[state]),
            '--speed': SPEED[state],
            '--play': play,
          },
        },
        h('div', { className: 'topbar' },
          h('div', { className: 'drawer' }),
          h('div', { className: 'knob' }),
          h('div', { className: 'led' })),
        h('div', { className: 'door' },
          h('div', { className: 'handle' }),
          h('div', { className: 'lock' }),
          h('div', { className: 'glass' },
            h('div', { className: 'drum' }),
            h('div', { className: 'clothes' }, h('i'), h('i'), h('i'), h('i')),
            h('div', { className: 'water' }),
            h('div', { className: 'bubbles' }, h('b'), h('b'), h('b'), h('b'), h('b'), h('b')))),
        h('div', { className: 'panel' },
          h('div', { className: 'row1' },
            h('span', { className: 'state-text' }, SCREEN_WORD[state] || 'READY'),
            h('span', { className: 'timer' }, screenTime)),
          h('div', { className: 'row2' },
            h('span', { className: 'wl' }, water + '%'),
            h('span', { className: 'bar' }, h('i')))),
        h('div', { className: 'feet' })));
    }

    function AnimeMachine(state, width, screenTime) {
      const play = SPEED[state] === '0s' ? 'paused' : 'running';
      // 表情（眼睛）曾经可开关，现在固定为关：在 32px 的停靠条里
      // 一双眼睛只占几个像素，看不出表情，反而让机器显得脏。
      const eyes = null;
      return MachineFrame('anime', state, width,
        h('div', {
          className: 'dw-aw',
          'data-state': state,
          'data-size': 'lg',

          style: {
            '--w': Math.round(NATURAL.anime.w) + 'px',
            '--speed': SPEED[state],
            '--play': play,
            '--water': AW_WATER[state] + '%',
            '--bubble': String(BUBBLE[state]),
          },
        },
        h('div', { className: 'dw-aw-body' }),
        h('div', { className: 'dw-aw-drawer' }),
        h('div', { className: 'dw-aw-knob' }),
        h('div', { className: 'dw-aw-screen' }, screenTime),
        h('div', { className: 'dw-aw-door' },
          h('div', { className: 'dw-aw-ring' }),
          h('div', { className: 'dw-aw-glass' },
            h('div', { className: 'dw-aw-drum' }),
            h('div', { className: 'dw-aw-clothes' }, h('i'), h('i'), h('i'), h('i')),
            h('div', { className: 'dw-aw-water' }),
            h('div', { className: 'dw-aw-foam' }),
            eyes),
          h('div', { className: 'dw-aw-handle' })),
        h('div', { className: 'dw-aw-filter' }),
        h('div', { className: 'dw-aw-feet' }, h('i'), h('i')),
        h('div', { className: 'dw-aw-cord' })));
    }

    function BigMachine(skin, state, width, screenTime) {
      if (skin === 'anime') return AnimeMachine(state, width, screenTime);
      if (skin === 'pixel') return PixelMachine(state, width);
      return PrecisionMachine(state, width, screenTime);
    }

    /* ------------------------------------------------------------------ *
     * 组件
     * ------------------------------------------------------------------ */
    /**
     * 订阅偏好变化并强制重渲染。
     *
     * 多个座位（dock / overlay / settings）各自持有 props.washerConfig 的快照，
     * 其中一处改了偏好，其它处必须跟着刷新——否则设置页切了皮肤，卡片还是旧的。
     */
    function usePrefRevision(props) {
      const [rev, setRev] = React.useState(0);
      React.useEffect(() => {
        const subscribe = props.washerSubscribePrefs;
        if (typeof subscribe !== 'function') return undefined;
        return subscribe(() => setRev((n) => n + 1));
      }, [props.washerSubscribePrefs]);
      return rev;
    }

    function WasherDock(props) {
      const { sessionId, useSession, useSessionStatus, useChat, useProjection } = props;
      // 'dock' = 常规座位（输入框下方）；'header' = 审批接管输入框时的替补座位。
      const variant = props.washerVariant === 'header' ? 'header' : 'dock';
      // useTrajectory 是宿主标准 prop，但只在 conversation 相关 slot 上稳定存在；
      // 拿不到时退回一个永远返回 undefined 的 hook（压缩态自动降级，不影响其它状态）。
      const useTrajectory = typeof props.useTrajectory === 'function'
        ? props.useTrajectory
        : () => undefined;
      const cfg = (typeof props.washerGetConfig === 'function' ? props.washerGetConfig() : props.washerConfig) || DEFAULT_CONFIG;
      // 订阅全局偏好：任何一处改了配置，这里跟着重渲染
      usePrefRevision(props);
      // 本地覆盖层：点完立刻见效，不等宿主把配置回传（避免一次往返的空档）
      const [prefPatch, setPrefPatch] = React.useState(null);
      const mergedCfg = prefPatch === null ? cfg : Object.assign({}, cfg, prefPatch);
      const setPref = React.useCallback((key, value) => {
        setPrefPatch((current) => Object.assign({}, current, { [key]: value }));
        if (typeof props.washerSetPref === 'function') props.washerSetPref(key, value);
      }, [props.washerSetPref]);
      // 注册 slot 时传了 locale: LOCALE_NS，渲染器给的 t 已是本命名空间内的裸 key
      const t = typeof props.t === 'function' ? props.t : (key) => key;
      const tr = (key) => t(key);

      const running = useSession((s) => s.running === true);
      const removed = useSession((s) => s.removed === true);
      const pending = useSessionStatus((status) => {
        if (sessionId === undefined || status === undefined) return undefined;
        const row = status.get(sessionId);
        return row === undefined ? undefined : row.pendingInteraction;
      });
      const runningCalls = useChat((s) => s.legacy.runningCalls);
      const partial = useChat((s) => s.legacy.partial);
      const nodes = useChat((s) => s.legacy.nodes);
      const turnTimings = useChat((s) => s.legacy.turnTimings);
      const outline = useProjection('turnOutline');
      // 上下文压缩的实时信号（chat nodes 里的 compaction 节点是压缩**落地后**才有的）
      const trajectory = useTrajectory((snapshot) => snapshot);

      const [, setTick] = React.useState(0);
      const [sticky, setSticky] = React.useState(null);
      const [shown, setShown] = React.useState(null);
      const prevRunning = React.useRef(running);
      const shownRef = React.useRef(null);

      const now = Date.now();
      const candidate = deriveState({
        sessionId, running, pending, runningCalls, partial, nodes, outline, trajectory, sticky, now,
      });

      /* 迟滞：washing ↔ rinsing 之间不抖，紧急态立即切 */
      React.useEffect(() => {
        const current = shownRef.current;
        if (current === null) {
          shownRef.current = { state: candidate, at: Date.now() };
          setShown(candidate);
          return undefined;
        }
        if (current.state === candidate) return undefined;
        const held = Date.now() - current.at;
        if (shouldSwitch(current.state, candidate, held)) {
          shownRef.current = { state: candidate, at: Date.now() };
          setShown(candidate);
          return undefined;
        }
        const id = setTimeout(() => {
          shownRef.current = { state: candidate, at: Date.now() };
          setShown(candidate);
        }, Math.max(0, 400 - held));
        return () => clearTimeout(id);
      }, [candidate]);

      /* running 由 true → false 且这一轮没有错误：进入 done 保持窗口 */
      React.useEffect(() => {
        if (running === true) {
          prevRunning.current = true;
          if (sticky !== null) setSticky(null);
          return;
        }
        if (prevRunning.current === true) {
          const turn = latestTurnOf(outline);
          if (findTurnError(nodes, turn) === undefined) {
            setSticky({ kind: 'done', turn, until: Date.now() + mergedCfg.doneHoldMs });
          }
        }
        prevRunning.current = false;
      }, [running, mergedCfg.doneHoldMs, outline, nodes, sticky]);

      /* 只有「在跑」或「done 保持窗口」才走 1s 心跳；闲着时零开销 */
      const needsClock = running === true || sticky !== null;
      React.useEffect(() => {
        if (!needsClock) return undefined;
        const id = setInterval(() => setTick((n) => n + 1), 1000);
        return () => clearInterval(id);
      }, [needsClock]);

      /* done 保持窗口到期后清掉 sticky */
      React.useEffect(() => {
        if (sticky === null) return undefined;
        const left = sticky.until - Date.now();
        if (left <= 0) { setSticky(null); return undefined; }
        const id = setTimeout(() => setSticky(null), left);
        return () => clearTimeout(id);
      }, [sticky]);

      // 根节点 ref：不再用于键盘处理（没有可收起的档位了），但保留它，
      // 供测试和宿主定位"这台洗衣机的 DOM 根"，也便于将来做点击穿透之类的判断。
      const washerRootRef = React.useRef(null);

      /*
       * 停靠条固定为一种形态，不再有展开档位。
       *
       * 这里曾经有三档（S 停靠条 / M 卡片 / L 大卡片+统计），点击循环、Esc 逐级退回。
       * 用户明确要求只保留小尺寸：一个显示"洗到哪了"的状态条，不需要点开看详情——
       * 详情该去悬浮窗右键菜单或详情面板看。于是 level 状态、cycle、
       * document 级 Esc 捕获、M/L 两档的整棵卡片 DOM 全部删除。
       */
      if (mergedCfg.enabled === false) return null;
      if (sessionId === undefined || sessionId === null || removed) return null;

      const state = shown === null ? candidate : shown;
      if (mergedCfg.hideWhenIdle === true && state === 'idle') return null;
      // 审批/提问会由宿主接管整个 composer（连同 composer.dock 一起 display:none），
      // 于是「等你确认」恰好在最该看见的时候消失。补救：header 座位只在 waiting 顶上来，
      // dock 座位在 waiting 主动让位，任何时刻只有一个实例在渲染。
      if (variant === 'header' && state !== 'waiting') return null;
      if (variant === 'dock' && state === 'waiting') return null;

      const turn = latestTurnOf(outline);
      const elapsed = elapsedOf(turnTimings, turn, now);
      const toolCount = toolCountOf(nodes, turn);
      const lastEnd = turnEndTimeOf(turnTimings, turn);
      const errorNode = findTurnError(nodes, turn) || findToolFailure(nodes, turn);
      const code = errorCodeOf(errorNode);
      const active = activeTool(runningCalls);
      const dur = formatDuration(elapsed);

      const title = tr('state.' + state);
      const toolName = active === undefined ? '' : active.name;

      const parts = { elapsed: dur, dur, n: String(toolCount), code, tool: toolName };
      let sub = tr('sub.' + state);
      if (state === 'idle') {
        sub = lastEnd === undefined ? tr('sub.idle') : fill(tr('sub.idleLast'), { time: formatClock(lastEnd) });
      } else if (state === 'rinsing' && toolName === '') {
        sub = fill(tr('sub.rinsingBare'), parts);
      } else if (state !== 'off' && state !== 'waiting') {
        sub = fill(tr('sub.' + state), parts);
      }

      const tone = state === 'error' ? 'error' : (state === 'waiting' ? 'warn' : (state === 'done' ? 'ok' : undefined));

      /*
       * 停靠条从 <button> 改成静态 <div>：它不再可点开，就不是可交互控件。
       * 继续用 button 会让读屏把它念成"可按下按钮"，键盘也会给它 tab 焦点，
       * 按下去却什么都不会发生——比不给焦点更让人困惑。
       * 状态信息改用 role="status" 传达，读屏会主动播报状态变化。
       */
      const strip = h('div', {
        className: 'dw-strip',
        role: 'status',
        'aria-label': tr('label.washer') + ': ' + title + ' · ' + sub,
        title: tr('label.washer') + ': ' + title + ' · ' + sub,
      },
      /*
       * 皮肤要真的生效。
       *
       * 删掉 M/L 展开卡时，这里跟着变成了写死的 PixelSprite——条上永远是像素小图，
       * 用户改设置页皮肤当然一点变化没有。三台机器本来都在（BigMachine 还在），
       * 只是没人调用它们了。
       *
       * 停靠条里机器只占 30px 宽，三套造型在这个尺寸下都还能认出来，
       * 所以按 skin 直接选；老配置里的 'auto' 由 pickSkin 兜底成 pixel。
       */
      /*
       * 三档自适应靠 CSS @media 窗口宽度查询（见 style.css，别用 @container——
       * 宿主父容器是 fit-content，容器查询会自激锁死在极简档）。
       * 这里只管把三份信息都吐出去，由宽度决定露多少：
       *   紧凑 —— 机器 + 状态 + 计时/件数（两行）
       *   迷你 —— 机器 + 状态 + 计时（一行）
       *   极简 —— 只留机器
       *
       * dw-dot 已删除：机器造型、水位、指示灯都在表达状态，
       * 再挂一颗圆点是同一件事说三遍，而且窄档位里它是最先该让位的。
       */
      MachineStrip(mergedCfg.skin, state, dur),
      h('span', { className: 'dw-text' },
        h('span', { className: 'dw-t1', 'data-tone': tone }, title),
        h('span', { className: 'dw-t2', 'data-hide': 'compact' }, sub)));

      return h('div', {
        className: 'dsh-washer',
        ref: washerRootRef,
        'data-state': state,
        'data-level': 'S',
        'data-variant': variant,
        'data-reduce-motion': reduceMotionFlag(),
      }, strip);
    }

    /* ------------------------------------------------------------------ *
     * 设置页（settings.section）
     *
     * 手编 cordis.patch.yml 不是普通用户能干的事，这里给一个真正的设置面板。
     * 写路径走 localStorage（不用 ctx.configForms 的原因见下方 apply 内注释），
     * 读路径 = 默认配置 ← 插件行 config ← localStorage 里的用户改动。
     * ------------------------------------------------------------------ */
    function WasherSettings(props) {
      const t = typeof props.t === 'function' ? props.t : (key) => key;
      const tr = (key) => t(key);
      const cfg = (typeof props.washerGetConfig === 'function' ? props.washerGetConfig() : props.washerConfig) || DEFAULT_CONFIG;
      usePrefRevision(props);
      const setPref = (key, value) => {
        if (typeof props.washerSetPref === 'function') props.washerSetPref(key, value);
      };

      /*
       * 一行 = 左（标题，必要时带说明）+ 右（控件）。
       * 这是宿主官方设置页的结构（ui-settings-general 的 DeveloperToolsRow）：
       * 行用 flex + space-between，标签占左边，控件贴右边。
       * 以前标签是普通 span 直接排在 div 里，没有 flex，所以全挤成一片。
       */
      const row = (labelKey, control) => h('div', { className: 'dw-set-row' },
        h('span', { className: 'dw-set-label' }, tr(labelKey)),
        h('span', { className: 'dw-set-control' }, control));

      /* 真正的 iOS 风格开关（role="switch"）。
         为什么不用分段按钮：设置页里一排小方块图形上还是"文字按钮"，用户要的是明确的开/关。
         轨道 + 滑块都用内联样式画，不依赖 className 命中——宿主的设置页容器会覆盖
         button 的 border/background（实测算出来 border 0px、透明背景），靠 class 样式不可靠。 */
      // 注意：设置页挂在 settings.section 里，**不在** .dsh-washer 范围内，
      // 所以拿不到插件自己的 --dw-* 变量（实测 --dw-run 算出空串）。而 var(--x, fallback)
      // 只在"变量无效"时回退，空串算"已定义"，于是整条背景色失效、开关变成透明方块。
      // 这里直接用宿主 token，并且不再套一层自家变量。
      /*
       * 选中态主色。原来用 state-business-primary（深蓝 #4176e6），
       * 和宿主设置页其它控件对不上——用户反馈"选择按钮得是黑色"。
       * 宿主自己的激活态（勾选框、页面 tab 下划线）用的是 label-primary，
       * 浅色主题下是 #0f1115（近黑），深色主题下自动翻成浅色。
       * 跟着它走就和整套设置页一致了。
       */
      const BRAND = 'var(--dsw-alias-label-primary)';
      const BRAND_FG = 'var(--dsw-alias-label-primary-inverted)';
      const LINE = 'var(--dsw-alias-border-l1)';
      const sw = (key, on, ariaLabel) => h('button', {
        key,
        type: 'button',
        role: 'switch',
        'aria-checked': on ? 'true' : 'false',
        'aria-label': ariaLabel,
        className: 'dw-switch',
        'data-on': on ? '1' : '0',
        style: {
          position: 'relative',
          display: 'inline-block',
          flex: '0 0 auto',
          width: '40px',
          height: '22px',
          padding: '0',
          border: '0',
          borderRadius: '11px',
          background: on ? BRAND : LINE,
          cursor: 'pointer',
          transition: 'background-color 0.18s ease',
          verticalAlign: 'middle',
        },
        onClick: () => setPref(key, !on),
      }, h('span', {
        'aria-hidden': 'true',
        style: {
          position: 'absolute',
          top: '2px',
          left: on ? '20px' : '2px',
          width: '18px',
          height: '18px',
          borderRadius: '50%',
          // 宿主自己的开关滑块色；写死 #fff 在深色主题下会突兀
          background: 'var(--dsw-alias-switch-thumb, #fff)',
          boxShadow: '0 1px 2px rgba(0,0,0,.28)',
          transition: 'left 0.18s cubic-bezier(.32,.72,0,1)',
        },
      }));

      /* 少数只能多选一的项（皮肤 / 初始档位）保留成"胶囊按钮"，
         同样内联样式，选中态用实心色块——跟开关拉开视觉层次。 */
      const seg = (groupLabel, options, current, onPick) => h('span', {
        className: 'dw-seg', role: 'group', 'aria-label': groupLabel,
        style: { display: 'inline-flex', gap: '4px', flexWrap: 'wrap' },
      }, options.map(([value, text]) => {
        const on = String(current) === String(value);
        return h('button', {
          key: groupLabel + '-' + value,
          type: 'button',
          className: 'dw-seg-btn',
          'data-on': on ? '1' : '0',
          'aria-pressed': on ? 'true' : 'false',
          style: {
            appearance: 'none',
            border: '1px solid ' + (on ? BRAND : LINE),
            background: on ? BRAND : 'transparent',
            // 选中态底色是黑（深色主题是白），字必须反着来，不能写死 #fff
            color: on ? BRAND_FG : 'var(--dsw-alias-label-secondary)',
            borderRadius: '999px',
            padding: '4px 11px',
            font: 'inherit',
            fontSize: '11px',
            lineHeight: '1.3',
            fontWeight: on ? '600' : '400',
            cursor: 'pointer',
            transition: 'background-color .14s ease, color .14s ease, border-color .14s ease',
          },
          onClick: () => onPick(value),
        }, text);
      }));

      return h('div', { className: 'dw-settings' },
        h('h3', { className: 'dw-set-title' }, tr('set.title')),
        h('p', { className: 'dw-set-intro' }, tr('set.intro')),

        row('set.hideIdle', sw('hideWhenIdle', cfg.hideWhenIdle === true, tr('set.hideIdle'))),

        row('label.skin', seg(tr('label.skin'), [
          ['precision', tr('skin.precision')],
          ['anime', tr('skin.anime')],
          ['pixel', tr('skin.pixel')],
        ], cfg.skin, (value) => setPref('skin', value))),
        h('p', { className: 'dw-set-hint' }, tr('set.skinHint')),

        h('h4', { className: 'dw-set-sub' }, tr('set.overlay')),
        h('p', { className: 'dw-set-hint' }, tr('set.overlayHint')),
        row('set.overlayOn', sw('desktopOverlay', cfg.desktopOverlay === true, tr('set.overlayOn'))),
        row('set.overlaySize', seg(tr('set.overlaySize'), [
          ['normal', tr('ov.normal')],
          ['tiny', tr('ov.tiny')],
        ], cfg.desktopOverlaySize === undefined ? 'normal' : cfg.desktopOverlaySize,
        (value) => setPref('desktopOverlaySize', value))),
        h('p', { className: 'dw-set-hint' }, tr('set.overlaySizeHint')),
        row('set.overlayThrough',
          sw('desktopOverlayClickThrough', cfg.desktopOverlayClickThrough === true, tr('set.overlayThrough'))),
        h('p', { className: 'dw-set-hint' }, tr('set.overlayThroughHint')),
        h('p', { className: 'dw-set-hint' }, tr('set.restartHint')));
    }

    /* ------------------------------------------------------------------ *
     * overlay 座位（mode:'overlay'）
     *
     * shell.overlay 是 frame 级浮层，拿不到 sessionId / useChat / useProjection
     * （标准 props 只有 useSessions + useSessionStatus），因此这里只做**最轻的一层**：
     *   - 从 useSessions 里找当前主视图会话（宿主 ui-layout 的官方写法）
     *   - 只读 running + pendingInteraction，只渲染一张停靠条
     * 想看完整卡片请用默认的 dock 模式。
     * ------------------------------------------------------------------ */
    function WasherOverlay(props) {
      const { useSessions, useSessionStatus } = props;
      const cfg = (typeof props.washerGetConfig === 'function' ? props.washerGetConfig() : props.washerConfig) || DEFAULT_CONFIG;
      usePrefRevision(props);
      const t = typeof props.t === 'function' ? props.t : (key) => key;
      const tr = (key) => t(key);

      // 与宿主 DocumentTitle 同一套取法：retainedBy.mainView > 0 的那个就是当前会话
      const sessionId = useSessions((state) => {
        const current = Object.values(state.byId).find((session) => (session.retainedBy.mainView ?? 0) > 0);
        return current === undefined ? undefined : current.id;
      });
      const running = useSessions((state) => {
        if (sessionId === undefined) return false;
        const row = state.byId[sessionId];
        return row !== undefined && row.running === true;
      });
      const pending = useSessionStatus((status) => {
        if (sessionId === undefined || status === undefined) return undefined;
        const row = status.get(sessionId);
        return row === undefined ? undefined : row.pendingInteraction;
      });

      const [, setTick] = React.useState(0);
      React.useEffect(() => {
        if (running !== true) return undefined;
        const id = setInterval(() => setTick((n) => n + 1), 1000);
        return () => clearInterval(id);
      }, [running]);

      if (cfg.enabled === false) return null;
      if (sessionId === undefined) return null;
      if (pending !== undefined) return null;           // 等你确认由 composer 区自己说
      // 浮层会盖住内容，空闲时不该出现。这是浮层独有的默认，
      // 不复用 hideWhenIdle（那个在 dock 下默认 false，语义相反）。
      if (running !== true && cfg.overlayOnlyWhenBusy !== false) return null;

      const state = 'washing';                           // 浮层不推导细分阶段，只表示「在忙」
      const title = tr('state.washing');
      const sub = tr('overlay.running');

      return h('div', {
        className: 'dsh-washer dw-overlay-root',
        'data-state': state,
        'data-level': 'S',
        'data-variant': 'overlay',
        'data-reduce-motion': reduceMotionFlag(),
      },
      h('button', {
        type: 'button',
        className: 'dw-strip',
        'aria-label': tr('label.washer') + ': ' + title + ' · ' + sub,
      },
      PixelSprite(state),
      h('span', { className: 'dw-text' },
        h('span', { className: 'dw-t1' }, title),
        h('span', { className: 'dw-t2' }, sub))));
    }

    /* ------------------------------------------------------------------ *
     * CSS：带 data-plugin / data-plugin-css 两个标记，卸载时由框架按归属清理
     * ------------------------------------------------------------------ */
    function ensureStyles() {
      if (typeof document === 'undefined') return;
      const tagId = 'dsh-washer/washer.css';
      if (document.querySelector('style[data-plugin-css="' + tagId + '"]') !== null) return;
      const tag = document.createElement('style');
      tag.dataset.plugin = 'dsh-washer';
      tag.dataset.pluginCss = tagId;
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    /* ------------------------------------------------------------------ *
     * 插件
     * ------------------------------------------------------------------ */
    return {
      name: 'dsh-washer',
      // 只要 slots 与 locale：配置改动存 localStorage，不再依赖 configForms。
      inject: ['slots', 'locale'],
      /**
       * 默认值清单。客户端合并配置的骨架就是它，
       * 测试也拿它钉「设置页能写的字段一个都不能漏」：
       * 漏了的字段在骨架里没有格子，设置页读出来就是 undefined，
       * "从没配过"和"用户亲手关了"就分不出来了。
       */
      __defaults: DEFAULT_CONFIG,
      apply(ctx, config) {
        const cfg = mergeConfig(config);
        ensureStyles();

        // ---------- 偏好持久化 ----------
        //
        // 为什么不用 ctx.configForms：那套 store 只服务挂在 loader `include` 行下的
        // 插件（dsh-config-editor 的 entries() 硬过滤 `fiber.entry?.id === "include"`）。
        // 第三方 bundle 走的是 `insert`，parent 不是 include，所以 describe 不会带
        // 上它，控制器永远停在 `status: 'unavailable'`——写进去也读不回来。
        // 同一路子 dsh-better-sidebar 也是绕开 configForms、自己存 localStorage。
        //
        // 语义：
        //   - 默认值 = cordis.patch.yml 的 config（由插件行传进来，mergeConfig 兜底）
        //   - 用户在设置页/卡片里改的值 → localStorage，覆盖默认值
        //   - 多个座位的组件共享同一份 pref，靠订阅同步
        const PREF_KEY = 'dsh-washer:prefs';
        const prefs = {};
        const prefListeners = new Set();
        const storage = (() => {
          try {
            if (typeof localStorage === 'undefined') return null;
            // 隐私模式 / 被禁用时 setItem 会抛，先探一次
            localStorage.setItem('dsh-washer:probe', '1');
            localStorage.removeItem('dsh-washer:probe');
            return localStorage;
          } catch { return null; }
        })();
        try {
          const raw = storage === null ? null : storage.getItem(PREF_KEY);
          if (raw) Object.assign(prefs, JSON.parse(raw) || {});
        } catch { /* 坏数据就当没有 */ }

        const notifyPrefs = () => { for (const fn of prefListeners) { try { fn(); } catch { /* noop */ } } };
        const liveConfig = () => mergeConfig(Object.assign({}, config, prefs));
        const writePref = (key, value) => {
          if (prefs[key] === value) return;
          prefs[key] = value;
          try { if (storage !== null) storage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch { /* 存不了也要让本次生效 */ }
          notifyPrefs();
          syncOverlayPrefs(key, value);
        };

        /*
         * 悬浮窗的三个偏好要额外告诉宿主一声。
         *
         * 为什么不能只写 localStorage：悬浮窗是独立的 Electron 进程，它的主进程
         * 读不到浏览器的 localStorage。宿主把值落进偏好文件，浮窗主进程 watch
         * 那个文件后自己改窗口大小/换造型——否则用户改完设置得重启宿主才生效，
         * 看起来就是"设置改了没反应"。
         *
         * 失败不打扰用户：设置本身已经在 localStorage 里生效了，只是浮窗要等下次启动。
         */
        /*
         * 只有两项往返同步：显不显示、浮窗大小。
         *
         * 皮肤曾经也在这里（desktopOverlaySkin ↔ skin），合并成单一 skin 后
         * 它仍然要同步，但走的不是这条通道——skin 是本地偏好，改它时
         * writePref 会额外把值推给宿主，见下方 syncSkinToOverlay。
         */
        const OVERLAY_PREF_KEYS = {
          desktopOverlay: 'show',
          desktopOverlaySize: 'size',
          /*
           * 鼠标穿透从浮窗的双击挪到设置页。
           * 双击进穿透原本是浮窗上唯一的鼠标入口，但用户要求"整个机器都能拖"——
           * Chromium 的拖拽区（-webkit-app-region: drag）会吞掉 dblclick，
           * 两者不能共存。于是拖拽优先，穿透改由设置页开关控制。
           */
          desktopOverlayClickThrough: 'clickThrough',
          /*
           * skin 现在同时是主界面皮肤和浮窗造型，所以改它必须推一份给宿主，
           * 否则浮窗要等下次重启才换。反方向由 SSE 回灌（见 applyRemotePrefs）。
           */
          skin: 'skin',
        };
        /** 宿主用 ctx.webServer 注册的同源路由，页面直接相对路径请求即可。 */
        const OVERLAY_PREFS_PATH = '/dsh-washer/prefs';
        /*
         * 注意：这里必须用**同源相对路径**。
         *
         * 之前写成 props.washerEndpoint().url + 拼 token —— 那个注入项在客户端
         * 插件里根本不存在，首行就 return，POST 一次都没发出去，功能看着写了
         * 实际静默不工作。宿主那边已经用 ctx.webServer 注册了同源路由
         * /dsh-washer/prefs，页面和它是同一个 origin，直接相对路径打过去即可：
         * 不用端口、不用 token、不受 connect-src 的 CSP 限制。
         */
        const syncOverlayPrefs = (key, value) => {
          const field = OVERLAY_PREF_KEYS[key];
          if (field === undefined) return;
          try {
            fetch(OVERLAY_PREFS_PATH, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ [field]: value }),
            }).catch(() => { /* 宿主没接这条路就算了，不影响设置本身 */ });
          } catch { /* 同上 */ }
        };
        // 组件一律通过 washerGetConfig() 现取，而不是吃 inject 给的快照：
        // inject 回调只在注册时跑一次，重渲染不会重新求值。
        const subscribePrefs = (fn) => {
          prefListeners.add(fn);
          return () => { prefListeners.delete(fn); };
        };

        /*
         * ---------------- 悬浮窗偏好：反方向同步 ----------------
         *
         * 到此为止全是「设置页 → 悬浮窗」：页面写 localStorage，再 POST 给宿主，
         * 宿主落文件，Electron 主进程 watch 文件改窗口。
         *
         * 缺的一半是反过来的：用户在悬浮窗右键菜单里换造型/切极简，
         * 那个改动只到 Electron 主进程和偏好文件。设置页读的是 localStorage，
         * **没有任何东西告诉它变了**——于是两边长期不一致，要手动刷新页面
         * 才"看起来"同步上。
         *
         * 现在补上：
         *   1) 打开设置页时先从宿主拉一次当前值（偏好文件才是真相源，
         *      localStorage 只是缓存，它不知道右键菜单里改过什么）
         *   2) 长连 SSE，宿主只要推过来就合并进 prefs 并重渲染
         */
        const OVERLAY_PREFS_EVENTS_PATH = '/dsh-washer/prefs/events';

        /**
         * 把宿主给的字段并进本地 prefs。
         *
         * 只认认识的字段、只做覆盖不删除：宿主那边少了某个 key 不代表
         * 用户要清空它，多半只是从没写过。返回值表示到底有没有变化，
         * 没变化就不重渲染，免得 SSE 心跳把整页刷一遍。
         */
        const applyRemotePrefs = (remote) => {
          if (remote === null || typeof remote !== 'object') return;
          // skin 从浮窗菜单改也要回灌到主界面皮肤，所以反向映射保留 skin → skin
          const REVERSE = {
            show: 'desktopOverlay', size: 'desktopOverlaySize', skin: 'skin',
            clickThrough: 'desktopOverlayClickThrough',
          };
          let changed = false;
          for (const field of Object.keys(REVERSE)) {
            if (remote[field] === undefined) continue;
            const key = REVERSE[field];
            let value = remote[field];
            // 本地字段名和文件字段名眼瞅着一样，但类型不同：
            // 文件里 size 是 'tiny'/'normal'，页面里是 desktopOverlaySize
            if ((key === 'desktopOverlay' || key === 'desktopOverlayClickThrough') && typeof value !== 'boolean') continue;
            if (prefs[key] === value) continue;
            prefs[key] = value;
            changed = true;
          }
          if (!changed) return;
          try { if (storage !== null) storage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch { /* 存不了也要让本次生效 */ }
          notifyPrefs();
        };

        /** 拉一次当前值。失败静默——宿主没起时页面照样能用旧的 localStorage 值。 */
        const pullOverlayPrefs = () => {
          try {
            fetch(OVERLAY_PREFS_PATH, { headers: { accept: 'application/json' } })
              .then((r) => (r.ok ? r.json() : null))
              .then((data) => applyRemotePrefs(data))
              .catch(() => { /* 宿主没接这条路就算了 */ });
          } catch { /* 同上 */ }
        };

        /*
         * 长连 SSE。EventSource 断线会自己重连（默认 3 秒左右），
         * 所以不用写重试逻辑；页面关掉时 EventSource 随文档销毁。
         *
         * 为什么不用 WebSocket：那是给 Electron 用的、带 token 的端口，
         * 页面这边同源 HTTP 就够，还不用碰 CSP 的 connect-src 名单。
         */
        let prefEvents = null;
        const startPrefEvents = () => {
          if (prefEvents !== null) return;
          if (typeof EventSource === 'undefined') {
            // 极老的浏览器没有 EventSource：退化成只拉一次，至少打开时不显示旧值
            pullOverlayPrefs();
            return;
          }
          try {
            prefEvents = new EventSource(OVERLAY_PREFS_EVENTS_PATH);
          } catch {
            prefEvents = null;
            return;
          }
          prefEvents.addEventListener('message', (event) => {
            try { applyRemotePrefs(JSON.parse(event.data)); } catch { /* 坏帧跳过，等下一帧 */ }
          });
          // error 事件里不用做任何事：EventSource 自己会重连。
          // 真正断网时它会一直重试，这正是想要的——用户切回来就自动恢复。
        };

        ctx.effect(() => {
          pullOverlayPrefs();
          startPrefEvents();
          return () => {
            if (prefEvents !== null) { try { prefEvents.close(); } catch { /* noop */ } prefEvents = null; }
          };
        }, 'dsh-washer: overlay prefs sync');

        // 测试用把手：拉取发生在 apply() 里，比任何用例都早，而且前面几条
        // 推送用例会把 fetch 记录清空——想断言"打开时会拉一次"就没法看全程了。
        // 暴露出来让测试能开一个明确的观察窗口。
        if (typeof globalThis === 'object' && globalThis !== null) {
          globalThis.__pullOverlayPrefs = pullOverlayPrefs;
        }

        // 同一命名空间重复注册同语言会抛错（HMR / 重复挂载），逐个容错
        ctx.effect(() => {
          const disposers = [];
          for (const [locale, dict] of [['zh', ZH], ['en', EN]]) {
            try {
              disposers.push(ctx.locale.register(LOCALE_NS, locale, dict));
            } catch (error) {
              console.warn('[dsh-washer] locale register skipped:', locale, error);
            }
          }
          return () => { disposers.forEach((off) => { try { off(); } catch { /* noop */ } }); };
        }, 'dsh-washer: locale dictionaries');

        if (cfg.enabled === false) return;

        // 设置页：不管 dock / overlay 都要有入口
        const offSettings = ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'washer',
          order: 80,
          label: (typeof ctx.locale.bind === 'function' ? (ctx.locale.bind(LOCALE_NS)('set.nav')) : '洗衣机'),
          locale: LOCALE_NS,
          registrant: 'dsh-washer',
          inject: () => ({ washerGetConfig: liveConfig, washerSetPref: writePref, washerSubscribePrefs: subscribePrefs }),
        }, WasherSettings));
        ctx.effect(() => () => {
          try { offSettings(); } catch { /* noop */ }
        }, 'dsh-washer: settings section');

        // mode:'overlay' → 改用 frame 级浮层，不占用输入框位置。
        if (cfg.mode === 'overlay') {
          const offOverlay = ctx.slots.inject('shell.overlay', () => ctx.slots.register({
            name: 'shell.overlay',
            id: ENTRY_ID,
            order: 40,
            locale: LOCALE_NS,
            registrant: 'dsh-washer',
            inject: () => ({ washerGetConfig: liveConfig, washerSubscribePrefs: subscribePrefs }),
          }, WasherOverlay));
          ctx.effect(() => () => {
            try { offOverlay(); } catch { /* noop */ }
          }, 'dsh-washer: overlay occupant');
          return;
        }

        // 主座位：composer.dock 紧贴输入框，是默认位置。
        const slotName = 'conversation.composer.dock';
        const offDock = ctx.slots.inject(slotName, () => ctx.slots.register({
          name: slotName,
          id: ENTRY_ID,
          order: 10,
          locale: LOCALE_NS,
          registrant: 'dsh-washer',
          inject: () => ({ washerGetConfig: liveConfig, washerVariant: 'dock', washerSetPref: writePref, washerSubscribePrefs: subscribePrefs }),
        }, WasherDock));

        // 替补座位：审批/提问时宿主接管整个 composer，dock 会随之 display:none。
        // header 座位在同一时刻顶上来，保证「等你确认」这一格永远看得见。
        const offHeader = ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
          name: 'conversation.session.header.utilities',
          id: ENTRY_ID + '-waiting',
          order: 60,
          locale: LOCALE_NS,
          registrant: 'dsh-washer',
          inject: () => ({ washerGetConfig: liveConfig, washerVariant: 'header', washerSubscribePrefs: subscribePrefs }),
        }, WasherDock));

        ctx.effect(() => () => {
          try { offHeader(); } catch { /* noop */ }
          try { offDock(); } catch { /* noop */ }
        }, 'dsh-washer: slot occupants');
      },
    };
  },
});
