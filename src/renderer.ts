import type {
  CustomQuotaSection,
  DeclarativeNode,
  LocalizedString,
  MetricDisplayMode,
  OpenFoxProviderInfo,
  PluginBadgeTone,
  QuotaGaugeInfo,
  QuotaMetric,
  QuotaModalOverride,
  QuotaProviderAssignment,
  QuotaSource,
} from './types.js'

/**
 * Check if a single metric is at or over limit.
 */
export function isQuotaMetricOverLimit(metric: QuotaMetric): boolean {
  if (metric.kind === 'currency') {
    return metric.tone === 'danger'
  }
  if (metric.kind === 'windowed') {
    return metric.used >= metric.limit
  }
  return metric.remaining <= 0
}

/**
 * Compute normalized percentage and stats for a metric.
 */
export function computeMetricPct(m: QuotaMetric): {
  used: number
  limit: number
  remaining: number
  pct: number
  tone: PluginBadgeTone
  short: string
} {
  if (m.kind === 'currency') {
    const used = 0
    const limit = m.amount
    const remaining = m.amount
    const pct = 0
    const tone: PluginBadgeTone = m.tone ?? 'info'
    const short = m.model || m.label || 'Quota'
    return { used, limit, remaining, pct, tone, short }
  }

  const isCurrencyUnit = m.unit === '$' || Boolean((m as any).currency)
  const used = m.kind === 'windowed' ? m.used : m.total - m.remaining
  const limit = m.kind === 'windowed' ? m.limit : m.total
  const remaining = m.kind === 'windowed' ? Math.max(0, m.limit - m.used) : m.remaining
  const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0
  const tone: PluginBadgeTone = isQuotaMetricOverLimit(m)
    ? 'danger'
    : isCurrencyUnit
      ? ((m as any).tone ?? (remaining > 0 ? 'success' : 'danger'))
      : pct >= 80
        ? 'warning'
        : 'info'
  const short = m.model || m.label || 'Quota'

  return { used, limit, remaining, pct, tone, short }
}

/**
 * Format a metric's value for display in Value mode badges.
 */
export function formatMetricValue(m: QuotaMetric): LocalizedString {
  if (m.formattedValue) {
    if (typeof m.formattedValue === 'string') {
      return { en: m.formattedValue, fr: m.formattedValue }
    }
    return m.formattedValue
  }

  if (m.kind === 'currency') {
    const isEur = m.currency === 'EUR' || m.currency === '€'
    const formatted = isEur ? `${m.amount.toFixed(2)} €` : `$${m.amount.toFixed(2)}`
    return { en: formatted, fr: formatted }
  }

  if (m.kind === 'token-balance') {
    if (m.unit === '$' || (m as any).currency === 'USD' || (m as any).currency === '$') {
      const formatted = `$${m.remaining.toFixed(2)}`
      return { en: formatted, fr: formatted }
    }
    if ((m as any).currency === 'EUR' || (m as any).currency === '€') {
      const formatted = `${m.remaining.toFixed(2)} €`
      return { en: formatted, fr: formatted }
    }
    const rem = formatNumber(m.remaining)
    return { en: rem, fr: rem }
  }

  // windowed
  if (m.unit === '$') {
    const formatted = `$${m.used.toFixed(2)}`
    return { en: formatted, fr: formatted }
  }
  const formatted = `${formatNumber(m.used)} / ${formatNumber(m.limit)}`
  return { en: formatted, fr: formatted }
}

/**
 * Build a standard QuotaGaugeInfo object from a QuotaMetric.
 */
export function buildQuotaGaugeInfo(
  m: QuotaMetric,
  overrideMode?: MetricDisplayMode,
): QuotaGaugeInfo {
  const stat = computeMetricPct(m)
  const windowLabel = m.kind === 'windowed' ? m.window : undefined
  const resetsAt = m.kind === 'windowed' ? m.resetsAt : undefined
  const displayMode: MetricDisplayMode = overrideMode ?? m.displayMode ?? 'gauge'
  const formattedValue = formatMetricValue(m)

  return {
    model: stat.short,
    label: m.label,
    pct: stat.pct,
    tone: stat.tone,
    used: stat.used,
    limit: stat.limit,
    remaining: stat.remaining,
    window: windowLabel,
    resetsAt,
    svg: renderCircularGaugeSvg(stat.pct, stat.tone, 16),
    icon: m.icon,
    displayMode,
    formattedValue,
  }
}

