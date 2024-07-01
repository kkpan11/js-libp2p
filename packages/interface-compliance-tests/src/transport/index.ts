import dial from './dial-test.js'
import filter from './filter-test.js'
import listen from './listen-test.js'
import type { TestSetup } from '../index.js'
import type { Transport } from '@libp2p/interface'
import type { Multiaddr } from '@multiformats/multiaddr'

export interface Connector {
  delay(ms: number): void
  restore(): void
}

export interface TransportTestFixtures {
  listenAddrs: Multiaddr[]
  dialAddrs: Multiaddr[]
  dialer: Transport
  listener: Transport
  connector: Connector
}

export default (common: TestSetup<TransportTestFixtures>): void => {
  describe('interface-transport', () => {
    dial(common)
    listen(common)
    filter(common)
  })
}
