import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  QUOTA_ICON_SVG,
  deactivate,
  getQuotaReport,
  isQuotaMetricOverLimit,
  quotaManager,
  register,
  registerCustomQuotaSection,
  registerQuotaModalOverride,
  registerQuotaProvider,
  renderMetricCard,
  renderSourceCard,
  submitQuotaSource,
} from './index.js'
import type {
  CustomQuotaSection,
  DeclarativeNode,
  PluginRegistry,
  QuotaModalOverride,
  QuotaProvider,
  QuotaSource,
} from './types.js'

function createMockRegistry() {
  const calls: Record<string, any[]> = {}
  const record = (key: string) => (value: any) => {
    calls[key] = [...(calls[key] ?? []), value]
  }

  const registry: PluginRegistry = {
    runtime: { mode: 'production', configDirectory: '/tmp' },
    context: {
      id: 'openfox-quota',
      version: '2.0.0',
      runtime: { mode: 'production', configDirectory: '/tmp' },
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      storage: { get: vi.fn(), set: vi.fn() },
      settings: vi.fn().mockReturnValue({ notifyOnLimit: true, refreshIntervalMinutes: 5 }),
      notify: vi.fn(),
      publish: vi.fn(),
    },
    registerTool: record('tool'),
    registerSettings: record('settings'),
    registerUiAction: record('uiAction'),
    registerUiBadge: record('uiBadge'),
    registerUiPanel: record('uiPanel'),
    registerUiComponent: record('uiComponent'),
    registerHook: (event, handler) => record(`hook:${event}`)(handler),
    registerRpc: (method, handler) => record(`rpc:${method}`)(handler),
    registerAsset: record('asset'),
    registerModelMetadataProvider: record('modelMetadataProvider'),
  }

  return { registry, calls }
}

function isCard(n: DeclarativeNode): n is Extract<DeclarativeNode, { type: 'card' }> {
  return n.type === 'card'
}

function isCallout(n: DeclarativeNode): n is Extract<DeclarativeNode, { type: 'callout' }> {
  return n.type === 'callout'
}