/**
 * Check if any source has metrics over limit.
 */
export function hasQuotaWarning(sources: QuotaSource[]): boolean {
  return sources.some((source) => source.metrics.some(isQuotaMetricOverLimit))
}

function formatNumber(n: number): string {
  return n.toLocaleString('en-US')
}

function getWindowLabel(window: 'hour' | 'day' | 'week' | 'month'): LocalizedString {
  switch (window) {
    case 'hour':
      return { en: 'per hour', fr: 'par heure' }
    case 'day':
      return { en: 'per day', fr: 'par jour' }
    case 'week':
      return { en: 'per week', fr: 'par semaine' }
    case 'month':
      return { en: 'per month', fr: 'par mois' }
  }
}

/**
 * Renders a circular SVG radial progress gauge with colored stroke.
 */
export function renderCircularGaugeSvg(pct: number, tone: PluginBadgeTone = 'info', size = 18): string {
  const strokeWidth = 2.6
  const radius = (size - strokeWidth) / 2
  const circumference = 2 * Math.PI * radius
  const offset = circumference - (pct / 100) * circumference
  const strokeColor =
    tone === 'danger'
      ? '#ef4444'
      : tone === 'warning'
        ? '#f59e0b'
        : tone === 'success'
          ? '#10b981'
          : '#3b82f6'

  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" class="transform -rotate-90 flex-shrink-0"><circle cx="${size / 2}" cy="${size / 2}" r="${radius}" fill="none" stroke="currentColor" stroke-opacity="0.15" stroke-width="${strokeWidth}" /><circle cx="${size / 2}" cy="${size / 2}" r="${radius}" fill="none" stroke="${strokeColor}" stroke-width="${strokeWidth}" stroke-dasharray="${circumference}" stroke-dashoffset="${offset}" stroke-linecap="round" /></svg>`
}

/**
 * Render metric inner content without wrapping into a card.
 */
