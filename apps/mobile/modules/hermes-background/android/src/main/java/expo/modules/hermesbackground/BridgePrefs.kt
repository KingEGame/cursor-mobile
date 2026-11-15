package expo.modules.hermesbackground

import android.content.Context

/** Service config in app-private storage (the service must reconnect after reboot without the JS side). */
internal object BridgePrefs {
  private const val FILE = "hermes_background"

  data class Config(val urls: List<String>, val token: String, val pcName: String)

  fun save(ctx: Context, urls: List<String>, token: String, pcName: String) {
    ctx.getSharedPreferences(FILE, Context.MODE_PRIVATE).edit()
      .putString("urls", urls.joinToString("\n"))
      .putString("token", token)
      .putString("pcName", pcName)
      .apply()
  }

  fun load(ctx: Context): Config? {
    val p = ctx.getSharedPreferences(FILE, Context.MODE_PRIVATE)
    val token = p.getString("token", null) ?: return null
    val urls = (p.getString("urls", "") ?: "").split("\n").map { it.trim() }.filter { it.isNotEmpty() }
    if (urls.isEmpty() || token.isBlank()) return null
    return Config(urls, token, p.getString("pcName", null) ?: "PC")
  }

  fun clear(ctx: Context) {
    ctx.getSharedPreferences(FILE, Context.MODE_PRIVATE).edit().clear().apply()
  }
}
