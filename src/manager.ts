import * as fs from 'node:fs'
import * as path from 'node:path'
import type {
  CustomQuotaSection,
  DeclarativeNode,
  MetricDisplayMode,
  OpenFoxProviderInfo,
  PluginContext,
  PluginRegistry,
  QuotaGaugeInfo,
  QuotaMetric,
  QuotaModalOverride,
  QuotaProvider,
  QuotaProviderAssignment,
  QuotaReport,
  QuotaSource,
} from './types.js'
import {
  buildModalDeclarativeTree,
  buildQuotaGaugeInfo,
  findAutoLinkedProvider,
  hasQuotaWarning,
  isQuotaMetricOverLimit,
} from './renderer.js'

const PENDING_PROVIDERS_KEY = Symbol.for('openfox.pendingQuotaProviders')
const GLOBAL_QUOTA_KEY = Symbol.for('openfox.quotaManager')
const STORAGE_ASSIGNMENTS_KEY = 'quota_provider_assignments'

export class QuotaManager {
  private readonly providers = new Map<string, QuotaProvider>()
  private readonly customSections = new Map<string, CustomQuotaSection>()
  private readonly modalOverrides = new Map<string, QuotaModalOverride>()
  private readonly pushedSources = new Map<string, QuotaSource>()
  private readonly assignments = new Map<string, QuotaProviderAssignment>()
  private availableProviders: OpenFoxProviderInfo[] = []
  private lastReport?: QuotaReport
  public context?: PluginContext
  public registry?: PluginRegistry

  constructor() {
    this.drainPendingProviders()
  }

  drainPendingProviders(): void {
    const pending = (globalThis as any)[PENDING_PROVIDERS_KEY]
    if (Array.isArray(pending)) {
      for (const p of pending) {
        if (p && p.id && !this.providers.has(p.id)) {
          this.registerProvider(p)
        }
      }
    }
  }

  /**
   * Load available OpenFox providers dynamically from configDirectory.
   */
  loadAvailableProviders(context?: PluginContext): OpenFoxProviderInfo[] {
    if (context?.runtime?.configDirectory) {
      try {
        const configPath = path.join(context.runtime.configDirectory, 'config.json')
        if (fs.existsSync(configPath)) {
          const raw = fs.readFileSync(configPath, 'utf8')
          const parsed = JSON.parse(raw)
          if (Array.isArray(parsed?.providers) && parsed.providers.length > 0) {
            const list: OpenFoxProviderInfo[] = parsed.providers.map((p: any) => ({
              id: String(p.id),
              name: String(p.name || p.id),
            }))
            this.availableProviders = list
            return list
          }
        }
      } catch {
        // Ignore config read error
      }
    }
    return this.availableProviders
  }

  setAvailableProviders(providers: OpenFoxProviderInfo[]): void {
    this.availableProviders = [...providers]
  }

  getAvailableProviders(): OpenFoxProviderInfo[] {
    return [...this.availableProviders]
  }

  /**
   * Load assignments from persistent plugin storage.
   */
  loadAssignmentsFromStorage(storage?: { get: (key: string) => unknown }): void {
    if (!storage) return
    try {
      const data = storage.get(STORAGE_ASSIGNMENTS_KEY)
      if (typeof data === 'string') {
        const parsed = JSON.parse(data)
        if (parsed && typeof parsed === 'object') {
          for (const [k, v] of Object.entries(parsed)) {
            this.assignments.set(k, v as QuotaProviderAssignment)
          }
        }
      } else if (data && typeof data === 'object') {
        for (const [k, v] of Object.entries(data)) {
          this.assignments.set(k, v as QuotaProviderAssignment)
        }
      }
    } catch {
      // Gracefully ignore storage parse error
    }
  }

  /**
   * Save assignments to persistent plugin storage.
   */
  saveAssignmentsToStorage(storage?: { set: (key: string, value: unknown) => void }): void {
    if (!storage) return
    try {
      const record = this.getAssignments()
      storage.set(STORAGE_ASSIGNMENTS_KEY, JSON.stringify(record))
    } catch {
      // Gracefully ignore storage save error
    }
  }