export function renderMetricBody(metric: QuotaMetric): DeclarativeNode[] {
  const over = isQuotaMetricOverLimit(metric)

  // Explicit Currency Metric
  if (metric.kind === 'currency') {
    const amountFormatted =
      metric.currency === 'EUR' || metric.currency === '€'
        ? `${metric.amount.toFixed(2)} €`
        : `$${metric.amount.toFixed(2)}`
    const tone = metric.tone ?? 'info'
    const colorClass =
      tone === 'danger'
        ? 'text-accent-error'
        : tone === 'success'
          ? 'text-accent-success'
          : tone === 'warning'
            ? 'text-accent-warning'
            : 'text-text-primary'

    const nodes: DeclarativeNode[] = [
      {
        type: 'text',
        text: { en: metric.label, fr: metric.label },
        className: 'text-[11px] font-mono text-text-muted truncate',
      },
      {
        type: 'stack',
        direction: 'row',
        align: 'end',
        gap: 'xs',
        className: 'w-full my-0.5',
        children: [
          {
            type: 'text',
            text: { en: amountFormatted, fr: amountFormatted },
            className: `text-2xl sm:text-3xl font-mono font-bold leading-none ${colorClass}`,
          },
        ],
      },
    ]

    if (metric.subtitle) {
      nodes.push({
        type: 'text',
        text: metric.subtitle,
        className: `text-[10px] leading-tight font-mono pt-1 ${tone === 'danger' ? 'text-accent-error' : 'text-text-muted'}`,
      })
    }

    return nodes
  }

  if (metric.kind === 'windowed') {
    const used = metric.used
    const limit = metric.limit
    const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0
    const remaining = Math.max(0, limit - used)
    const tone: PluginBadgeTone = over ? 'danger' : pct >= 80 ? 'warning' : 'info'
    const windowLabel = getWindowLabel(metric.window)

    if (metric.unit === '$') {
      const formattedUsed = `$${used.toFixed(2)}`
      const nodes: DeclarativeNode[] = [
        {
          type: 'text',
          text: { en: metric.label, fr: metric.label },
          className: 'text-[11px] font-mono text-text-muted truncate',
        },
        {
          type: 'stack',
          direction: 'row',
          align: 'end',
          gap: 'xs',
          className: 'w-full my-0.5',
          children: [
            {
              type: 'text',
              text: { en: formattedUsed, fr: formattedUsed },
              className: 'text-2xl sm:text-3xl font-mono font-bold text-accent-success leading-none',
            },
            {
              type: 'text',
              text: {
                en: `${windowLabel.en}`,
                fr: `${windowLabel.fr}`,
              },
              className: 'text-xs font-mono text-text-muted pb-0.5',
            },
          ],
        },
      ]

      if (metric.subtitle) {
        nodes.push({
          type: 'text',
          text: metric.subtitle,
          className: 'text-[10px] leading-tight font-mono text-text-muted pt-1',
        })
      }

      return nodes
    }

    const resetDate = metric.resetsAt ? new Date(metric.resetsAt) : null
    const hasValidReset = resetDate && !Number.isNaN(resetDate.getTime())
    const resetText: LocalizedString | undefined = hasValidReset
      ? {
          en: `🕒 Resets ${resetDate.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}`,
          fr: `🕒 Réinit. ${resetDate.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`,
        }
      : undefined

    const nodes: DeclarativeNode[] = [
      {
        type: 'text',
        text: { en: metric.label, fr: metric.label },
        className: 'text-xs font-mono text-text-muted',
      },
      {
        type: 'stack',
        direction: 'row',
        align: 'end',
        gap: 'xs',
        className: 'w-full my-0.5',
        children: [
          {
            type: 'text',
            text: { en: `${formatNumber(used)}`, fr: `${formatNumber(used)}` },
            className: 'text-3xl font-mono font-bold text-text-primary leading-none',
          },
          {
            type: 'text',
            text: {
              en: `/ ${formatNumber(limit)} ${windowLabel.en}`,
              fr: `/ ${formatNumber(limit)} ${windowLabel.fr}`,
            },
            className: 'text-sm font-mono text-text-muted pb-0.5',
          },
        ],
      },
      {
        type: 'progress',
        label: { en: '', fr: '' },
        value: used,
        max: limit,
        tone,
      },
      {
        type: 'stack',
        direction: 'row',
        justify: 'between',
        align: 'center',
        className: 'w-full -mt-0.5',
        children: [
          {
            type: 'text',
            text: { en: `${pct}% used`, fr: `${pct}% utilisé` },
            className: 'text-xs font-mono text-text-muted',
          },
          {
            type: 'text',
            text: {
              en: `${formatNumber(remaining)} left`,
              fr: `${formatNumber(remaining)} restants`,
            },
            className: 'text-xs font-mono text-text-muted',
          },
        ],
      },
    ]

    if (resetText) {
      nodes.push({
        type: 'text',
        text: resetText,
        className: 'text-xs font-mono text-text-muted pt-1 flex items-center gap-1.5',
      })
    }

    return nodes
  }

  // Token balance pool or Currency-based token balance
  const isCurrencyUnit = metric.unit === '$' || Boolean(metric.currency)
  if (isCurrencyUnit) {
    const balanceStr = `$${metric.remaining.toFixed(2)}`
    const tone = metric.remaining <= 0 ? 'danger' : 'info'
    const colorClass =
      tone === 'danger'
        ? 'text-accent-error'
        : 'text-text-primary'

    const nodes: DeclarativeNode[] = [
      {
        type: 'text',
        text: { en: metric.label, fr: metric.label },
        className: 'text-[11px] font-mono text-text-muted truncate',
      },
      {
        type: 'stack',
        direction: 'row',
        align: 'end',
        gap: 'xs',
        className: 'w-full my-0.5',
        children: [
          {
            type: 'text',
            text: { en: balanceStr, fr: balanceStr },
            className: `text-2xl sm:text-3xl font-mono font-bold leading-none ${colorClass}`,
          },
        ],
      },
    ]

    if (metric.subtitle) {
      nodes.push({
        type: 'text',
        text: metric.subtitle,
        className: `text-[10px] leading-tight font-mono pt-1 ${tone === 'danger' ? 'text-accent-error' : 'text-text-muted'}`,
      })
    }

    return nodes
  }

  const total = metric.total
  const remaining = metric.remaining
  const used = Math.max(0, total - remaining)
  const usedPct = total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0
  const tone: PluginBadgeTone = over ? 'danger' : total > 0 && usedPct >= 80 ? 'warning' : 'info'

  return [
    {
      type: 'text',
      text: { en: metric.label, fr: metric.label },
      className: 'text-xs font-mono text-text-muted',
    },
    {
      type: 'stack',
      direction: 'row',
      align: 'end',
      gap: 'xs',
      className: 'w-full my-0.5',
      children: [
        {
          type: 'text',
          text: { en: `${formatNumber(used)}`, fr: `${formatNumber(used)}` },
          className: 'text-3xl font-mono font-bold text-text-primary leading-none',
        },
        {
          type: 'text',
          text: {
            en: `/ ${formatNumber(total)} tokens`,
            fr: `/ ${formatNumber(total)} jetons`,
          },
          className: 'text-sm font-mono text-text-muted pb-0.5',
        },
      ],
    },
    {
      type: 'progress',
      label: { en: '', fr: '' },
      value: used,
      max: total,
      tone,
    },
    {
      type: 'stack',
      direction: 'row',
      justify: 'between',
      align: 'center',
      className: 'w-full -mt-0.5',
      children: [
        {
          type: 'text',
          text: { en: `${usedPct}% used`, fr: `${usedPct}% utilisé` },
          className: 'text-xs font-mono text-text-muted',
        },
        {
          type: 'text',
          text: {
            en: `${formatNumber(remaining)} left`,
            fr: `${formatNumber(remaining)} restants`,
          },
          className: 'text-xs font-mono text-text-muted',
        },
      ],
    },
  ]
}

