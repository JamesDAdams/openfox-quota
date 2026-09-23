import type {
  CustomQuotaSection,
  MetricDisplayMode,
  OpenFoxProviderInfo,
  PluginBadgeTone,
  PluginRegistry,
  PluginSettingsSchema,
  QuotaGaugeInfo,
  QuotaMetric,
  QuotaModalOverride,
  QuotaProvider,
  QuotaProviderAssignment,
  QuotaReport,
  QuotaSource,
} from './types.js'
import { QuotaManager, quotaManager } from './manager.js'
import {
  buildModalDeclarativeTree,
  buildQuotaGaugeInfo,
  computeMetricPct,
  formatMetricValue,
  hasQuotaWarning,
  isQuotaMetricOverLimit,
  renderMetricCard,
  renderSourceCard,
} from './renderer.js'

// Export types
export type * from './types.js'

export { QuotaManager, quotaManager }
export {
  buildModalDeclarativeTree,
  buildQuotaGaugeInfo,
  computeMetricPct,
  formatMetricValue,
  hasQuotaWarning,
  isQuotaMetricOverLimit,
  renderMetricCard,
  renderSourceCard,
}

// Module-level convenience functions for other plugins running in-process:
export function registerQuotaProvider(provider: QuotaProvider): void {
  quotaManager.registerProvider(provider)
}

export function registerCustomQuotaSection(section: CustomQuotaSection): void {
  quotaManager.registerCustomSection(section)
}

export function registerQuotaModalOverride(override: QuotaModalOverride): void {
  quotaManager.registerModalOverride(override)
}

export function submitQuotaSource(source: QuotaSource): void {
  quotaManager.submitSource(source)
}

export function getQuotaReport(): Promise<QuotaReport> {
  return quotaManager.getQuotaReport()
}

export function assignQuotaProvider(
  assignment: QuotaProviderAssignment,
): void {
  quotaManager.assignProvider(assignment)
}

export function removeQuotaAssignment(sourceId: string): boolean {
  return quotaManager.removeAssignment(sourceId)
}

export function getProviderQuotas(providerId: string): QuotaGaugeInfo[] {
  return quotaManager.getGaugesForProvider(providerId)
}

export function setAvailableQuotaProviders(providers: OpenFoxProviderInfo[]): void {
  quotaManager.setAvailableProviders(providers)
}

export function getAvailableQuotaProviders(): OpenFoxProviderInfo[] {
  return quotaManager.getAvailableProviders()
}

export const QUOTA_ICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v4m0 12v4M4.93 4.93l2.83 2.83m8.48 8.48 2.83 2.83M2 12h4m12 0h4M4.93 19.07l2.83-2.83m8.48-8.48 2.83-2.83"/><circle cx="12" cy="12" r="4"/></svg>'

const SETTINGS: PluginSettingsSchema = {
  fields: [
    {
      key: 'autoRefreshIntervalSeconds',
      label: { en: 'Auto-refresh Interval (seconds)', fr: 'Intervalle d’actualisation (secondes)' },
      type: 'number',
      description: {
        en: 'How often to automatically refresh background quota data (0 to disable).',
        fr: 'Fréquence d’actualisation automatique des quotas en arrière-plan (0 pour désactiver).',
      },
      default: 300,
    },
    {
      key: 'warnAtThresholdPercent',
      label: { en: 'Warning Threshold (%)', fr: 'Seuil d’alerte (%)' },
      type: 'number',
      description: {
        en: 'Show warnings in OpenFox UI when quota usage exceeds this percentage.',
        fr: 'Afficher des avertissements dans l’interface OpenFox quand l’utilisation dépasse ce pourcentage.',
      },
      default: 80,
    },
    {
      key: 'notifyOnLimitExceeded',
      label: { en: 'Notify when Limit Exceeded', fr: 'Notifier en cas de dépassement' },
      type: 'boolean',
      description: {
        en: 'Send an OpenFox desktop/system notification when a provider reaches 100% capacity.',
        fr: 'Envoyer une notification OpenFox lorsqu’un fournisseur atteint 100 % de sa capacité.',
      },
      default: true,
    },
  ],
}

let lastNotifiedOverLimit = false

