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
      'label.tools': '工具',
      'label.tokens': 'Token',
      'label.turns': '轮次',
      'label.cost': '成本',
      'label.expand': '展开明细',
      'label.collapse': '收起',
      'label.washer': '洗衣机状态',
      'overlay.running': '浮窗模式 · 想看得更全请切回 dock',
      'label.skin': '外观',
      'skin.auto': '跟随尺寸',
      'skin.precision': '精密家电',
      'skin.anime': '动漫',
      'skin.pixel': '像素',
      'label.face': '表情',
      'face.on': '开',
      'face.off': '关',
      'label.skinHint': '「跟随尺寸」= 小尺寸像素、中尺寸精密、大尺寸动漫',
      'set.title': '洗衣机',
      'set.intro': 'Agent 干活时的状态指示。改完立即生效。',
      'set.nav': '洗衣机',
      'set.cost': '显示成本',
      'set.hideIdle': '空闲时隐藏',
      'set.size': '默认档位',
      'set.restartHint': '档位和外观改完不用重启；成本需要先配好单价才会显示金额。',
      'set.reduceMotion': '减少动态效果',
      'reduce.auto': '跟随系统',
      'reduce.always': '始终减弱',
      'reduce.never': '不减弱',
      'label.reduceMotionHint': '「跟随系统」由系统辅助功能开关决定；减弱只停滚筒、衣物、气泡这类装饰运动，指示灯和水位照常变化——它们表示状态。',
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
      'label.noTools': '这轮还没有工具调用',
      'foot': '状态全部由宿主事件推导，不猜测',
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
      'label.tools': 'Tools',
      'label.tokens': 'Tokens',
      'label.turns': 'Turns',
      'label.cost': 'Cost',
      'label.expand': 'Show details',
      'label.collapse': 'Collapse',
      'label.washer': 'Washer status',
      'overlay.running': 'Overlay mode - switch back to dock for full detail',
      'label.skin': 'Skin',
      'skin.auto': 'By size',
      'skin.precision': 'Precision',
      'skin.anime': 'Anime',
      'skin.pixel': 'Pixel',
      'label.face': 'Face',
      'face.on': 'On',
      'face.off': 'Off',
      'label.skinHint': '"By size" = pixel when small, precision when medium, anime when large',
      'set.title': 'Washer',
      'set.intro': 'Live status while the agent works. Changes take effect immediately.',
      'set.nav': 'Washer',
      'set.cost': 'Show cost',
      'set.hideIdle': 'Hide when idle',
      'set.size': 'Default size',
      'set.restartHint': 'Skin and size apply instantly; cost only shows once a unit price is configured.',
      'set.reduceMotion': 'Reduced motion',
      'reduce.auto': 'Follow system',
      'reduce.always': 'Always reduce',
      'reduce.never': 'Never reduce',
      'label.reduceMotionHint': '"Follow system" respects your OS accessibility setting. Reducing stops only decorative motion (drum, clothes, bubbles); status indicators keep animating.',
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
      'label.noTools': 'No tool calls this turn',
      'foot': 'Every state is derived from host events, never guessed',
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

    const DEFAULT_CONFIG = {
      enabled: true,
      mode: 'dock',
      size: 'S',
      expandedByDefault: false,
      skin: 'auto',
      skinBySize: { xs: 'pixel', sm: 'precision', md: 'precision', lg: 'anime' },
      face: false,
      reduceMotion: 'auto',
      showCost: false,
      costPerKToken: 0,
      costCurrency: 'CNY',
      hideWhenIdle: false,
      overlayOnlyWhenBusy: true,
      doneHoldMs: 6000,
      toolHistoryLimit: 6,
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

    function formatCost(tokens, cfg) {
      const rate = cfg.costPerKToken;
      if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) return '';
      if (typeof tokens !== 'number' || !Number.isFinite(tokens) || tokens <= 0) return '';
      const value = (tokens / 1000) * rate;
      const digits = value >= 1 ? 2 : 3;
      return (cfg.costCurrency === 'USD' ? '$' : '¥') + value.toFixed(digits);
    }

    function pickSkin(cfg, bucket) {
      if (cfg.skin !== 'auto') return cfg.skin;
      const mapped = cfg.skinBySize ? cfg.skinBySize[bucket] : undefined;
      return mapped === 'precision' || mapped === 'anime' || mapped === 'pixel' ? mapped : 'pixel';
    }

    /**
     * reduceMotion 三态：
     *   'always' 强制减弱（用户手动关动画）
     *   'never'  强制不减弱（哪怕系统开着）
     *   'auto'   跟随系统 —— 之前这里直接 return '0'，等于把系统开关当空气
     *
     * 只读一次系统偏好即可，不需要挂 matchMedia 变更监听：
     * 系统的实时变化由 CSS 的 @media 自己兜底，这里只负责配置态的初值。
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

    function reduceMotionFlag(cfg) {
      if (cfg.reduceMotion === 'always') return '1';
      if (cfg.reduceMotion === 'never') return '0';
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

    function AnimeMachine(state, width, face, screenTime) {
      const play = SPEED[state] === '0s' ? 'paused' : 'running';
      const eyes = face ? h('div', { className: 'dw-aw-eyes' }, h('i'), h('i')) : null;
      return MachineFrame('anime', state, width,
        h('div', {
          className: 'dw-aw',
          'data-state': state,
          'data-size': 'lg',
          'data-face': face ? 'on' : 'off',
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

    function BigMachine(skin, state, width, face, screenTime) {
      if (skin === 'anime') return AnimeMachine(state, width, face, screenTime);
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
      const tokenUsage = useProjection('tokenUsage');
      const sessionStats = useProjection('sessionStats');
      // 上下文压缩的实时信号（chat nodes 里的 compaction 节点是压缩**落地后**才有的）
      const trajectory = useTrajectory((snapshot) => snapshot);

      // size 决定挂载档位；expandedByDefault 是兼容别名（等价 size:'M'）
      const [level, setLevel] = React.useState(
        mergedCfg.size === 'L' ? 'L' : (mergedCfg.size === 'M' || mergedCfg.expandedByDefault === true ? 'M' : 'S'),
      );
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

      const cycle = React.useCallback(() => {
        setLevel((current) => (current === 'S' ? 'M' : current === 'M' ? 'L' : 'S'));
      }, []);
      /**
       * Esc 逐级退回：L → M → S。
       *
       * 为什么用 document 级监听而不是根节点的 onKeyDown：
       * React 的 onKeyDown 是合成事件、走冒泡，只有「焦点就在洗衣机的子孙节点里」
       * 才会触发。而用户在 M/L 档看着卡片时，焦点多半还停在输入框或页面别处，
       * 此时在根节点上挂 onKeyDown 根本收不到事件——表现为「按 Esc 没反应」。
       *
       * 这里用 document 捕获阶段监听，覆盖两条路径：
       *   1. 焦点在洗衣机子树里 → 拦下 Esc，逐级退回（焦点可能已不在根节点上，
       *      比如用户点了卡片里的皮肤按钮，React 委托处理器同样会漏）；
       *   2. 焦点不在洗衣机里   → 交给宿主，输入框自己处理 Esc（取消生成等）。
       */
      const washerRootRef = React.useRef(null);

      React.useEffect(() => {
        if (level === 'S') return undefined;
        const onDocKeyDown = (event) => {
          if (event.key !== 'Escape' || event.isComposing || event.defaultPrevented) return;
          const root = washerRootRef.current;
          if (root === null || !root.isConnected) return;
          const active = typeof document === 'undefined' ? null : document.activeElement;
          const focusInside = active !== null && active !== undefined && root.contains(active);
          // 焦点不在洗衣机里：不拦，让输入框等宿主控件自己消化 Esc
          if (!focusInside) return;
          event.preventDefault();
          event.stopPropagation();
          setLevel((current) => (current === 'L' ? 'M' : 'S'));
        };
        document.addEventListener('keydown', onDocKeyDown, true);
        return () => document.removeEventListener('keydown', onDocKeyDown, true);
      }, [level]);

      const onKeyDown = React.useCallback((event) => {
        if (event.key === 'Escape' && level !== 'S') {
          event.stopPropagation();
          setLevel((current) => (current === 'L' ? 'M' : 'S'));
        }
      }, [level]);

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
      const tools = recentTools(nodes, mergedCfg.toolHistoryLimit);
      const lastEnd = turnEndTimeOf(turnTimings, turn);
      const errorNode = findTurnError(nodes, turn) || findToolFailure(nodes, turn);
      const code = errorCodeOf(errorNode);
      // 错误码本身对用户没信息量，翻译成「发生了什么 + 怎么办」
      const errText = state === 'error' ? explainError(code) : null;
      const active = activeTool(runningCalls);
      const tokens = tokenUsage
        ? (Number(tokenUsage.uncachedInputTokens) || 0) + (Number(tokenUsage.cacheReadTokens) || 0)
          + (Number(tokenUsage.cacheWriteTokens) || 0) + (Number(tokenUsage.outputTokens) || 0)
        : 0;
      const cost = mergedCfg.showCost === true ? formatCost(tokens, cfg) : '';
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

      const strip = h('button', {
        type: 'button',
        className: 'dw-strip',
        onClick: cycle,
        'aria-expanded': level === 'S' ? 'false' : 'true',
        'aria-label': tr('label.washer') + ': ' + title + ' · ' + sub,
        title: level === 'S' ? tr('label.expand') : tr('label.collapse'),
      },
      PixelSprite(state),
      h('span', { className: 'dw-text' },
        h('span', { className: 'dw-t1', 'data-tone': tone }, title),
        h('span', { className: 'dw-t2' }, sub)),
      h('span', { className: 'dw-dot' }));

      if (level === 'S') {
        return h('div', {
          className: 'dsh-washer',
          ref: washerRootRef,
          'data-state': state,
          'data-level': 'S',
          'data-variant': variant,
          'data-reduce-motion': reduceMotionFlag(cfg),
          onKeyDown,
        }, strip);
      }

      const bucket = level === 'M' ? 'sm' : 'lg';
      const skin = pickSkin(cfg, bucket);
      const machineWidth = level === 'M' ? 96 : 176;
      const screenTime = state === 'idle' || state === 'off' ? '--:--' : dur;

      const toolRows = tools.length === 0
        ? [h('div', { className: 'dw-empty', key: 'empty' }, tr('label.noTools'))]
        : tools.map((item, index) => h('div', { className: 'dw-tool', key: 'tool-' + index },
          h('span', { className: 'dw-tool-mark', 'data-error': item.isError ? '1' : '0' }),
          h('span', { className: 'dw-tool-name' }, item.name),
          h('span', { className: 'dw-tool-dur' }, item.ms === undefined ? '' : formatToolMs(item.ms))));

      // 外观切换：直接改 store，立刻生效（不用手编 cordis.patch.yml）
      const skinNow = pickSkin(cfg, level === 'M' ? 'sm' : 'lg');
      const skinOptions = [
        ['auto', tr('skin.auto')],
        ['precision', tr('skin.precision')],
        ['anime', tr('skin.anime')],
        ['pixel', tr('skin.pixel')],
      ];
      const skinRow = h('div', { className: 'dw-skinrow' },
        h('span', { className: 'dw-skinrow-label' }, tr('label.skin')),
        h('span', { className: 'dw-seg', role: 'group', 'aria-label': tr('label.skin') },
          skinOptions.map(([value, text]) => h('button', {
            key: 'skin-' + value,
            type: 'button',
            className: 'dw-seg-btn',
            'data-on': (mergedCfg.skin === value ? '1' : '0'),
            onClick: (event) => {
              event.stopPropagation();
              setPref('skin', value);
            },
          }, text))),
        h('span', { className: 'dw-skinrow-label' }, tr('label.face')),
        h('span', { className: 'dw-seg', role: 'group', 'aria-label': tr('label.face') },
          [['on', tr('face.on')], ['off', tr('face.off')]].map(([value, text]) => h('button', {
            key: 'face-' + value,
            type: 'button',
            className: 'dw-seg-btn',
            'data-on': ((mergedCfg.face === true ? 'on' : 'off') === value ? '1' : '0'),
            onClick: (event) => {
              event.stopPropagation();
              setPref('face', value === 'on');
            },
          }, text))));

      const stats = [
        h('span', { key: 'tools' }, tr('label.tools') + ' ', h('b', {}, String(toolCount))),
        h('span', { key: 'tokens' }, tr('label.tokens') + ' ', h('b', {}, formatTokens(tokens))),
      ];
      if (sessionStats && typeof sessionStats.turns === 'number') {
        stats.push(h('span', { key: 'turns' }, tr('label.turns') + ' ', h('b', {}, String(sessionStats.turns))));
      }
      if (cost !== '') {
        stats.push(h('span', { key: 'cost' }, tr('label.cost') + ' ', h('b', {}, cost)));
      }

      let badgeText = '';
      if (state === 'error') badgeText = code;
      else if (state === 'idle') badgeText = lastEnd === undefined ? '' : formatClock(lastEnd);
      else if (state === 'off') badgeText = '';
      else badgeText = dur;
      const badgeTone = state === 'error' ? 'error' : undefined;

      // 卡片头的折叠按钮：点标题区在 M ⇄ L 之间切换，L 档再点就收起回 S。
      // 为什么不在整张卡片上挂 onClick：卡片里已经有皮肤分段控件和自己的按钮，
      // 外层再监听点击会让"点控件"同时触发折叠（得靠每个子按钮 stopPropagation 兜底，
      // 漏一个就是 bug）。用显式按钮最稳，也让键盘/读屏能直接摸到。
      // 收起键在任何档位都直接回 S。之前 M 档点它是「展开到 L」，
      // 于是 M 档既没有收起入口、连按 Esc 也只是退回 M，用户会以为按钮坏了。
      const headToggle = h('button', {
        type: 'button',
        className: 'dw-fold',
        onClick: (event) => {
          event.stopPropagation();
          setLevel('S');
        },
        'aria-expanded': 'true',
        'aria-label': tr('label.collapse'),
        title: tr('label.collapse'),
      }, h('span', { className: 'dw-fold-icon', 'aria-hidden': 'true' }, '⌄'));

      return h('div', {
        className: 'dsh-washer',
        ref: washerRootRef,
        'data-state': state,
        'data-level': level,
        'data-variant': variant,
        'data-reduce-motion': reduceMotionFlag(cfg),
        onKeyDown,
      },
      // 三档互斥：S 只显示停靠条，M/L 只显示卡片（同屏出现两个「待机」是明显的错）
      level === 'S' ? strip : h('div', { className: 'dw-card' },
        h('div', { className: 'dw-card-head' },
          h('div', { className: 'dw-machine' }, BigMachine(skin, state, machineWidth, mergedCfg.face === true, screenTime)),
          h('div', { className: 'dw-meta' },
            h('span', { className: 'dw-meta-title', 'data-tone': tone }, title),
            h('span', { className: 'dw-meta-sub', 'data-tone': tone }, sub)),
          badgeText === '' ? null : h('span', { className: 'dw-badge', 'data-tone': badgeTone }, badgeText)),
        errText === null ? null : h('div', { className: 'dw-err' },
          h('span', { className: 'dw-err-code' }, code),
          h('span', { className: 'dw-err-title' }, tr(errText.title)),
          h('span', { className: 'dw-err-hint' }, tr(errText.hint))),
        h('div', { className: 'dw-tools' }, toolRows),
        level === 'L' ? h('div', { className: 'dw-stats' }, stats) : null,
        level === 'L' ? skinRow : null,
        level === 'L' ? h('div', { className: 'dw-foot' }, tr('foot')) : null,
        h('div', { className: 'dw-footbar' }, headToggle)));
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
      const BRAND = 'var(--dsw-alias-state-business-primary)';
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
          background: '#fff',
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
            color: on ? '#fff' : 'var(--dsw-alias-label-secondary)',
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

        row('label.face', sw('face', cfg.face === true, tr('label.face'))),
        row('set.cost', sw('showCost', cfg.showCost === true, tr('set.cost'))),
        row('set.hideIdle', sw('hideWhenIdle', cfg.hideWhenIdle === true, tr('set.hideIdle'))),

        row('label.skin', seg(tr('label.skin'), [
          ['auto', tr('skin.auto')],
          ['precision', tr('skin.precision')],
          ['anime', tr('skin.anime')],
          ['pixel', tr('skin.pixel')],
        ], cfg.skin, (value) => setPref('skin', value))),
        h('p', { className: 'dw-set-hint' }, tr('label.skinHint')),

        row('set.size', seg(tr('set.size'), [
          ['S', 'S'], ['M', 'M'], ['L', 'L'],
        ], cfg.size, (value) => setPref('size', value))),

        row('set.reduceMotion', seg(tr('set.reduceMotion'), [
          ['auto', tr('reduce.auto')],
          ['always', tr('reduce.always')],
          ['never', tr('reduce.never')],
        ], cfg.reduceMotion === undefined ? 'auto' : cfg.reduceMotion,
        (value) => setPref('reduceMotion', value))),
        h('p', { className: 'dw-set-hint' }, tr('label.reduceMotionHint')),

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
        'data-reduce-motion': reduceMotionFlag(cfg),
      },
      h('button', {
        type: 'button',
        className: 'dw-strip',
        'aria-label': tr('label.washer') + ': ' + title + ' · ' + sub,
      },
      PixelSprite(state),
      h('span', { className: 'dw-text' },
        h('span', { className: 'dw-t1' }, title),
        h('span', { className: 'dw-t2' }, sub)),
      h('span', { className: 'dw-dot' })));
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
        };
        // 组件一律通过 washerGetConfig() 现取，而不是吃 inject 给的快照：
        // inject 回调只在注册时跑一次，重渲染不会重新求值。
        const subscribePrefs = (fn) => {
          prefListeners.add(fn);
          return () => { prefListeners.delete(fn); };
        };

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