  /**
   * Assign a quota source to an OpenFox provider.
   */
  assignProvider(assignment: QuotaProviderAssignment, context?: PluginContext): void {
    // Enforce 1-to-1: disallow assigning multiple quota sources to the same provider
    if (assignment.providerId && !assignment.unlinked) {
      for (const [sId, existing] of this.assignments.entries()) {
        if (sId !== assignment.sourceId && existing.providerId === assignment.providerId && !existing.unlinked) {
          this.assignments.set(sId, {
            sourceId: sId,
            providerId: '',
            unlinked: true,
          })
        }
      }
    }

    const existing = this.assignments.get(assignment.sourceId)
    const merged: QuotaProviderAssignment = {
      ...assignment,
      unlinked: false,
      selectedModels:
        assignment.selectedModels !== undefined
          ? assignment.selectedModels
          : existing?.selectedModels,
      metricDisplayModes:
        assignment.metricDisplayModes !== undefined
          ? assignment.metricDisplayModes
          : existing?.metricDisplayModes,
    }
    this.assignments.set(assignment.sourceId, merged)
    if (context?.storage) {
      this.saveAssignmentsToStorage(context.storage)
    }
  }

  /**
   * Remove a provider assignment for a quota source (marking it explicitly unlinked).
   */
  removeAssignment(sourceId: string, context?: PluginContext): boolean {
    this.assignments.set(sourceId, {
      sourceId,
      providerId: '',
      unlinked: true,
    })
    if (context?.storage) {
      this.saveAssignmentsToStorage(context.storage)
    }
    return true
  }

  /**
   * Toggle specific model / metric visibility for a quota source's assigned provider.
   */
  async toggleModelForSource(
    sourceId: string,
    model: string,
    context?: PluginContext,
  ): Promise<QuotaProviderAssignment | undefined> {
    let assignment = this.assignments.get(sourceId)
    if (!assignment) {
      assignment = { sourceId, providerId: sourceId, selectedModels: undefined }
    }

    // Determine all metric keys present in this source
    const report = await this.getQuotaReport()
    const source =
      report.sources.find((s) => s.id === sourceId) ?? this.pushedSources.get(sourceId)
    const allModels = Array.from(
      new Set(
        source?.metrics
          .map((m) => m.model || m.label || 'Quota')
          .filter(Boolean) ?? [model],
      ),
    )

    let currentSelected =
      assignment.selectedModels !== undefined ? [...assignment.selectedModels] : [...allModels]

    if (currentSelected.includes(model)) {
      currentSelected = currentSelected.filter((m) => m !== model)
    } else {
      currentSelected.push(model)
    }

    assignment.selectedModels = currentSelected
    this.assignments.set(sourceId, assignment)
    if (context?.storage) {
      this.saveAssignmentsToStorage(context.storage)
    }
    return assignment
  }

  /**
   * Cycle display mode for a model / metric: Off -> Circle (gauge) -> Value (value) -> Off
   */
  async cycleModelModeForSource(
    sourceId: string,
    model: string,
    context?: PluginContext,
  ): Promise<QuotaProviderAssignment | undefined> {
    let assignment = this.assignments.get(sourceId)
    if (!assignment) {
      assignment = { sourceId, providerId: sourceId, selectedModels: undefined }
    }

    const report = await this.getQuotaReport()
    const source =
      report.sources.find((s) => s.id === sourceId) ?? this.pushedSources.get(sourceId)
    const matchingMetric = source?.metrics.find((m) => (m.model || m.label || 'Quota') === model)

    const allModels = Array.from(
      new Set(
        source?.metrics
          .map((m) => m.model || m.label || 'Quota')
          .filter(Boolean) ?? [model],
      ),
    )

    let currentSelected =
      assignment.selectedModels !== undefined ? [...assignment.selectedModels] : [...allModels]
    const metricDisplayModes = { ...(assignment.metricDisplayModes ?? {}) }

    const isCurrentlySelected = currentSelected.includes(model)
    const currentMode: MetricDisplayMode =
      metricDisplayModes[model] ?? matchingMetric?.displayMode ?? 'gauge'

    if (!isCurrentlySelected) {
      currentSelected.push(model)
      metricDisplayModes[model] = matchingMetric?.displayMode ?? 'gauge'
    } else if (currentMode === 'gauge') {
      metricDisplayModes[model] = 'value'
    } else {
      currentSelected = currentSelected.filter((m) => m !== model)
      delete metricDisplayModes[model]
    }

    assignment.selectedModels = currentSelected
    assignment.metricDisplayModes = metricDisplayModes
    this.assignments.set(sourceId, assignment)
    if (context?.storage) {
      this.saveAssignmentsToStorage(context.storage)
    }
    return assignment
  }