/**
 * Render a single standard QuotaMetric into OpenFox declarative node.
 */
export function renderMetricCard(metric: QuotaMetric): DeclarativeNode {
  return {
    type: 'card',
    children: renderMetricBody(metric),
  }
}

/**
 * Automatically match a QuotaSource to an available provider if not manually linked.
 */
export function findAutoLinkedProvider(
  source: QuotaSource,
  availableProviders: OpenFoxProviderInfo[] = [],
  claimedProviderIds: Set<string> = new Set(),
): OpenFoxProviderInfo | undefined {
  const unclaimed = availableProviders.filter((p) => !claimedProviderIds.has(p.id))
  if (unclaimed.length === 0) return undefined

  const sourceIdLower = source.id.toLowerCase()
  const cleanSourceName = source.name.replace(/\s*\([^)]*\)\s*$/, '').trim().toLowerCase()

  // 1. Direct ID match
  const directId = unclaimed.find((p) => p.id.toLowerCase() === sourceIdLower)
  if (directId) return directId

  // 2. Exact or prefix name match (e.g. "Google Antigravity" matches "Google Antigravity (user@gmail.com)")
  const nameMatch = unclaimed.find((p) => {
    const pName = p.name.trim().toLowerCase()
    return (
      pName === cleanSourceName ||
      cleanSourceName.startsWith(pName) ||
      pName.startsWith(cleanSourceName)
    )
  })
  if (nameMatch) return nameMatch

  // 3. Provider family heuristics
  if (sourceIdLower.includes('antigravity') || cleanSourceName.includes('antigravity')) {
    const pMatch = unclaimed.find(
      (p) => p.name.toLowerCase().includes('antigravity') || p.id.toLowerCase().includes('antigravity'),
    )
    if (pMatch) return pMatch
  }

  if (sourceIdLower.includes('copilot') || cleanSourceName.includes('copilot')) {
    const pMatch = unclaimed.find(
      (p) => p.name.toLowerCase().includes('copilot') || p.id.toLowerCase().includes('copilot'),
    )
    if (pMatch) return pMatch
  }

  if (sourceIdLower.includes('opencode') || cleanSourceName.includes('opencode')) {
    const pMatch = unclaimed.find(
      (p) => p.name.toLowerCase().includes('opencode') || p.id.toLowerCase().includes('opencode'),
    )
    if (pMatch) return pMatch
  }

  if (sourceIdLower.includes('cheaper') || cleanSourceName.includes('cheaper')) {
    const pMatch = unclaimed.find(
      (p) => p.name.toLowerCase().includes('cheaper') || p.id.toLowerCase().includes('cheaper'),
    )
    if (pMatch) return pMatch
  }

  return undefined
}

