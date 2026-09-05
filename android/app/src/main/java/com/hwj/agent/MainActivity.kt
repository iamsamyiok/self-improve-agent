package com.hwj.agent

import android.annotation.SuppressLint
import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.SharedPreferences
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Message
import android.view.View
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.EditText
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import java.io.File

/**
 * 远程壳（2.0 架构）：本 APK 已移除内嵌 Node 运行时（旧方案归档于 android/legacy-node-src/）。
 * 程序本体运行在用户的云 Windows 上，经 Tailscale 虚拟局域网访问。
 * 本壳职责：管理服务地址（设置页 + 本机记忆）→ 全屏 WebView 承载交互 → 连接失败给出诊断指引。
 */
class MainActivity : AppCompatActivity() {

    private lateinit var prefs: SharedPreferences
    private lateinit var web: WebView
    private lateinit var progress: ProgressBar
    private lateinit var setupView: View
    private lateinit var urlInput: EditText
    private lateinit var webContainer: View
    private lateinit var errorView: View
    private lateinit var errorText: TextView
    private lateinit var fabMenu: TextView
    private var serverUrl: String? = null
    private var filePathCallback: ValueCallback<Array<Uri>>? = null

    companion object {
        private const val FILE_CHOOSER_REQUEST = 10001
        private const val PREFS = "hwj_mobile"
        private const val KEY_URL = "serverUrl"
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        prefs = getSharedPreferences(PREFS, MODE_PRIVATE)

        web = findViewById(R.id.web)
        progress = findViewById(R.id.progress)
        setupView = findViewById(R.id.setupView)
        urlInput = findViewById(R.id.urlInput)
        webContainer = findViewById(R.id.webContainer)
        errorView = findViewById(R.id.errorView)
        errorText = findViewById(R.id.errorText)
        fabMenu = findViewById(R.id.fabMenu)
        findViewById<View>(R.id.connectBtn).setOnClickListener { onConnect() }
        findViewById<View>(R.id.retryBtn).setOnClickListener { enterWeb(null) }
        findViewById<View>(R.id.changeBtn).setOnClickListener { showSetup() }
        fabMenu.setOnClickListener { showMenu() }

        setupWebView()

        serverUrl = prefs.getString(KEY_URL, null)
        savedInstanceState?.getString(KEY_URL)?.let { serverUrl = it }

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (webContainer.visibility == View.VISIBLE && web.canGoBack()) web.goBack() else finish()
            }
        })

        if (serverUrl.isNullOrEmpty()) showSetup() else enterWeb(savedInstanceState)
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun setupWebView() {
        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            useWideViewPort = true
            loadWithOverviewMode = true
        }
        web.setBackgroundColor(0xFF101418.toInt())

        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val u = request.url
                // 站内（服务器同主机）放行；其余站点与 scheme 交给系统浏览器
                return if (u.host != null && u.host == serverHost()) false else {
                    openExternal(u.toString()); true
                }
            }

            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (!request.isForMainFrame) return
                showError(when (error.errorCode) {
                    ERROR_HOST_UNRESOLVED -> "服务地址无法解析。请确认地址填写正确，且手机 Tailscale 已连接。"
                    ERROR_CONNECT, ERROR_TIMEOUT -> "连接失败或超时。请检查：云 Windows 是否开机、程序是否在运行、Tailscale 是否在线。"
                    else -> "加载失败：${error.description}"
                })
            }
        }

        web.webChromeClient = object : WebChromeClient() {
            override fun onProgressChanged(view: WebView?, newProgress: Int) {
                progress.progress = newProgress
                progress.visibility = if (newProgress >= 100) View.GONE else View.VISIBLE
            }

            // 文件上传：<input type=file> 必须经此回调拉起系统选择器，否则点击无反应
            override fun onShowFileChooser(
                webView: WebView,
                callback: ValueCallback<Array<Uri>>,
                fileChooserParams: FileChooserParams
            ): Boolean {
                filePathCallback?.onReceiveValue(null) // 上一次未完结的选择作废
                filePathCallback = callback
                return try {
                    startActivityForResult(fileChooserParams.createIntent().apply {
                        addCategory(Intent.CATEGORY_OPENABLE)
                    }, FILE_CHOOSER_REQUEST)
                    true
                } catch (e: ActivityNotFoundException) {
                    filePathCallback = null
                    callback.onReceiveValue(null)
                    false
                }
            }

            // window.open（帮助页/发布页等新标签）WebView 无法承载，借探针取 URL 后转交外部浏览器
            override fun onCreateWindow(view: WebView, isDialog: Boolean, isUserGesture: Boolean, resultMsg: Message): Boolean {
                val probe = WebView(view.context)
                probe.webViewClient = object : WebViewClient() {
                    override fun shouldOverrideUrlLoading(v: WebView, request: WebResourceRequest): Boolean {
                        openExternal(request.url.toString()); return true
                    }
                }
                (resultMsg.obj as WebView.WebViewTransport).setWebView(probe)
                resultMsg.sendToTarget()
                return true
            }
        }

        // 网页触发的下载（如交付文件导出）：落地 App 私有目录后经 FileProvider 拉起系统分享
        web.setDownloadListener { url, _, _, mime, _ -> Thread { shareDownloaded(url, mime) }.start() }
    }

    private fun enterWeb(saved: Bundle?) {
        setupView.visibility = View.GONE
        errorView.visibility = View.GONE
        webContainer.visibility = View.VISIBLE
        fabMenu.visibility = View.VISIBLE
        val url = serverUrl ?: return showSetup()
        // 进程重建优先恢复 WebView 历史栈，避免整页重载
        val restored = saved != null && web.restoreState(saved) != null
        if (!restored) web.loadUrl(url)
    }

    private fun showSetup() {
        webContainer.visibility = View.GONE
        errorView.visibility = View.GONE
        fabMenu.visibility = View.GONE
        setupView.visibility = View.VISIBLE
        urlInput.setText(serverUrl ?: "")
    }

    private fun showError(reason: String) {
        progress.visibility = View.GONE
        webContainer.visibility = View.GONE
        fabMenu.visibility = View.GONE
        errorView.visibility = View.VISIBLE
        errorText.text = reason
    }

    private fun showMenu() {
        AlertDialog.Builder(this)
            .setItems(arrayOf("更改服务器地址", "刷新页面")) { _, which ->
                when (which) { 0 -> showSetup(); 1 -> web.reload() }
            }
            .show()
    }

    private fun onConnect() {
        val normalized = normalizeUrl(urlInput.text.toString())
        if (normalized == null) {
            Toast.makeText(this, "请填写完整地址，例如 http://100.x.y.z:3788", Toast.LENGTH_LONG).show()
            return
        }
        serverUrl = normalized
        prefs.edit().putString(KEY_URL, normalized).apply()
        enterWeb(null)
    }

    /** 补 scheme、去尾斜杠；解析不出主机判为非法 */
    private fun normalizeUrl(raw: String): String? {
        var s = raw.trim().trimEnd('/')
        if (s.isEmpty()) return null
        if (!s.contains("://")) s = "http://$s"
        val u = Uri.parse(s)
        return if (u.host.isNullOrEmpty()) null else s
    }

    private fun serverHost(): String? = serverUrl?.let { Uri.parse(it).host }

    private fun openExternal(url: String) {
        try {
            startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
        } catch (_: Exception) {
            Toast.makeText(this, "无法打开链接", Toast.LENGTH_SHORT).show()
        }
    }

    private fun shareDownloaded(url: String, mime: String) {
        if (!url.startsWith("http")) {
            runOnUiThread { Toast.makeText(this, "该类型文件暂不支持壳内下载", Toast.LENGTH_LONG).show() }
            return
        }
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
                Toast.makeText(this, "导出失败：${e.message}", Toast.LENGTH_LONG).show()
            }
        }
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        if (requestCode == FILE_CHOOSER_REQUEST) {
            val cb = filePathCallback ?: return
            filePathCallback = null
            cb.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data))
            return
        }
        super.onActivityResult(requestCode, resultCode, data)
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        outState.putString(KEY_URL, serverUrl)
        if (webContainer.visibility == View.VISIBLE) web.saveState(outState)
    }
}