  /**
   * Set display mode directly for a metric ('gauge' or 'value').
   */
  async setMetricDisplayMode(
    sourceId: string,
    model: string,
    mode: MetricDisplayMode,
    context?: PluginContext,
  ): Promise<QuotaProviderAssignment | undefined> {
    let assignment = this.assignments.get(sourceId)
    if (!assignment) {
      assignment = { sourceId, providerId: sourceId, selectedModels: undefined }
    }

    const report = await this.getQuotaReport()
    const source =
      report.sources.find((s) => s.id === sourceId) ?? this.pushedSources.get(sourceId)
    const allModels = Array.from(
      new Set(
        source?.metrics
          .map((m) => m.model || m.label || 'Quota')
          .filter(Boolean) ?? [model],
      ),
    )

    let currentSelected =
      assignment.selectedModels !== undefined ? [...assignment.selectedModels] : [...allModels]
    const metricDisplayModes = { ...(assignment.metricDisplayModes ?? {}) }

    if (!currentSelected.includes(model)) {
      currentSelected.push(model)
    }
    metricDisplayModes[model] = mode

    assignment.selectedModels = currentSelected
    assignment.metricDisplayModes = metricDisplayModes
    this.assignments.set(sourceId, assignment)
    if (context?.storage) {
      this.saveAssignmentsToStorage(context.storage)
    }
    return assignment
  }

  /**
   * Get all provider assignments.
   */
  getAssignments(): Record<string, QuotaProviderAssignment> {
    const res: Record<string, QuotaProviderAssignment> = {}
    for (const [k, v] of this.assignments.entries()) {
      res[k] = { ...v }
    }
    return res
  }

  /**
   * Get assignment for a single quota source.
   */
  getAssignment(sourceId: string): QuotaProviderAssignment | undefined {
    return this.assignments.get(sourceId)
  }

  /**
   * Compute circular gauge or direct value indicators for a specific OpenFox provider.
   */
  getGaugesForProvider(providerId: string): QuotaGaugeInfo[] {
    const gauges: QuotaGaugeInfo[] = []
    const report = this.lastReport

    // Find sources assigned to this provider ID (or matching by sourceId)
    for (const [sourceId, assignment] of this.assignments.entries()) {
      if (assignment.unlinked || !assignment.providerId) continue
      if (
        assignment.providerId === providerId ||
        assignment.providerId.toLowerCase().includes(providerId.toLowerCase()) ||
        providerId.toLowerCase().includes(assignment.providerId.toLowerCase())
      ) {
        const source =
          this.pushedSources.get(sourceId) ??
          report?.sources.find((s) => s.id === sourceId)
        if (!source) continue

        const selected = assignment.selectedModels
        const displayModes = assignment.metricDisplayModes ?? {}
        for (const metric of source.metrics) {
          const key = metric.model || metric.label || 'Quota'
          const isSelected =
            selected === undefined
              ? true
              : selected.includes(key) ||
                selected.includes(metric.model ?? '') ||
                selected.includes(metric.label)
          if (isSelected) {
            const modeOverride =
              displayModes[key] ??
              (metric.model ? displayModes[metric.model] : undefined) ??
              displayModes[metric.label]
            const info = buildQuotaGaugeInfo(metric, modeOverride)
            gauges.push(info)
          }
        }
      }
    }

    // If no explicit assignments found, check for auto-linked sources
    if (gauges.length === 0 && report?.sources) {
      for (const source of report.sources) {
        const assignment = this.assignments.get(source.id)
        if (assignment?.unlinked || assignment?.providerId) continue
        const auto = findAutoLinkedProvider(source, this.getAvailableProviders())
        if (auto && (auto.id === providerId || auto.name.toLowerCase() === providerId.toLowerCase())) {
          for (const metric of source.metrics) {
            gauges.push(buildQuotaGaugeInfo(metric))
          }
        }
      }
    }

    return gauges
  }

  /**
   * Clear pushed sources (optionally matching a predicate)
   */
  clearPushedSources(predicate?: (id: string) => boolean): void {
    if (!predicate) {
      this.pushedSources.clear()
      return
    }
    for (const id of Array.from(this.pushedSources.keys())) {
      if (predicate(id)) {
        this.pushedSources.delete(id)
      }
    }
  }

  /**
   * Method 1: Register a standard QuotaProvider (PR #288)
   */
  registerProvider(provider: QuotaProvider): void {
    this.providers.set(provider.id, provider)
  }

  unregisterProvider(id: string): boolean {
    return this.providers.delete(id)
  }

  getProviders(): QuotaProvider[] {
    this.drainPendingProviders()
    return Array.from(this.providers.values())
  }

  /**
   * Push static or cached QuotaSource data directly
   */
  submitSource(source: QuotaSource): void {
    this.pushedSources.set(source.id, source)
  }

  /**
   * Push a single metric to a quota source
   */
  submitMetric(sourceId: string, sourceName: string, metric: QuotaMetric): void {
    const existing = this.pushedSources.get(sourceId) ?? {
      id: sourceId,
      name: sourceName,
      metrics: [],
    }
    const index = existing.metrics.findIndex(
      (m) =>
        m.kind === metric.kind &&
        m.label === metric.label &&
        (m.model ?? '') === (metric.model ?? ''),
    )
    if (index >= 0) {
      existing.metrics[index] = metric
    } else {
      existing.metrics.push(metric)
    }
    this.pushedSources.set(sourceId, existing)
  }

