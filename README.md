# openfox-quota

Usage & Quota tracking plugin for OpenFox.

This plugin provides a unified Quota Modal and Header Action button in OpenFox, allowing other plugins to report, customize, and display AI model usage and rate limits.

---

## Features

- **Header Integration**: Adds a header action and header button to quickly open the Quotas modal.
- **Unified Quota Modal**: Displays windowed limits (requests/hour, week, month), token balance pools, model breakdowns, progress bars, and reset countdowns.
- **Limit Warnings**: Highlights metrics exceeding limits with danger tones, and sends in-app notifications on turn completion.
- **Two Extension Methods for Other Plugins**:
  1. **Method 1 (Standard Quota Provider)**: Generic `QuotaProvider` interface supporting windowed and token-balance metrics with failure resilience.
  2. **Method 2 (Custom Declarative Quota Section)**: Plugins can inject their own OpenFox `DeclarativeNode` trees or modal overrides to display specialized quota formats.

---

## Extension Guide for Other Plugins

### Method 1: Standard Quota Provider

Plugins reporting standard quota limits (e.g. hourly requests, monthly token pool) can register a `QuotaProvider`:

```typescript
import type { QuotaProvider, QuotaSource } from 'openfox-quota'

export function register(registry) {
  const provider: QuotaProvider = {
    id: 'my-provider-id',
    name: 'My Provider',
    getQuota: async (): Promise<QuotaSource> => {
      return {
        id: 'my-provider-id',
        name: 'My Provider',
        metrics: [
          {
            kind: 'windowed',
            label: 'Requests',
            used: 42,
            limit: 100,
            window: 'hour',
            resetsAt: new Date(Date.now() + 3600_000).toISOString(),
          },
          {
            kind: 'token-balance',
            label: 'Credits',
            total: 1000,
            remaining: 750,
          },
        ],
      }
    },
  }

  // Option A: Via registry enhancement
  if (typeof registry.registerQuotaProvider === 'function') {
    registry.registerQuotaProvider(provider)
  }

  // Option B: Via module import
  // registerQuotaProvider(provider)
}
```

---

### Method 2: Custom Declarative Quota Sections

If a plugin needs to display quotas in a specialized format (custom charts, tables, cluster hardware allocations, callouts, iframes), it can register a `CustomQuotaSection`:

```typescript
import type { CustomQuotaSection } from 'openfox-quota'

export function register(registry) {
  const customSection: CustomQuotaSection = {
    id: 'gpu-cluster-quota',
    title: { en: 'GPU Compute Cluster', fr: 'Cluster de calcul GPU' },
    order: 20,
    render: async () => [
      {
        type: 'table',
        columns: [
          { en: 'Node', fr: 'Nœud' },
          { en: 'Allocation', fr: 'Allocation' },
          { en: 'Status', fr: 'Statut' },
        ],
        rows: [
          ['Cluster-A', '8 / 8 GPUs', 'Active'],
          ['Cluster-B', '2 / 16 GPUs', 'Idle'],
        ],
      },
      {
        type: 'callout',
        tone: 'info',
        title: { en: 'Scheduled Maintenance', fr: 'Maintenance prévue' },
        text: { en: 'Node A reboot at 04:00 UTC', fr: 'Redémarrage du nœud A à 04:00 UTC' },
      },
    ],
  }

  if (typeof registry.registerCustomQuotaSection === 'function') {
    registry.registerCustomQuotaSection(customSection)
  }
}
```

---

## RPC API

- `quota.getReport`: Retrieve aggregated JSON quota report.
- `quota.refresh`: Re-fetches all quotas and publishes updated declarative tree to the modal.
- `quota.getModalContent`: Retrieve full `DeclarativeNode[]` tree.
- `quota.submitMetric`: Push a single metric `{ sourceId, sourceName, metric }`.
- `quota.submitSource`: Push a complete `QuotaSource`.

---

## Build and Test

```bash
cd tmp/openfox-plugins/openfox-quota
npm run build
npm run test
npm run typecheck
```