describe('openfox-quota plugin', () => {
  beforeEach(() => {
    deactivate()
    vi.clearAllMocks()
  })

  describe('Plugin Registration & Lifecycle', () => {
    it('registers header action, header component, modal panel, settings, RPCs, and tools', async () => {
      const { registry, calls } = createMockRegistry()
      await register(registry)

      // Header Action (slot: header.actions)
      expect(calls['uiAction']).toHaveLength(1)
      expect(calls['uiAction']?.[0]?.slot).toBe('header.actions')
      expect(calls['uiAction']?.[0]?.icon).toBe(QUOTA_ICON_SVG)
      expect(calls['uiAction']?.[0]?.variant).toBe('ghost')
      expect(calls['uiAction']?.[0]?.onActivate).toEqual({
        kind: 'openPanel',
        panelId: 'quota-modal',
      })

      // Header Component (zone: header.actions)
      expect(calls['uiComponent']).toHaveLength(1)
      expect(calls['uiComponent']?.[0]?.zone).toBe('header.actions')
      expect(calls['uiComponent']?.[0]?.position).toBe('before')
      expect(calls['uiComponent']?.[0]?.component?.type).toBe('button')
      expect(calls['uiComponent']?.[0]?.component?.icon).toBe(QUOTA_ICON_SVG)
      expect(calls['uiComponent']?.[0]?.component?.variant).toBe('ghost')

      // Quota Modal Panel
      expect(calls['uiPanel']).toHaveLength(1)
      expect(calls['uiPanel']?.[0]?.id).toBe('quota-modal')
      expect(calls['uiPanel']?.[0]?.kind).toBe('declarative')

      // Settings
      expect(calls['settings']).toHaveLength(1)

      // RPC methods
      expect(calls['rpc:quota.getReport']).toHaveLength(1)
      expect(calls['rpc:quota.refresh']).toHaveLength(1)
      expect(calls['rpc:quota.getModalContent']).toHaveLength(1)
      expect(calls['rpc:quota.submitMetric']).toHaveLength(1)
      expect(calls['rpc:quota.submitSource']).toHaveLength(1)

      // Tool
      expect(calls['tool']).toHaveLength(1)
      expect(calls['tool']?.[0]?.name).toBe('get_quota_report')

      // Hook
      expect(calls['hook:turn.completed']).toHaveLength(1)

      // Registry enhancement
      expect(typeof registry.registerQuotaProvider).toBe('function')
      expect(typeof registry.registerCustomQuotaSection).toBe('function')
      expect(typeof registry.registerQuotaModalOverride).toBe('function')
    })

    it('clears state on deactivate', () => {
      registerQuotaProvider({
        id: 'test',
        name: 'Test',
        getQuota: () => ({ id: 'test', name: 'Test', metrics: [] }),
      })
      expect(quotaManager.getProviders()).toHaveLength(1)
      deactivate()
      expect(quotaManager.getProviders()).toHaveLength(0)
    })
  })

  describe('Method 1: Standard Quota Providers (PR #288)', () => {
    it('aggregates multiple quota providers with windowed and token-balance metrics', async () => {
      const windowedProvider: QuotaProvider = {
        id: 'opencode-go',
        name: 'OpenCode Go',
        getQuota: async () => ({
          id: 'opencode-go',
          name: 'OpenCode Go',
          metrics: [
            {
              kind: 'windowed',
              label: 'Hourly Requests',
              used: 25,
              limit: 100,
              window: 'hour',
              resetsAt: new Date(Date.now() + 1800_000).toISOString(),
            },
            {
              kind: 'windowed',
              label: 'Weekly Requests',
              used: 400,
              limit: 5000,
              window: 'week',
            },
          ],
        }),
      }

      const tokenProvider: QuotaProvider = {
        id: 'github-copilot',
        name: 'GitHub Copilot Business',
        getQuota: async () => ({
          id: 'github-copilot',
          name: 'GitHub Copilot Business',
          metrics: [
            {
              kind: 'token-balance',
              label: 'Fast Requests',
              total: 500,
              remaining: 350,
            },
          ],
        }),
      }

      registerQuotaProvider(windowedProvider)
      registerQuotaProvider(tokenProvider)

      const report = await getQuotaReport()
      expect(report.sources).toHaveLength(2)
      expect(report.hasWarning).toBe(false)

      const opencode = report.sources.find((s) => s.id === 'opencode-go')
      expect(opencode?.metrics).toHaveLength(2)
      expect(opencode?.metrics[0]?.kind).toBe('windowed')

      const copilot = report.sources.find((s) => s.id === 'github-copilot')
      expect(copilot?.metrics).toHaveLength(1)
      expect(copilot?.metrics[0]?.kind).toBe('token-balance')
    })

    it('handles provider failures gracefully without crashing aggregation', async () => {
      const workingProvider: QuotaProvider = {
        id: 'working-provider',
        name: 'Working Provider',
        getQuota: async () => ({
          id: 'working-provider',
          name: 'Working Provider',
          metrics: [
            {
              kind: 'windowed',
              label: 'Requests',
              used: 10,
              limit: 100,
              window: 'hour',
            },
          ],
        }),
      }

      const failingProvider: QuotaProvider = {
        id: 'failing-provider',
        name: 'Failing Provider',
        getQuota: async () => {
          throw new Error('Network timeout')
        },
      }

      registerQuotaProvider(workingProvider)
      registerQuotaProvider(failingProvider)

      const report = await getQuotaReport()
      expect(report.sources).toHaveLength(1)
      expect(report.sources[0]?.id).toBe('working-provider')
    })

    it('correctly detects limits and sets warning flag', async () => {
      const overLimitProvider: QuotaProvider = {
        id: 'over-limit',
        name: 'Over Limit Provider',
        getQuota: async () => ({
          id: 'over-limit',
          name: 'Over Limit Provider',
          metrics: [
            {
              kind: 'windowed',
              label: 'Hourly Limit',
              used: 100,
              limit: 100,
              window: 'hour',
            },
          ],
        }),
      }

      registerQuotaProvider(overLimitProvider)

      const report = await getQuotaReport()
      expect(report.hasWarning).toBe(true)
      expect(isQuotaMetricOverLimit(report.sources[0]!.metrics[0]!)).toBe(true)
    })

    it('renders standard source and metric cards properly', () => {
      const source: QuotaSource = {
        id: 'google-antigravity',
        name: 'Google Antigravity',
        description: 'Cloud Code Assist limits',
        metrics: [
          {
            kind: 'windowed',
            label: 'Requests',
            used: 50,
            limit: 200,
            window: 'hour',
            model: 'claude-3-5-sonnet',
            resetsAt: '2026-09-22T00:00:00.000Z',
          },
        ],
      }

      const card = renderSourceCard(source)
      expect(card.type).toBe('card')
      if (card.type === 'card') {
        expect(card.title?.en).toBe('Google Antigravity')
      }

      const rendered = JSON.stringify(card)
      expect(rendered).toContain('w-full flex-row flex-nowrap gap-2')
      expect(rendered).toContain('Requests')
      expect(rendered).toContain('text-3xl font-mono font-bold')
      expect(rendered).toContain('left')
      expect(rendered).toContain('🕒 Resets')
      expect(rendered).toContain('quota.cycleModelMode')
      expect(rendered).toContain('"variant":"pill"')

      const metricCard = renderMetricCard(source.metrics[0]!)
      expect(metricCard.type).toBe('card')
    })
  })

  describe('Method 2: Custom Quota Sections & Overrides', () => {
    it('renders custom declarative components from other plugins', async () => {
      const customSection: CustomQuotaSection = {
        id: 'gpu-cluster-quota',
        title: { en: 'GPU Compute Hours', fr: 'Heures de calcul GPU' },
        order: 10,
        render: async () => [
          {
            type: 'table',
            columns: [
              { en: 'Cluster', fr: 'Cluster' },
              { en: 'Allocated', fr: 'Alloué' },
              { en: 'Available', fr: 'Disponible' },
            ],
            rows: [
              ['H100 Node A', '8 / 8 GPUs', '0 available'],
              ['A100 Node B', '4 / 16 GPUs', '12 available'],
            ],
          },
          {
            type: 'callout',
            tone: 'info',
            title: { en: 'Scheduled Maintenance', fr: 'Maintenance prévue' },
            text: { en: 'Cluster maintenance at 02:00 UTC', fr: 'Maintenance à 02:00 UTC' },
          },
        ],
      }

      registerCustomQuotaSection(customSection)
      const nodes = await quotaManager.renderModalContent()

      // Finds the custom card
      const customNode = nodes.find(
        (n): n is Extract<DeclarativeNode, { type: 'card' }> =>
          isCard(n) && n.title?.en === 'GPU Compute Hours',
      )
      expect(customNode).toBeDefined()
      if (customNode && customNode.type === 'card') {
        expect(customNode.children).toHaveLength(2)
        expect(customNode.children[0]?.type).toBe('table')
        expect(customNode.children[1]?.type).toBe('callout')
      }
    })

    it('handles custom section errors gracefully without crashing modal', async () => {
      const buggySection: CustomQuotaSection = {
        id: 'buggy-section',
        render: async () => {
          throw new Error('Render failed')
        },
      }

      registerCustomQuotaSection(buggySection)
      const nodes = await quotaManager.renderModalContent()

      const errorCallout = nodes.find(
        (n): n is Extract<DeclarativeNode, { type: 'callout' }> =>
          isCallout(n) && Boolean(n.title?.en.includes('Failed to render custom quota: buggy-section')),
      )
      expect(errorCallout).toBeDefined()
    })

    it('supports modal layout override replacing the entire modal content', async () => {
      const customOverride: QuotaModalOverride = {
        id: 'full-override',
        mode: 'replace',
        order: 100,
        render: () => [
          {
            type: 'text',
            text: { en: 'Completely customized modal', fr: 'Modal entièrement personnalisé' },
          },
        ],
      }

      registerQuotaModalOverride(customOverride)
      const nodes = await quotaManager.renderModalContent()

      expect(nodes).toHaveLength(1)
      expect(nodes[0]?.type).toBe('text')
      if (nodes[0]?.type === 'text') {
        expect(nodes[0].text.en).toBe('Completely customized modal')
      }
    })
  })

  describe('RPC Methods & Direct Data Submission', () => {
    it('handles quota.getReport and quota.refresh RPC calls', async () => {
      const { registry, calls } = createMockRegistry()
      await register(registry)

      registerQuotaProvider({
        id: 'p1',
        name: 'Provider 1',
        getQuota: () => ({
          id: 'p1',
          name: 'Provider 1',
          metrics: [
            { kind: 'token-balance', label: 'Tokens', total: 1000, remaining: 800 },
          ],
        }),
      })

      const getReportHandler = calls['rpc:quota.getReport']?.[0]
      const report = (await getReportHandler()) as any
      expect(report.sources).toHaveLength(1)
      expect(report.sources[0]?.id).toBe('p1')

      const refreshHandler = calls['rpc:quota.refresh']?.[0]
      const refreshResult = (await refreshHandler()) as any
      expect(refreshResult.success).toBe(true)
      expect(registry.context.publish).toHaveBeenCalledWith('quota-modal', 'content', expect.any(Array))
    })

    it('allows external metrics submission via submitMetric and submitSource', async () => {
      const { registry, calls } = createMockRegistry()
      await register(registry)

      const submitSourceHandler = calls['rpc:quota.submitSource']?.[0]
      submitSourceHandler({
        source: {
          id: 'custom-src',
          name: 'Custom Source',
          metrics: [{ kind: 'windowed', label: 'Reqs', used: 5, limit: 20, window: 'hour' }],
        },
      })

      const report1 = await getQuotaReport()
      expect(report1.sources.some((s) => s.id === 'custom-src')).toBe(true)

      const submitMetricHandler = calls['rpc:quota.submitMetric']?.[0]
      submitMetricHandler({
        sourceId: 'custom-src',
        sourceName: 'Custom Source',
        metric: { kind: 'token-balance', label: 'Points', total: 50, remaining: 10 },
      })

      const report2 = await getQuotaReport()
      const src = report2.sources.find((s) => s.id === 'custom-src')
      expect(src?.metrics).toHaveLength(2)
    })
  })

  describe('LLM Tool & Notification Hook', () => {
    it('executes get_quota_report tool and returns formatted JSON', async () => {
      const { registry, calls } = createMockRegistry()
      await register(registry)

      submitQuotaSource({
        id: 'tool-test',
        name: 'Tool Test',
        metrics: [{ kind: 'windowed', label: 'Calls', used: 12, limit: 100, window: 'day' }],
      })

      const tool = calls['tool']?.[0]
      const result = await tool.execute({}, {})
      expect(result.success).toBe(true)
      const parsed = JSON.parse(result.output)
      expect(parsed.sources).toHaveLength(1)
      expect(parsed.sources[0].id).toBe('tool-test')
    })

    it('notifies user on turn.completed when a quota limit is exceeded', async () => {
      const { registry, calls } = createMockRegistry()
      await register(registry)

      submitQuotaSource({
        id: 'exhausted-quota',
        name: 'Exhausted Quota',
        metrics: [{ kind: 'token-balance', label: 'Tokens', total: 100, remaining: 0 }],
      })

      const turnCompletedHook = calls['hook:turn.completed']?.[0]
      await turnCompletedHook({ sessionId: 's1' })

      expect(registry.context.notify).toHaveBeenCalledWith(
        expect.objectContaining({
          level: 'warning',
          title: expect.objectContaining({ en: 'Quota Limit Reached' }),
        }),
      )
    })
  })

  describe('Provider Quota Assignment & Metric Gauge Selection', () => {
    it('assigns a quota source to an OpenFox provider and retrieves gauges', async () => {
      const { registry, calls } = createMockRegistry()
      await register(registry)

      submitQuotaSource({
        id: 'google-antigravity',
        name: 'Google Antigravity (4 accounts)',
        metrics: [
          { kind: 'windowed', label: 'Requests', used: 676, limit: 4000, window: 'day', model: 'Gemini' },
          { kind: 'windowed', label: 'Requests', used: 0, limit: 4000, window: 'day', model: 'Claude' },
          { kind: 'windowed', label: 'Requests', used: 0, limit: 4000, window: 'day', model: 'GPT-OSS' },
        ],
      })

      // Assign via RPC
      const assignHandler = calls['rpc:quota.assignProvider']?.[0]
      const assignRes = (await assignHandler({
        sourceId: 'google-antigravity',
        providerId: 'antigravity',
        providerName: 'Antigravity',
      })) as any

      expect(assignRes.success).toBe(true)
      expect(quotaManager.getAssignment('google-antigravity')?.providerId).toBe('antigravity')

      // Get provider gauges
      const getProviderQuotasHandler = calls['rpc:quota.getProviderQuotas']?.[0]
      const gaugesRes = (getProviderQuotasHandler({ providerId: 'antigravity' })) as any

      expect(gaugesRes.success).toBe(true)
      expect(gaugesRes.gauges).toHaveLength(3)
      expect(gaugesRes.gauges[0].model).toBe('Gemini')
      expect(gaugesRes.gauges[0].pct).toBe(17)
      expect(gaugesRes.gauges[0].svg).toContain('<svg')
    })

    it('toggles metric visibility for provider gauges and persists to storage', async () => {
      const { registry, calls } = createMockRegistry()
      await register(registry)

      submitQuotaSource({
        id: 'google-antigravity',
        name: 'Google Antigravity',
        metrics: [
          { kind: 'windowed', label: 'Requests', used: 676, limit: 4000, window: 'day', model: 'Gemini' },
          { kind: 'windowed', label: 'Requests', used: 0, limit: 4000, window: 'day', model: 'Claude' },
          { kind: 'windowed', label: 'Requests', used: 0, limit: 4000, window: 'day', model: 'GPT-OSS' },
        ],
      })

      quotaManager.assignProvider({
        sourceId: 'google-antigravity',
        providerId: 'antigravity',
      }, registry.context)

      // Toggle Claude off
      const toggleHandler = calls['rpc:quota.toggleModel']?.[0]
      await toggleHandler({ sourceId: 'google-antigravity', model: 'Claude' })

      const gauges = quotaManager.getGaugesForProvider('antigravity')
      expect(gauges.map((g) => g.model)).toEqual(['Gemini', 'GPT-OSS'])

      // Storage set called
      expect(registry.context.storage.set).toHaveBeenCalled()
    })

    it('allows hiding all models without resetting to all visible', async () => {
      const { registry, calls } = createMockRegistry()
      await register(registry)

      submitQuotaSource({
        id: 'test-src',
        name: 'Test Source',
        metrics: [
          { kind: 'windowed', label: 'Reqs', used: 10, limit: 100, window: 'day', model: 'M1' },
          { kind: 'windowed', label: 'Reqs', used: 20, limit: 100, window: 'day', model: 'M2' },
        ],
      })

      quotaManager.assignProvider({
        sourceId: 'test-src',
        providerId: 'prov-test',
      }, registry.context)

      const toggleHandler = calls['rpc:quota.toggleModel']?.[0]
      // Hide M1
      await toggleHandler({ sourceId: 'test-src', model: 'M1' })
      expect(quotaManager.getGaugesForProvider('prov-test').map((g) => g.model)).toEqual(['M2'])

      // Hide M2 (now both are hidden!)
      await toggleHandler({ sourceId: 'test-src', model: 'M2' })
      expect(quotaManager.getGaugesForProvider('prov-test')).toEqual([])

      // Unhide M1
      await toggleHandler({ sourceId: 'test-src', model: 'M1' })
      expect(quotaManager.getGaugesForProvider('prov-test').map((g) => g.model)).toEqual(['M1'])
    })

    it('renders provider assignment bar and metric selectors in modal tree', async () => {
      submitQuotaSource({
        id: 'antigravity-pool',
        name: 'Google Antigravity (4 accounts)',
        metrics: [
          { kind: 'windowed', label: 'Requests', used: 676, limit: 4000, window: 'day', model: 'Gemini' },
          { kind: 'windowed', label: 'Requests', used: 0, limit: 4000, window: 'day', model: 'Claude' },
        ],
      })

      quotaManager.setAvailableProviders([
        { id: 'prov-antigravity', name: 'Antigravity' },
        { id: 'prov-opencode', name: 'OpenCode Go' },
        { id: 'prov-copilot', name: 'GitHub Copilot' },
      ])

      quotaManager.assignProvider({
        sourceId: 'antigravity-pool',
        providerId: 'prov-antigravity',
        providerName: 'Antigravity',
      })

      const nodes = await quotaManager.renderModalContent()
      const card = nodes.find(isCard)
      expect(card).toBeDefined()
      expect(JSON.stringify(card)).toContain('Antigravity')
      expect(JSON.stringify(card)).toContain('quota.cycleModelMode')
      expect(JSON.stringify(card)).toContain('quota.removeAssignment')
    })

    it('renders all available providers when unassigned', async () => {
      submitQuotaSource({
        id: 'unassigned-source',
        name: 'Unassigned Quota',
        metrics: [
          { kind: 'windowed', label: 'Calls', used: 10, limit: 100, window: 'day', model: 'Gemini' },
        ],
      })

      quotaManager.setAvailableProviders([
        { id: 'prov-1', name: 'Antigravity' },
        { id: 'prov-2', name: 'OpenCode Go' },
        { id: 'prov-3', name: 'ChatGPT Codex' },
      ])

      const nodes = await quotaManager.renderModalContent()
      const str = JSON.stringify(nodes)
      expect(str).toContain('Antigravity')
      expect(str).toContain('OpenCode Go')
      expect(str).toContain('ChatGPT Codex')
      expect(str).toContain('quota.assignProvider')
    })
    it('automatically links source to matching provider without manual assignment', async () => {
      submitQuotaSource({
        id: 'antigravity-cred-ref-1',
        name: 'Google Antigravity (james@google.com)',
        metrics: [
          { kind: 'windowed', label: 'Requests', used: 100, limit: 4000, window: 'day', model: 'Gemini' },
        ],
      })

      quotaManager.setAvailableProviders([
        { id: 'prov-antigravity', name: 'Google Antigravity' },
        { id: 'prov-copilot', name: 'GitHub Copilot' },
      ])

      const nodes = await quotaManager.renderModalContent()
      const str = JSON.stringify(nodes)
      expect(str).toContain('Google Antigravity')
      expect(str).toContain('Provider: Google Antigravity')
      expect(str).toContain('Unlink')

      // Verify gauges are also automatically resolved for the provider
      const gauges = quotaManager.getGaugesForProvider('prov-antigravity')
      expect(gauges).toHaveLength(1)
      expect(gauges[0]?.model).toBe('Gemini')

      // Now explicitly unlink the source and verify it stays unlinked
      quotaManager.removeAssignment('antigravity-cred-ref-1')
      const unlinkedNodes = await quotaManager.renderModalContent()
      const unlinkedStr = JSON.stringify(unlinkedNodes)
      expect(unlinkedStr).toContain('quota.assignProvider')
      expect(unlinkedStr).not.toContain('Provider: Google Antigravity')

      // And gauges should be empty after unlinking
      const unlinkedGauges = quotaManager.getGaugesForProvider('prov-antigravity')
      expect(unlinkedGauges).toHaveLength(0)
    })

    it('automatically links Cheaper Inference source to matching provider', async () => {
      submitQuotaSource({
        id: 'cheaperinference-cred-1',
        name: 'Cheaper Inference (sk-1234)',
        metrics: [
          { kind: 'token-balance', label: 'Credits Balance', total: 1000, remaining: 750 },
        ],
      })

      quotaManager.setAvailableProviders([
        { id: 'prov-cheaper', name: 'Cheaper Inference' },
        { id: 'prov-copilot', name: 'GitHub Copilot' },
      ])

      const nodes = await quotaManager.renderModalContent()
      const str = JSON.stringify(nodes)
      expect(str).toContain('Cheaper Inference')
      expect(str).toContain('Provider: Cheaper Inference')
      expect(str).toContain('Unlink')

      const gauges = quotaManager.getGaugesForProvider('prov-cheaper')
      expect(gauges).toHaveLength(1)
      expect(gauges[0]?.label).toBe('Credits Balance')
    })

    it('enforces 1-to-1 provider assignment preventing 2 quota sources from linking to the same provider', async () => {
      submitQuotaSource({
        id: 'source-1',
        name: 'Account 1',
        metrics: [{ kind: 'windowed', label: 'Req', used: 10, limit: 100, window: 'day' }],
      })
      submitQuotaSource({
        id: 'source-2',
        name: 'Account 2',
        metrics: [{ kind: 'windowed', label: 'Req', used: 20, limit: 100, window: 'day' }],
      })

      quotaManager.assignProvider({
        sourceId: 'source-1',
        providerId: 'shared-provider',
        providerName: 'Shared Provider',
      })

      expect(quotaManager.getAssignment('source-1')?.providerId).toBe('shared-provider')

      // Now assign source-2 to the same provider
      quotaManager.assignProvider({
        sourceId: 'source-2',
        providerId: 'shared-provider',
        providerName: 'Shared Provider',
      })

      // source-2 is now assigned, and source-1 was unlinked
      expect(quotaManager.getAssignment('source-2')?.providerId).toBe('shared-provider')
      expect(quotaManager.getAssignment('source-1')?.unlinked).toBe(true)
    })

    it('supports cycleModelMode, setMetricDisplayMode, and renders value badges with plugin icons', async () => {
      const { registry, calls } = createMockRegistry()
      await register(registry)

      const WALLET_SVG = '<svg wallet></svg>'
      const PIGGY_SVG = '<svg piggy></svg>'

      submitQuotaSource({
        id: 'cheaperinference-wallet',
        name: 'Cheaper Inference',
        metrics: [
          {
            kind: 'currency',
            label: 'Balance',
            amount: 0.59,
            currency: 'USD',
            tone: 'danger',
            icon: WALLET_SVG,
            displayMode: 'value',
          },
          {
            kind: 'currency',
            label: 'Estimated Saved',
            amount: 7.07,
            currency: 'USD',
            tone: 'success',
            icon: PIGGY_SVG,
            displayMode: 'value',
          },
          {
            kind: 'windowed',
            label: 'Requests',
            model: 'Gemini',
            used: 1634,
            limit: 4000,
            window: 'day',
            displayMode: 'gauge',
          },
        ],
      })

      quotaManager.assignProvider({
        sourceId: 'cheaperinference-wallet',
        providerId: 'prov-ci',
        providerName: 'Cheaper Inference',
      }, registry.context)

      // Test 1: Check gauges generated with default display modes and plugin icons
      let gauges = quotaManager.getGaugesForProvider('prov-ci')
      expect(gauges).toHaveLength(3)

      const balanceGauge = gauges.find((g) => g.label === 'Balance')
      expect(balanceGauge?.displayMode).toBe('value')
      expect(balanceGauge?.formattedValue.en).toBe('$0.59')
      expect(balanceGauge?.icon).toBe(WALLET_SVG)

      const savedGauge = gauges.find((g) => g.label === 'Estimated Saved')
      expect(savedGauge?.displayMode).toBe('value')
      expect(savedGauge?.formattedValue.en).toBe('$7.07')
      expect(savedGauge?.icon).toBe(PIGGY_SVG)

      const geminiGauge = gauges.find((g) => g.model === 'Gemini')
      expect(geminiGauge?.displayMode).toBe('gauge')
      expect(geminiGauge?.svg).toContain('<svg')

      // Test 2: Check metadata provider output (badges for provider list)
      const metaProvider = calls['modelMetadataProvider']?.[0]
      expect(metaProvider).toBeDefined()

      const meta = await metaProvider.getProviderMetadata({ providerId: 'prov-ci' })
      expect(meta?.badges).toHaveLength(3)

      // Balance badge in Value mode has label, icon, and tone
      const balanceBadge = meta?.badges?.find((b: any) => b.label?.en === '$0.59')
      expect(balanceBadge).toBeDefined()
      expect(balanceBadge?.icon).toBe(WALLET_SVG)
      expect(balanceBadge?.tone).toBe('danger')

      // Gemini badge in Gauge mode has empty label and circular SVG icon
      const geminiBadge = meta?.badges?.find((b: any) => b.label?.en === '')
      expect(geminiBadge).toBeDefined()
      expect(geminiBadge?.icon).toContain('<svg')

      // Test 3: cycleModelMode RPC
      const cycleHandler = calls['rpc:quota.cycleModelMode']?.[0]
      expect(cycleHandler).toBeDefined()

      // Gemini was 'gauge' -> cycle becomes 'value'
      await cycleHandler({ sourceId: 'cheaperinference-wallet', model: 'Gemini' })
      gauges = quotaManager.getGaugesForProvider('prov-ci')
      expect(gauges.find((g) => g.model === 'Gemini')?.displayMode).toBe('value')

      // Gemini was 'value' -> cycle becomes 'off' (hidden)
      await cycleHandler({ sourceId: 'cheaperinference-wallet', model: 'Gemini' })
      gauges = quotaManager.getGaugesForProvider('prov-ci')
      expect(gauges.find((g) => g.model === 'Gemini')).toBeUndefined()

      // Gemini was 'off' -> cycle becomes 'gauge'
      await cycleHandler({ sourceId: 'cheaperinference-wallet', model: 'Gemini' })
      gauges = quotaManager.getGaugesForProvider('prov-ci')
      expect(gauges.find((g) => g.model === 'Gemini')?.displayMode).toBe('gauge')

      // Test 4: setMetricDisplayMode RPC
      const setModeHandler = calls['rpc:quota.setMetricDisplayMode']?.[0]
      expect(setModeHandler).toBeDefined()

      await setModeHandler({ sourceId: 'cheaperinference-wallet', model: 'Balance', mode: 'gauge' })
      gauges = quotaManager.getGaugesForProvider('prov-ci')
      expect(gauges.find((g) => g.label === 'Balance')?.displayMode).toBe('gauge')
    })
  })
})