/**
 * Render a single standard QuotaSource (Method 1).
 */
export function renderSourceCard(
  source: QuotaSource,
  assignment?: QuotaProviderAssignment,
  availableProviders: OpenFoxProviderInfo[] = [],
  claimedProviderIds: Set<string> = new Set(),
): DeclarativeNode {
  const hasWarning = source.metrics.some(isQuotaMetricOverLimit)

  // Group metrics by model or label
  const groups = new Map<string, QuotaMetric[]>()
  for (const m of source.metrics) {
    const key = m.model || m.label || 'Quota'
    const list = groups.get(key) ?? []
    list.push(m)
    groups.set(key, list)
  }

  const children: DeclarativeNode[] = []

  // Auto-link provider ONLY IF the user hasn't explicitly unlinked or assigned this source
  const isExplicitlyUnlinked = assignment?.unlinked === true
  const hasManualAssignment = Boolean(assignment?.providerId && !assignment.unlinked)
  const autoProvider = !hasManualAssignment && !isExplicitlyUnlinked
    ? findAutoLinkedProvider(source, availableProviders, claimedProviderIds)
    : undefined

  if (autoProvider) {
    claimedProviderIds.add(autoProvider.id)
  }

  const effectiveAssignment: QuotaProviderAssignment | undefined = hasManualAssignment
    ? assignment
    : autoProvider
      ? {
          sourceId: source.id,
          providerId: autoProvider.id,
          providerName: autoProvider.name,
        }
      : undefined

  // Clean & Sleek Provider Assignment Header Bar
  const isAssigned = Boolean(effectiveAssignment?.providerId)
  const currentProviderId = effectiveAssignment?.providerId
  const currentProviderName = effectiveAssignment?.providerName

  const providerButtons: DeclarativeNode[] =
    availableProviders.length > 0
      ? availableProviders.map((p) => ({
          type: 'button',
          label: {
            en: p.name,
            fr: p.name,
          },
          variant: 'default',
          onActivate: {
            kind: 'rpc',
            method: 'quota.assignProvider',
            params: {
              sourceId: source.id,
              providerId: p.id,
              providerName: p.name,
            },
          },
        }))
      : []

  const headerRight: DeclarativeNode = isAssigned
    ? {
        type: 'stack',
        direction: 'row',
        align: 'center',
        gap: 'xs',
        className: 'flex-wrap',
        children: [
          {
            type: 'badge',
            label: {
              en: `● Provider: ${currentProviderName || currentProviderId}`,
              fr: `● Fournisseur : ${currentProviderName || currentProviderId}`,
            },
            tone: 'info',
          },
          {
            type: 'button',
            label: { en: '✕ Unlink', fr: '✕ Dissocier' },
            variant: 'ghost',
            onActivate: {
              kind: 'rpc',
              method: 'quota.removeAssignment',
              params: { sourceId: source.id },
            },
          },
        ],
      }
    : {
        type: 'stack',
        direction: 'row',
        align: 'center',
        gap: 'xs',
        className: 'flex-wrap',
        children: [
          {
            type: 'text',
            text: {
              en: 'Link to provider:',
              fr: 'Lier à un fournisseur :',
            },
            muted: true,
          },
          ...(providerButtons.length > 0
            ? [
                {
                  type: 'stack' as const,
                  direction: 'row' as const,
                  align: 'center' as const,
                  gap: 'xs' as const,
                  className: 'flex-wrap',
                  children: providerButtons,
                },
              ]
            : [
                {
                  type: 'text' as const,
                  text: {
                    en: 'No providers configured',
                    fr: 'Aucun fournisseur configuré',
                  },
                  muted: true,
                },
              ]),
        ],
      }

  // Card Header with Description (if present) and Link Bar
  const headerRow: DeclarativeNode = {
    type: 'stack',
    direction: 'row',
    align: 'center',
    justify: 'between',
    className: 'w-full pb-3 border-b border-border/30 gap-4 flex-wrap',
    children: [
      source.description
        ? {
            type: 'text' as const,
            text: { en: source.description, fr: source.description },
            muted: true,
          }
        : {
            type: 'text' as const,
            text: { en: '', fr: '' },
          },
      headerRight,
    ],
  }

  children.push(headerRow)

  // Per-metric/model groups in multi-column rows with direct in-card toggle button
  const selectedList = assignment?.selectedModels
  const displayModes = assignment?.metricDisplayModes ?? {}
  const groupNodes: DeclarativeNode[] = []

  for (const [groupKey, metrics] of groups.entries()) {
    const isSelected = selectedList === undefined || selectedList.includes(groupKey)
    const currentMode: MetricDisplayMode =
      displayModes[groupKey] ?? metrics[0]?.displayMode ?? 'gauge'

    const metricChildren: DeclarativeNode[] = []
    for (const m of metrics) {
      metricChildren.push(...renderMetricBody(m))
    }

    const modeLabel: LocalizedString = !isSelected
      ? { en: 'Off', fr: 'Off' }
      : currentMode === 'gauge'
        ? { en: '● Circle', fr: '● Cercle' }
        : { en: '123 Value', fr: '123 Valeur' }

    groupNodes.push({
      type: 'card',
      className: 'flex-1 min-w-0',
      children: [
        {
          type: 'stack',
          direction: 'column',
          align: 'stretch',
          gap: 'xs',
          className: 'w-full min-w-full',
          children: [
            {
              type: 'stack',
              direction: 'row',
              align: 'center',
              justify: 'between',
              className: 'w-full pb-1 gap-1 border-b border-border/40',
              children: [
                {
                  type: 'stack',
                  direction: 'row',
                  align: 'center',
                  gap: 'xs',
                  className: 'min-w-0 flex-1 truncate',
                  children: [
                    {
                      type: 'text',
                      text: {
                        en: groupKey,
                        fr: groupKey,
                      },
                      className: 'font-mono text-xs font-semibold text-text-primary truncate',
                    },
                  ],
                },
                {
                  type: 'button',
                  label: modeLabel,
                  variant: isSelected ? 'pill' : 'default',
                  onActivate: {
                    kind: 'rpc',
                    method: 'quota.cycleModelMode',
                    params: {
                      sourceId: source.id,
                      model: groupKey,
                    },
                  },
                },
              ],
            },
            {
              type: 'stack',
              direction: 'column',
              gap: 'xs',
              className: 'pt-2 w-full',
              children: metricChildren,
            },
          ],
        },
      ],
    })
  }

  if (groupNodes.length > 0) {
    for (let i = 0; i < groupNodes.length; i += 4) {
      const rowGroup = groupNodes.slice(i, i + 4)
      children.push({
        type: 'stack',
        direction: 'row',
        gap: 'sm',
        className: 'w-full flex-row flex-nowrap gap-2',
        children: rowGroup,
      })
    }
  }

  return {
    type: 'card',
    title: { en: source.name, fr: source.name },
    tone: hasWarning ? 'danger' : undefined,
    children: [
      {
        type: 'stack',
        direction: 'column',
        align: 'stretch',
        gap: 'md',
        className: 'w-full min-w-full',
        children,
      },
    ],
  }
}

