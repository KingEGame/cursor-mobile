package expo.modules.hermesbackground

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.ConnectivityManager
import android.net.Network
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import okhttp3.CertificatePinner
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.net.URLEncoder
import java.security.MessageDigest
import java.util.concurrent.TimeUnit

/**
 * Keeps one WebSocket to the Hermes phone bridge while the app is closed and posts a notification when a
 * phone session finishes a turn ("Hermes replied"). Foreground service of type remoteMessaging: Android keeps
 * it alive and lets it use the network in Doze; the ongoing notification is the price (low importance, silent).
 */
class HermesBridgeService : Service() {
  companion object {
    private const val TAG = "HermesBackground"
    private const val CH_STATUS = "hermes_connection"
    private const val CH_REPLY = "hermes_replies"
    private const val ONGOING_ID = 7301

    @Volatile var appInForeground = false
    @Volatile var running = false

    fun start(ctx: Context) {
      ContextCompat.startForegroundService(ctx, Intent(ctx, HermesBridgeService::class.java))
    }

    fun stop(ctx: Context) {
      ctx.stopService(Intent(ctx, HermesBridgeService::class.java))
    }
  }

  private val main = Handler(Looper.getMainLooper())
  private var httpClient: OkHttpClient? = null
  private var ws: WebSocket? = null
  private var config: BridgePrefs.Config? = null
  private var urlIndex = 0
  private var failures = 0
  private var generation = 0
  private var stopped = false
  private val notified = HashMap<String, Long>()   // sessionId -> last message id already notified
  private var netCallback: ConnectivityManager.NetworkCallback? = null

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    running = true
    createChannels()
    goForeground(getString(R.string.hermes_bg_connecting))
    registerNetwork()
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val cfg = BridgePrefs.load(this)
    if (cfg == null) {
      stopSelf()
      return START_NOT_STICKY
    }
    val changed = cfg != config
    config = cfg
    if (changed || ws == null) {
      urlIndex = 0
      failures = 0
      connect()
    }
    return START_STICKY
  }

  override fun onDestroy() {
    stopped = true
    running = false
    generation++
    main.removeCallbacksAndMessages(null)
    ws?.close(1000, "service stopped")
    ws = null
    netCallback?.let {
      try {
        (getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager).unregisterNetworkCallback(it)
      } catch (_: Exception) {}
    }
    super.onDestroy()
  }

  // connection -------------------------------------------------------------------------------------
  private fun clientFor(cfg: BridgePrefs.Config): OkHttpClient {
    val cb = OkHttpClient.Builder()
      .connectTimeout(5, TimeUnit.SECONDS)
      .readTimeout(0, TimeUnit.MILLISECONDS)   // long-lived socket; liveness via pings
      .pingInterval(45, TimeUnit.SECONDS)
    // T16: TLS certificate pinning
    val fp = cfg.certFingerprint.trim()
    if (fp.isNotEmpty() && fp.length >= 44) {  // SHA-256 base64 is 44 chars
      try {
        val host = hostOf(cfg.urls.firstOrNull() ?: "")
        if (host.isNotEmpty()) {
          cb.certificatePinner(CertificatePinner.Builder()
            .add(host, "sha256/$fp")
            .build())
        }
      } catch (_: Exception) {}
    }
    return cb.build()
  }

  private fun hostOf(url: String): String {
    // http://100.1.2.3:8097 -> 100.1.2.3
    val cleaned = url.trimStart()
    var start = cleaned.indexOf("://")
    if (start < 0) start = 0 else start += 3
    val end = cleaned.indexOf(':', start)
    return if (end < 0) "" else cleaned.substring(start, end)
  }

  private fun connect() {
    val cfg = config ?: return
    if (stopped) return
    ws?.cancel()
    val gen = ++generation
    val http = httpClient ?: clientFor(cfg).also { httpClient = it }
    val base = cfg.urls[urlIndex % cfg.urls.size].trimEnd('/')
    // T16: token sent in client.hello frame, not in URL
    val wsUrl = base.replaceFirst("http://", "ws://").replaceFirst("https://", "wss://") + "/v1/ws"
    ws = http.newWebSocket(Request.Builder().url(wsUrl).build(), object : WebSocketListener() {
      override fun onOpen(webSocket: WebSocket, response: Response) {
        main.post {
          if (gen != generation) return@post
          failures = 0
          // T16: send token in client.hello
          val hello = JSONObject().apply {
            put("type", "client.hello")
            put("sessions", JSONObject.NULL)
            put("token", cfg.token)
          }
          webSocket.send(hello.toString())
          updateOngoing(getString(R.string.hermes_bg_connected, cfg.pcName))
        }
      }

      override fun onMessage(webSocket: WebSocket, text: String) {
        main.post { if (gen == generation) handle(text) }
      }

      override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
        main.post { if (gen == generation) retry() }
      }

      override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
        main.post {
          if (gen != generation) return@post
          if (response?.code == 401) {   // revoked on the PC: stop for good, the app shows "pair again"
            Log.i(TAG, "token revoked; stopping")
            BridgePrefs.clear(this@HermesBridgeService)
            stopSelf()
            return@post
          }
          retry()
        }
      }
    })
  }

  /** Walk through every known address (Wi-Fi, Tailscale…) quickly, then back off up to a minute. */
  private fun retry() {
    if (stopped) return
    val cfg = config ?: return
    ws = null
    urlIndex++
    val roundDone = urlIndex % cfg.urls.size == 0
    if (roundDone) failures++
    val delay = if (!roundDone) 300L else minOf(60_000L, 1_000L shl minOf(failures, 6))
    updateOngoing(getString(R.string.hermes_bg_waiting, cfg.pcName))
    main.postDelayed({ connect() }, delay)
  }

  private fun registerNetwork() {
    val cm = getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
    val cb = object : ConnectivityManager.NetworkCallback() {
      override fun onAvailable(network: Network) {
        // New network (home Wi-Fi ↔ mobile + Tailscale): reconnect right away from the best address.
        main.post {
          if (stopped) return@post
          main.removeCallbacksAndMessages(null)
          urlIndex = 0
          failures = 0
          connect()
        }
      }
    }
    try {
      cm.registerDefaultNetworkCallback(cb)
      netCallback = cb
    } catch (e: Exception) {
      Log.w(TAG, "network callback: ${e.message}")
    }
  }

  // events -----------------------------------------------------------------------------------------
  private fun handle(text: String) {
    val ev = try { JSONObject(text) } catch (_: Exception) { return }
    when (ev.optString("type")) {
      "session.updated" -> handleSessionUpdated(ev)
      "presence.updated" -> handlePresenceUpdated(ev)
    }
  }

  private fun handlePresenceUpdated(ev: JSONObject) {
    val state = ev.optString("state", "")
    val block = ev.optString("current_block", "")
    val label = when (state) {
      "on_task" -> "\u25CF On task"
      "off_task" -> "\u25CF Off task"
      "waiting_approval" -> "\u25CF Needs approval"
      "idle" -> "\u25CF Idle"
      else -> "Mate"
    }
    val note = if (block.isNotEmpty()) "$label \u2014 $block" else label
    updateOngoing(note)
  }

  private fun handleSessionUpdated(ev: JSONObject) {
    val msg = ev.optJSONObject("lastMessage") ?: return
    if (msg.optString("role") != "assistant") return
    val content = msg.optString("content").trim()
    if (content.isEmpty()) return
    // Phone sessions only (started or continued from the phone) — PC work must not buzz the phone.
    val source = ev.optString("source", "")
    if (source.isNotEmpty() && source != "phone") return
    val sid = ev.optString("sessionId")
    val mid = msg.optLong("id", 0)
    if (notified[sid] == mid) return
    notified[sid] = mid
    if (appInForeground) return
    val title = ev.optString("title").takeIf { it.isNotBlank() && it != "null" } ?: (config?.pcName ?: "Hermes")
    notifyReply(sid, title, content)
  }

  private fun notifyReply(sessionId: String, title: String, content: String) {
    if (Build.VERSION.SDK_INT >= 33 &&
      ContextCompat.checkSelfPermission(this, android.Manifest.permission.POST_NOTIFICATIONS) !=
      android.content.pm.PackageManager.PERMISSION_GRANTED) return
    val open = Intent(Intent.ACTION_VIEW, Uri.parse("hermes-phone://session/" + Uri.encode(sessionId)))
      .setPackage(packageName)
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
    val pi = PendingIntent.getActivity(this, sessionId.hashCode(), open,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    val plain = content.replace(Regex("[*_`#>]+"), "").trim()
    val n = NotificationCompat.Builder(this, CH_REPLY)
      .setSmallIcon(R.drawable.ic_hermes_notification)
      .setContentTitle(title)
      .setContentText(plain.take(200))
      .setStyle(NotificationCompat.BigTextStyle().bigText(plain.take(1500)))
      .setCategory(NotificationCompat.CATEGORY_MESSAGE)
      .setPriority(NotificationCompat.PRIORITY_HIGH)
      .setAutoCancel(true)
      .setContentIntent(pi)
      .build()
    try {
      NotificationManagerCompat.from(this).notify(sessionId.hashCode(), n)
    } catch (e: SecurityException) {
      Log.w(TAG, "notify: ${e.message}")
    }
  }

  // notifications ----------------------------------------------------------------------------------
  private fun createChannels() {
    if (Build.VERSION.SDK_INT < 26) return
    val nm = getSystemService(NotificationManager::class.java)
    nm.createNotificationChannel(NotificationChannel(CH_STATUS, getString(R.string.hermes_bg_channel_status),
      NotificationManager.IMPORTANCE_MIN).apply { setShowBadge(false) })
    nm.createNotificationChannel(NotificationChannel(CH_REPLY, getString(R.string.hermes_bg_channel_replies),
      NotificationManager.IMPORTANCE_HIGH))
  }

  private fun ongoing(text: String): Notification {
    val launch = packageManager.getLaunchIntentForPackage(packageName)
    val pi = launch?.let {
      PendingIntent.getActivity(this, 0, it, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }
    return NotificationCompat.Builder(this, CH_STATUS)
      .setSmallIcon(R.drawable.ic_hermes_notification)
      .setContentTitle("Hermes Phone")
      .setContentText(text)
      .setOngoing(true)
      .setSilent(true)
      .setPriority(NotificationCompat.PRIORITY_MIN)
      .setContentIntent(pi)
      .build()
  }

  private fun goForeground(text: String) {
    val n = ongoing(text)
    if (Build.VERSION.SDK_INT >= 34) {
      startForeground(ONGOING_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING)
    } else {
      startForeground(ONGOING_ID, n)
    }
  }

  private fun updateOngoing(text: String) {
    try {
      NotificationManagerCompat.from(this).notify(ONGOING_ID, ongoing(text))
    } catch (_: SecurityException) {}
  }
}