export async function register(registry: PluginRegistry): Promise<void> {
  const { context } = registry
  quotaManager.registry = registry
  quotaManager.context = context

  // 1. Initial provider & storage loading for OpenFox
  quotaManager.loadAssignmentsFromStorage(context.storage)
  quotaManager.loadAvailableProviders(context)

  // Extend PluginRegistry with quota-specific registration helpers
  registry.registerQuotaProvider = (provider: QuotaProvider) => {
    quotaManager.registerProvider(provider)
    context.logger.info(`Registered quota provider: ${provider.id} (${provider.name})`)
    void quotaManager.refresh(context)
  }

  registry.registerCustomQuotaSection = (section: CustomQuotaSection) => {
    quotaManager.registerCustomSection(section)
    context.logger.info(`Registered custom quota section: ${section.id}`)
    void quotaManager.refresh(context)
  }

  registry.registerQuotaModalOverride = (override: QuotaModalOverride) => {
    quotaManager.registerModalOverride(override)
    context.logger.info(`Registered quota modal override: ${override.id}`)
    void quotaManager.refresh(context)
  }

  // 2. Register Header UI Action (shows in header action / plugin menu)
  registry.registerUiAction({
    id: 'quota-action-open',
    pluginId: 'openfox-quota',
    slot: 'header.actions',
    label: {
      en: 'Usage & Quotas',
      fr: 'Utilisation & quotas',
    },
    icon: QUOTA_ICON_SVG,
    variant: 'ghost',
    tooltip: {
      en: 'View model usage and quota limits',
      fr: 'Voir l’utilisation des modèles et les quotas',
    },
    onActivate: {
      kind: 'openPanel',
      panelId: 'quota-modal',
    },
  })

  // 3. Register Header UI Component (identical design to native OpenFox header buttons)
  registry.registerUiComponent({
    id: 'quota-header-button',
    pluginId: 'openfox-quota',
    zone: 'header.actions',
    position: 'before',
    order: 1,
    component: {
      type: 'button',
      label: {
        en: 'Usage & Quotas',
        fr: 'Utilisation & quotas',
      },
      icon: QUOTA_ICON_SVG,
      variant: 'ghost',
      onActivate: {
        kind: 'openPanel',
        panelId: 'quota-modal',
      },
    },
  })

  // 4. Register Quota Modal Panel (Native declarative panel)
  const initialContent = await quotaManager.renderModalContent()
  registry.registerUiPanel({
    id: 'quota-modal',
    pluginId: 'openfox-quota',
    title: {
      en: 'Usage & Quotas',
      fr: 'Utilisation & quotas',
    },
    size: 'xl',
    kind: 'declarative',
    content: initialContent,
  })

  // 5. Register Settings
  registry.registerSettings(SETTINGS)

  // 6. Register RPC Methods
  registry.registerRpc('quota.getReport', async () => {
    return await quotaManager.getQuotaReport()
  })

  registry.registerRpc('quota.refresh', async () => {
    const report = await quotaManager.refresh(context)
    return { success: true, report }
  })

  registry.registerRpc('quota.getModalContent', async () => {
    const nodes = await quotaManager.renderModalContent()
    return { nodes }
  })

  registry.registerRpc('quota.submitMetric', (params) => {
    const { sourceId, sourceName, metric } = params as {
      sourceId?: string
      sourceName?: string
      metric?: QuotaMetric
    }
    if (sourceId && sourceName && metric) {
      quotaManager.submitMetric(sourceId, sourceName, metric)
      void quotaManager.refresh(context)
      return { success: true }
    }
    return { success: false, error: 'Invalid metric payload' }
  })

  registry.registerRpc('quota.submitSource', (params) => {
    const { source } = params as { source?: QuotaSource }
    if (source && source.id && source.name && Array.isArray(source.metrics)) {
      quotaManager.submitSource(source as QuotaSource)
      void quotaManager.refresh(context)
      return { success: true }
    }
    return { success: false, error: 'Invalid source payload' }
  })

  // RPC: Assign / Link a Quota Source to an OpenFox Provider
  registry.registerRpc('quota.assignProvider', async (params) => {
    const { sourceId, providerId, providerName, selectedModels } = params as {
      sourceId?: string
      providerId?: string
      providerName?: string
      selectedModels?: string[]
    }
    if (sourceId && providerId) {
      quotaManager.assignProvider(
        { sourceId, providerId, providerName, selectedModels },
        context,
      )
      await quotaManager.refresh(context)
      return { success: true, assignments: quotaManager.getAssignments() }
    }
    return { success: false, error: 'Missing sourceId or providerId' }
  })

  // RPC: Remove Quota Source Assignment
  registry.registerRpc('quota.removeAssignment', async (params) => {
    const { sourceId } = params as { sourceId?: string }
    if (sourceId) {
      const removed = quotaManager.removeAssignment(sourceId, context)
      await quotaManager.refresh(context)
      return { success: removed, assignments: quotaManager.getAssignments() }
    }
    return { success: false, error: 'Missing sourceId' }
  })

  // RPC: Toggle specific model / metric gauge display for assigned provider (hide/show)
  registry.registerRpc('quota.toggleModel', async (params) => {
    const { sourceId, model } = params as { sourceId?: string; model?: string }
    if (sourceId && model) {
      const assignment = await quotaManager.toggleModelForSource(sourceId, model, context)
      await quotaManager.refresh(context)
      return { success: true, assignment }
    }
    return { success: false, error: 'Missing sourceId or model' }
  })

  // RPC: Cycle display mode for model / metric: Off -> Circle -> Value -> Off
  registry.registerRpc('quota.cycleModelMode', async (params) => {
    const { sourceId, model } = params as { sourceId?: string; model?: string }
    if (sourceId && model) {
      const assignment = await quotaManager.cycleModelModeForSource(sourceId, model, context)
      await quotaManager.refresh(context)
      return { success: true, assignment }
    }
    return { success: false, error: 'Missing sourceId or model' }
  })

  // RPC: Set display mode directly ('gauge' | 'value') for a model / metric
  registry.registerRpc('quota.setMetricDisplayMode', async (params) => {
    const { sourceId, model, mode } = params as {
      sourceId?: string
      model?: string
      mode?: MetricDisplayMode
    }
    if (sourceId && model && mode) {
      const assignment = await quotaManager.setMetricDisplayMode(sourceId, model, mode, context)
      await quotaManager.refresh(context)
      return { success: true, assignment }
    }
    return { success: false, error: 'Missing sourceId, model, or mode' }
  })

  // RPC: Get all assignments
  registry.registerRpc('quota.getAssignments', () => {
    return { assignments: quotaManager.getAssignments() }
  })

  // RPC: Get circular gauges for a specific provider
  registry.registerRpc('quota.getProviderQuotas', (params) => {
    const { providerId } = params as { providerId?: string }
    if (providerId) {
      const gauges = quotaManager.getGaugesForProvider(providerId)
      return { success: true, gauges }
    }
    return { success: false, error: 'Missing providerId', gauges: [] }
  })

  // 7. Register Tool for LLM
  registry.registerTool({
    name: 'get_quota_report',
    description:
      'Retrieve current model API usage and quota limits across all registered providers.',
    parameters: {
      type: 'object',
      properties: {
        sourceId: {
          type: 'string',
          description: 'Optional filter by provider/source ID',
        },
      },
    },
    execute: async (args) => {
      const report = await quotaManager.getQuotaReport()
      const sourceId = typeof args['sourceId'] === 'string' ? args['sourceId'] : undefined
      if (sourceId) {
        const filtered = report.sources.filter((s) => s.id === sourceId)
        return {
          success: true,
          output: JSON.stringify({ ...report, sources: filtered }, null, 2),
        }
      }
      return {
        success: true,
        output: JSON.stringify(report, null, 2),
      }
    },
  })

  // 8. Register Hook on turn.completed
  registry.registerHook('turn.completed', async () => {
    const report = await quotaManager.refresh(context)

    if (report.hasWarning && !lastNotifiedOverLimit) {
      lastNotifiedOverLimit = true
      context.notify({
        title: {
          en: 'Quota Limit Reached',
          fr: 'Limite de quota atteinte',
        },
        body: {
          en: 'One or more AI providers reached usage or quota limit.',
          fr: 'Un ou plusieurs de vos fournisseurs d’IA ont atteint leur limite d’utilisation ou de quota.',
        },
        level: 'warning',
        actions: [
          {
            label: { en: 'View Quotas', fr: 'Voir les quotas' },
            onActivate: { kind: 'openPanel', panelId: 'quota-modal' },
          },
        ],
      })
    } else if (!report.hasWarning) {
      lastNotifiedOverLimit = false
    }
  })

  // 9. Register Model Metadata Provider to display quota glyphs & percentages on providers / models
  if (typeof registry.registerModelMetadataProvider === 'function') {
    registry.registerModelMetadataProvider({
      id: 'quota-indicators',
      getProviderMetadata: async (ctx: { providerId: string; provider?: any }) => {
        const { providerId } = ctx
        let report = quotaManager.getLastReport()
        if (!report || !report.sources || report.sources.length === 0) {
          report = await quotaManager.getQuotaReport()
        }
        if (!report || !report.sources || report.sources.length === 0) return undefined

        const gauges = quotaManager.getGaugesForProvider(providerId)
        if (!gauges || gauges.length === 0) return undefined

        const badges: Array<{
          label: { en: string; fr: string }
          tooltip?: { en: string; fr: string }
          tone?: PluginBadgeTone
          icon?: string
        }> = gauges.map((gauge) => {
          if (gauge.displayMode === 'value') {
            return {
              label: gauge.formattedValue,
              tooltip: {
                en: `${gauge.model || gauge.label}: ${gauge.formattedValue.en}`,
                fr: `${gauge.model || gauge.label} : ${gauge.formattedValue.fr}`,
              },
              tone: gauge.tone,
              icon: gauge.icon,
            }
          }

          return {
            label: { en: '', fr: '' },
            tooltip: {
              en: `${gauge.model || gauge.label}: ${gauge.pct}% used (${gauge.remaining.toLocaleString()} left)`,
              fr: `${gauge.model || gauge.label} : ${gauge.pct}% utilisé (${gauge.remaining.toLocaleString()} restant)`,
            },
            tone: gauge.tone,
            icon: gauge.svg,
          }
        })

        return badges.length > 0 ? { badges } : undefined
      },
      getMetadata: (_ctx: { providerId: string; modelId: string }) => {
        return undefined
      },
    })
  }

  context.logger.info('openfox-quota initialized successfully')
}

export function deactivate(): void {
  quotaManager.clear()
}
