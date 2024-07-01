/**
 * @packageDocumentation
 *
 * Configure your libp2p node with Prometheus metrics:
 *
 * ```typescript
 * import { createLibp2p } from 'libp2p'
 * import { prometheusMetrics } from '@libp2p/prometheus-metrics'
 *
 * const node = await createLibp2p({
 *   metrics: prometheusMetrics()
 * })
 * ```
 *
 * Then use the `prom-client` module to supply metrics to the Prometheus/Graphana client using your http framework:
 *
 * ```JavaScript
 * import client from 'prom-client'
 *
 * async function handler (request, h) {
 *   return h.response(await client.register.metrics())
 *     .type(client.register.contentType)
 * }
 * ```
 *
 * All Prometheus metrics are global so there's no other work required to extract them.
 *
 * ## Queries
 *
 * Some useful queries are:
 *
 * ### Data sent/received
 *
 * ```
 * rate(libp2p_data_transfer_bytes_total[30s])
 * ```
 *
 * ### CPU usage
 *
 * ```
 * rate(process_cpu_user_seconds_total[30s]) * 100
 * ```
 *
 * ### Memory usage
 *
 * ```
 * nodejs_memory_usage_bytes
 * ```
 *
 * ### DHT query time
 *
 * ```
 * libp2p_kad_dht_wan_query_time_seconds
 * ```
 *
 * or
 *
 * ```
 * libp2p_kad_dht_lan_query_time_seconds
 * ```
 *
 * ### TCP transport dialer errors
 *
 * ```
 * rate(libp2p_tcp_dialer_errors_total[30s])
 * ```
 */

import { serviceCapabilities } from '@libp2p/interface'
import each from 'it-foreach'
import { collectDefaultMetrics, type DefaultMetricsCollectorConfiguration, register, type Registry, type RegistryContentType } from 'prom-client'
import { PrometheusCounterGroup } from './counter-group.js'
import { PrometheusCounter } from './counter.js'
import { PrometheusMetricGroup } from './metric-group.js'
import { PrometheusMetric } from './metric.js'
import type { ComponentLogger, Logger, MultiaddrConnection, Stream, Connection, CalculatedMetricOptions, Counter, CounterGroup, Metric, MetricGroup, MetricOptions, Metrics } from '@libp2p/interface'
import type { Duplex } from 'it-stream-types'
import type { Uint8ArrayList } from 'uint8arraylist'

// prom-client metrics are global
const metrics = new Map<string, any>()

export interface PrometheusMetricsInit {
  /**
   * Use a custom registry to register metrics.
   * By default, the global registry is used to register metrics.
   */
  registry?: Registry

  /**
   * By default we collect default metrics - CPU, memory etc, to not do
   * this, pass true here
   */
  collectDefaultMetrics?: boolean

  /**
   * prom-client options to pass to the `collectDefaultMetrics` function
   */
  defaultMetrics?: DefaultMetricsCollectorConfiguration<RegistryContentType>

  /**
   * All metrics in prometheus are global so to prevent clashes in naming
   * we reset the global metrics registry on creation - to not do this,
   * pass true here
   */
  preserveExistingMetrics?: boolean
}

export interface PrometheusCalculatedMetricOptions<T=number> extends CalculatedMetricOptions<T> {
  registry?: Registry
}

export interface PrometheusMetricsComponents {
  logger: ComponentLogger
}

class PrometheusMetrics implements Metrics {
  private readonly log: Logger
  private transferStats: Map<string, number>
  private readonly registry?: Registry

  constructor (components: PrometheusMetricsComponents, init?: Partial<PrometheusMetricsInit>) {
    this.log = components.logger.forComponent('libp2p:prometheus-metrics')
    this.registry = init?.registry

    if (init?.preserveExistingMetrics !== true) {
      this.log('Clearing existing metrics')
      metrics.clear()
      ;(this.registry ?? register).clear()
    }

    if (init?.collectDefaultMetrics !== false) {
      this.log('Collecting default metrics')
      collectDefaultMetrics({ ...init?.defaultMetrics, register: this.registry ?? init?.defaultMetrics?.register })
    }

    // holds global and per-protocol sent/received stats
    this.transferStats = new Map()

    this.log('Collecting data transfer metrics')
    this.registerCounterGroup('libp2p_data_transfer_bytes_total', {
      label: 'protocol',
      calculate: () => {
        const output: Record<string, number> = {}

        for (const [key, value] of this.transferStats.entries()) {
          output[key] = value
        }

        // reset counts for next time
        this.transferStats = new Map()

        return output
      }
    })

    this.log('Collecting memory metrics')
    this.registerMetricGroup('nodejs_memory_usage_bytes', {
      label: 'memory',
      calculate: () => {
        return {
          ...process.memoryUsage()
        }
      }
    })
  }

