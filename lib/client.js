/**
 * Client half of the token ledger: a Settings page that shows how many tokens
 * every project in this DSH installation has spent, broken down by project, by
 * model route, and by session.
 *
 * The page is a reader: it fetches the host half's JSON summary and derives every
 * view from the returned per-session rows, so the time filter and the drill-down
 * share one aggregation. The host's own totals are compared against that
 * aggregation and any disagreement is surfaced rather than hidden.
 *
 * Bundle form follows every shipped client half: factory-form CJS registering
 * itself on `window.__ModuleLoader__`, requiring only the platform seed words
 * (`react` / `react/jsx-runtime`) and reaching the slot and locale services
 * through cordis.
 */
window.__ModuleLoader__.load({
  id: 'dsh-token-ledger',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')

    /** Host half's JSON route. */
    const SUMMARY_URL = '/token-ledger/summary'
    /** Slot this page occupies: one Settings section with a navigation row. */
    const SECTION = 'settings.section'
    /** Sidebar global-panel row and the centre-column slot it selects. */
    const PANELLIST = 'sidebar.panellist'
    const MAIN = 'main'
    /**
     * Shared id: the panellist entry's `id` is what the shell hands to
     * `ctx.layout.selectPanel`, and the `main` entry must carry the same value as
     * its `key` — that identity is the entire link between the two.
     */
    const PANEL_ID = 'token-ledger'
    /** This plugin's locale namespace. */
    const NS = 'dsh-token-ledger'
    /** Day length in milliseconds, for the period filter. */
    const DAY = 86_400_000

    //#region dictionaries
    const DICTIONARIES = {
      zh: {
        nav: 'Token 统计',
        title: 'Token 统计',
        intro: 'DSH 中所有项目累计消耗的 token。按会话工作目录分组，同一笔模型调用只计一次。',
        modeAccurate: '精确',
        modeFast: '快速',
        refresh: '重新统计',
        busy: '统计中…',
        loadingAccurate: '正在读取变化的会话日志并折算…（未变化的会话直接复用上次结果）',
        loadingFast: '正在读取持久化投影缓存…',
        periodAll: '全部时间',
        period7: '近 7 天',
        period30: '近 30 天',
        byCreation: '按会话创建时间筛选',
        export: '导出 CSV',
        back: '← 返回对话',
        cardTotalDedup: '总 token（已去重）',
        cardTotalRaw: '总 token（未去重）',
        cardOutput: '输出 token',
        cardCacheRead: '缓存读取',
        cardUncached: '输入（未命中缓存）',
        cardCacheWrite: '缓存写入',
        cardSessions: '{sessions} 个会话 · {projects} 个项目',
        cardOverlap: '其中来自继承历史 {value}',
        cardFastNote: '快速模式：无法区分继承历史',
        cardOutputNote: '模型生成的 token',
        colProject: '项目',
        colSessions: '会话',
        colSubagents: '子代理',
        colSubagentsNote: '该项目的子代理会话总数——其中多数是全新上下文，不会重复计入',
        colInherited: '继承历史',
        colInheritedNote: '该项目的会话中，日志开头复制了父会话历史的数量——这一列才是重复量的来源',
        colTokens: '消耗 token',
        colRawTokens: '记录 token',
        colInput: '输入',
        colOutput: '输出',
        colInputNote: '输入 = 未命中缓存 + 缓存读取 + 缓存写入：三者都是计费的输入侧',
        colOutputNote: '模型生成的 token，即输出侧',
        colCacheRate: '缓存率',
        colCacheRateNote: '缓存读取 ÷ 输入（未命中 + 缓存读 + 缓存写）。与 DSH 聊天统计里的「缓存命中」同一口径，且不会把部分命中显示成 100%',
        cardCacheRate: '缓存命中率',
        cardCacheRateNote: '缓存读 {read} / 输入 {input}',
        noBilledInput: '没有计费输入',
        colShare: '占比',
        colTime: '时间',
        colKind: '类型',
        colRoute: '模型路由',
        routesTitle: '按模型路由',
        kindUser: '用户',
        kindSubagent: '子代理',
        kindInherited: '继承',
        detailIn: '入',
        detailOut: '出',
        detailCache: '缓存',
        expand: '展开会话明细',
        collapse: '收起会话明细',
        noSessions: '该时间段内没有会话。',
        capped: '仅显示前 50 个会话，完整明细请导出 CSV。',
        footSource: '数据来源：{source}',
        footScopeDedup: '统计口径：每个会话只累计其自身事件（跳过它从父会话继承来的历史前缀），因此每笔计费调用只算一次。',
        footScopeFast: '统计口径：直接读取持久化投影缓存，无法排除继承来的历史，因此会偏高。',
        footGenerated: '生成于 {time}，耗时 {ms} ms（复用 {reused} 个会话、重读 {read} 个）',
        footInherited: '「继承历史」列统计日志开头复制了父会话历史的会话：它们自己通常只产生很少的 token，但整条日志里含有父会话已计费的历史，所以该数越大，「未去重」与去重值的差距就越大。',
        footSubagents: '「子代理」列是该项目的子代理会话总数——其中多数是全新上下文，不会重复计入。',
        footPeriod: '时间筛选依据会话的创建时间（不是每次调用的时间）。',
        footMismatch: '警告：{n} 个会话的自算结果与 DSH 持久化的投影不一致（通常是该会话正在写入）。',
        footProblems: '有 {n} 个会话读取失败，已跳过。',
        footClientMismatch: '警告：本地汇总与宿主返回的合计不一致（{client} vs {host}），请报告此问题。',
        degraded: '宿主端尚未加载新版（重启 DSH 后可用）：当前只显示项目级合计，时间筛选与会话明细暂不可用。',
        error: '统计失败：{error}',
      },
      en: {
        nav: 'Token ledger',
        title: 'Token ledger',
        intro: 'Tokens spent by every project in this DSH installation, grouped by session working directory, each billed call counted once.',
        modeAccurate: 'Accurate',
        modeFast: 'Fast',
        refresh: 'Recount',
        busy: 'Counting…',
        loadingAccurate: 'Reading the session logs that changed… (unchanged sessions reuse the previous result)',
        loadingFast: 'Reading the durable projection cache…',
        periodAll: 'All time',
        period7: 'Last 7 days',
        period30: 'Last 30 days',
        byCreation: 'Filtered by session creation time',
        export: 'Export CSV',
        back: '← Back to conversation',
        cardTotalDedup: 'Total tokens (deduplicated)',
        cardTotalRaw: 'Total tokens (raw)',
        cardOutput: 'Output tokens',
        cardCacheRead: 'Cache read',
        cardUncached: 'Input (uncached)',
        cardCacheWrite: 'Cache write',
        cardSessions: '{sessions} sessions · {projects} projects',
        cardOverlap: '{value} of it from inherited history',
        cardFastNote: 'Fast mode: inherited history cannot be separated',
        cardOutputNote: 'Tokens generated by the model',
        colProject: 'Project',
        colSessions: 'Sessions',
        colSubagents: 'Subagents',
        colSubagentsNote: 'This project\'s total subagent sessions — most start from fresh context and duplicate nothing',
        colInherited: 'Inherited',
        colInheritedNote: 'Sessions in this project whose log begins with a copy of the parent\'s history — the source of the duplicated figures',
        colTokens: 'Tokens',
        colRawTokens: 'Recorded tokens',
        colInput: 'Input',
        colOutput: 'Output',
        colInputNote: 'Input = uncached + cache read + cache write: all three are billed on the input side',
        colOutputNote: 'Tokens generated by the model — the output side',
        colCacheRate: 'Cache rate',
        colCacheRateNote: 'Cache read ÷ input (uncached + cache read + cache write). The same definition the chat stats strip uses, and a partial hit is never shown as 100%',
        cardCacheRate: 'Cache hit rate',
        cardCacheRateNote: 'Cache read {read} / input {input}',
        noBilledInput: 'no billed input',
        colShare: 'Share',
        colTime: 'Time',
        colKind: 'Kind',
        colRoute: 'Model route',
        routesTitle: 'By model route',
        kindUser: 'user',
        kindSubagent: 'subagent',
        kindInherited: 'seeded',
        detailIn: 'in',
        detailOut: 'out',
        detailCache: 'cache',
        expand: 'Show sessions',
        collapse: 'Hide sessions',
        noSessions: 'No sessions in this period.',
        capped: 'Showing the first 50 sessions; export the CSV for the full detail.',
        footSource: 'Source: {source}',
        footScopeDedup: 'Scope: each session counts only its own events (its parent-inherited prefix is skipped), so every billed call is counted once.',
        footScopeFast: 'Scope: read straight from the durable projection cache, which cannot exclude inherited history, so these figures run high.',
        footGenerated: 'Generated at {time} in {ms} ms (reused {reused} sessions, re-read {read})',
        footInherited: '"Inherited" counts sessions whose log begins with a copy of another session\'s history: they usually generate few tokens themselves but carry the parent\'s already-billed history, so a larger number widens the gap between raw and deduplicated totals.',
        footSubagents: '"Subagents" is the project\'s total subagent sessions — most start from fresh context and duplicate nothing.',
        footPeriod: 'The period filter uses each session\'s creation time, not each call\'s time.',
        footMismatch: 'Warning: {n} sessions disagree with DSH\'s persisted projection (usually because the session is being written).',
        footProblems: '{n} sessions could not be read and were skipped.',
        footClientMismatch: 'Warning: the local aggregation disagrees with the host total ({client} vs {host}); please report this.',
        degraded: 'The host half has not reloaded yet (restart DSH): only project-level totals are shown, and the period filter and session detail are unavailable.',
        error: 'Counting failed: {error}',
      },
    }
    //#endregion

    //#region styles
    const CSS = [
      // The section must survive two very different homes: the wide centre column
      // and the settings modal's narrow content column. It is its own query
      // container so the tables can shed decorative columns instead of overflowing.
      '.dtl-section{max-width:960px;width:100%;min-width:0;container-type:inline-size;color:var(--dsw-alias-label-primary);flex-direction:column;gap:14px;display:flex}',
      '.dtl-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap}',
      '.dtl-title{margin:0;font-size:18px;font-weight:600}',
      '.dtl-intro{color:var(--dsw-alias-label-tertiary);margin:4px 0 0;font-size:13px;line-height:20px;max-width:60ch}',
      '.dtl-controls{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.dtl-sep{width:1px;height:18px;background:var(--dsw-alias-border-l2)}',
      '.dtl-btn{font:inherit;font-size:13px;line-height:20px;padding:5px 12px;border-radius:6px;cursor:pointer;color:var(--dsw-alias-label-primary);border:.5px solid var(--dsw-alias-border-l2);background:0 0}',
      '.dtl-btn:hover{border-color:var(--dsw-alias-label-tertiary)}',
      '.dtl-btn:disabled{opacity:.5;cursor:default}',
      '.dtl-btn[data-active=true]{border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-state-business-primary)}',
      '.dtl-btn:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}',
      '.dtl-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}',
      '.dtl-card{border:.5px solid var(--dsw-alias-border-l2);border-radius:10px;padding:12px 14px;display:flex;flex-direction:column;gap:4px}',
      '.dtl-cardLabel{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}',
      '.dtl-cardValue{font-size:22px;font-weight:600;line-height:28px;font-variant-numeric:tabular-nums}',
      '.dtl-cardNote{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}',
      '.dtl-muted{color:var(--dsw-alias-label-tertiary);font-size:13px;margin:0}',
      '.dtl-error{color:var(--dsw-alias-state-error-primary,var(--dsw-alias-label-primary));font-size:13px;margin:0}',
      '.dtl-h3{margin:6px 0 0;font-size:14px;font-weight:600}',
      '.dtl-table{width:100%;border-collapse:collapse;font-size:13px}',
      '.dtl-tableWrap{max-width:100%;overflow-x:auto}',
      '.dtl-table th{color:var(--dsw-alias-label-tertiary);font-weight:500;text-align:right;padding:6px 8px;border-bottom:.5px solid var(--dsw-alias-border-l2);white-space:nowrap}',
      '.dtl-table th:first-child,.dtl-table td:first-child{text-align:left}',
      '.dtl-table td{padding:7px 8px;border-bottom:.5px solid var(--dsw-alias-border-l2);text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}',
      '.dtl-table tr:last-child td{border-bottom:0}',
      '.dtl-rowBtn{font:inherit;color:inherit;background:0 0;border:0;padding:0;cursor:pointer;text-align:left;display:block;max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dtl-rowBtn:hover{text-decoration:underline}',
      '.dtl-name{display:block;max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dtl-cwd{display:block;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:280px}',
      '.dtl-bar{height:6px;border-radius:3px;background:var(--dsw-alias-state-business-primary);min-width:2px;display:block}',
      '.dtl-barCell{width:96px}',
      // Narrow containers, sized from the two real homes: the settings modal is
      // `width:800px` with a 188px nav and 24px content padding, so the section
      // gets ~564px there; the centre column gets whatever the window allows.
      // Measured column budget: all nine columns need ~716px, without the share
      // bar ~620px, without the two diagnostic counts ~490px.
      '@container (max-width:760px){.dtl-barCell{display:none}.dtl-rowBtn,.dtl-name,.dtl-cwd{max-width:140px}}',
      '@container (max-width:640px){.dtl-colDiagnostic{display:none}.dtl-rowBtn,.dtl-name,.dtl-cwd{max-width:120px}}',
      '.dtl-detail{background:0 0}',
      '.dtl-detail td{padding:0 8px 8px;border-bottom:.5px solid var(--dsw-alias-border-l2)}',
      '.dtl-detailBox{border-left:2px solid var(--dsw-alias-border-l2);padding:6px 0 6px 10px;max-height:320px;overflow:auto}',
      '.dtl-badge{display:inline-block;font-size:11px;line-height:16px;padding:0 6px;border-radius:4px;border:.5px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-tertiary)}',
      '.dtl-mono{font-family:var(--ds-font-family-code,monospace);font-size:11px;color:var(--dsw-alias-label-tertiary)}',
      '.dtl-foot{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;margin:0}',
      '.dtl-panel{box-sizing:border-box;height:100%;overflow:auto;padding:20px clamp(24px,4vw,48px) 48px}',
    ].join('')

    const STYLE_ID = 'dsh-token-ledger/SettingsSection.css'
    if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(STYLE_ID) + ']') === null) {
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-token-ledger'
      tag.dataset.pluginCss = STYLE_ID
      tag.textContent = CSS
      document.head.appendChild(tag)
    }
    //#endregion

    //#region formatting
    /** Compact scale figure for large counts. */
    function compact(value, locale) {
      if (typeof value !== 'number') return '—'
      if (locale === 'zh') {
        if (Math.abs(value) >= 1e8) return (value / 1e8).toFixed(2) + ' 亿'
        if (Math.abs(value) >= 1e4) return (value / 1e4).toFixed(1) + ' 万'
      } else {
        if (Math.abs(value) >= 1e9) return (value / 1e9).toFixed(2) + 'B'
        if (Math.abs(value) >= 1e6) return (value / 1e6).toFixed(2) + 'M'
        if (Math.abs(value) >= 1e3) return (value / 1e3).toFixed(1) + 'K'
      }
      return value.toLocaleString('en-US')
    }

    /** Exact figure with thousands separators. */
    function exact(value) {
      return typeof value === 'number' ? value.toLocaleString('en-US') : '—'
    }

    /** Local wall-clock time for one host timestamp. */
    function clock(ms) {
      if (typeof ms !== 'number') return '—'
      const date = new Date(ms)
      const pad = (n) => String(n).padStart(2, '0')
      return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    }

    /** Short local date-time for one session timestamp. */
    function stamp(ms) {
      if (typeof ms !== 'number') return '—'
      const date = new Date(ms)
      const pad = (n) => String(n).padStart(2, '0')
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
    }

    /** Substitute `{name}` placeholders in one dictionary string. */
    function fill(template, params) {
      return template.replace(/\{(\w+)\}/gu, (_, key) => String(params[key] ?? ''))
    }

    /** The four billed buckets of one bucket set, in reporting order. */
    function bucketList(buckets) {
      if (buckets === null || buckets === undefined) return []
      return [
        ['cardUncached', buckets.uncachedInputTokens],
        ['cardCacheRead', buckets.cacheReadTokens],
        ['cardCacheWrite', buckets.cacheWriteTokens],
        ['cardOutput', buckets.outputTokens],
      ]
    }

    /** Sum a list of bucket sets. */
    function sumBuckets(list) {
      return list.reduce((accumulator, buckets) => ({
        uncachedInputTokens: accumulator.uncachedInputTokens + (buckets?.uncachedInputTokens ?? 0),
        outputTokens: accumulator.outputTokens + (buckets?.outputTokens ?? 0),
        cacheReadTokens: accumulator.cacheReadTokens + (buckets?.cacheReadTokens ?? 0),
        cacheWriteTokens: accumulator.cacheWriteTokens + (buckets?.cacheWriteTokens ?? 0),
      }), { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })
    }

    /** One scalar for sorting and display. */
    const bucketTotal = (buckets) => buckets === null || buckets === undefined
      ? 0
      : buckets.uncachedInputTokens + buckets.cacheReadTokens + buckets.cacheWriteTokens + buckets.outputTokens

    /**
     * Input-side tokens: every bucket the provider bills as prompt. Cache reads
     * and writes are input traffic, not a separate category, so the panel adds
     * them here and still shows the four buckets separately in the cards.
     */
    const inputOf = (buckets) => buckets === null || buckets === undefined
      ? 0
      : buckets.uncachedInputTokens + buckets.cacheReadTokens + buckets.cacheWriteTokens

    /** Output-side tokens: what the model generated. */
    const outputOf = (buckets) => (buckets === null || buckets === undefined ? 0 : buckets.outputTokens)

    /** The four buckets as `title` detail for a cell that shows their sum. */
    const bucketsTitle = (buckets) => buckets === null || buckets === undefined
      ? ''
      : [
        `输入·未命中缓存 ${exact(buckets.uncachedInputTokens)}`,
        `输入·缓存读取 ${exact(buckets.cacheReadTokens)}`,
        `输入·缓存写入 ${exact(buckets.cacheWriteTokens)}`,
        `输出 ${exact(buckets.outputTokens)}`,
      ].join('\n')

    //#region cache-hit share
    // Ported verbatim from the shipped chat bundle so this page shows the SAME
    // number as the conversation's own "cache hit" figure. Round a cache-read
    // ratio to exact percentage units, with positive ties rounded up.
    function roundedPercentUnits(cacheReadTokens, denominator, decimalPlaces) {
      const scale = (decimalPlaces === 0 ? 1 : 10) * 100
      const doubledScale = scale * 2
      const denominatorQuotient = Math.floor(denominator / doubledScale)
      const denominatorRemainder = denominator % doubledScale
      let lower = 0
      let upper = scale
      while (lower < upper) {
        const candidate = Math.floor((lower + upper + 1) / 2)
        const factor = candidate * 2 - 1
        const threshold = factor * denominatorQuotient + Math.ceil((factor * denominatorRemainder) / doubledScale)
        if (cacheReadTokens >= threshold) lower = candidate
        else upper = candidate - 1
      }
      return lower
    }

    /** Render exact percentage units at the requested precision. */
    function displayPercentUnits(units, decimalPlaces) {
      if (decimalPlaces === 0) return String(units)
      const whole = Math.floor(units / 10)
      const tenths = units % 10
      return tenths === 0 ? String(whole) : `${whole}.${tenths}`
    }

    /**
     * Display-ready cache-hit share without rounding a partial hit to 100%.
     *
     * @param cacheReadTokens - exact prompt tokens served from cache.
     * @param promptTokens - exact aggregate prompt tokens.
     * @param decimalPlaces - ordinary-ratio precision; a partial hit that would
     *   round to 100 automatically uses enough precision to stay honest.
     * @returns percentage text, or null when there was no billed input.
     */
    function formatCacheHitPercent(cacheReadTokens, promptTokens, decimalPlaces = 0) {
      if (promptTokens === 0) return null
      const missedInputTokens = promptTokens - cacheReadTokens
      if (missedInputTokens === 0) return '100'
      const roundedUnits = roundedPercentUnits(cacheReadTokens, promptTokens, decimalPlaces)
      if (roundedUnits < (decimalPlaces === 0 ? 100 : 1e3)) return displayPercentUnits(roundedUnits, decimalPlaces)
      let distinguishingPlaces = 1
      let scaledDoubleGap = missedInputTokens * 200
      const denominatorTens = Math.floor(promptTokens / 10)
      while (scaledDoubleGap <= denominatorTens) {
        scaledDoubleGap *= 10
        distinguishingPlaces += 1
      }
      const denominatorOnes = promptTokens % 10
      let roundedLoss = 5
      for (let loss = 1; loss < 5; loss += 1) {
        const factor = loss * 2 + 1
        const threshold = factor * denominatorTens + Math.floor((factor * denominatorOnes) / 10)
        if (scaledDoubleGap <= threshold) {
          roundedLoss = loss
          break
        }
      }
      return `99.${'9'.repeat(distinguishingPlaces - 1)}${10 - roundedLoss}`
    }

    /**
     * The cache-hit share of one bucket set, at one decimal place — the same
     * precision the chat's per-turn usage panel uses.
     *
     * @param buckets - a row's four billing buckets.
     * @returns percentage text, or null when the row billed no input.
     */
    const cacheHitOf = (buckets) => buckets === null || buckets === undefined
      ? null
      : formatCacheHitPercent(buckets.cacheReadTokens, inputOf(buckets), 1)
    //#endregion

    /** RFC 4180 escaping. */
    function csvCell(value) {
      const text = value === null || value === undefined ? '' : String(value)
      return /[",\r\n]/u.test(text) ? `"${text.replace(/"/gu, '""')}"` : text
    }

    /** Build the long-format CSV of the current view for spreadsheet analysis. */
    function buildCsv(view, data, locale) {
      const header = [
        'session_id', 'project', 'cwd', 'created_at', 'origin', 'is_seeded', 'inherited_events',
        'uncached_input_tokens', 'cache_read_tokens', 'cache_write_tokens', 'output_tokens',
        'own_total_tokens', 'reported_total_tokens',
      ]
      const lines = [header.join(',')]
      for (const session of view.sessions) {
        const own = session.own ?? { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 }
        lines.push([
          session.id,
          session.name,
          session.cwd ?? '',
          typeof session.createdAt === 'number' ? new Date(session.createdAt).toISOString() : '',
          session.origin,
          session.isSeeded ? 'yes' : 'no',
          session.inheritedEventCount,
          own.uncachedInputTokens,
          own.cacheReadTokens,
          own.cacheWriteTokens,
          own.outputTokens,
          bucketTotal(session.own),
          bucketTotal(session.reported),
        ].map(csvCell).join(','))
      }
      const totals = view.totals
      lines.push(['TOTAL', '', '', '', '', '', '', '', '', '', '', totals.totalTokens, totals.reportedTotalTokens].map(csvCell).join(','))
      lines.push('')
      lines.push(['# mode', data.mode, 'deduped', String(data.deduped), 'generated_at', new Date(data.generatedAt).toISOString(), 'locale', locale].map(csvCell).join(','))
      // A BOM keeps Excel from mangling non-ASCII project names.
      return '\uFEFF' + lines.join('\r\n')
    }

    /** Hand the CSV to the browser as a download. */
    function downloadCsv(text, name) {
      const blob = new Blob([text], { type: 'text/csv;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = name
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      setTimeout(() => URL.revokeObjectURL(url), 0)
    }
    //#endregion

    //#region derivation
    /**
     * Aggregate the host's per-session rows into every view the page shows. One
     * code path serves the unfiltered and the filtered cases alike.
     *
     * @param data - the host payload.
     * @param period - `all`, `7`, or `30` days before now.
     * @param now - reference timestamp for the period filter.
     * @returns totals, per-project rows, per-route rows, and the filtered sessions.
     */
    function deriveView(data, period, now) {
      // An older host half returns aggregates but no per-session rows. The client
      // half reloads on a page refresh while the host half only reloads on a
      // restart, so both orders must render something truthful.
      if (!Array.isArray(data.sessions)) {
        const projects = (data.projects ?? []).map((project) => ({
          cwd: project.cwd ?? null,
          name: project.name,
          sessions: project.sessions ?? 0,
          forks: project.forks ?? 0,
          subagents: project.subagentSessions ?? 0,
          own: project.own ?? null,
          reported: project.reported ?? null,
          ...((data.deduped ? project.own : project.reported) ?? {}),
          totalTokens: project.ownTotalTokens ?? project.reportedTotalTokens ?? 0,
          reportedTotalTokens: project.reportedTotalTokens ?? 0,
        }))
        const totals = {
          own: data.totals?.own ?? null,
          reported: data.totals?.reported ?? null,
          deduped: data.deduped,
          totalTokens: data.totals?.ownTotalTokens ?? data.totals?.reportedTotalTokens ?? 0,
          reportedTotalTokens: data.totals?.reportedTotalTokens ?? 0,
          overlapTokens: data.totals?.overlapTokens ?? 0,
        }
        return { sessions: [], projects, routes: data.routes ?? [], totals, degraded: true }
      }

      const cutoff = period === 'all' ? null : now - Number(period) * DAY
      const sessions = (data.sessions ?? []).filter((session) => cutoff === null
        || (typeof session.createdAt === 'number' && session.createdAt >= cutoff))

      const projects = new Map()
      const routes = new Map()
      const ownList = []
      const reportedList = []

      for (const session of sessions) {
        const cwd = session.cwd ?? ''
        let project = projects.get(cwd)
        if (project === undefined) {
          project = { cwd: session.cwd, name: session.name, sessions: 0, forks: 0, subagents: 0, own: [], reported: [] }
          projects.set(cwd, project)
        }
        project.sessions += 1
        if (session.isSeeded) project.forks += 1
        if (session.origin === 'subagent') project.subagents += 1
        ownList.push(session.own)
        reportedList.push(session.reported)
        project.own.push(session.own)
        project.reported.push(session.reported)

        for (const entry of session.byRoute ?? []) {
          const buckets = routes.get(entry.route) ?? []
          routes.set(entry.route, [...buckets, entry])
        }
      }

      const totals = {
        own: sumBuckets(ownList),
        reported: sumBuckets(reportedList),
        deduped: data.deduped,
      }
      totals.totalTokens = bucketTotal(totals.own)
      totals.reportedTotalTokens = bucketTotal(totals.reported)
      totals.overlapTokens = totals.reportedTotalTokens - totals.totalTokens

      // Every row type exposes the four billing buckets flattened, plus a
      // `totalTokens` that is the figure THIS view displays (deduplicated in
      // accurate mode, recorded in fast mode). Keeping one shape for projects,
      // routes and sessions is what lets the input/output columns be plain sums.
      const projectRows = [...projects.values()]
        .map((project) => {
          const own = sumBuckets(project.own)
          const reported = sumBuckets(project.reported)
          const display = data.deduped ? own : reported
          return {
            cwd: project.cwd,
            name: project.name,
            sessions: project.sessions,
            forks: project.forks,
            subagents: project.subagents,
            own,
            reported,
            ...display,
            totalTokens: bucketTotal(display),
            reportedTotalTokens: bucketTotal(reported),
          }
        })
        .sort((left, right) => right.totalTokens - left.totalTokens || left.name.localeCompare(right.name))

      const routeRows = [...routes.entries()]
        .map(([route, entries]) => {
          const buckets = sumBuckets(entries)
          return { route, ...buckets, totalTokens: bucketTotal(buckets) }
        })
        .sort((left, right) => right.totalTokens - left.totalTokens || left.route.localeCompare(right.route))

      const sessionRows = [...sessions]
        .sort((left, right) => bucketTotal(data.deduped ? right.own : right.reported) - bucketTotal(data.deduped ? left.own : left.reported))
        .map((session) => {
          const display = (data.deduped ? session.own : session.reported) ?? {}
          return {
            ...session,
            ...display,
            totalTokens: bucketTotal(display),
            reportedTotalTokens: bucketTotal(session.reported),
          }
        })

      return { sessions: sessionRows, projects: projectRows, routes: routeRows, totals, degraded: false }
    }
    //#endregion

    //#region panel
    const h = React.createElement

    /**
     * Decorative glyph for the sidebar's global-panel row.
     *
     * The shell owns the row button, its label, the tooltip and the click, and
     * renders this as the row's DIRECT icon child — wrapping it in an element
     * would break the row's glyph slot baseline.
     */
    function LedgerPanelIcon({ size }) {
      const edge = typeof size === 'number' ? size : 18
      return h('svg', {
        width: edge,
        height: edge,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.6,
        strokeLinecap: 'round',
        'aria-hidden': 'true',
        focusable: 'false',
      },
        h('path', { key: 'axis', d: 'M4 19V5' }),
        h('path', { key: 'floor', d: 'M4 19h16' }),
        h('path', { key: 'bars', d: 'M8 19v-5M12.5 19V8M17 19v-3' }),
      )
    }

    /**
     * The ledger hosted by the centre column instead of the settings modal: the
     * slot outlet uses `display: contents`, so this element is a direct flex child
     * of the frame column and must own its height and scrolling. `onClose` comes
     * from this registration's inject face — the settings modal supplies its own
     * chrome instead and gets no such prop.
     */
    function LedgerPanel(props) {
      return h('div', { className: 'dtl-panel' }, h(LedgerSection, props))
    }

    /** The Settings page, and the centre-column page. */
    function LedgerSection({ t, onClose }) {
      // The slot renderer hands a component only `t` — no locale tag. A locale
      // switch mints a NEW bound `t`, so the language actually being displayed is
      // whatever dictionary `t` resolves, and number formatting follows it in the
      // same render as the words.
      const translate = typeof t === 'function' ? t : (key) => key
      const language = translate('nav') === DICTIONARIES.zh.nav ? 'zh' : 'en'
      const [state, setState] = React.useState({ status: 'loading' })
      const [mode, setMode] = React.useState('accurate')
      const [period, setPeriod] = React.useState('all')
      const [expanded, setExpanded] = React.useState(() => new Set())
      // A refresh is consumed by the request it triggers.
      const [request, setRequest] = React.useState({ seq: 0, refresh: false })

      const dict = DICTIONARIES[language]
      const text = React.useCallback((key, params) => fill(dict[key] ?? key, params ?? {}), [dict])

      /** One `缓存率` cell, shared by the project and route tables. */
      const rateCell = (buckets, key) => {
        const rate = cacheHitOf(buckets)
        return h('td', {
          key,
          title: rate === null
            ? text('noBilledInput')
            : text('cardCacheRateNote', {
              read: exact(buckets?.cacheReadTokens ?? 0),
              input: exact(inputOf(buckets)),
            }),
        }, rate === null ? '—' : rate + '%')
      }
      React.useEffect(() => {
        let cancelled = false
        const controller = new AbortController()
        setState((prev) => ({ status: 'loading', data: prev.data, error: prev.error }))
        const url = SUMMARY_URL + '?mode=' + mode + (request.refresh ? '&refresh=1' : '')
        fetch(url, { signal: controller.signal })
          .then((response) => response.json())
          .then((payload) => {
            if (cancelled) return
            if (payload.ok !== true) setState({ status: 'error', error: payload.error ?? 'unknown host failure', data: payload })
            else setState({ status: 'ready', data: payload })
          })
          .catch((error) => {
            if (cancelled || error?.name === 'AbortError') return
            setState({ status: 'error', error: String(error?.message ?? error) })
          })
        return () => {
          cancelled = true
          controller.abort()
        }
      }, [mode, request])

      const data = state.data
      const ready = data !== undefined && data.ok === true
      const busy = state.status === 'loading'
      const view = React.useMemo(() => (ready ? deriveView(data, period, Date.now()) : null), [data, ready, period])

      const toggleProject = (key) => setExpanded((prev) => {
        const next = new Set(prev)
        if (next.has(key)) next.delete(key)
        else next.add(key)
        return next
      })

      const header = h('div', { className: 'dtl-head' },
        h('div', null,
          h('h2', { className: 'dtl-title' }, text('title')),
          h('p', { className: 'dtl-intro' }, text('intro')),
        ),
        h('div', { className: 'dtl-controls' },
          typeof onClose === 'function' ? h('button', {
            type: 'button',
            className: 'dtl-btn',
            onClick: onClose,
          }, text('back')) : null,
          h('button', {
            type: 'button',
            className: 'dtl-btn',
            'data-active': mode === 'accurate' ? 'true' : 'false',
            disabled: busy,
            onClick: () => setMode('accurate'),
          }, text('modeAccurate')),
          h('button', {
            type: 'button',
            className: 'dtl-btn',
            'data-active': mode === 'fast' ? 'true' : 'false',
            disabled: busy,
            onClick: () => setMode('fast'),
          }, text('modeFast')),
          h('span', { className: 'dtl-sep' }),
          ...['all', '30', '7'].map((key) => h('button', {
            key,
            type: 'button',
            className: 'dtl-btn',
            'data-active': period === key ? 'true' : 'false',
            title: text('byCreation'),
            disabled: view === null || view.degraded,
            onClick: () => setPeriod(key),
          }, text(key === 'all' ? 'periodAll' : key === '30' ? 'period30' : 'period7'))),
          h('span', { className: 'dtl-sep' }),
          h('button', {
            type: 'button',
            className: 'dtl-btn',
            disabled: busy,
            onClick: () => setRequest((prev) => ({ seq: prev.seq + 1, refresh: true })),
          }, busy ? text('busy') : text('refresh')),
          h('button', {
            type: 'button',
            className: 'dtl-btn',
            disabled: view === null || view.degraded || view.sessions.length === 0,
            onClick: () => {
              if (view === null) return
              const day = new Date().toISOString().slice(0, 10)
              downloadCsv(buildCsv(view, data, language), `dsh-token-ledger-${day}.csv`)
            },
          }, text('export')),
        ),
      )

      const body = []

      if (ready && view !== null) {
        const totals = view.totals
        const value = data.deduped ? totals.totalTokens : totals.reportedTotalTokens
        // Both modes bill input the same way, so the rate is computable from
        // whichever figure this view displays.
        const shownBuckets = data.deduped ? totals.own : totals.reported
        const cacheHit = cacheHitOf(shownBuckets)

        body.push(h('div', { className: 'dtl-cards', key: 'cards' },
          h('div', { className: 'dtl-card' },
            h('span', { className: 'dtl-cardLabel' }, data.deduped ? text('cardTotalDedup') : text('cardTotalRaw')),
            h('span', { className: 'dtl-cardValue', title: exact(value) }, compact(value, language)),
            h('span', { className: 'dtl-cardNote' }, text('cardSessions', { sessions: view.sessions.length, projects: view.projects.length })),
          ),
          h('div', { className: 'dtl-card' },
            h('span', { className: 'dtl-cardLabel' }, text('cardTotalRaw')),
            h('span', { className: 'dtl-cardValue', title: exact(totals.reportedTotalTokens) }, compact(totals.reportedTotalTokens, language)),
            h('span', { className: 'dtl-cardNote' }, data.deduped
              ? text('cardOverlap', { value: compact(totals.overlapTokens, language) })
              : text('cardFastNote')),
          ),
          // The cache-hit share is the cost lever: cache reads bill far below
          // uncached input, so this one number explains most of a bill.
          h('div', { className: 'dtl-card' },
            h('span', { className: 'dtl-cardLabel' }, text('cardCacheRate')),
            h('span', {
              className: 'dtl-cardValue',
              title: text('colCacheRateNote'),
            }, cacheHit === null ? '—' : cacheHit + '%'),
            h('span', { className: 'dtl-cardNote' }, cacheHit === null
              ? text('noBilledInput')
              : text('cardCacheRateNote', {
                read: compact(shownBuckets.cacheReadTokens, language),
                input: compact(inputOf(shownBuckets), language),
              })),
          ),
        ))

        const breakdown = bucketList(data.deduped ? totals.own : totals.reported)
          .filter(([, count]) => count !== 0)
        if (breakdown.length > 0) {
          body.push(h('div', { className: 'dtl-cards', key: 'breakdown' },
            breakdown.map(([key, count]) => h('div', { className: 'dtl-card', key },
              h('span', { className: 'dtl-cardLabel' }, text(key)),
              h('span', { className: 'dtl-cardValue', style: { fontSize: '17px', lineHeight: '23px' }, title: exact(count) }, compact(count, language)),
            )),
          ))
        }

        const maxProject = view.projects.reduce((max, project) => Math.max(max, project.totalTokens), 0)

        if (view.projects.length === 0) {
          body.push(h('p', { className: 'dtl-muted', key: 'empty' }, text('noSessions')))
        } else {
          body.push(h('div', { className: 'dtl-tableWrap', key: 'projects' },
            h('table', { className: 'dtl-table' },
            h('thead', null, h('tr', null,
              h('th', null, text('colProject')),
              h('th', null, text('colSessions')),
              h('th', { className: 'dtl-colDiagnostic', title: text('colSubagentsNote') }, text('colSubagents')),
              h('th', { className: 'dtl-colDiagnostic', title: text('colInheritedNote') }, text('colInherited')),
              h('th', { title: text('colInputNote') }, text('colInput')),
              h('th', { title: text('colOutputNote') }, text('colOutput')),
              h('th', null, data.deduped ? text('colTokens') : text('colRawTokens')),
              h('th', { title: text('colCacheRateNote') }, text('colCacheRate')),
              h('th', { className: 'dtl-barCell' }, text('colShare')),
            )),
            h('tbody', null, view.projects.flatMap((project) => {
              const key = project.cwd ?? project.name
              const shown = project.totalTokens
              const share = maxProject > 0 ? Math.max(2, Math.round((shown / maxProject) * 100)) : 0
              const isOpen = !view.degraded && expanded.has(key)
              const rows = [h('tr', { key },
                h('td', null,
                  view.degraded
                    ? h('span', { className: 'dtl-name', title: project.cwd ?? project.name }, project.name)
                    : h('button', {
                      type: 'button',
                      className: 'dtl-rowBtn',
                      'aria-expanded': isOpen ? 'true' : 'false',
                      title: isOpen ? text('collapse') : text('expand'),
                      onClick: () => toggleProject(key),
                    }, (isOpen ? '▾ ' : '▸ ') + project.name),
                  project.cwd === null ? null : h('span', { className: 'dtl-cwd', title: project.cwd }, project.cwd),
                ),
                h('td', null, String(project.sessions)),
                h('td', { className: 'dtl-colDiagnostic' }, project.subagents > 0 ? String(project.subagents) : '—'),
                h('td', { className: 'dtl-colDiagnostic' }, project.forks > 0 ? String(project.forks) : '—'),
                h('td', { title: bucketsTitle(project) }, compact(inputOf(project), language)),
                h('td', { title: bucketsTitle(project) }, compact(outputOf(project), language)),
                h('td', { title: exact(shown) + '\n' + bucketsTitle(project) }, compact(shown, language)),
                rateCell(project),
                h('td', { className: 'dtl-barCell' }, h('span', { className: 'dtl-bar', style: { width: share + '%' } })),
              )]

              if (isOpen) {
                const own = view.sessions.filter((session) => (session.cwd ?? '') === (project.cwd ?? ''))
                const shownSessions = own.slice(0, 50)
                rows.push(h('tr', { key: key + ':detail', className: 'dtl-detail' },
                  h('td', { colSpan: 9 },
                    h('div', { className: 'dtl-detailBox' },
                      shownSessions.map((session) => h('div', { key: session.id, style: { display: 'flex', gap: '10px', alignItems: 'baseline', padding: '2px 0' } },
                        h('span', { className: 'dtl-mono', style: { minWidth: '110px' } }, stamp(session.createdAt)),
                        h('span', { className: 'dtl-badge' }, text(session.origin === 'subagent' ? 'kindSubagent' : 'kindUser')),
                        session.isSeeded ? h('span', { className: 'dtl-badge' }, text('kindInherited')) : null,
                        h('span', { className: 'dtl-mono', style: { flex: '1 1 auto', overflow: 'hidden', textOverflow: 'ellipsis' } }, session.id),
                        h('span', { className: 'dtl-mono', style: { flex: 'none' }, title: bucketsTitle(session) },
                          text('detailIn') + ' ' + compact(inputOf(session), language)
                          + ' · ' + text('detailOut') + ' ' + compact(outputOf(session), language)
                          + (cacheHitOf(session) === null
                            ? ''
                            : ' · ' + text('detailCache') + ' ' + cacheHitOf(session) + '%')),
                        h('span', { style: { flex: 'none', minWidth: '80px', textAlign: 'right' }, title: exact(session.totalTokens) },
                          compact(session.totalTokens, language)),
                      )),
                      own.length > shownSessions.length ? h('p', { className: 'dtl-muted' }, text('capped')) : null,
                    ),
                  ),
                ))
              }
              return rows
            })),
          )))
        }

        if (data.deduped && view.routes.length > 0) {
          const maxRoute = view.routes[0].totalTokens
          body.push(h('h3', { className: 'dtl-h3', key: 'routesTitle' }, text('routesTitle')))
          body.push(h('div', { className: 'dtl-tableWrap', key: 'routes' },
            h('table', { className: 'dtl-table' },
            h('thead', null, h('tr', null,
              h('th', null, text('colRoute')),
              h('th', { title: text('colInputNote') }, text('colInput')),
              h('th', { title: text('colOutputNote') }, text('colOutput')),
              h('th', null, text('colTokens')),
              h('th', { title: text('colCacheRateNote') }, text('colCacheRate')),
              h('th', { className: 'dtl-barCell' }, text('colShare')),
            )),
            h('tbody', null, view.routes.map((route) => h('tr', { key: route.route },
              h('td', null, h('span', { className: 'dtl-mono' }, route.route)),
              h('td', { title: bucketsTitle(route) }, compact(inputOf(route), language)),
              h('td', { title: bucketsTitle(route) }, compact(outputOf(route), language)),
              h('td', { title: exact(route.totalTokens) + '\n' + bucketsTitle(route) }, compact(route.totalTokens, language)),
              rateCell(route),
              h('td', { className: 'dtl-barCell' }, h('span', { className: 'dtl-bar', style: { width: Math.max(2, Math.round((route.totalTokens / maxRoute) * 100)) + '%' } })),
            ))),
          )))
        }

        const notes = []
        notes.push(text('footSource', { source: data.source }))
        notes.push(data.deduped ? text('footScopeDedup') : text('footScopeFast'))
        notes.push(text('footGenerated', {
          time: clock(data.generatedAt),
          ms: data.durationMs,
          reused: data.sessionsReused ?? 0,
          read: data.sessionsRead ?? 0,
        }))
        if (period !== 'all') notes.push(text('footPeriod'))
        if (view.degraded) notes.push(text('degraded'))
        if (data.forkCount > 0) notes.push(text('footInherited'))
        if (data.subagentCount > 0) notes.push(text('footSubagents'))
        if (data.foldMismatches > 0) notes.push(text('footMismatch', { n: data.foldMismatches }))
        if ((data.problems ?? []).length > 0) notes.push(text('footProblems', { n: data.problems.length }))
        // The page aggregates the same rows the host did; disagreement is a bug
        // worth showing rather than hiding.
        if (period === 'all' && data.deduped && typeof data.totals?.ownTotalTokens === 'number'
          && data.totals.ownTotalTokens !== view.totals.totalTokens) {
          notes.push(text('footClientMismatch', { client: exact(view.totals.totalTokens), host: exact(data.totals.ownTotalTokens) }))
        }
        body.push(h('p', { className: 'dtl-foot', key: 'foot' }, notes.join(' ')))
      } else if (busy) {
        body.push(h('p', { className: 'dtl-muted', key: 'loading' },
          text(mode === 'accurate' ? 'loadingAccurate' : 'loadingFast')))
      } else if (state.status === 'error') {
        body.push(h('p', { className: 'dtl-error', key: 'error' }, text('error', { error: String(state.error) })))
      }

      return h('div', { className: 'dtl-section' }, header, ...body)
    }
    //#endregion

    //#region activation
    /** The slot registry is the page's purpose; locale gives it translated text. */
    const inject = ['slots', 'locale']

    /**
     * Register the Settings page and this plugin's dictionaries.
     *
     * @param ctx - client context carrying the slot and locale registries.
     */
    function apply(ctx) {
      const t = ctx.locale.bind(NS)
      ctx.effect(() => {
        try {
          return ctx.locale.register(NS, DICTIONARIES)
        } catch (error) {
          // A failed dictionary leaves keys visible but must never abort the page
          // boot, which is what an escaping apply throw would do.
          console.error('dsh-token-ledger: locale registration failed', error)
          return () => {}
        }
      }, 'dsh-token-ledger: dictionaries')

      ctx.slots.inject(SECTION, () => ctx.slots.register({
        name: SECTION,
        id: 'token-ledger',
        order: 45,
        label: () => t('nav'),
        locale: NS,
      }, LedgerSection))

      // The sidebar row and the panel it opens are registered together with the
      // same id: the shell's row button calls `selectPanel(id)`, and the layout
      // throws if no `main` entry claims that key.
      ctx.slots.inject(MAIN, () => ctx.slots.register({
        name: MAIN,
        key: PANEL_ID,
        locale: NS,
        // `layout` is read optionally rather than declared in `inject`: a missing
        // service would leave this fiber pending and abort the whole page boot,
        // which a "back" button must never be able to cause.
        inject: () => ({ onClose: () => ctx.get('layout')?.selectPanel(null) }),
      }, LedgerPanel))

      ctx.slots.inject(PANELLIST, () => ctx.slots.register({
        name: PANELLIST,
        id: PANEL_ID,
        order: 60,
        label: () => t('nav'),
        locale: NS,
      }, LedgerPanelIcon))
    }

    // Exported so the derivation and the CSV writer can be exercised in Node
    // without a browser; only `apply`/`inject` matter to the slot renderer.
    exports.LedgerSection = LedgerSection
    exports.LedgerPanel = LedgerPanel
    exports.LedgerPanelIcon = LedgerPanelIcon
    exports.PANEL_ID = PANEL_ID
    exports.deriveView = deriveView
    exports.cacheHitPercent = formatCacheHitPercent
    exports.buildCsv = buildCsv
    exports.DICTIONARIES = DICTIONARIES
    exports.apply = apply
    exports.inject = inject
    exports.SUMMARY_URL = SUMMARY_URL
    return module.exports
  },
})
