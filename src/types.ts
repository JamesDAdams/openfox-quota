// ============================================================================
// OpenFox Declarative UI & Plugin Types
// ============================================================================

export type LocalizedString = { en: string; fr: string }

export type PluginBadgeTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger'

export type PluginActivation =
  | { kind: 'rpc'; method: string; params?: Record<string, unknown> }
  | { kind: 'openPanel'; panelId: string }
  | { kind: 'openUrl'; url: string }

export interface PluginVisibilityCondition {
  hasSession?: boolean
  hasProject?: boolean
  hasMessage?: boolean
}

export type DeclarativeNode =
  | { type: 'text'; text: LocalizedString; muted?: boolean; className?: string }
  | { type: 'keyValue'; items: { key: LocalizedString; value: string }[] }
  | { type: 'table'; columns: LocalizedString[]; rows: string[][] }
  | { type: 'progress'; label: LocalizedString; value: number; max: number; tone?: PluginBadgeTone }
  | { type: 'badge'; label: LocalizedString; tone?: PluginBadgeTone }
  | {
      type: 'button'
      label: LocalizedString
      variant?: 'default' | 'primary' | 'danger' | 'ghost' | 'pill'
      icon?: string
      onActivate: PluginActivation
    }
  | { type: 'divider' }
  | {
      type: 'stack'
      direction?: 'row' | 'column'
      gap?: 'none' | 'xs' | 'sm' | 'md' | 'lg'
      align?: 'start' | 'center' | 'end' | 'stretch'
      justify?: 'start' | 'center' | 'end' | 'between'
      className?: string
      children: DeclarativeNode[]
    }
  | {
      type: 'card'
      title?: LocalizedString
      subtitle?: LocalizedString
      tone?: PluginBadgeTone
      className?: string
      children: DeclarativeNode[]
    }
  | {
      type: 'callout'
      tone?: PluginBadgeTone
      title?: LocalizedString
      text: LocalizedString
      icon?: string
    }
  | {
      type: 'icon'
      icon: string
      tone?: PluginBadgeTone
      className?: string
    }
  | {
      type: 'input'
      id: string
      placeholder?: LocalizedString
      defaultValue?: string
      label?: LocalizedString
      inputType?: 'text' | 'number' | 'password'
    }
  | {
      type: 'select'
      id: string
      label?: LocalizedString
      options: { value: string; label: LocalizedString }[]
      defaultValue?: string
    }
  | {
      type: 'iframe'
      url: string
      height?: string | number
      width?: string | number
    }

export interface PluginUiAction {
  id: string
  pluginId?: string
  slot: string
  label: LocalizedString
  icon?: string
  variant?: 'default' | 'primary' | 'danger' | 'ghost'
  tooltip?: LocalizedString
  visibleWhen?: PluginVisibilityCondition
  onActivate: PluginActivation
}

export interface PluginUiBadge {
  id: string
  pluginId?: string
  slot: string
  label: LocalizedString
  tone?: PluginBadgeTone
  tooltip?: LocalizedString
  value?: string
  visibleWhen?: PluginVisibilityCondition
  source?: { kind: 'rpc'; method: string }
}

export interface PluginUiComponent {
  id: string
  pluginId?: string
  zone: string
  position?: 'before' | 'after' | 'inside'
  order?: number
  visibleWhen?: PluginVisibilityCondition
  component: DeclarativeNode
}

export interface PluginUiPanel {
  id: string
  pluginId?: string
  title: LocalizedString
  size?: 'sm' | 'md' | 'lg' | 'xl' | 'full'
  kind: 'declarative' | 'iframe'
  content?: DeclarativeNode[]
  url?: string
}

export interface PluginSettingsField {
  key: string
  type: 'text' | 'password' | 'number' | 'boolean' | 'select' | 'textarea' | 'path'
  label: LocalizedString
  description?: LocalizedString
  default?: string | number | boolean
  options?: { value: string; label: LocalizedString }[]
  required?: boolean
  secret?: boolean
}

export interface PluginSettingsSchema {
  fields: PluginSettingsField[]
}

export interface PluginContext {
  readonly id: string
  readonly version: string
  readonly runtime: { mode: 'production' | 'development'; configDirectory: string }
  readonly logger: {
    debug(message: string, context?: Record<string, unknown>): void
    info(message: string, context?: Record<string, unknown>): void
    warn(message: string, context?: Record<string, unknown>): void
    error(message: string, context?: Record<string, unknown>): void
  }
  readonly storage: {
    get(key: string): unknown
    set(key: string, value: unknown): void
  }
  settings(scope?: 'global' | 'project', projectId?: string): Record<string, unknown>
  notify(request: {
    title: LocalizedString
    body?: LocalizedString
    level?: 'info' | 'success' | 'warning' | 'error'
    actions?: { label: LocalizedString; onActivate: PluginActivation }[]
  }): void
  publish(panelId: string | undefined, key: string, value: unknown): void
}

export interface PluginRegistry {
  readonly runtime: { mode: 'production' | 'development'; configDirectory: string }
  readonly context: PluginContext