  /**
   * Method 2: Register a custom declarative QuotaSection
   */
  registerCustomSection(section: CustomQuotaSection): void {
    this.customSections.set(section.id, section)
  }

  unregisterCustomSection(id: string): boolean {
    return this.customSections.delete(id)
  }

  getCustomSections(): CustomQuotaSection[] {
    return Array.from(this.customSections.values())
  }

  /**
   * Method 2: Register a Modal layout override
   */
  registerModalOverride(override: QuotaModalOverride): void {
    this.modalOverrides.set(override.id, override)
  }

  unregisterModalOverride(id: string): boolean {
    return this.modalOverrides.delete(id)
  }

  getModalOverrides(): QuotaModalOverride[] {
    return Array.from(this.modalOverrides.values())
  }

  /**
   * Aggregate quota report across all providers and pushed sources.
   * Gracefully ignores provider errors so failure in one provider doesn't break the whole report.
   */
  async getQuotaReport(): Promise<QuotaReport> {
    this.drainPendingProviders()
    if (this.context) {
      this.loadAvailableProviders(this.context)
    }
    const providerList = Array.from(this.providers.values())
    const providerResults = await Promise.all(
      providerList.map(async (provider) => {
        try {
          return await provider.getQuota()
        } catch {
          return null
        }
      }),
    )

    const sourceMap = new Map<string, QuotaSource>()

    // Pushed sources
    for (const [id, source] of this.pushedSources.entries()) {
      sourceMap.set(id, source)
    }

    // Provider sources override pushed
    for (const source of providerResults) {
      if (source && source.id) {
        sourceMap.set(source.id, source)
      }
    }

    const sources = Array.from(sourceMap.values())
    const hasWarning = hasQuotaWarning(sources)

    const report: QuotaReport = {
      sources,
      customSectionIds: Array.from(this.customSections.keys()),
      fetchedAt: new Date().toISOString(),
      hasWarning,
    }

    this.lastReport = report
    return report
  }

  /**
   * Check if any metric is currently at or over limit.
   */
  async hasWarning(): Promise<boolean> {
    const report = await this.getQuotaReport()
    return report.hasWarning
  }

  /**
   * Render the declarative UI for the modal.
   */
  async renderModalContent(): Promise<DeclarativeNode[]> {
    this.drainPendingProviders()
    if (this.context) {
      this.loadAvailableProviders(this.context)
    }
    const report = await this.getQuotaReport()
    return buildModalDeclarativeTree({
      sources: report.sources,
      customSections: this.getCustomSections(),
      overrides: this.getModalOverrides(),
      assignments: this.getAssignments(),
      availableProviders: this.getAvailableProviders(),
    })
  }

  /**
   * Refresh and publish updated quota modal state to OpenFox client.
   */
  async refresh(context?: PluginContext): Promise<QuotaReport> {
    if (context) {
      if (context.storage) {
        this.loadAssignmentsFromStorage(context.storage)
      }
      this.loadAvailableProviders(context)
    }

    const report = await this.getQuotaReport()
    const content = await this.renderModalContent()

    // Update the registered UI Panel in the PluginRegistry if available
    if (this.registry && typeof this.registry.registerUiPanel === 'function') {
      this.registry.registerUiPanel({
        id: 'quota-modal',
        pluginId: 'openfox-quota',
        title: {
          en: 'Usage & Quotas',
          fr: 'Utilisation & quotas',
        },
        size: 'xl',
        kind: 'declarative',
        content,
      })
    }

    if (context) {
      context.publish('quota-modal', 'content', content)
      context.publish('quota-modal', 'report', report)
      context.publish('quota-modal', 'hasWarning', report.hasWarning)
      context.publish('quota-modal', 'assignments', this.getAssignments())

      if (report.hasWarning) {
        context.logger.warn('Quota limit reached on one or more providers', {
          sources: report.sources
            .filter((s) => s.metrics.some(isQuotaMetricOverLimit))
            .map((s) => s.id),
        })
      }
    }

    return report
  }

  getLastReport(): QuotaReport | undefined {
    return this.lastReport
  }

  clear(): void {
    this.providers.clear()
    this.customSections.clear()
    this.modalOverrides.clear()
    this.pushedSources.clear()
    this.assignments.clear()
    this.availableProviders = []
    this.lastReport = undefined
  }
}

export const quotaManager: QuotaManager =
  (globalThis as any)[GLOBAL_QUOTA_KEY] ??
  ((globalThis as any)[GLOBAL_QUOTA_KEY] = new QuotaManager())
