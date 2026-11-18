package expo.modules.hermesbackground

import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class HermesBackgroundModule : Module() {
  private val context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  override fun definition() = ModuleDefinition {
    Name("HermesBackground")

    Function("configure") { urls: List<String>, token: String, pcName: String, certFingerprint: String ->
      BridgePrefs.save(context, urls, token, pcName, certFingerprint)
      HermesBridgeService.start(context)
    }

    Function("stop") {
      BridgePrefs.clear(context)
      HermesBridgeService.stop(context)
    }

    Function("setForeground") { foreground: Boolean ->
      HermesBridgeService.appInForeground = foreground
    }

    Function("isRunning") {
      HermesBridgeService.running
    }
  }
}