/**
 * Build full Declarative UI tree for Quota Modal.
 * Combines Method 1 (standard quota sources), Method 2 (custom declarative sections),
 * and any registered modal layout overrides.
 */
export async function buildModalDeclarativeTree(options: {
  sources: QuotaSource[]
  customSections: CustomQuotaSection[]
  overrides?: QuotaModalOverride[]
  assignments?: Record<string, QuotaProviderAssignment>
  availableProviders?: OpenFoxProviderInfo[]
}): Promise<DeclarativeNode[]> {
  const {
    sources,
    customSections,
    overrides = [],
    assignments = {},
    availableProviders = [],
  } = options

  // Check for winning override
  const winningOverride = overrides
    .slice()
    .sort((a, b) => (a.order ?? 50) - (b.order ?? 50))
    .pop()

  if (winningOverride && winningOverride.mode === 'replace') {
    return winningOverride.render(sources, customSections)
  }

  const nodes: DeclarativeNode[] = []
  const activeSources = sources.filter((s) => s.metrics && s.metrics.length > 0)
  const warningActive = hasQuotaWarning(activeSources)

  // Warning banner if any limit reached
  if (warningActive) {
    nodes.push({
      type: 'callout',
      tone: 'danger',
      icon: 'warning',
      title: {
        en: 'Quota Limit Reached',
        fr: 'Limite de quota atteinte',
      },
      text: {
        en: 'One or more quotas have reached their limit. Some requests may be rate-limited.',
        fr: 'Un ou plusieurs quotas ont atteint leur limite. Certaines requêtes peuvent être restreintes.',
      },
    })
  }

  // Empty state
  if (activeSources.length === 0 && customSections.length === 0) {
    nodes.push({
      type: 'callout',
      tone: 'neutral',
      icon: 'info',
      title: {
        en: 'No Quota Providers',
        fr: 'Aucun fournisseur de quota',
      },
      text: {
        en: 'No plugins have reported usage or quota limits yet.',
        fr: 'Aucun plugin n’a encore signalé d’utilisation ou de limites de quota.',
      },
    })
  }

  // Track claimed provider IDs across all sources to enforce 1-to-1 matching
  const claimedProviderIds = new Set<string>()
  for (const source of activeSources) {
    const assignment = assignments[source.id]
    if (assignment?.providerId && !assignment.unlinked) {
      claimedProviderIds.add(assignment.providerId)
    }
  }

  // Method 1: Render standard quota sources
  for (const source of activeSources) {
    const assignment = assignments[source.id]
    // Filter available providers so a provider claimed by another source cannot be assigned twice
    const cardAvailableProviders = availableProviders.filter(
      (p) => !claimedProviderIds.has(p.id) || assignment?.providerId === p.id,
    )
    nodes.push(renderSourceCard(source, assignment, cardAvailableProviders, claimedProviderIds))
  }

  // Method 2: Render custom sections sorted by order
  const sortedCustom = customSections
    .slice()
    .sort((a, b) => (a.order ?? 50) - (b.order ?? 50))

  for (const custom of sortedCustom) {
    try {
      const rendered = await custom.render()
      const customNodes = Array.isArray(rendered) ? rendered : [rendered]

      if (custom.title) {
        nodes.push({
          type: 'card',
          title: custom.title,
          children: customNodes,
        })
      } else {
        nodes.push(...customNodes)
      }
    } catch (error) {
      nodes.push({
        type: 'callout',
        tone: 'danger',
        icon: 'warning',
        title: {
          en: `Failed to render custom quota: ${custom.id}`,
          fr: `Échec du rendu du quota personnalisé : ${custom.id}`,
        },
        text: {
          en: error instanceof Error ? error.message : String(error),
          fr: error instanceof Error ? error.message : String(error),
        },
      })
    }
  }

  // Optional extend overrides
  for (const override of overrides.filter((o) => o.mode === 'extend')) {
    try {
      const extraNodes = await override.render(sources, customSections)
      nodes.push(...extraNodes)
    } catch {
      // ignore
    }
  }

  // Footer action: Refresh button & timestamp
  nodes.push({ type: 'divider' })
  nodes.push({
    type: 'stack',
    direction: 'row',
    justify: 'between',
    align: 'center',
    className: 'w-full min-w-full',
    children: [
      {
        type: 'text',
        text: {
          en: `Updated: ${new Date().toLocaleTimeString('en-US')}`,
          fr: `Mis à jour : ${new Date().toLocaleTimeString('fr-FR')}`,
        },
        muted: true,
      },
      {
        type: 'button',
        label: { en: 'Refresh', fr: 'Actualiser' },
        icon: 'refresh',
        variant: 'default',
        onActivate: { kind: 'rpc', method: 'quota.refresh' },
      },
    ],
  })

  return nodes
}
