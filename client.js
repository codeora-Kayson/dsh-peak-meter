/**
 * Peak/off-peak badge + conversation/turn cost estimate for the Harness composer dock.
 *
 * Placement: one extra `conversation.composer.dock` cell (a NEW id, so the shipped
 * `activity` / `usage` / context-ring entries stay untouched) — the row directly
 * under the composer, laid out like the Reasonix Studio strip:
 *
 *     — tok/s   缓存 23%   ◯ 上下文 1%   平峰 1天   本会话 ¥0.01   本轮 ¥0.01
 *     └────────── shipped by Harness ──┘   └──────────── this plugin ───────────┘
 *
 * Peak rule (DeepSeek official, verified 2026-10-24):
 *   Beijing time, Monday–Friday 09:00–12:00 and 14:00–18:00 are PEAK.
 *   Every other moment — weekends and Chinese statutory holidays all day
 *   included — is OFF-PEAK, billed at 50% of the peak price.
 *
 * Cost:
 *   - 本会话: whole-session buckets from the `tokenUsage` session projection,
 *     priced at the CURRENT zone's unit price (the projection carries no time
 *     dimension, so a cross-zone session is an estimate, never an invoice).
 *   - 本轮: the latest completed Turn's exact usage (`turn-tail` node), priced at
 *     that Turn's own end time, so a Turn that ran in the other zone is priced
 *     for its own zone.
 */
