package com.hwj.agent

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.view.View
import android.webkit.DownloadListener
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.appcompat.app.AppCompatActivity
import java.io.File

class MainActivity : AppCompatActivity() {
    private lateinit var web: WebView
    private lateinit var splash: View
    private var filePathCallback: android.webkit.ValueCallback<Array<Uri>>? = null

    companion object { private const val FILE_CHOOSER_REQUEST = 10001 }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // 全局崩溃留痕：任何线程未捕获异常先写入 node-log.txt 再交给系统处理，
        // 避免"无声闪崩"（用户可截图日志反馈，开发者可定位）
        val upstream = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { t, e ->
            try {
                NodeRuntime.log(this, "未捕获崩溃(${t.name}): ${e.stackTraceToString().take(3500)}")
            } catch (_: Exception) { }
            upstream?.uncaughtException(t, e)
        }
        setContentView(R.layout.activity_main)
        splash = findViewById(R.id.splash)
        web = findViewById(R.id.web)

        // 启动前台服务（内含 Node 运行时拉起与就绪探测）
        NodeService.start(this)

        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
        }
        // API 33+ 通知权限（前台服务通知可见性；拒绝不影响服务运行）
        if (Build.VERSION.SDK_INT >= 33 &&
            checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(android.Manifest.permission.POST_NOTIFICATIONS), 1)
        }

        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val u = request.url
                // 站内（127.0.0.1）放行，外链交给系统浏览器
                return if (u.host == "127.0.0.1") false else {
                    startActivity(Intent(Intent.ACTION_VIEW, u)); true
                }
            }

            override fun onPageFinished(view: WebView?, url: String?) {
                if (url != null && url.startsWith(NodeRuntime.BASE_URL)) splash.visibility = View.GONE
            }
        }
        web.webChromeClient = object : WebChromeClient() {
            // 文件上传：<input type=file> 必须经此回调拉起系统选择器，否则点击无反应
            override fun onShowFileChooser(
                webView: WebView,
                callback: android.webkit.ValueCallback<Array<Uri>>,
                fileChooserParams: FileChooserParams
            ): Boolean {
                filePathCallback?.onReceiveValue(null) // 上一次未完结的选择作废
                filePathCallback = callback
                val intent = fileChooserParams.createIntent().apply {
                    addCategory(Intent.CATEGORY_OPENABLE)
                }
                return try {
                    startActivityForResult(intent, FILE_CHOOSER_REQUEST)
                    true
                } catch (e: ActivityNotFoundException) {
                    filePathCallback = null
                    callback.onReceiveValue(null)
                    false
                }
            }
        }
        // 文件下载/导出：存入 App 私有 Downloads 后拉起系统分享
        web.setDownloadListener(DownloadListener { url, _, _, mime, _ ->
            Thread { shareDownloaded(url, mime) }.start()
        })

        // 就绪后加载页面（轮询回调主线程）；线程级兜底防中断异常闪崩
        Thread {
            try {
                val deadline = System.currentTimeMillis() + 40_000
                while (System.currentTimeMillis() < deadline && !NodeRuntime.ready) Thread.sleep(300)
            } catch (_: InterruptedException) { /* 服务异常中断：按未就绪走失败页 */ }
            runOnUiThread {
                splash.visibility = View.GONE // 无论成败都撤掉启动页（否则失败信息被遮住）
                if (NodeRuntime.ready) {
                    web.loadUrl(NodeRuntime.BASE_URL)
                } else {
                    val diag = NodeRuntime.readLog(this)
                        .replace("&", "&amp;").replace("<", "&lt;").replace("\n", "<br>")
                    web.loadDataWithBaseURL(null,
                        "<body style='background:#101418;color:#E8EDF2;font-family:sans-serif;padding:20px;line-height:1.7'>" +
                        "<h3>服务启动失败</h3><p>Node 运行时未能就绪。可尝试完全退出 App 后重开；" +
                        "仍失败请把下方诊断日志截图反馈。</p>" +
                        "<pre style='background:#171C22;padding:14px;border-radius:8px;font-size:12px;white-space:pre-wrap;color:#AAB6C2'>$diag</pre>" +
                        "</body>",
                        "text/html", "utf-8", null)
                }
            }
        }.start()
    }

    /** WebView 下载（交付文件导出）：拉取后经 FileProvider 分享 */
    private fun shareDownloaded(url: String, mime: String) {
        try {
            val name = url.substringAfterLast('/').substringBefore('?').ifEmpty { "export.txt" }
            val conn = java.net.URL(url).openConnection() as java.net.HttpURLConnection
            conn.connectTimeout = 5000; conn.readTimeout = 30000
            val outDir = File(filesDir, "exports").apply { mkdirs() }
            val f = File(outDir, name)
            conn.inputStream.use { it.copyTo(f.outputStream()) }
            val uri = androidx.core.content.FileProvider.getUriForFile(
                this, "${packageName}.fileprovider", f)
            val i = Intent(Intent.ACTION_SEND).apply {
                type = mime.ifEmpty { "application/octet-stream" }
                putExtra(Intent.EXTRA_STREAM, uri)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            startActivity(Intent.createChooser(i, "分享 $name"))
        } catch (e: Exception) {
            runOnUiThread {
                android.widget.Toast.makeText(this, "导出失败：${e.message}", android.widget.Toast.LENGTH_LONG).show()
            }
        }
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        if (requestCode == FILE_CHOOSER_REQUEST) {
            val cb = filePathCallback ?: return
            filePathCallback = null
            cb.onReceiveValue(
                WebChromeClient.FileChooserParams.parseResult(resultCode, data)
            )
            return
        }
        super.onActivityResult(requestCode, resultCode, data)
    }

    override fun onBackPressed() {
        if (web.canGoBack()) web.goBack() else super.onBackPressed()
    }

    override fun onDestroy() {
        // Node 由前台服务持有，Activity 销毁不退出运行时
        super.onDestroy()
    }
}
