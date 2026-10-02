package expo.modules.pcwatch

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.Uri
import android.os.Build
import android.os.IBinder
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit

/**
 * Foreground service: polls the paired PC Hub (GET /v1/agents) and posts a local
 * notification when an agent chat finishes, fails, or needs approval.
 *
 * The device token arrives in the start Intent only (START_REDELIVER_INTENT re-sends it
 * after a restart) — it is never written to plain storage.
 */
class PcWatchService : Service() {
  private var executor: ScheduledExecutorService? = null
  private var baseUrl: String = ""
  private var token: String = ""
  private var hubName: String = "your PC"
  /** composerId → last seen status; null until the first poll records a baseline. */
  private var lastStatus: MutableMap<String, String>? = null
  private var nextNotificationId = 100

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == ACTION_STOP) {
      stopSelf()
      return START_NOT_STICKY
    }
    baseUrl = intent?.getStringExtra(EXTRA_BASE_URL)?.trimEnd('/') ?: baseUrl
    token = intent?.getStringExtra(EXTRA_TOKEN) ?: token
    hubName = intent?.getStringExtra(EXTRA_HUB_NAME) ?: hubName
    if (baseUrl.isEmpty() || token.isEmpty()) {
      stopSelf()
      return START_NOT_STICKY
    }

    createChannels(this)
    val ongoing = Notification.Builder(this, CHANNEL_WATCH)
      .setSmallIcon(android.R.drawable.stat_notify_sync_noanim)
      .setContentTitle("Watching agents on $hubName")
      .setContentText("You'll be notified when a chat finishes or fails.")
      .setContentIntent(openApp(null))
      .setOngoing(true)
      .build()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
      startForeground(ONGOING_ID, ongoing, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
    } else {
      startForeground(ONGOING_ID, ongoing)
    }

    if (executor == null) {
      executor = Executors.newSingleThreadScheduledExecutor().also {
        it.scheduleWithFixedDelay({ pollSafely() }, 0, POLL_SECONDS, TimeUnit.SECONDS)
      }
    }
    running = true
    return START_REDELIVER_INTENT
  }

  override fun onDestroy() {
    executor?.shutdownNow()
    executor = null
    running = false
    super.onDestroy()
  }

  private fun pollSafely() {
    try {
      poll()
    } catch (_: Exception) {
      // Hub or Tailscale unreachable: stay quiet and try again next tick.
    }
  }

  private fun poll() {
    val conn = URL("$baseUrl/v1/agents").openConnection() as HttpURLConnection
    conn.connectTimeout = 8_000
    conn.readTimeout = 15_000
    conn.setRequestProperty("Authorization", "Bearer $token")
    conn.setRequestProperty("Accept", "application/json")
    try {
      if (conn.responseCode != 200) return
      val body = conn.inputStream.bufferedReader().use { it.readText() }
      val current = mutableMapOf<String, String>()
      val titles = mutableMapOf<String, String>()
      val sessions = mutableMapOf<String, String>()
      val projects = JSONObject(body).optJSONArray("projects") ?: return
      for (p in 0 until projects.length()) {
        val chats = projects.getJSONObject(p).optJSONArray("chats") ?: continue
        for (c in 0 until chats.length()) {
          val chat = chats.getJSONObject(c)
          val id = chat.optString("composerId")
          current[id] = chat.optString("status", "idle")
          titles[id] = chat.optString("title", "Chat")
          sessions[id] = chat.optString("sessionId")
        }
      }
      val before = lastStatus
      lastStatus = current
      if (before == null) return // first poll is the baseline — no backlog of alerts
      for ((id, now) in current) {
        val was = before[id] ?: continue
        val event = transition(was, now) ?: continue
        notify(event, titles[id] ?: "Chat", sessions[id])
      }
    } finally {
      conn.disconnect()
    }
  }

  private fun notify(event: String, title: String, sessionId: String?) {
    val (heading, channel) = when (event) {
      "failed" -> "Agent stopped with an error" to CHANNEL_EVENTS
      "approval" -> "Approval needed" to CHANNEL_APPROVALS
      else -> "Agent finished" to CHANNEL_EVENTS
    }
    val n = Notification.Builder(this, channel)
      .setSmallIcon(android.R.drawable.stat_notify_chat)
      .setContentTitle("$heading · $title")
      .setContentText(if (event == "finished") "Tap to read the reply." else "Tap to open the chat.")
      .setContentIntent(openApp(sessionId))
      .setAutoCancel(true)
      .build()
    getSystemService(NotificationManager::class.java).notify(nextNotificationId++, n)
  }

  private fun openApp(sessionId: String?): PendingIntent {
    val uri = if (sessionId.isNullOrEmpty()) "cursor-companion://main" else "cursor-companion://history/$sessionId"
    val intent = Intent(Intent.ACTION_VIEW, Uri.parse(uri)).setPackage(packageName)
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
    return PendingIntent.getActivity(
      this,
      uri.hashCode(),
      intent,
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )
  }

  companion object {
    const val ACTION_STOP = "expo.modules.pcwatch.STOP"
    const val EXTRA_BASE_URL = "baseUrl"
    const val EXTRA_TOKEN = "token"
    const val EXTRA_HUB_NAME = "hubName"
    private const val ONGOING_ID = 1
    private const val POLL_SECONDS = 10L
    private const val CHANNEL_WATCH = "pc_watch"
    private const val CHANNEL_EVENTS = "agent_events"
    private const val CHANNEL_APPROVALS = "agent_approvals"

    @Volatile var running = false

    /** Status change → notification kind, or null for no alert. */
    fun transition(was: String, now: String): String? = when {
      now == was -> null
      now == "error" -> "failed"
      now == "waiting_approval" -> "approval"
      was == "working" && now == "idle" -> "finished"
      else -> null
    }

    fun createChannels(context: Context) {
      val nm = context.getSystemService(NotificationManager::class.java)
      nm.createNotificationChannel(
        NotificationChannel(CHANNEL_WATCH, "Watching your PC", NotificationManager.IMPORTANCE_MIN).apply {
          description = "Ongoing while the phone watches agent chats on your PC"
          setShowBadge(false)
        },
      )
      nm.createNotificationChannel(
        NotificationChannel(CHANNEL_EVENTS, "Agent finished / failed", NotificationManager.IMPORTANCE_DEFAULT),
      )
      nm.createNotificationChannel(
        NotificationChannel(CHANNEL_APPROVALS, "Approvals", NotificationManager.IMPORTANCE_HIGH),
      )
    }
  }
}