  registerTool(tool: {
    name: string
    description: string
    parameters: Record<string, unknown>
    execute(args: Record<string, unknown>, context: Record<string, unknown>): Promise<{ success: boolean; output?: string; error?: string }>
  }): void
  registerSettings(schema: PluginSettingsSchema): void
  registerUiAction(action: PluginUiAction): void
  registerUiBadge(badge: PluginUiBadge): void
  registerUiPanel(panel: PluginUiPanel): void
  registerUiComponent(component: PluginUiComponent): void
  registerHook(event: string, handler: (payload: any) => void | Promise<void>): void
  registerRpc(method: string, handler: (params: Record<string, unknown>, context: Record<string, unknown>) => unknown | Promise<unknown>): void
  registerAsset(relativePath: string): void
  registerModelMetadataProvider?(provider: {
    id: string
    getMetadata(context: {
      providerId: string
      modelId: string
      model?: unknown
    }):
      | {
          badges?: { label: LocalizedString; tooltip?: LocalizedString; tone?: PluginBadgeTone; icon?: string }[]
          pricing?: unknown
          contextWindow?: number
        }
      | undefined
      | Promise<
          | {
              badges?: { label: LocalizedString; tooltip?: LocalizedString; tone?: PluginBadgeTone; icon?: string }[]
              pricing?: unknown
              contextWindow?: number
            }
          | undefined
        >
    getProviderMetadata?(context: {
      providerId: string
      provider?: any
    }):
      | {
          badges?: { label: LocalizedString; tooltip?: LocalizedString; tone?: PluginBadgeTone; icon?: string }[]
          pricing?: unknown
        }
      | undefined
      | Promise<
          | {
              badges?: { label: LocalizedString; tooltip?: LocalizedString; tone?: PluginBadgeTone; icon?: string }[]
              pricing?: unknown
            }
          | undefined
        >
  }): void

  // Extension points added by openfox-quota plugin:
  registerQuotaProvider?(provider: QuotaProvider): void
  registerCustomQuotaSection?(section: CustomQuotaSection): void
  registerQuotaModalOverride?(override: QuotaModalOverride): void
}

// ============================================================================
// Quota Tracking & Extension Types (Method 1 & Method 2)
// ============================================================================

export type MetricDisplayMode = 'gauge' | 'value'

/**
 * Method 1: Generic Quota Metric (PR #288)
 * Windowed usage/limit, token balance pool, or currency amount.
 */
export type QuotaMetric =
  | {
      kind: 'windowed'
      label: string
      used: number
      limit: number
      window: 'hour' | 'day' | 'week' | 'month'
      model?: string
      resetsAt?: string
      unit?: string
      subtitle?: LocalizedString
      icon?: string
      displayMode?: MetricDisplayMode
      formattedValue?: string | LocalizedString
    }
  | {
      kind: 'token-balance'
      label: string
      total: number
      remaining: number
      model?: string
      unit?: string
      currency?: string
      subtitle?: LocalizedString
      icon?: string
      displayMode?: MetricDisplayMode
      formattedValue?: string | LocalizedString
    }
  | {
      kind: 'currency'
      label: string
      amount: number
      currency?: string
      subtitle?: LocalizedString
      tone?: PluginBadgeTone
      model?: string
      icon?: string
      displayMode?: MetricDisplayMode
      formattedValue?: string | LocalizedString
    }

/**
 * Method 1: Quota source representing a single plugin / provider.
 */
export interface QuotaSource {
  id: string
  name: string
  description?: string
  metrics: QuotaMetric[]
}

/**
 * OpenFox Provider basic info for quota mapping.
 */
export interface OpenFoxProviderInfo {
  id: string
  name: string
}

/**
 * Mapping between a QuotaSource and an OpenFox Provider.
 */
export interface QuotaProviderAssignment {
  sourceId: string
  providerId: string
  providerName?: string
  selectedModels?: string[]
  metricDisplayModes?: Record<string, MetricDisplayMode>
  unlinked?: boolean
}

/**
 * Circular gauge or direct value indicator representation for a specific model / metric.
 */
export interface QuotaGaugeInfo {
  model: string
  label: string
  pct: number
  tone: PluginBadgeTone
  used: number
  limit: number
  remaining: number
  window?: string
  resetsAt?: string
  svg: string
  icon?: string
  displayMode: MetricDisplayMode
  formattedValue: LocalizedString
}

/**
 * Method 1: Quota provider interface for plugins to register.
 */
export interface QuotaProvider {
  readonly id: string
  readonly name: string
  getQuota(): Promise<QuotaSource> | QuotaSource
}

/**
 * Method 2: Custom Quota Section (Special UI component override)
 * Allows plugins to supply custom OpenFox DeclarativeNode hierarchies.
 */
export interface CustomQuotaSection {
  readonly id: string
  readonly title?: LocalizedString
  readonly order?: number
  render(context?: { locale?: string }): Promise<DeclarativeNode[] | DeclarativeNode> | DeclarativeNode[] | DeclarativeNode
  getState?(): Promise<Record<string, unknown>> | Record<string, unknown>
}

/**
 * Method 2: Modal override to completely customize or extend the Quota Modal layout.
 */
export interface QuotaModalOverride {
  readonly id: string
  readonly pluginId?: string
  readonly mode: 'replace' | 'extend' | 'custom'
  readonly order?: number
  render(sources: QuotaSource[], customSections: CustomQuotaSection[]): Promise<DeclarativeNode[]> | DeclarativeNode[]
}

/**
 * Aggregated quota report returned by the manager.
 */
export interface QuotaReport {
  sources: QuotaSource[]
  customSectionIds: string[]
  fetchedAt: string
  hasWarning: boolean
}
