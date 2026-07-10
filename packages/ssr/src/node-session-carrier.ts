import { AsyncLocalStorage } from 'node:async_hooks'

import { __fictInstallSSRSessionCarrier, type FictSSRSession } from '@fictjs/runtime/internal'

const sessionStorage = new AsyncLocalStorage<FictSSRSession>()

__fictInstallSSRSessionCarrier({
  getStore: () => sessionStorage.getStore(),
  run: (session, fn) => sessionStorage.run(session, fn),
})
