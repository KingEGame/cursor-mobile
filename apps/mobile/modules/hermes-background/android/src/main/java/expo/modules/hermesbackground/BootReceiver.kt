package expo.modules.hermesbackground

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

/** Bring the notification service back after a reboot / app update (only when the phone is paired). */
class BootReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (BridgePrefs.load(context) == null) return
    try {
      HermesBridgeService.start(context)
    } catch (e: Exception) {
      Log.w("HermesBackground", "cannot start after ${intent.action}: ${e.message}")
    }
  }
}
