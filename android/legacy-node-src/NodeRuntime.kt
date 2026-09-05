package com.hwj.agent

import android.content.Context
import android.os.Build
import android.util.Log
import java.io.File
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * nodejs-mobile 运行时封装：
 * 1. 首次启动把 assets/nodejs-project（dual-agent 48 文件）与 assets/native/<abi>/libnode.so 释放到私有目录
 * 2. System.load(libnode.so) 后经 JNI 桥在新线程启动 Node
 * 3. 轮询 /api/health 直到就绪
 */
object NodeRuntime {
    private const val TAG = "hwj/NodeRuntime"
    const val PORT = 3788
    const val BASE_URL = "http://127.0.0.1:$PORT"

    @Volatile private var started = false
    @Volatile var ready = false
        private set

    val executor = Executors.newSingleThreadExecutor()

    /** 诊断日志：失败页直接展示，用户无需 adb 即可反馈 */
    fun log(context: Context, msg: String) {
        Log.i(TAG, msg)
        try {
            val f = File(context.filesDir, "node-log.txt")
            val line = "[${java.text.SimpleDateFormat("MM-dd HH:mm:ss").format(java.util.Date())}] $msg\n"
            if (f.length() > 64 * 1024) f.delete() // 超限清空重写，防无限膨胀
            f.appendText(line)
        } catch (_: Exception) { /* 日志失败不阻断 */ }
    }

    fun readLog(context: Context): String {
        return try {
            val f = File(context.filesDir, "node-log.txt")
            if (f.exists()) f.readText().takeLast(4000) else "(无日志)"
        } catch (e: Exception) { "(读取失败: ${e.message})" }
    }

    fun start(context: Context) {
        if (started) return
        started = true
        val app = context.applicationContext
        executor.execute {
            try {
                log(app, "启动流程开始")
                val filesRoot = app.filesDir
                val nodeDir = File(filesRoot, "nodejs-project")
                val nativeDir = File(filesRoot, "native").apply { mkdirs() }

                // 1) 释放 Node 工程（带版本戳：升级后重解压）
                val stamp = File(filesRoot, "nodejs-project.stamp")
                val curVer = app.packageManager.getPackageInfo(app.packageName, 0).versionName ?: "?"
                if (stamp.exists() && stamp.readText() == curVer && File(nodeDir, "server.js").exists()) {
                    log(app, "nodejs-project 已是最新 ($curVer)")
                } else {
                    log(app, "释放 nodejs-project 到 $nodeDir …")
                    copyAssetsTree(app, "nodejs-project", nodeDir)
                    stamp.writeText(curVer)
                    log(app, "nodejs-project 释放完成 ($curVer)")
                }

                // 2) 释放 libnode.so（按当前 ABI）
                //    文件名必须保持 libnode.so：bridge 的 NEEDED 按该名查找已加载库，
                //    改名会导致 System.loadLibrary(node_bridge) 时 "library libnode.so not found"
                val abi = Build.SUPPORTED_ABIS.firstOrNull() ?: "arm64-v8a"
                val libDir = File(nativeDir, abi).apply { mkdirs() }
                val libSo = File(libDir, "libnode.so")
                if (!libSo.exists() || libSo.length() == 0L) {
                    log(app, "释放 libnode.so ($abi) …")
                    app.assets.open("native/$abi/libnode.so").use { input ->
                        File(libDir, "libnode.so.tmp").outputStream().use { input.copyTo(it) }
                    }
                    File(libDir, "libnode.so.tmp").renameTo(libSo)
                    log(app, "libnode.so 释放完成 (${libSo.length() / 1048576}MB)")
                }

                // 3) 先加载 libnode，再加载 JNI 桥（bridge 链接了 node 符号）
                log(app, "System.load libnode.so …")
                System.load(libSo.absolutePath)
                log(app, "System.loadLibrary node_bridge …")
                System.loadLibrary("node_bridge")

                // 4) 数据目录：filesDir/mobile-data，与网页版状态结构一致
                val dataDir = File(filesRoot, "mobile-data")
                val argv = arrayOf("node", File(nodeDir, "mobile-main.js").absolutePath, dataDir.absolutePath)
                log(app, "启动 Node: ${argv.joinToString(" ")}")
                startNodeWithArguments(argv)
                log(app, "Node 线程已拉起，等待 /api/health 就绪")
            } catch (e: Throwable) {
                log(app, "启动失败: ${e::class.java.simpleName}: ${e.message}")
                return@execute
            }

            // 5) 就绪探测（最长 30s）
            val deadline = System.currentTimeMillis() + 30_000
            while (System.currentTimeMillis() < deadline) {
                try {
                    val conn = java.net.URL("$BASE_URL/api/health").openConnection() as java.net.HttpURLConnection
                    conn.connectTimeout = 1000
                    conn.readTimeout = 1000
                    if (conn.responseCode == 200) {
                        ready = true
                        log(app, "Node 服务就绪: $BASE_URL")
                        return@execute
                    }
                } catch (_: Exception) { /* 尚未起来，继续轮询 */ }
                Thread.sleep(400)
            }
            log(app, "Node 服务 30s 内未就绪（Node 线程可能已崩溃，logcat 可见其 stderr）")
        }
    }

    /** 递归复制 assets 目录到目标目录 */
    private fun copyAssetsTree(context: Context, src: String, dst: File) {
        val files = context.assets.list(src) ?: emptyArray()
        if (files.isEmpty()) { // 是文件
            dst.parentFile?.mkdirs()
            context.assets.open(src).use { it.copyTo(dst.outputStream()) }
            return
        }
        dst.mkdirs()
        for (f in files) copyAssetsTree(context, "$src/$f", File(dst, f))
    }

    // JNI：nodejs-mobile 启动入口
    private external fun startNodeWithArguments(arguments: Array<String>)
}