window.__ModuleLoader__.load({
  id: 'dsh-peak-meter',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    // ── calendar ────────────────────────────────────────────────────────────
    const CN_OFFSET = 8 * 3600 * 1000 // Beijing = UTC+8, no DST
    const DAY = 86400000

    // Chinese statutory holidays, 2026 (国办发明电〔2025〕7号). Only weekday
    // dates matter: weekends are always off-peak.
    const HOLIDAY_RANGES = [
      ['2026-01-01', '2026-01-03'], // 元旦
      ['2026-02-15', '2026-02-23'], // 春节
      ['2026-04-04', '2026-04-06'], // 清明
      ['2026-05-01', '2026-05-05'], // 劳动节
      ['2026-06-19', '2026-06-21'], // 端午
      ['2026-09-25', '2026-09-27'], // 中秋
      ['2026-10-01', '2026-10-07'], // 国庆
    ]

    const PEAK_WINDOWS = [
      [9 * 60, 12 * 60],
      [14 * 60, 18 * 60],
    ]

    function pad2(value) {
      return value < 10 ? '0' + value : String(value)
    }

    function calendarKey(date) {
      return (
        date.getUTCFullYear() +
        '-' +
        pad2(date.getUTCMonth() + 1) +
        '-' +
        pad2(date.getUTCDate())
      )
    }

    function expandRanges(ranges) {
      const days = new Set()
      for (const range of ranges) {
        const end = Date.parse(range[1] + 'T00:00:00Z')
        for (let t = Date.parse(range[0] + 'T00:00:00Z'); t <= end; t += DAY) {
          days.add(calendarKey(new Date(t)))
        }
      }
      return days
    }

    const HOLIDAYS = expandRanges(HOLIDAY_RANGES)

    /** Beijing-calendar facts for one epoch millisecond. */
    function beijing(ms) {
      const date = new Date(ms + CN_OFFSET)
      return {
        day: calendarKey(date),
        weekday: date.getUTCDay(),
        minutes: date.getUTCHours() * 60 + date.getUTCMinutes(),
      }
    }

    function isPeak(ms) {
      const local = beijing(ms)
      if (local.weekday === 0 || local.weekday === 6) return false
      if (HOLIDAYS.has(local.day)) return false
      return PEAK_WINDOWS.some(
        window => local.minutes >= window[0] && local.minutes < window[1],
      )
    }

    function beijingMidnight(ms) {
      const parts = beijing(ms).day.split('-').map(Number)
      return Date.UTC(parts[0], parts[1] - 1, parts[2]) - CN_OFFSET
    }

    /** First instant after `ms` whose zone differs from the zone at `ms`. */
    function nextSwitch(ms) {
      const current = isPeak(ms)
      const base = beijingMidnight(ms)
      for (let day = 0; day < 30; day += 1) {
        const start = base + day * DAY
        for (const hour of [9, 12, 14, 18]) {
          const candidate = start + hour * 3600000
          if (candidate > ms && isPeak(candidate) !== current) return candidate
        }
        const midnight = start + DAY
        if (isPeak(midnight) !== current) return midnight
      }
      return null
    }

    /** Last instant before `ms` whose zone differs from the zone at `ms`. */
    function previousSwitch(ms) {
      const current = isPeak(ms)
      const base = beijingMidnight(ms)
      const boundary = candidate => {
        if (candidate >= ms) return false
        // A boundary is where the zone *changes*: the instant itself already
        // belongs to the zone it starts.
        return isPeak(candidate) === current && isPeak(candidate - 60000) !== current
      }
      for (let day = 0; day < 30; day += 1) {
        const start = base - day * DAY
        for (const hour of [18, 14, 12, 9]) {
          const candidate = start + hour * 3600000
          if (boundary(candidate)) return candidate
        }
        if (boundary(start)) return start
      }
      return null
    }

    // ── pricing (CNY per 1M tokens, official DeepSeek list) ─────────────────
    // Swap TIER to 'pro' for deepseek-v4-pro routes.
    const TIER = 'flash'
    const TIERS = {
      'deepseek-flash': {
        hit: { idle: 0.02, peak: 0.04 },
        miss: { idle: 1, peak: 2 },
        out: { idle: 4, peak: 8 },
      },
      'deepseek-v4-pro': {
        hit: { idle: 0.15, peak: 0.3 },
        miss: { idle: 4.5, peak: 9 },
        out: { idle: 13.5, peak: 27 },
      },
    }
    const PRICE_OF = TIERS[TIER === 'pro' ? 'deepseek-v4-pro' : 'deepseek-flash']
    const TIER_NAME = TIER === 'pro' ? 'deepseek-v4-pro' : 'deepseek-flash'

    /** Official list snapshot shown in the detail card; `TIERS` prices both the table and the estimate. */
    const MODEL_PRICES = [
      { label: 'DeepSeek-V4.1-Flash', key: 'deepseek-flash' },
      { label: 'DeepSeek-V4-Pro', key: 'deepseek-v4-pro' },
    ]
    const PRICING_UPDATED = '2026-10-24'
    const PRICING_URL = 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing'

    /**
     * Price one usage bucket set (projection totals or one Turn's accounting).
     * @param usage - bucket object; null/undefined answers null.
     * @param peak - whether to use the peak column.
     * @returns CNY, or null without usage.
     */
    function estimate(usage, peak) {
      if (!usage) return null
      const zone = peak ? 'peak' : 'idle'
      const hitTokens = usage.cacheReadTokens || 0
      const missTokens = (usage.uncachedInputTokens || 0) + (usage.cacheWriteTokens || 0)
      const outputTokens = usage.outputTokens || 0
      return (
        (hitTokens * PRICE_OF.hit[zone] +
          missTokens * PRICE_OF.miss[zone] +
          outputTokens * PRICE_OF.out[zone]) /
        1e6
      )
    }

    /**
     * Cost of the newest loaded Turn that reports exact accounting, priced at
     * that Turn's own zone.
     * @param snapshot - Chat snapshot from `useChat`.
     * @returns CNY, or null when no completed Turn carries usage.
     */
    function readTurnCost(snapshot) {
      try {
        const timeline = snapshot && snapshot.timeline
        const locations = snapshot && snapshot.locations
        const nodes = snapshot && snapshot.nodes
        if (!timeline || !locations || !nodes) return null
        const order = timeline.turnOrder
        if (!order || order.length === 0) return null
        const keys = locations.getTurn(order[order.length - 1])
        if (!keys) return null
        for (let index = keys.length - 1; index >= 0; index -= 1) {
          const node = nodes.get(keys[index])
          if (!node || node.kind !== 'turn-tail') continue
          const data = node.data
          if (!data || !data.tokenUsage) continue
          return estimate(data.tokenUsage, isPeak(data.time || Date.now()))
        }
        return null
      } catch (error) {
        return null
      }
    }

    // ── copy ────────────────────────────────────────────────────────────────
    const DICTS = {
      zh: {
        idle: '平峰',
        peak: '高峰',
        soonIdle: '{delta}后转平峰',
        soonPeak: '{delta}后转高峰',
        days: '天',
        hours: '小时',
        minutes: '分',
        join: '',
        session: '本会话',
        turn: '本轮',
        balance: '余额',
        balanceSignedOut: '未登录',
        balanceUnavailable: '不可用',
        panelTitle: '费用参考',
        cacheHit: '缓存命中',
        uncachedInput: '未缓存输入',
        cacheRead: '缓存读取',
        output: '输出',
        tokens: 'tok',
        modelCol: '模型',
        priceMiss: '缓存未命中',
        priceNote: '元/百万 tokens · 深色为当前时段价 · 更新于 {date}',
        priceSource: '官网价目',
        zoneIdle: '平峰时段',
        zonePeak: '高峰时段',
        badgeIdle: '5 折',
        badgePeak: '标准价',
        bigCountdown: '{h} 小时 {m} 分 {s} 秒',
        nextPeakAt: '{when} 进入高峰时段',
        nextIdleAt: '{when} 进入平峰时段',
        sloganIdle: '放开用',
        sloganIdleNote: '半价时段，尽管使劲用',
        sloganPeak: '省着点用',
        sloganPeakNote: '标准价时段，能省则省',
        accountBalance: '账户余额',
        topUp: '去充值',
        refreshAction: '刷新',
        topUpBalance: '充值余额',
        bonusBalance: '赠送余额',
        updatedAt: '更新于 {time}',
        priceCaption: '元 / 百万 tokens（划线为高峰价）',
        bonusPart: '赠送 {bonus}',
        untilSwitch: '还有 {delta}',
        rule: '高峰：工作日 09:00–12:00、14:00–18:00（北京时间）',
        checkedAt: '核对 {date}',
        close: '关闭',
        monthUnit: '月',
        dayUnit: '日',
        titlePeak: '高峰：标准价',
        titleIdle: '平峰：高峰价的 5 折',
        titleBasis: '按官方 {tier} 价折算',
        titleBalance: '充值 {topUp} · 赠送 {bonus}',
        titleTopUp: '充值 {topUp}',
        titleSignedOut: '未登录 DeepSeek 账号',
        titleBalanceFailed: '余额读取失败：{reason}',
        titleBalanceUnavailable: '账户服务未启用',
        titleRefresh: '点击刷新',
      },
      en: {
        idle: 'Off-peak',
        peak: 'Peak',
        soonIdle: '{delta} until off-peak',
        soonPeak: '{delta} until peak',
        days: 'd',
        hours: 'h',
        minutes: 'm',
        join: ' ',
        session: 'Session',
        turn: 'Turn',
        balance: 'Balance',
        balanceSignedOut: 'signed out',
        balanceUnavailable: 'n/a',
        panelTitle: 'Cost reference',
        cacheHit: 'Cache hit',
        uncachedInput: 'Uncached input',
        cacheRead: 'Cache read',
        output: 'Output',
        tokens: 'tok',
        modelCol: 'Model',
        priceMiss: 'Cache miss',
        priceNote: 'CNY per 1M tokens · bold = current zone · updated {date}',
        priceSource: 'Official pricing',
        zoneIdle: 'Off-peak hours',
        zonePeak: 'Peak hours',
        badgeIdle: '50% off',
        badgePeak: 'List price',
        bigCountdown: '{h}h {m}m {s}s',
        nextPeakAt: '{when} → peak',
        nextIdleAt: '{when} → off-peak',
        sloganIdle: 'Go for it',
        sloganIdleNote: 'half price — use it freely',
        sloganPeak: 'Go easy',
        sloganPeakNote: 'list price — keep an eye on it',
        accountBalance: 'Account balance',
        topUp: 'Top up',
        refreshAction: 'Refresh',
        topUpBalance: 'Top-up',
        bonusBalance: 'Bonus',
        updatedAt: 'updated {time}',
        priceCaption: 'CNY / 1M tokens (struck = peak)',
        bonusPart: 'bonus {bonus}',
        untilSwitch: '{delta} left',
        rule: 'Peak: weekdays 09:00–12:00 and 14:00–18:00 (Beijing time)',
        checkedAt: 'checked {date}',
        close: 'Close',
        monthUnit: '/',
        dayUnit: '',
        titlePeak: 'Peak: list price',
        titleIdle: 'Off-peak: 50% of list price',
        titleBasis: 'priced from the official {tier} list price',
        titleBalance: 'top-up {topUp} · bonus {bonus}',
        titleTopUp: 'top-up {topUp}',
        titleSignedOut: 'not signed in to DeepSeek',
        titleBalanceFailed: 'balance read failed: {reason}',
        titleBalanceUnavailable: 'account service unavailable',
        titleRefresh: 'click to refresh',
      },
    }

    function fill(template, vars) {
      return String(template).replace(/\{(\w+)\}/g, (match, key) =>
        vars[key] === undefined || vars[key] === null ? match : String(vars[key]),
      )
    }

    /** ¥1.23 / ¥0.01 / ¥0.0031 — never collapse a billable amount to ¥0.00. */
    function yuan(value) {
      if (!(value > 0)) return '¥0.00'
      if (value < 0.0001) return '<¥0.0001'
      if (value < 0.01) return '¥' + value.toFixed(4)
      return '¥' + value.toFixed(2)
    }

    /** Match the shipped composer statistics strip: 12px, secondary text, dot separators. */
    const FONT_SIZE = '12px'
    const DOT = { color: 'var(--dsw-alias-label-secondary)', opacity: 0.55 }

    /** Click-to-open detail card, matching the shipped statistics dialogs. */
    const PANEL_STYLE = {
      position: 'absolute',
      bottom: 'calc(100% + 8px)',
      right: 0,
      zIndex: 80,
      width: '400px',
      padding: '14px 16px 12px',
      borderRadius: '14px',
      background: 'var(--dsw-alias-bg-overlay)',
      border: '1px solid var(--dsw-alias-border-l1)',
      boxShadow: '0 12px 32px rgba(0, 0, 0, 0.2)',
      color: 'var(--dsw-alias-label-primary)',
      fontSize: FONT_SIZE,
      lineHeight: '18px',
      whiteSpace: 'normal',
      textAlign: 'left',
      cursor: 'default',
      display: 'flex',
      flexDirection: 'column',
      gap: '2px',
    }
    const CLOSE_STYLE = {
      all: 'unset',
      cursor: 'pointer',
      color: 'var(--dsw-alias-label-secondary)',
      fontSize: '16px',
      lineHeight: 1,
      padding: '0 2px',
    }
    const ACTION_STYLE = {
      border: 'none',
      background: 'none',
      padding: 0,
      margin: 0,
      color: 'var(--dsw-alias-brand-primary)',
      cursor: 'pointer',
      fontSize: '11px',
      fontFamily: 'inherit',
      textDecoration: 'none',
    }
    const ROW_STYLE = {
      display: 'flex',
      alignItems: 'baseline',
      justifyContent: 'space-between',
      gap: '16px',
    }
    const PRICE_GRID = {
      display: 'grid',
      gridTemplateColumns: '1fr 74px 74px 74px',
      columnGap: '6px',
      alignItems: 'baseline',
    }
    const DIVIDER_STYLE = {
      height: '1px',
      background: 'var(--dsw-alias-border-l1)',
      margin: '6px 0',
    }
    const NOTE_STYLE = {
      color: 'var(--dsw-alias-label-secondary)',
      fontSize: '11px',
      lineHeight: '16px',
    }

    const DB_ICON = h(
      'svg',
      { width: 14, height: 14, viewBox: '0 0 16 16', 'aria-hidden': true, style: { display: 'block' } },
      h('ellipse', { cx: 8, cy: 3.6, rx: 5, ry: 2.1, fill: 'currentColor' }),
      h('path', {
        d: 'M3 3.6v3.4c0 1.16 2.24 2.1 5 2.1s5-.94 5-2.1V3.6',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.2,
      }),
      h('path', {
        d: 'M3 7v3.4c0 1.16 2.24 2.1 5 2.1s5-.94 5-2.1V7',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.2,
      }),
    )

    /** Precise span, hours and minutes only: 45小时12分 / 45分. */
    function duration(ms, t) {
      const total = Math.max(1, Math.round(ms / 60000))
      const hours = Math.floor(total / 60)
      const minutes = total % 60
      const parts = []
      if (hours > 0) parts.push(hours + t('hours'))
      if (minutes > 0 || hours === 0) parts.push(minutes + t('minutes'))
      return parts.join(t('join'))
    }

    /** Coarse span for the pill, hours only (no days): 46小时 / 45分. */
    function coarseDuration(ms, t) {
      const total = Math.max(1, Math.round(ms / 60000))
      if (total >= 60) return Math.round(total / 60) + t('hours')
      return total + t('minutes')
    }

    /** Hours / minutes / seconds left, for the big countdown. */
    function countdownParts(ms) {
      const total = Math.max(0, Math.floor(ms / 1000))
      return {
        h: Math.floor(total / 3600),
        m: Math.floor((total % 3600) / 60),
        s: total % 60,
      }
    }

    /** Beijing wall-clock label: 10月26日 09:00. */
    function beijingLabel(ms, t) {
      const date = new Date(ms + CN_OFFSET)
      const pad = value => (value < 10 ? '0' + value : String(value))
      return (
        (date.getUTCMonth() + 1) +
        t('monthUnit') +
        date.getUTCDate() +
        t('dayUnit') +
        ' ' +
        pad(date.getUTCHours()) +
        ':' +
        pad(date.getUTCMinutes())
      )
    }

    /** Local HH:MM for an “updated at” note. */
    function clock(ms) {
      const date = new Date(ms)
      const pad = value => (value < 10 ? '0' + value : String(value))
      return pad(date.getHours()) + ':' + pad(date.getMinutes())
    }

    /** Compact token count: 34.4M / 203.7K / 932. */
    function compact(value) {
      const n = Number(value) || 0
      if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M'
      if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K'
      return String(Math.round(n))
    }

    // ── plugin ──────────────────────────────────────────────────────────────
    return {
      inject: ['slots', 'locale', 'remote'],
      apply(ctx) {
        const locale = ctx.locale
        const NS = 'peak-meter'

        for (const id of ['zh', 'en']) {
          ctx.effect(() => {
            try {
              return locale.register(NS, id, DICTS[id])
            } catch (error) {
              return () => {}
            }
          }, 'peak-meter: locale dictionary ' + id)
        }

        let bound = null
        try {
          bound = locale.bind(NS)
        } catch (error) {
          bound = null
        }

        const activeLocale = () => {
          try {
            const snapshot = locale.getSnapshot()
            return (snapshot && snapshot.active) || 'zh'
          } catch (error) {
            return 'zh'
          }
        }

        /** Dictionary lookup through the locale service, with an inline fallback. */
        const translate = () => {
          const dict = String(activeLocale()).toLowerCase().startsWith('zh')
            ? DICTS.zh
            : DICTS.en
          return key => {
            let value = null
            if (bound) {
              try {
                value = bound(key)
              } catch (error) {
                value = null
              }
            }
            if (typeof value === 'string' && value !== key) return value
            if (dict[key] !== undefined) return dict[key]
            return DICTS.en[key] !== undefined ? DICTS.en[key] : key
          }
        }

        // ── DeepSeek account balance (optional capability) ──────────────────
        // `ctx.remote.account` is mounted by this client assembly; the read is
        // still allowed to fail (signed out, Platform error, old build), and
        // every failure keeps a short reason for the tooltip.
        const VERSION =
          (typeof window !== 'undefined' &&
            window.__DSH_BOOT__ &&
            window.__DSH_BOOT__.version) ||
          '0.2.1-rc.2'

        const codeOf = error => {
          if (!error) return 'unknown'
          if (typeof error === 'string') return error.slice(0, 48)
          return String(error.code || error.message || error.name || 'unknown').slice(0, 48)
        }

        const unwrapRemote = result => {
          if (!result) return null
          if (result.ok === false) return null
          if (result.ok === true) return result.value === undefined ? null : result.value
          if (result.value !== undefined) return result.value
          return result
        }

        const accountMeta = () => ({
          version: VERSION,
          locale: activeLocale(),
          timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
        })

        /** Settle one promise against a deadline so a hung carrier cannot hide the segment forever. */
        const withTimeout = (promise, ms) =>
          Promise.race([
            Promise.resolve(promise).then(
              value => ({ timedOut: false, value }),
              error => ({ timedOut: false, error }),
            ),
            new Promise(resolve => setTimeout(() => resolve({ timedOut: true }), ms)),
          ])

        /** Sum the ready balance payload; null when the query itself failed. */
        const walletFrom = balance => {
          if (!balance || balance.status !== 'ready') return null
          const sum = wallets =>
            (Array.isArray(wallets) ? wallets : []).reduce(
              (total, wallet) =>
                total +
                (wallet && wallet.currency === 'CNY' ? Number(wallet.balance) || 0 : 0),
              0,
            )
          const topUp = sum(balance.value)
          const bonus = sum(balance.bonusWallets)
          return { total: topUp + bonus, topUp, bonus }
        }

        /** Preferred path: the typed account Remote, when this client mounts it. */
        const readAccountRemote = async () => {
          let remote = null
          try {
            remote = ctx.remote && ctx.remote.account
          } catch (error) {
            remote = null
          }
          if (!remote) return { state: 'unavailable', reason: 'no-account-remote' }
          if (typeof remote.getBalance !== 'function') {
            return { state: 'unavailable', reason: 'no-getBalance' }
          }

          let view = null
          if (typeof remote.getState === 'function') {
            try {
              view = unwrapRemote(await remote.getState())
              if (view && view.status === 'signed-out') return { state: 'signed-out' }
            } catch (error) {
              view = null
            }
          }

          const outcome = await withTimeout(remote.getBalance(accountMeta()), 8000)
          if (outcome.timedOut) return { state: 'failed', reason: 'timeout' }
          if (outcome.error) return { state: 'failed', reason: codeOf(outcome.error) }

          const result = outcome.value
          if (result && result.ok === false) {
            return { state: 'failed', reason: codeOf(result.error) }
          }
          const details = unwrapRemote(result)
          if (!details) return { state: 'signed-out' }
          if (details.status !== 'ready') return { state: 'failed', reason: 'platform' }
          return {
            state: 'ok',
            wallet: walletFrom(details),
            links: view && view.links,
            at: Date.now(),
          }
        }

        /**
         * Fallback path: the Host route registered by this bundle's Host half.
         * Used when the client assembly does not mount the account Remote.
         */
        const readAccountHttp = async () => {
          if (typeof fetch !== 'function') return { state: 'unavailable', reason: 'no-fetch' }
          let response = null
          try {
            response = await fetch('/__dsh-peak-meter/balance', {
              cache: 'no-store',
              headers: {
                'x-dsh-locale': activeLocale(),
                'x-dsh-offset': String(-new Date().getTimezoneOffset() * 60),
              },
            })
          } catch (error) {
            return { state: 'failed', reason: 'http:' + codeOf(error) }
          }
          if (!response) return { state: 'failed', reason: 'http:none' }
          if (!response.ok) return { state: 'failed', reason: 'http-' + response.status }

          let body = null
          try {
            body = await response.json()
          } catch (error) {
            return { state: 'failed', reason: 'bad-json' }
          }
          if (!body) return { state: 'failed', reason: 'empty' }
          if (body.state === 'ok') {
            const wallet = walletFrom(body.balance)
            if (wallet) return { state: 'ok', wallet, links: body.links, at: Date.now() }
            return {
              state: 'failed',
              reason: body.balance && body.balance.status === 'failed' ? 'platform' : 'empty',
            }
          }
          if (body.state === 'signed-out') return { state: 'signed-out' }
          if (body.state === 'unavailable') return { state: 'unavailable', reason: body.reason }
          return { state: 'failed', reason: String(body.reason || 'unknown').slice(0, 48) }
        }

        const readAccount = async () => {
          const viaRemote = await readAccountRemote()
          if (viaRemote.state === 'ok' || viaRemote.state === 'signed-out') return viaRemote
          const viaHttp = await readAccountHttp()
          if (viaHttp.state === 'ok' || viaHttp.state === 'signed-out') return viaHttp
          // Both paths failed: keep the Remote's specific reason when it has one.
          return viaRemote.state === 'failed' ? viaRemote : viaHttp
        }

        function PeakCostPill(props) {
          const [, setRevision] = React.useState(0)
          const [now, setNow] = React.useState(() => Date.now())
          const [open, setOpen] = React.useState(false)
          const rootRef = React.useRef(null)

          React.useEffect(() => {
            let stop = null
            try {
              stop = locale.subscribe(() => setRevision(value => value + 1))
            } catch (error) {
              stop = null
            }
            return () => {
              if (typeof stop === 'function') stop()
            }
          }, [])

          // Tick once a second while the card is open (the countdown shows
          // seconds); idle at 30s so the pill's hour slot stays fresh.
          React.useEffect(() => {
            const timer = setInterval(() => setNow(Date.now()), open ? 1000 : 30000)
            return () => clearInterval(timer)
          }, [open])

          // Balance: one read on mount, a 5-minute refresh, and a manual
          // refresh by clicking the pill. A failed or signed-out read is still
          // surfaced (with its reason in the tooltip) instead of vanishing.
          const [account, setAccount] = React.useState({ state: 'loading' })
          const [refreshing, setRefreshing] = React.useState(false)
          const [reloadToken, setReloadToken] = React.useState(0)

          React.useEffect(() => {
            let alive = true
            let retries = 0
            let retryTimer = null

            const finish = next => {
              if (!alive) return
              setAccount(next)
              setRefreshing(false)
              // Remote namespaces mount asynchronously at client boot, so an
              // early read can miss `ctx.remote.account`; retry briefly before
              // settling on "unavailable".
              if (next.state === 'unavailable' && retries < 3) {
                const delay = [800, 2500, 6000][retries] || 6000
                retries += 1
                retryTimer = setTimeout(load, delay)
              }
            }

            const load = () => {
              withTimeout(readAccount(), 12000).then(outcome => {
                if (!alive) return
                if (outcome.timedOut) return finish({ state: 'failed', reason: 'timeout' })
                if (outcome.error) return finish({ state: 'failed', reason: codeOf(outcome.error) })
                finish(outcome.value)
              })
            }

            setRefreshing(true)
            load()
            const timer = setInterval(load, 300000)
            return () => {
              alive = false
              clearInterval(timer)
              if (retryTimer) clearTimeout(retryTimer)
            }
          }, [reloadToken])

          const refresh = () => {
            setNow(Date.now())
            setReloadToken(token => token + 1)
          }

          // Close the panel on an outside pointer press or Escape, like the
          // shipped statistics dialogs.
          React.useEffect(() => {
            if (!open) return undefined
            const onPointerDown = event => {
              const root = rootRef.current
              try {
                if (root && root.contains(event.target)) return
              } catch (error) {
                // Cross-document targets cannot be contained; treat as outside.
              }
              setOpen(false)
            }
            const onKeyDown = event => {
              if (event.key === 'Escape') setOpen(false)
            }
            document.addEventListener('pointerdown', onPointerDown, true)
            document.addEventListener('keydown', onKeyDown)
            return () => {
              document.removeEventListener('pointerdown', onPointerDown, true)
              document.removeEventListener('keydown', onKeyDown)
            }
          }, [open])

          const useProjection = props.useProjection
          const usage =
            typeof useProjection === 'function' ? useProjection('tokenUsage') : undefined

          // The selector returns a number, so the hook's equality gate keeps
          // streaming deltas from re-rendering this pill.
          let turnCost = null
          const useChat = props.useChat
          if (typeof useChat === 'function') {
            try {
              const value = useChat(snapshot => readTurnCost(snapshot))
              if (typeof value === 'number' && isFinite(value)) turnCost = value
            } catch (error) {
              turnCost = null
            }
          }

          const t = translate()
          const peak = isPeak(now)
          const until = nextSwitch(now)
          const sessionCost = estimate(usage, peak)

          const spanText = until === null ? '' : coarseDuration(until - now, t)
          const spanTitle =
            until === null ? '' : fill(t(peak ? 'soonIdle' : 'soonPeak'), {
              delta: duration(until - now, t),
            })

          const wallet = account.state === 'ok' ? account.wallet : null

          const balanceValue = wallet
            ? yuan(wallet.total)
            : account.state === 'signed-out'
              ? t('balanceSignedOut')
              : account.state === 'unavailable'
                ? t('balanceUnavailable')
                : account.state === 'loading'
                  ? '…'
                  : '—'

          const zoneColor = peak
            ? 'var(--dsw-alias-state-warn-primary)'
            : 'var(--dsw-alias-state-success-primary)'
          const muted = 'var(--dsw-alias-label-secondary)'
          const strong = 'var(--dsw-alias-label-primary)'

          const children = [
            h(
              'span',
              { key: 'zone', style: { display: 'inline-flex', alignItems: 'center', gap: '4px' } },
              h('span', { style: { color: zoneColor, fontWeight: 500 } }, t(peak ? 'peak' : 'idle')),
              spanText ? h('span', { style: { color: muted } }, spanText) : null,
            ),
          ]
          if (sessionCost !== null) {
            children.push(h('span', { key: 'dot-session', style: DOT }, '·'))
            children.push(
              h(
                'span',
                { key: 'session', style: { display: 'inline-flex', alignItems: 'center', gap: '4px' } },
                h('span', { style: { color: muted } }, t('session')),
                h('span', { style: { color: strong } }, yuan(sessionCost)),
              ),
            )
          }
          if (turnCost !== null) {
            children.push(h('span', { key: 'dot-turn', style: DOT }, '·'))
            children.push(
              h(
                'span',
                { key: 'turn', style: { display: 'inline-flex', alignItems: 'center', gap: '4px' } },
                h('span', { style: { color: muted } }, t('turn')),
                h('span', { style: { color: strong } }, yuan(turnCost)),
              ),
            )
          }
          if (account.state !== 'loading') {
            children.push(h('span', { key: 'dot-balance', style: DOT }, '·'))
            children.push(
              h(
                'span',
                {
                  key: 'balance',
                  style: { display: 'inline-flex', alignItems: 'center', gap: '4px' },
                },
                h('span', { style: { color: muted } }, t('balance')),
                h('span', { style: { color: wallet ? strong : muted } }, balanceValue),
              ),
            )
          }

          // ── click-to-open detail card ──────────────────────────────────────
          const prev = previousSwitch(now)
          const progress =
            prev !== null && until !== null && until > prev
              ? Math.min(1, Math.max(0, (now - prev) / (until - prev)))
              : 0
          const untilText = until === null ? '' : duration(until - now, t)
          const nextText =
            until === null
              ? ''
              : fill(t(peak ? 'nextIdleAt' : 'nextPeakAt'), { when: beijingLabel(until, t) })

          const topUpUrl =
            (account.links && account.links.topUpUrl) || 'https://platform.deepseek.com/top_up'

          const row = (key, label, value, color) =>
            h(
              'div',
              { key, style: ROW_STYLE },
              h('span', { style: { color: muted } }, label),
              h(
                'span',
                { style: { color: color || strong, fontVariantNumeric: 'tabular-nums' } },
                value,
              ),
            )
          const divider = key => h('div', { key, style: DIVIDER_STYLE })

          const actions = []
          if (wallet) {
            actions.push(
              h(
                'a',
                {
                  key: 'topup',
                  href: topUpUrl,
                  target: '_blank',
                  rel: 'noreferrer',
                  style: ACTION_STYLE,
                },
                t('topUp'),
              ),
            )
          }
          actions.push(
            h(
              'button',
              { key: 'refresh', type: 'button', onClick: () => refresh(), style: ACTION_STYLE },
              t('refreshAction'),
            ),
          )

          const accountNote = []
          if (wallet) {
            if (wallet.topUp > 0) {
              accountNote.push(fill(t('titleTopUp'), { topUp: yuan(wallet.topUp) }))
            }
            if (wallet.bonus > 0) {
              accountNote.push(fill(t('bonusPart'), { bonus: yuan(wallet.bonus) }))
            }
            if (account.at) {
              accountNote.push(fill(t('updatedAt'), { time: clock(account.at) }))
            }
          }

          // Price table: flat price in front, the peak price struck through.
          const priceCell = (model, bucket) => {
            const prices = TIERS[model.key][bucket]
            return h(
              'span',
              {
                key: bucket,
                style: {
                  display: 'inline-flex',
                  justifyContent: 'flex-end',
                  gap: '4px',
                  fontVariantNumeric: 'tabular-nums',
                },
              },
              h('span', { style: { color: strong } }, String(prices.idle)),
              h(
                'span',
                { style: { color: muted, fontSize: '10px', textDecoration: 'line-through' } },
                String(prices.peak),
              ),
            )
          }
          const priceHeader = h(
            'div',
            { key: 'price-head', style: PRICE_GRID },
            h('span', { style: { color: muted } }, t('modelCol')),
            h('span', { style: { color: muted, textAlign: 'right' } }, t('cacheHit')),
            h('span', { style: { color: muted, textAlign: 'right' } }, t('priceMiss')),
            h('span', { style: { color: muted, textAlign: 'right' } }, t('output')),
          )
          const priceRows = MODEL_PRICES.map(model =>
            h(
              'div',
              { key: model.key, style: PRICE_GRID },
              h('span', { style: { color: strong } }, model.label),
              priceCell(model, 'hit'),
              priceCell(model, 'miss'),
              priceCell(model, 'out'),
            ),
          )

          const panel = h(
            'div',
            { role: 'dialog', 'aria-label': t('panelTitle'), style: PANEL_STYLE },
            h(
              'div',
              {
                key: 'head',
                style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' },
              },
              h('span', { style: { fontWeight: 600, fontSize: '13px' } }, t('panelTitle')),
              h(
                'button',
                { key: 'close', type: 'button', onClick: () => setOpen(false), 'aria-label': t('close'), style: CLOSE_STYLE },
                '×',
              ),
            ),
            h(
              'div',
              { key: 'hero', style: { display: 'flex', gap: '28px', marginTop: '12px' } },
              h(
                'div',
                { key: 'session-fig', style: { display: 'flex', flexDirection: 'column', gap: '2px' } },
                h('span', { style: { color: muted, fontSize: '11px' } }, t('session')),
                h(
                  'span',
                  {
                    style: {
                      fontSize: '20px',
                      lineHeight: '24px',
                      fontWeight: 600,
                      fontVariantNumeric: 'tabular-nums',
                    },
                  },
                  sessionCost === null ? '—' : yuan(sessionCost),
                ),
              ),
              h(
                'div',
                { key: 'turn-fig', style: { display: 'flex', flexDirection: 'column', gap: '2px' } },
                h('span', { style: { color: muted, fontSize: '11px' } }, t('turn')),
                h(
                  'span',
                  {
                    style: {
                      fontSize: '20px',
                      lineHeight: '24px',
                      fontWeight: 600,
                      fontVariantNumeric: 'tabular-nums',
                    },
                  },
                  turnCost === null ? '—' : yuan(turnCost),
                ),
              ),
            ),
            h(
              'div',
              { key: 'zone', style: { marginTop: '14px' } },
              h(
                'div',
                {
                  key: 'zone-line',
                  style: {
                    display: 'flex',
                    alignItems: 'baseline',
                    justifyContent: 'space-between',
                    gap: '10px',
                  },
                },
                h(
                  'span',
                  { style: { display: 'inline-flex', alignItems: 'center', gap: '6px' } },
                  h('span', {
                    style: {
                      width: '6px',
                      height: '6px',
                      borderRadius: '50%',
                      background: zoneColor,
                      display: 'inline-block',
                    },
                  }),
                  h(
                    'span',
                    { style: { color: zoneColor, fontWeight: 500 } },
                    t(peak ? 'zonePeak' : 'zoneIdle'),
                  ),
                  h(
                    'span',
                    { style: { color: muted, fontSize: '11px' } },
                    t(peak ? 'badgePeak' : 'badgeIdle'),
                  ),
                ),
                h(
                  'span',
                  { style: { color: muted, fontSize: '11px' } },
                  fill(t('untilSwitch'), { delta: untilText }),
                ),
              ),
              h(
                'div',
                {
                  key: 'zone-bar',
                  style: {
                    height: '4px',
                    borderRadius: '999px',
                    background: 'var(--dsw-alias-border-l1)',
                    overflow: 'hidden',
                    marginTop: '6px',
                  },
                },
                h('div', {
                  style: {
                    width: (progress * 100).toFixed(1) + '%',
                    height: '100%',
                    background: zoneColor,
                    opacity: 0.75,
                  },
                }),
              ),
              h('div', { key: 'next', style: { ...NOTE_STYLE, marginTop: '4px' } }, nextText),
            ),
            divider('divider-account'),
            h(
              'div',
              {
                key: 'account',
                style: {
                  display: 'flex',
                  alignItems: 'baseline',
                  justifyContent: 'space-between',
                  gap: '10px',
                },
              },
              h(
                'span',
                { style: { display: 'inline-flex', alignItems: 'baseline', gap: '8px' } },
                h('span', { style: { color: muted } }, t('accountBalance')),
                h(
                  'span',
                  { style: { color: wallet ? strong : muted, fontVariantNumeric: 'tabular-nums' } },
                  balanceValue,
                ),
              ),
              h('span', { style: { display: 'inline-flex', gap: '12px' } }, actions),
            ),
            accountNote.length
              ? h(
                  'div',
                  { key: 'account-note', style: { ...NOTE_STYLE, marginTop: '2px' } },
                  accountNote.join(' · '),
                )
              : null,
            divider('divider-prices'),
            h(
              'div',
              { key: 'price-caption', style: { ...NOTE_STYLE, marginBottom: '4px' } },
              t('priceCaption'),
            ),
            h(
              'div',
              {
                key: 'price-table',
                style: { display: 'flex', flexDirection: 'column', gap: '2px', fontSize: '11px' },
              },
              priceHeader,
              priceRows,
            ),
            divider('divider-rule'),
            h('div', { key: 'rule', style: NOTE_STYLE }, t('rule')),
            h(
              'div',
              {
                key: 'meta',
                style: {
                  ...NOTE_STYLE,
                  display: 'flex',
                  justifyContent: 'space-between',
                  gap: '8px',
                  marginTop: '2px',
                },
              },
              h('span', null, fill(t('checkedAt'), { date: PRICING_UPDATED })),
              h(
                'a',
                {
                  href: PRICING_URL,
                  target: '_blank',
                  rel: 'noreferrer',
                  style: { color: muted, textDecoration: 'underline', whiteSpace: 'nowrap' },
                },
                t('priceSource'),
              ),
            ),
          )

          return h(
            'span',
            { ref: rootRef, style: { position: 'relative', display: 'inline-flex' } },
            h(
              'button',
              {
                type: 'button',
                'data-composer-stat': 'peak-meter',
                'aria-haspopup': 'dialog',
                'aria-expanded': open ? 'true' : 'false',
                onClick: () => {
                  const next = !open
                  setOpen(next)
                  if (next) refresh()
                },
                style: {
                  all: 'unset',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '6px',
                  fontSize: FONT_SIZE,
                  lineHeight: '16px',
                  fontWeight: 400,
                  color: muted,
                  whiteSpace: 'nowrap',
                  fontVariantNumeric: 'tabular-nums',
                  cursor: 'pointer',
                  userSelect: 'none',
                  opacity: refreshing ? 0.65 : 1,
                  transition: 'opacity 120ms ease',
                },
              },
              children,
            ),
            open ? panel : null,
          )
        }

        ctx.slots.inject('conversation.composer.dock', () =>
          ctx.slots.register(
            { name: 'conversation.composer.dock', id: 'peak-meter', order: 2 },
            PeakCostPill,
          ),
        )
      },
    }
  },
})
