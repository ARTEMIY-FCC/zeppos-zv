import { BaseApp } from '@zeppos/zml/base-app'

import { releaseAll } from './lib/audio'

App(
  BaseApp({
    globalData: {},
    onCreate() {},
    onDestroy() {
      // The watch has a single media session: if it is not released, sound is gone until reboot
      releaseAll()
    },
  }),
)