  readonly [Symbol.toStringTag] = '@libp2p/metrics-prometheus'

  readonly [serviceCapabilities]: string[] = [
    '@libp2p/metrics'
  ]

  /**
   * Increment the transfer stat for the passed key, making sure
   * it exists first
   */
  _incrementValue (key: string, value: number): void {
    const existing = this.transferStats.get(key) ?? 0

    this.transferStats.set(key, existing + value)
  }

  /**
   * Override the sink/source of the stream to count the bytes
   * in and out
   */
  _track (stream: Duplex<AsyncGenerator<Uint8Array | Uint8ArrayList>>, name: string): void {
    const self = this

    const sink = stream.sink
    stream.sink = async function trackedSink (source) {
      await sink(each(source, buf => {
        self._incrementValue(`${name} sent`, buf.byteLength)
      }))
    }

    const source = stream.source
    stream.source = each(source, buf => {
      self._incrementValue(`${name} received`, buf.byteLength)
    })
  }

  trackMultiaddrConnection (maConn: MultiaddrConnection): void {
    this._track(maConn, 'global')
  }

  trackProtocolStream (stream: Stream, connection: Connection): void {
    if (stream.protocol == null) {
      // protocol not negotiated yet, should not happen as the upgrader
      // calls this handler after protocol negotiation
      return
    }

    this._track(stream, stream.protocol)
  }

  registerMetric (name: string, opts: PrometheusCalculatedMetricOptions): void
  registerMetric (name: string, opts?: MetricOptions): Metric
  registerMetric (name: string, opts: any = {}): any {
    if (name == null ?? name.trim() === '') {
      throw new Error('Metric name is required')
    }

    let metric = metrics.get(name)

    if (metrics.has(name)) {
      this.log('Reuse existing metric', name)

      if (opts.calculate != null) {
        metric.addCalculator(opts.calculate)
      }

      return metrics.get(name)
    }

    this.log('Register metric', name)
    metric = new PrometheusMetric(name, { registry: this.registry, ...opts })

    metrics.set(name, metric)

    if (opts.calculate == null) {
      return metric
    }
  }

  registerMetricGroup (name: string, opts: PrometheusCalculatedMetricOptions<Record<string, number>>): void
  registerMetricGroup (name: string, opts?: MetricOptions): MetricGroup
  registerMetricGroup (name: string, opts: any = {}): any {
    if (name == null ?? name.trim() === '') {
      throw new Error('Metric group name is required')
    }

    let metricGroup = metrics.get(name)

    if (metricGroup != null) {
      this.log('Reuse existing metric group', name)

      if (opts.calculate != null) {
        metricGroup.addCalculator(opts.calculate)
      }

      return metricGroup
    }

    this.log('Register metric group', name)
    metricGroup = new PrometheusMetricGroup(name, { registry: this.registry, ...opts })

    metrics.set(name, metricGroup)

    if (opts.calculate == null) {
      return metricGroup
    }
  }

  registerCounter (name: string, opts: PrometheusCalculatedMetricOptions): void
  registerCounter (name: string, opts?: MetricOptions): Counter
  registerCounter (name: string, opts: any = {}): any {
    if (name == null ?? name.trim() === '') {
      throw new Error('Counter name is required')
    }

    let counter = metrics.get(name)

    if (counter != null) {
      this.log('Reuse existing counter', name)

      if (opts.calculate != null) {
        counter.addCalculator(opts.calculate)
      }

      return metrics.get(name)
    }

    this.log('Register counter', name)
    counter = new PrometheusCounter(name, { registry: this.registry, ...opts })

    metrics.set(name, counter)

    if (opts.calculate == null) {
      return counter
    }
  }

  registerCounterGroup (name: string, opts: PrometheusCalculatedMetricOptions<Record<string, number>>): void
  registerCounterGroup (name: string, opts?: MetricOptions): CounterGroup
  registerCounterGroup (name: string, opts: any = {}): any {
    if (name == null ?? name.trim() === '') {
      throw new Error('Counter group name is required')
    }

    let counterGroup = metrics.get(name)

    if (counterGroup != null) {
      this.log('Reuse existing counter group', name)

      if (opts.calculate != null) {
        counterGroup.addCalculator(opts.calculate)
      }

      return counterGroup
    }

    this.log('Register counter group', name)
    counterGroup = new PrometheusCounterGroup(name, { registry: this.registry, ...opts })

    metrics.set(name, counterGroup)

    if (opts.calculate == null) {
      return counterGroup
    }
  }
}

export function prometheusMetrics (init?: Partial<PrometheusMetricsInit>): (components: PrometheusMetricsComponents) => Metrics {
  return (components) => {
    return new PrometheusMetrics(components, init)
  }
}
