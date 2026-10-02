package expo.modules.pcwatch

import android.content.Intent
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/** JS bridge: start/stop the PC watch service (notification permission is asked from JS). */
class PcWatchModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("PcWatch")

    Function("start") { baseUrl: String, token: String, hubName: String ->
      val context = appContext.reactContext ?: return@Function false
      val intent = Intent(context, PcWatchService::class.java)
        .putExtra(PcWatchService.EXTRA_BASE_URL, baseUrl)
        .putExtra(PcWatchService.EXTRA_TOKEN, token)
        .putExtra(PcWatchService.EXTRA_HUB_NAME, hubName)
      context.startForegroundService(intent)
      true
    }

    Function("stop") {
      val context = appContext.reactContext ?: return@Function false
      context.startService(
        Intent(context, PcWatchService::class.java).setAction(PcWatchService.ACTION_STOP),
      )
      true
    }

    Function("isRunning") { PcWatchService.running }
  }
}
