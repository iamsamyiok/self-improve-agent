package com.hwj.agent

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * 前台服务（dataSync）：让 Node 运行时在后台/Doze 下存活。
 * 通知栏显示运行状态；任务进度通过轮询 /api/state 拿 busy 状态更新文案。
 */
class NodeService : Service() {
    private var schedExecutor = Executors.newSingleThreadExecutor()
    private var running = false

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        startForeground(1, buildNotification("启动中…"))
        NodeRuntime.start(this)
        running = true
        schedExecutor.execute {
            while (running) {
                try {
                    val busy = probeBusy()
                    updateNotification(if (busy) "任务执行中…" else "运行中 · 等待任务")
                } catch (_: Exception) { /* 忽略单次探测失败 */ }
                try { Thread.sleep(5000) } catch (_: InterruptedException) { break }
            }
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int = START_STICKY

    override fun onDestroy() {
        running = false
        super.onDestroy()
    }

    private fun probeBusy(): Boolean {
        val conn = java.net.URL("${NodeRuntime.BASE_URL}/api/state").openConnection() as java.net.HttpURLConnection
        conn.connectTimeout = 2000; conn.readTimeout = 2000
        if (conn.responseCode != 200) return false
        val body = conn.inputStream.bufferedReader().readText()
        return Regex("\"busy\"\\s*:\\s*true").containsMatchIn(body)
    }

    private fun buildNotification(text: String): Notification {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= 26) {
            nm.createNotificationChannel(NotificationChannel(CHAN, "后台运行", NotificationManager.IMPORTANCE_LOW))
        }
        val pi = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        return NotificationCompat.Builder(this, CHAN)
            .setSmallIcon(R.drawable.ic_stat_node)
            .setContentTitle("hwj-agent")
            .setContentText(text)
            .setContentIntent(pi)
            .setOngoing(true)
            .build()
    }

    private fun updateNotification(text: String) {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.notify(1, buildNotification(text))
    }

    companion object {
        private const val CHAN = "hwj_node"
        fun start(ctx: Context) {
            val i = Intent(ctx, NodeService::class.java)
            if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(i) else ctx.startService(i)
        }
    }
}
